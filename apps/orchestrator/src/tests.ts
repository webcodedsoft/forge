import type { SavedTest, TestInput, TestRunResult } from "@forge/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./db/index.ts";
import { appendEvent } from "./events.ts";
import { ensureDevServer, ensureSandbox, exec } from "./sandbox.ts";
import { specResultsChanged, unlinkTest } from "./spec.ts";

/*
 * Saved tests: steps replayed in a real browser (the sandbox's Chromium, via the checks'
 * playwright-core), each test in a fresh browser context, so earlier tests' cookies and
 * storage don't leak in. No AI is involved, so they're cheap enough to run after every version.
 *
 * Replays of one project never overlap; a second request waits for the first.
 */

/** Runs inside the project container; prints one TestRunResult per test as JSON. */
const REPLAY_SCRIPT = String.raw`
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/opt/forge/checks/");
const { chromium } = require("playwright-core");
const tests = JSON.parse(Buffer.from(process.env.FORGE_TESTS_B64, "base64").toString("utf8"));
const dir = readdirSync("/ms-playwright").find((d) => /^chromium-\d+$/.test(d));
const arch = readdirSync("/ms-playwright/" + dir).find((d) => d.startsWith("chrome-linux"));
const browser = await chromium.launch({ executablePath: "/ms-playwright/" + dir + "/" + arch + "/chrome", args: ["--no-sandbox"] });
const APP = "http://localhost:3000";
const STEP_MS = 6000;

const locate = (page, t) => {
  if (t.selector) return page.locator(t.selector).first();
  if (t.role) return page.getByRole(t.role, t.name ? { name: t.name } : {}).first();
  if (t.label) return page.getByLabel(t.label).first();
  return page.getByText(t.text).first();
};
const what = (t) =>
  t.role ? t.role + (t.name ? ' "' + t.name + '"' : "") : t.label ? 'the field "' + t.label + '"' : t.text ? '"' + t.text + '"' : t.selector;

async function step(page, s) {
  if (s.action === "open") {
    const res = await page.goto(APP + (s.path.startsWith("/") ? s.path : "/" + s.path), { waitUntil: "load", timeout: 90000 });
    if (res && res.status() >= 400) throw new Error("The page " + s.path + " answered " + res.status() + ".");
    await page.waitForTimeout(600);
  } else if (s.action === "click") {
    await locate(page, s.target).click({ timeout: STEP_MS }).catch(() => { throw new Error("Couldn't click " + what(s.target) + ": it isn't on the page."); });
    await page.waitForTimeout(400);
  } else if (s.action === "fill") {
    await locate(page, s.target).fill(s.value, { timeout: STEP_MS }).catch(() => { throw new Error("Couldn't type into " + what(s.target) + ": it isn't on the page."); });
  } else if (s.action === "press") {
    await page.keyboard.press(s.key);
    await page.waitForTimeout(400);
  } else if (s.action === "expect") {
    const loc = locate(page, s.target);
    if (s.state === "visible") {
      await loc.waitFor({ state: "visible", timeout: STEP_MS }).catch(() => { throw new Error("Expected " + what(s.target) + " to be shown, but it isn't."); });
    } else if (s.state === "hidden") {
      await loc.waitFor({ state: "hidden", timeout: STEP_MS }).catch(() => { throw new Error("Expected " + what(s.target) + " to be gone, but it's still shown."); });
    } else {
      let last = null;
      for (const until = Date.now() + STEP_MS; Date.now() < until; ) {
        last = await loc.innerText({ timeout: 1000 }).catch(() => null);
        if (last !== null && last.includes(s.value || "")) return;
        await page.waitForTimeout(200);
      }
      throw new Error(last === null
        ? "Expected " + what(s.target) + ' to contain "' + s.value + '", but it isn\'t on the page.'
        : "Expected " + what(s.target) + ' to contain "' + s.value + '", but it says "' + last.replace(/\s+/g, " ").trim().slice(0, 160) + '".');
    }
  }
}

const results = [];
try {
  for (const test of tests) {
    const started = Date.now();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    let failedStep;
    let error;
    for (let i = 0; i < test.steps.length; i++) {
      try {
        await step(page, test.steps[i]);
      } catch (e) {
        failedStep = i;
        error = String((e && e.message) || e).split("\n")[0].slice(0, 400);
        break;
      }
    }
    await ctx.close().catch(() => {});
    results.push({ ok: failedStep === undefined, failedStep, error, durationMs: Date.now() - started });
  }
} finally {
  await browser.close().catch(() => {});
}
process.stdout.write(JSON.stringify(results));
`;

