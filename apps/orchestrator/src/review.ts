import type { A11yFinding, ReviewShot, VersionReview, VersionReviewSummary } from "@forge/protocol";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { extract } from "tar-stream";
import { db, schema } from "./db/index.ts";
import { appendEvent, publish } from "./events.ts";
import { containerName, docker, ensureDevServer, ensureSandbox, exec } from "./sandbox.ts";

/*
 * Version reviews: how each saved version looks, and how accessible it is.
 *
 * While the green-build smoke test has every page open, it also takes a screenshot at desktop
 * and phone width and runs an accessibility scan (sandbox/checks/checks.mjs). When the version
 * is saved, Forge copies those out of the sandbox into data/reviews/<project>/<sha>/, compares
 * each screenshot with the nearest earlier version that has one, and stores which pages look
 * different (with a picture of the differences). Nothing here blocks saving a version.
 *
 * Versions made without the checks (a restore, an idea brought into main, changes from GitHub)
 * get their review from reviewVersion(), which runs only the smoke test.
 */

export const REVIEWS_DIR = resolve(fileURLToPath(new URL("../../../data/reviews", import.meta.url)));
const SHA = /^[0-9a-f]{40}$/;
const SHOT = /^[a-z0-9-]{1,80}--(desktop|phone)\.png$/;
export const REVIEW_IMAGE = /^[a-z0-9-]{1,80}--(desktop|phone)(\.diff)?\.png$/;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_TOTAL = 80 * 1024 * 1024;
/** Reviews kept per project; older ones (pictures and rows) are removed. */
const KEEP = 40;
/** Fewer differing pixels than this is rendering noise, not a change. */
const MIN_DIFF_PIXELS = 30;

type RawReview = {
  at: string;
  pages: { route: string; slug: string; shots: Record<string, { file: string; width: number; height: number }> }[];
  a11y: Omit<A11yFinding, "id">[];
  a11yChecked: boolean;
  notes: string[];
};

const dirOf = (projectId: string, sha: string) => join(REVIEWS_DIR, projectId, sha);

/**
 * Copy the review the checks just wrote (screenshots + review.json) out of the sandbox.
 * Resolves false when there is nothing usable (an older sandbox image, or no page loaded).
 */
