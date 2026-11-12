import type { AppProblem } from "@forge/protocol";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./db/index.ts";
import { publish } from "./events.ts";
import { activeRunId, startRun } from "./runs.ts";
import { docker, exec } from "./sandbox.ts";

/*
 * Fix from logs: problems the running app produced.
 *
 *   browser  uncaught errors, unhandled promise rejections, console.error  ─┐ reported by the
 *   network  failed requests (5xx, same-origin 4xx, network failures)      ─┘ preview's inspector
 *   server   errors in the dev server's log (/tmp/dev.log), read every 15 s
 *
 * The same problem is one row, counted each time it happens (fingerprint = source + message with
 * numbers and ids blanked out). Errors while the agent is editing are ignored: they are usually
 * half-finished edits. "Fix this" starts a build run with the problem as the request; when that
 * run saves a version the problem is marked fixed, and it reopens if it happens again.
 */

export type ProblemReport = { source: "browser" | "network" | "server"; message: string; detail?: string; page?: string };

const MAX_MESSAGE = 500;
const MAX_DETAIL = 6000;

/** Blank out what varies between occurrences of the same problem. */
function fingerprint(r: ProblemReport): string {
  const norm = r.message
    .toLowerCase()
    .replace(/https?:\/\/[^\s"')]+/g, (u) => u.replace(/[?#].*$/, ""))
    .replace(/\b[0-9a-f]{8,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha1").update(`${r.source}\n${norm}`).digest("hex").slice(0, 24);
}

/* Live updates: tell open builders the list changed (at most every 2 s per project). */
const lastPublish = new Map<string, number>();
const pendingPublish = new Map<string, ReturnType<typeof setTimeout>>();
function notify(projectId: string) {
  if (pendingPublish.has(projectId)) return;
  const wait = Math.max(0, 2000 - (Date.now() - (lastPublish.get(projectId) ?? 0)));
  pendingPublish.set(
    projectId,
    setTimeout(() => {
      pendingPublish.delete(projectId);
      lastPublish.set(projectId, Date.now());
      publish(projectId, { type: "problems_changed", projectId });
    }, wait),
  );
}

/* Abuse guard for the unauthenticated preview endpoint: 60 reports a minute per project. */
const budget = new Map<string, { minute: number; n: number }>();
function allowed(projectId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const b = budget.get(projectId);
  if (!b || b.minute !== minute) {
    budget.set(projectId, { minute, n: 1 });
    return true;
  }
  return ++b.n <= 60;
}

export async function recordProblems(projectId: string, reports: ProblemReport[]) {
  if (activeRunId(projectId)) return; // the agent is mid-edit
  let changed = false;
  for (const r of reports) {
    if (!allowed(projectId)) break;
    const message = r.message.trim().slice(0, MAX_MESSAGE);
    if (!message) continue;
    await db
      .insert(schema.appProblem)
      .values({
        id: nanoid(12),
        projectId,
        fingerprint: fingerprint(r),
        source: r.source,
        message,
        detail: (r.detail ?? "").slice(0, MAX_DETAIL),
        page: r.page?.slice(0, 300) ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.appProblem.projectId, schema.appProblem.fingerprint],
        set: {
          count: sql`${schema.appProblem.count} + 1`,
          lastSeen: sql`now()`,
          detail: sql`excluded.detail`,
          page: sql`coalesce(excluded.page, ${schema.appProblem.page})`,
          // Happening again after a fix (or after being ignored) reopens it.
          status: sql`case when ${schema.appProblem.status} in ('fixed', 'ignored') then 'open' else ${schema.appProblem.status} end`,
        },
      });
    changed = true;
  }
  if (changed) notify(projectId);
}

const toApi = (r: typeof schema.appProblem.$inferSelect): AppProblem => ({
  id: r.id,
  source: r.source as AppProblem["source"],
  message: r.message,
  detail: r.detail,
  page: r.page,
  count: r.count,
  status: r.status as AppProblem["status"],
  fixedSha: r.fixedSha,
  firstSeen: r.firstSeen.toISOString(),
  lastSeen: r.lastSeen.toISOString(),
});

export async function listProblems(projectId: string): Promise<AppProblem[]> {
  await scanServerLog(projectId).catch(() => undefined);
  const rows = await db
    .select()
    .from(schema.appProblem)
    .where(eq(schema.appProblem.projectId, projectId))
    .orderBy(desc(schema.appProblem.lastSeen))
    .limit(300);
  const rank = { open: 0, fixing: 1, fixed: 2, ignored: 3 } as Record<string, number>;
  return rows.map(toApi).sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
}

export class ProblemError extends Error {}

async function getProblem(projectId: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.appProblem)
    .where(and(eq(schema.appProblem.projectId, projectId), eq(schema.appProblem.id, id)));
  if (!row) throw new ProblemError("That problem no longer exists.");
  return row;
}

export async function setProblemStatus(projectId: string, id: string, status: "open" | "ignored") {
  await getProblem(projectId, id);
  await db.update(schema.appProblem).set({ status, fixRunId: null }).where(eq(schema.appProblem.id, id));
  notify(projectId);
}

/** Forget fixed and ignored problems. */
export async function clearSettled(projectId: string) {
  await db
    .delete(schema.appProblem)
    .where(and(eq(schema.appProblem.projectId, projectId), inArray(schema.appProblem.status, ["fixed", "ignored"])));
  notify(projectId);
}

const SOURCE_TEXT = { browser: "an error in the browser", network: "a failed request", server: "a server error" } as const;

/** The request the agent gets for "Fix this" (one problem) or "Fix all" (several). */
function fixPrompt(rows: (typeof schema.appProblem.$inferSelect)[]): string {
  const one = (r: (typeof schema.appProblem.$inferSelect), i?: number) =>
    [
      `${i !== undefined ? `${i + 1}. ` : ""}${SOURCE_TEXT[r.source as keyof typeof SOURCE_TEXT] ?? r.source}${r.page ? ` on ${r.page}` : ""}, seen ${r.count} time${r.count === 1 ? "" : "s"}:`,
      r.message,
      r.detail && r.detail !== r.message ? `Details:\n${r.detail.slice(0, 2500)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  const intro =
    rows.length === 1
      ? "Fix this problem the running app produced (Forge recorded it from the app's logs):"
      : `Fix these ${rows.length} problems the running app produced (Forge recorded them from the app's logs):`;
  return [
    intro,
    rows.map((r, i) => one(r, rows.length === 1 ? undefined : i)).join("\n\n"),
    "Find the root cause in the code and fix it; don't just hide the error. If a problem comes from outside the app (a third-party service, a browser extension), say so instead of changing code.",
  ].join("\n\n");
}

/** "Fix this" / "Fix all": start a build run for open problems and mark them as being fixed. */
export async function fixProblems(projectId: string, ids: string[] | "all", user: { id: string; name: string }) {
  const rows = (
    await db
      .select()
      .from(schema.appProblem)
      .where(and(eq(schema.appProblem.projectId, projectId), eq(schema.appProblem.status, "open")))
      .orderBy(desc(schema.appProblem.count))
  ).filter((r) => ids === "all" || ids.includes(r.id));
  if (!rows.length) throw new ProblemError("There are no open problems to fix.");
  const picked = rows.slice(0, 10); // one request stays readable
  const runId = await startRun(projectId, fixPrompt(picked), user);
  await db
    .update(schema.appProblem)
    .set({ status: "fixing", fixRunId: runId })
    .where(inArray(schema.appProblem.id, picked.map((r) => r.id)));
  notify(projectId);
  return { runId, count: picked.length };
}

/** Called when a run ends: its problems are fixed if it saved a version, otherwise open again. */
export async function settleFixRun(projectId: string, runId: string, committed: boolean) {
  const fixing = await db
    .select({ id: schema.appProblem.id })
    .from(schema.appProblem)
    .where(and(eq(schema.appProblem.projectId, projectId), eq(schema.appProblem.fixRunId, runId)));
  if (!fixing.length) return;
  const sha = committed ? (await exec(projectId, ["git", "rev-parse", "HEAD"])).stdout.trim() || null : null;
  await db
    .update(schema.appProblem)
    .set(committed ? { status: "fixed", fixedSha: sha } : { status: "open", fixRunId: null })
    .where(and(eq(schema.appProblem.projectId, projectId), eq(schema.appProblem.fixRunId, runId)));
  notify(projectId);
}

/* ------------------------------ server log ------------------------------- */

/** How far into /tmp/dev.log we've read, per project (in memory: a restart starts at the end). */
const offsets = new Map<string, number>();
const scanning = new Set<string>();

// Next's dev server marks errors with ⨯; plain "Error:" lines and 5xx responses count too.
const START = /^\s*(?:⨯|Error:|TypeError:|ReferenceError:|SyntaxError:|RangeError:|Unhandled|uncaughtException)/;
const RESPONSE_5XX = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) (5\d\d) in /;

/** Turn new log text into problem reports. Exported for tests. */
export function parseServerLog(text: string): ProblemReport[] {
  const reports: ProblemReport[] = [];
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const resp = RESPONSE_5XX.exec(line);
    if (resp) {
      reports.push({ source: "server", message: `${resp[1]} ${resp[2]!.replace(/\?.*$/, "")} answered ${resp[3]}`, detail: line.trim(), page: resp[2] });
      continue;
    }
    if (!START.test(line)) continue;
    const block = [line];
    const message = line.replace(/^\s*⨯\s*/, "").trim();
    // A compile error names the file first ("⨯ ./src/app/page.tsx:3:1"); its reason is the next line.
    if (/^\.?\/\S+:\d+/.test(message) && i + 1 < lines.length) block.push(lines[++i]!);
    // The stack and details follow, indented by 2+ spaces (or in braces). Next's own status
    // lines ("GET / 200 in 5ms", "✓ Compiled") are indented by one space and end the block.
    while (
      i + 1 < lines.length &&
      block.length < 30 &&
      /^(\s{2,}\S|\s*[{}]|\s*$)/.test(lines[i + 1]!) &&
      !START.test(lines[i + 1]!) &&
      !RESPONSE_5XX.test(lines[i + 1]!)
    ) {
      if (lines[i + 1]!.trim()) block.push(lines[i + 1]!);
      i++;
    }
    const head = /^\.?\/\S+:\d+/.test(message) && block[1] ? `${message} ${block[1].trim()}` : message;
    reports.push({ source: "server", message: head, detail: block.join("\n") });
  }
  return reports;
}

export async function scanServerLog(projectId: string) {
  if (scanning.has(projectId)) return;
  scanning.add(projectId);
  try {
    const size = Number((await exec(projectId, ["sh", "-c", "stat -c %s /tmp/dev.log 2>/dev/null || echo 0"])).stdout.trim()) || 0;
    const from = offsets.get(projectId);
    // First look after a restart of Forge: start at the end. A smaller file: the server restarted.
    if (from === undefined || size < from) {
      offsets.set(projectId, from === undefined ? size : 0);
      if (from === undefined) return;
    }
    const start = offsets.get(projectId)!;
    if (size <= start) return;
    const r = await exec(projectId, ["sh", "-c", `tail -c +${start + 1} /tmp/dev.log | head -c 200000`]);
    offsets.set(projectId, start + Buffer.byteLength(r.stdout));
    const reports = parseServerLog(r.stdout);
    if (reports.length) await recordProblems(projectId, reports);
  } finally {
    scanning.delete(projectId);
  }
}

/** Every 15 s: read new server errors of every running project sandbox. */
export function startServerLogWatcher() {
  setInterval(async () => {
    const list = await docker.listContainers({ filters: { label: ["forge.project"], status: ["running"] } }).catch(() => []);
    for (const c of list) {
      const id = c.Labels["forge.project"];
      if (id) await scanServerLog(id).catch(() => undefined);
    }
  }, 15_000).unref();
}

export const _forTests = { fingerprint };