const locks = new Map<string, Promise<unknown>>();

/** Replay tests against the app as it is now. */
export async function replayTests(projectId: string, tests: TestInput[]): Promise<TestRunResult[]> {
  if (!tests.length) return [];
  const prev = locks.get(projectId) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureSandbox(projectId);
      await ensureDevServer(projectId);
      const r = await exec(projectId, ["node", "--input-type=module", "-e", REPLAY_SCRIPT], {
        env: [`FORGE_TESTS_B64=${Buffer.from(JSON.stringify(tests.map((t) => ({ steps: t.steps })))).toString("base64")}`],
      });
      try {
        const parsed = JSON.parse(r.stdout.trim()) as TestRunResult[];
        if (Array.isArray(parsed) && parsed.length === tests.length) return parsed;
      } catch {
        /* fall through */
      }
      const why = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300) || "the test browser didn't start";
      return tests.map(() => ({ ok: false, failedStep: undefined, error: `Forge couldn't run the test: ${why}` }));
    });
  locks.set(projectId, run);
  try {
    return await run;
  } finally {
    if (locks.get(projectId) === run) locks.delete(projectId);
  }
}

const toApi = (r: typeof schema.savedTest.$inferSelect): SavedTest => ({
  id: r.id,
  title: r.title,
  steps: r.steps as TestInput["steps"],
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  lastResult: (r.lastResult as SavedTest["lastResult"]) ?? null,
});

export async function listTests(projectId: string): Promise<SavedTest[]> {
  const rows = await db.select().from(schema.savedTest).where(eq(schema.savedTest.projectId, projectId)).orderBy(asc(schema.savedTest.createdAt));
  return rows.map(toApi);
}

/** `result`: the outcome of a replay Forge just did (a proposed test), stored as its first result. */
export async function saveTest(projectId: string, input: TestInput, user: { name: string }, result?: TestRunResult): Promise<SavedTest> {
  const sha = result ? (await exec(projectId, ["git", "rev-parse", "HEAD"]).catch(() => null))?.stdout.trim() || null : null;
  const [row] = await db
    .insert(schema.savedTest)
    .values({
      id: nanoid(12),
      projectId,
      title: input.title,
      steps: input.steps,
      createdBy: user.name,
      ...(result ? { lastResult: { ...result, sha, at: new Date().toISOString() } } : {}),
    })
    .returning();
  return toApi(row!);
}

export async function deleteTest(projectId: string, id: string) {
  await db.delete(schema.savedTest).where(and(eq(schema.savedTest.projectId, projectId), eq(schema.savedTest.id, id)));
  await unlinkTest(projectId, id); // a spec criterion it proved is untested again
}

/**
 * Replay saved tests (all, or some), store each result, and post the outcome to the chat.
 * After a new version this runs automatically; a project without saved tests is a no-op.
 */
export async function runSavedTests(projectId: string, trigger: "version" | "manual" | "push", ids?: string[]) {
  const rows = await db
    .select()
    .from(schema.savedTest)
    .where(and(eq(schema.savedTest.projectId, projectId), ids ? inArray(schema.savedTest.id, ids) : undefined))
    .orderBy(asc(schema.savedTest.createdAt));
  if (!rows.length) return null;
  const sha = (await exec(projectId, ["git", "rev-parse", "HEAD"]).catch(() => null))?.stdout.trim() || null;
  const results = await replayTests(projectId, rows.map((r) => ({ title: r.title, steps: r.steps as TestInput["steps"] })));
  const at = new Date().toISOString();
  for (const [i, row] of rows.entries()) {
    await db.update(schema.savedTest).set({ lastResult: { ...results[i]!, sha, at } }).where(eq(schema.savedTest.id, row.id));
  }
  const summary = rows.map((r, i) => ({ testId: r.id, title: r.title, ...results[i]! }));
  await appendEvent({ type: "tests.result", projectId, runId: `tests-${nanoid(8)}`, trigger, sha, results: summary });
  specResultsChanged(projectId); // criteria show their test's new result
  return summary;
}