export async function collectReview(projectId: string, sha: string, from = "/tmp/forge-review"): Promise<boolean> {
  if (!SHA.test(sha)) return false;
  const present = await exec(projectId, ["test", "-f", `${from}/review.json`]);
  if (present.exitCode !== 0) return false;
  const archive = await docker.getContainer(containerName(projectId)).getArchive({ path: from });
  const files = new Map<string, Buffer>();
  let total = 0;
  await new Promise<void>((done, reject) => {
    const ex = extract();
    ex.on("entry", (header, stream, next) => {
      const name = header.name.split("/").pop() ?? "";
      const wanted = header.type === "file" && (name === "review.json" || SHOT.test(name)) && (header.size ?? 0) <= MAX_FILE;
      const chunks: Buffer[] = [];
      stream.on("data", (c: unknown) => {
        if (!wanted) return;
        const b = Buffer.from(c as Uint8Array);
        total += b.length;
        if (total <= MAX_TOTAL) chunks.push(b);
      });
      stream.on("end", () => {
        if (wanted && total <= MAX_TOTAL) files.set(name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    ex.on("finish", done);
    ex.on("error", reject);
    archive.pipe(ex);
  });
  if (!files.has("review.json")) return false;
  const dir = dirOf(projectId, sha);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, data] of files) await writeFile(join(dir, name), data);
  return true;
}

/** The nearest earlier version (first-parent history) that has a stored review. */
async function baseline(projectId: string, sha: string): Promise<string | null> {
  const r = await exec(projectId, ["git", "rev-list", "--first-parent", "-n", "80", `${sha}^`]);
  if (r.exitCode !== 0) return null;
  const ancestors = r.stdout.split("\n").filter((s) => SHA.test(s));
  if (!ancestors.length) return null;
  const rows = await db
    .select({ sha: schema.versionReview.sha })
    .from(schema.versionReview)
    .where(and(eq(schema.versionReview.projectId, projectId), inArray(schema.versionReview.sha, ancestors)));
  const have = new Set(rows.map((x) => x.sha));
  return ancestors.find((a) => have.has(a) && existsSync(dirOf(projectId, a))) ?? null;
}

async function readPng(file: string): Promise<PNG | null> {
  try {
    return PNG.sync.read(await readFile(file));
  } catch {
    return null;
  }
}

/** The image on a white canvas of the given size (pages of different heights are compared top-aligned). */
function onCanvas(img: PNG, width: number, height: number): Buffer {
  if (img.width === width && img.height === height) return img.data;
  const out = Buffer.alloc(width * height * 4, 255);
  const w = Math.min(width, img.width);
  for (let y = 0; y < Math.min(height, img.height); y++) {
    img.data.copy(out, y * width * 4, y * img.width * 4, y * img.width * 4 + w * 4);
  }
  return out;
}

/** Compare one screenshot with the earlier one; writes the picture of the differences when they differ. */
async function compareShot(nowFile: string, beforeFile: string, diffFile: string): Promise<{ changed: boolean; ratio: number }> {
  const [nowBuf, beforeBuf] = await Promise.all([readFile(nowFile), readFile(beforeFile)]);
  if (nowBuf.equals(beforeBuf)) return { changed: false, ratio: 0 };
  const now = PNG.sync.read(nowBuf);
  const before = PNG.sync.read(beforeBuf);
  const width = Math.max(now.width, before.width);
  const height = Math.max(now.height, before.height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(onCanvas(before, width, height), onCanvas(now, width, height), diff.data, width, height, {
    threshold: 0.1,
    alpha: 0.25,
    diffColor: [226, 44, 110],
  });
  if (pixels < MIN_DIFF_PIXELS) return { changed: false, ratio: 0 };
  await writeFile(diffFile, PNG.sync.write(diff));
  return { changed: true, ratio: pixels / (width * height) };
}

const toReview = (r: typeof schema.versionReview.$inferSelect): VersionReview => ({
  sha: r.sha,
  baseSha: r.baseSha,
  at: r.createdAt.toISOString(),
  shots: r.shots as ReviewShot[],
  a11y: r.a11y as A11yFinding[],
  a11yChecked: r.a11yChecked,
});

const serious = (list: A11yFinding[]) => list.filter((f) => f.impact === "critical" || f.impact === "serious").length;
const routesOf = (shots: ReviewShot[], status: ReviewShot["status"]) => [...new Set(shots.filter((s) => s.status === status).map((s) => s.route))];

/**
 * Turn the collected files of a version into its review: compare with the earlier version,
 * store the result, tell open builders, and (after a run) post a line in the chat when the
 * look changed or new serious accessibility problems appeared.
 */
export async function finishReview(projectId: string, sha: string, runId?: string): Promise<VersionReview | null> {
  const dir = dirOf(projectId, sha);
  let raw: RawReview;
  try {
    raw = JSON.parse(await readFile(join(dir, "review.json"), "utf8")) as RawReview;
  } catch {
    return null;
  }
  const baseSha = await baseline(projectId, sha);
  const [baseRow] = baseSha
    ? await db.select().from(schema.versionReview).where(and(eq(schema.versionReview.projectId, projectId), eq(schema.versionReview.sha, baseSha)))
    : [];
  const before = new Map(((baseRow?.shots as ReviewShot[] | undefined) ?? []).filter((s) => s.status !== "removed").map((s) => [`${s.slug}--${s.viewport}`, s]));

  const shots: ReviewShot[] = [];
  for (const page of raw.pages ?? []) {
    for (const viewport of ["desktop", "phone"] as const) {
      const shot = page.shots?.[viewport];
      if (!shot || !SHOT.test(shot.file) || !existsSync(join(dir, shot.file))) continue;
      const entry: ReviewShot = { route: page.route, slug: page.slug, viewport, file: shot.file, width: shot.width, height: shot.height, status: "new" };
      const earlier = before.get(`${page.slug}--${viewport}`);
      before.delete(`${page.slug}--${viewport}`);
      if (baseSha && earlier && existsSync(join(dirOf(projectId, baseSha), earlier.file))) {
        const diffFile = shot.file.replace(/\.png$/, ".diff.png");
        const r = await compareShot(join(dir, shot.file), join(dirOf(projectId, baseSha), earlier.file), join(dir, diffFile)).catch(() => null);
        if (r?.changed) Object.assign(entry, { status: "changed", ratio: r.ratio, diffFile });
        else if (r) entry.status = "same";
      } else if (!baseSha) {
        entry.status = "same"; // the first reviewed version: nothing to compare with
      }
      shots.push(entry);
    }
  }
  // Pages the earlier version had and this one doesn't (their picture stays with the earlier version).
  if (baseSha) for (const s of before.values()) shots.push({ ...s, status: "removed", ratio: undefined, diffFile: undefined });

  const a11y: A11yFinding[] = (raw.a11y ?? []).slice(0, 200).map((f, i) => ({ ...f, id: `a${i + 1}` }));
  const values = { projectId, sha, baseSha, shots, a11y, a11yChecked: Boolean(raw.a11yChecked) };
  const [row] = await db
    .insert(schema.versionReview)
    .values(values)
    .onConflictDoUpdate({ target: [schema.versionReview.projectId, schema.versionReview.sha], set: { ...values, createdAt: new Date() } })
    .returning();
  await prune(projectId).catch((e) => console.error("could not prune old reviews", e));
  publish(projectId, { type: "review_changed", projectId });

  if (runId) {
    const changed = routesOf(shots, "changed");
    const added = baseSha ? routesOf(shots, "new") : [];
    const removed = routesOf(shots, "removed");
    const parts: string[] = [];
    if (changed.length) parts.push(`looks different on ${changed.length === 1 ? `the page ${changed[0]}` : `${changed.length} pages (${changed.slice(0, 4).join(", ")}${changed.length > 4 ? "…" : ""})`}`);
    if (added.length) parts.push(`has ${added.length === 1 ? `a new page (${added[0]})` : `${added.length} new pages`}`);
    if (removed.length) parts.push(`no longer has ${removed.length === 1 ? `the page ${removed[0]}` : `${removed.length} pages`}`);
    const nowSerious = serious(a11y);
    const wasSerious = baseRow ? serious(baseRow.a11y as A11yFinding[]) : 0;
    const lines: string[] = [];
    if (parts.length) lines.push(`This version ${parts.join(", ")}. Open Versions › Look to see before and after.`);
    if (nowSerious > wasSerious) {
      lines.push(`Accessibility: ${nowSerious - wasSerious} new serious problem${nowSerious - wasSerious === 1 ? "" : "s"} (${nowSerious} in total). See Health › Accessibility.`);
    }
    if (lines.length) await appendEvent({ type: "notice", projectId, runId, text: lines.join(" ") }).catch(() => undefined);
  }
  return row ? toReview(row) : null;
}

async function prune(projectId: string) {
  const rows = await db
    .select({ sha: schema.versionReview.sha })
    .from(schema.versionReview)
    .where(eq(schema.versionReview.projectId, projectId))
    .orderBy(desc(schema.versionReview.createdAt));
  const keep = new Set(rows.slice(0, KEEP).map((r) => r.sha));
  const old = rows.slice(KEEP).map((r) => r.sha);
  if (old.length) await db.delete(schema.versionReview).where(and(eq(schema.versionReview.projectId, projectId), inArray(schema.versionReview.sha, old)));
  const dirs = await readdir(join(REVIEWS_DIR, projectId)).catch(() => [] as string[]);
  for (const d of dirs) if (!keep.has(d)) await rm(join(REVIEWS_DIR, projectId, d), { recursive: true, force: true });
}

/** After the checks passed and the version was saved: keep its review. Never throws. */
export async function reviewAfterCommit(projectId: string, sha: string, runId: string) {
  try {
    // Copy the files out now (the next check run overwrites them); compare in the background.
    if (await collectReview(projectId, sha)) void finishReview(projectId, sha, runId).catch((e) => console.error("review failed", e));
  } catch (e) {
    console.error("could not collect the version review", e);
  }
}

const reviewing = new Map<string, Promise<VersionReview | null>>();

/**
 * Review a version that was saved without the checks (restore, idea, changes from GitHub), or on
 * request: load every page in the sandbox's browser, then store the result. `sha` must be HEAD.
 */
export function reviewVersion(projectId: string, sha?: string): Promise<VersionReview | null> {
  const running = reviewing.get(projectId);
  if (running) return running;
  const p = (async () => {
    await ensureSandbox(projectId);
    await ensureDevServer(projectId);
    const head = (await exec(projectId, ["git", "rev-parse", "HEAD"])).stdout.trim();
    if (!SHA.test(head) || (sha && sha !== head)) return null;
    const dir = `/tmp/forge-review-${nanoid(8)}`;
    try {
      await exec(projectId, ["node", "/opt/forge/checks/checks.mjs"], { env: ["FORGE_ONLY=review", `FORGE_REVIEW_DIR=${dir}`] });
      // The files changed while the pages loaded (a run started): the pictures aren't of this version.
      const after = (await exec(projectId, ["git", "rev-parse", "HEAD"])).stdout.trim();
      if (after !== head || !(await collectReview(projectId, head, dir))) return null;
      return await finishReview(projectId, head);
    } finally {
      await exec(projectId, ["rm", "-rf", dir]).catch(() => undefined);
    }
  })().finally(() => reviewing.delete(projectId));
  reviewing.set(projectId, p);
  return p;
}

/* ---------------------------------- reading ---------------------------------- */

export async function listReviews(projectId: string): Promise<VersionReviewSummary[]> {
  const rows = await db
    .select()
    .from(schema.versionReview)
    .where(eq(schema.versionReview.projectId, projectId))
    .orderBy(desc(schema.versionReview.createdAt))
    .limit(KEEP);
  return rows.map((r) => {
    const shots = r.shots as ReviewShot[];
    return {
      sha: r.sha,
      baseSha: r.baseSha,
      changed: routesOf(shots, "changed"),
      added: r.baseSha ? routesOf(shots, "new") : [],
      removed: routesOf(shots, "removed"),
      a11y: (r.a11y as A11yFinding[]).length,
    };
  });
}

export async function getReview(projectId: string, sha: string): Promise<VersionReview | null> {
  if (!SHA.test(sha)) return null;
  const [row] = await db.select().from(schema.versionReview).where(and(eq(schema.versionReview.projectId, projectId), eq(schema.versionReview.sha, sha)));
  return row ? toReview(row) : null;
}

/** The newest review of the project (the Health tab's accessibility list). */
export async function latestReview(projectId: string): Promise<VersionReview | null> {
  const [row] = await db
    .select()
    .from(schema.versionReview)
    .where(eq(schema.versionReview.projectId, projectId))
    .orderBy(desc(schema.versionReview.createdAt))
    .limit(1);
  return row ? toReview(row) : null;
}

/** A stored screenshot or difference picture, or null. */
export async function reviewImage(projectId: string, sha: string, name: string): Promise<Buffer | null> {
  if (!SHA.test(sha) || !REVIEW_IMAGE.test(name)) return null;
  return readFile(join(dirOf(projectId, sha), name)).catch(() => null);
}

/** The request the agent gets for "Fix" on accessibility findings. */
export function a11yFixPrompt(findings: A11yFinding[]): string {
  return [
    findings.length === 1
      ? "Forge's accessibility check (axe, WCAG 2.1 A/AA) found this problem in the running app. Fix its cause in the code:"
      : `Forge's accessibility check (axe, WCAG 2.1 A/AA) found these ${findings.length} problems in the running app. Fix their causes in the code:`,
    ...findings.map((f, i) =>
      [
        `${findings.length > 1 ? `${i + 1}. ` : ""}[${f.impact}] ${f.help} (rule ${f.rule}) on the page ${f.route}, ${f.count} element${f.count === 1 ? "" : "s"}`,
        ...f.nodes.map((n) => `- ${n.target}\n  ${n.html}\n  ${n.summary}`),
        f.helpUrl ? `More: ${f.helpUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "Fix the shared component or style when the same problem repeats, rather than each place separately. Keep the design as it is apart from what the fix needs (for contrast, pick the nearest colour that passes). Then look at the pages you touched with look_at_page.",
  ].join("\n\n");
}
