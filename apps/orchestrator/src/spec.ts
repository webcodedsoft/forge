import type { ProjectSpec, SpecCriterion, SpecUpdate } from "@forge/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db, schema } from "./db/index.ts";
import { publish } from "./events.ts";

/*
 * The living spec: what the app does, as a short summary and a list of acceptance criteria
 * (things a user can do or see, each one checkable in the browser).
 *
 *   written by   the build agent (its update_spec tool, after work that changes behaviour) and
 *                the team (the Spec tab)
 *   proven by    saved tests: a criterion can be linked to one, and then shows passing/failing
 *   used by      the build agent (it must keep the criteria true) and the QA agent (it tests
 *                against them and proposes a test per criterion)
 *   shipped as   docs/SPEC.md in projects made in Forge, written with every saved version
 *
 * The agent's updates are staged while it works and applied when its version is saved, so a
 * discarded attempt never changes the spec.
 */

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);
const MAX_CRITERIA = 150;
export const SPEC_FILE = "docs/SPEC.md";

const changed = (projectId: string) => publish(projectId, { type: "spec_changed", projectId });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function getSpec(projectId: string): Promise<ProjectSpec> {
  const [[head], rows, tests] = await Promise.all([
    db.select().from(schema.projectSpec).where(eq(schema.projectSpec.projectId, projectId)),
    db.select().from(schema.specCriterion).where(eq(schema.specCriterion.projectId, projectId)).orderBy(asc(schema.specCriterion.createdAt)),
    db.select().from(schema.savedTest).where(eq(schema.savedTest.projectId, projectId)),
  ]);
  const byId = new Map(tests.map((t) => [t.id, t]));
  const criteria: SpecCriterion[] = rows.map((r) => {
    const test = r.testId ? byId.get(r.testId) : undefined;
    const last = test?.lastResult as { ok: boolean; error?: string } | null | undefined;
    return {
      id: r.id,
      area: r.area,
      text: r.text,
      testId: test ? test.id : null,
      testTitle: test?.title ?? null,
      status: !test ? "untested" : !last ? "not_run" : last.ok ? "passing" : "failing",
      error: last && !last.ok ? (last.error ?? null) : null,
      createdBy: r.createdBy,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
  // Areas in the order their first criterion was written.
  const order = [...new Set(criteria.map((c) => c.area))];
  criteria.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area));
  return {
    summary: head?.summary ?? "",
    updatedAt: head?.updatedAt.toISOString() ?? null,
    updatedBy: head?.updatedBy ?? null,
    criteria,
    tested: criteria.filter((c) => c.status !== "untested").length,
    passing: criteria.filter((c) => c.status === "passing").length,
    failing: criteria.filter((c) => c.status === "failing").length,
  };
}

async function touch(projectId: string, by: string, summary?: string) {
  await db
    .insert(schema.projectSpec)
    .values({ projectId, summary: summary ?? "", updatedBy: by })
    .onConflictDoUpdate({ target: schema.projectSpec.projectId, set: { ...(summary !== undefined ? { summary } : {}), updatedBy: by, updatedAt: new Date() } });
}

/** Apply additions, changes and removals. Returns how many of each took effect. */
export async function applySpecUpdate(projectId: string, update: SpecUpdate, by: string) {
  const existing = await db.select().from(schema.specCriterion).where(eq(schema.specCriterion.projectId, projectId));
  const ids = new Set(existing.map((r) => r.id));
  const texts = new Set(existing.map((r) => norm(r.text)));
  let added = 0;
  let edited = 0;
  let removed = 0;

  const gone = (update.remove ?? []).filter((id) => ids.has(id));
  if (gone.length) {
    await db.delete(schema.specCriterion).where(and(eq(schema.specCriterion.projectId, projectId), inArray(schema.specCriterion.id, gone)));
    removed = gone.length;
  }
  for (const c of update.change ?? []) {
    if (!ids.has(c.id) || gone.includes(c.id) || (c.text === undefined && c.area === undefined)) continue;
    await db
      .update(schema.specCriterion)
      .set({ ...(c.text !== undefined ? { text: c.text } : {}), ...(c.area !== undefined ? { area: c.area } : {}) })
      .where(and(eq(schema.specCriterion.projectId, projectId), eq(schema.specCriterion.id, c.id)));
    edited++;
  }
  let room = MAX_CRITERIA - (existing.length - removed);
  // Rows of one update share a timestamp otherwise; spread them so they keep the order given.
  const base = Date.now();
  for (const c of update.add ?? []) {
    if (room <= 0) break;
    if (texts.has(norm(c.text))) continue; // already there
    texts.add(norm(c.text));
    await db.insert(schema.specCriterion).values({ id: `c${newId()}`, projectId, area: c.area, text: c.text, createdBy: by, createdAt: new Date(base + added) });
    added++;
    room--;
  }
  const summaryChanged = update.summary !== undefined;
  if (added || edited || removed || summaryChanged) {
    await touch(projectId, by, update.summary);
    changed(projectId);
  }
  return { added, edited, removed, summaryChanged };
}

/** Link a criterion to the saved test that proves it (or unlink with null). */
export async function linkTest(projectId: string, criterionId: string, testId: string | null): Promise<boolean> {
  const r = await db
    .update(schema.specCriterion)
    .set({ testId })
    .where(and(eq(schema.specCriterion.projectId, projectId), eq(schema.specCriterion.id, criterionId)))
    .returning({ id: schema.specCriterion.id });
  if (r.length) changed(projectId);
  return r.length > 0;
}

/** A saved test was deleted: criteria it proved are untested again. */
export async function unlinkTest(projectId: string, testId: string) {
  const r = await db
    .update(schema.specCriterion)
    .set({ testId: null })
    .where(and(eq(schema.specCriterion.projectId, projectId), eq(schema.specCriterion.testId, testId)))
    .returning({ id: schema.specCriterion.id });
  if (r.length) changed(projectId);
}

/** Test results changed: builders with the Spec tab open refetch. */
export const specResultsChanged = changed;

/* ------------------------------ staged updates ------------------------------ */

const staged = new Map<string, SpecUpdate[]>();

export function stageSpecUpdate(projectId: string, update: SpecUpdate) {
  staged.set(projectId, [...(staged.get(projectId) ?? []), update].slice(-20));
}
export const hasStagedSpec = (projectId: string) => (staged.get(projectId)?.length ?? 0) > 0;
export const dropStagedSpec = (projectId: string) => void staged.delete(projectId);

/** Apply what the agent recorded while it worked (in order). Resolves true when the spec changed. */
export async function applyStagedSpec(projectId: string, by: string): Promise<boolean> {
  const list = staged.get(projectId);
  staged.delete(projectId);
  if (!list?.length) return false;
  let any = false;
  for (const u of list) {
    const r = await applySpecUpdate(projectId, u, by);
    any ||= Boolean(r.added || r.edited || r.removed || r.summaryChanged);
  }
  return any;
}

/* --------------------------------- prompts --------------------------------- */

const listed = (criteria: SpecCriterion[], withStatus = false) =>
  criteria
    .map((c) => `- [${c.id}] (${c.area}) ${c.text}${withStatus ? (c.status === "untested" ? "  — no test yet" : c.status === "failing" ? "  — its test fails" : "") : ""}`)
    .join("\n");

/** The build agent's system-prompt section: the spec as it stands and how to keep it current. */
export async function specPrompt(projectId: string): Promise<string> {
  const spec = await getSpec(projectId);
  return [
    "## Living spec",
    "This project keeps a living spec: a short summary of what the app does and its acceptance criteria (things a user can do or see, each checkable in the browser). It is the team's record of what the app must keep doing; the QA agent tests against it and the team reads it.",
    spec.summary ? `Summary:\n${spec.summary}` : "There is no summary yet.",
    spec.criteria.length ? `Acceptance criteria (id, area, statement):\n${listed(spec.criteria)}` : "There are no acceptance criteria yet.",
    [
      "Rules:",
      "- Keep every criterion true. If a request conflicts with one, do what the user asked and change that criterion; never break one silently.",
      "- When your work adds, changes or removes behaviour a user can observe, call mcp__forge__update_spec once, after the work is done: add criteria for new behaviour, change (by id) the ones whose behaviour changed, remove the ones whose feature is gone, and update the summary when the app's purpose or main features changed.",
      "- Don't call it for styling, copy tweaks, refactors, or fixes that restore behaviour the spec already describes.",
      '- A criterion is one plain, observable statement from the user\'s side ("A visitor can vote once per day per restaurant", "The Leading badge moves to the restaurant with most votes"). No implementation details, no vague ones ("works well"). Typically 3 to 8 per feature, grouped by area (a short feature name such as "Voting" or "Sign-in").',
      spec.criteria.length === 0 && !spec.summary
        ? "- The spec is empty: with your first update_spec, also cover what the app already does (read the pages first), not only this request."
        : "",
      "- Updates take effect when this version is saved.",
    ]
      .filter(Boolean)
      .join("\n"),
  ].join("\n\n");
}

/** Appended to each build request (agents skip a system-prompt rule alone). */
export const SPEC_REMINDER =
  "\n\n(Forge: if this changes what a user can do or see, finish with mcp__forge__update_spec so the living spec matches the app.)";

/** For the QA agent: the criteria to test against, and how to tie tests to them. */
export async function specQaPrompt(projectId: string): Promise<string> {
  const spec = await getSpec(projectId);
  if (!spec.criteria.length) return "";
  return [
    `The project's living spec lists these acceptance criteria (id, area, statement). Check that each holds:\n${listed(spec.criteria, true)}`,
    "When you report a problem that breaks a criterion, start the title with its id in brackets, e.g. \"[c1a2b3] Voting twice counts once\". When you propose a test that proves a criterion, pass its id as criterionId; prefer criteria that have no test yet.",
  ].join("\n");
}

/** The QA request for "write tests for these criteria". */
export function coverPrompt(criteria: SpecCriterion[]): string {
  return [
    `Write repeatable tests for these acceptance criteria from the project's living spec (id, area, statement):\n${listed(criteria)}`,
    "For each one: walk through it in the browser. If it holds, call propose_test once with the steps you used, expect steps that check the outcome, and criterionId set to the criterion's id (one test per criterion; title it after what it proves). If it doesn't hold, report it with report_issue, starting the title with the id in brackets. Don't test anything else.",
  ].join("\n\n");
}

/** docs/SPEC.md: the spec as a document for the repository. */
export function specMarkdown(spec: ProjectSpec, projectName: string): string {
  const areas = [...new Set(spec.criteria.map((c) => c.area))];
  return [
    `# ${projectName}: spec`,
    "",
    "_What this app does and what it must keep doing. Kept current by Forge with every saved version; edit it in Forge (Spec tab), not here._",
    "",
    spec.summary.trim() || "_No summary yet._",
    "",
    "## Acceptance criteria",
    "",
    ...(areas.length
      ? areas.flatMap((a) => [`### ${a}`, "", ...spec.criteria.filter((c) => c.area === a).map((c) => `- ${c.text}${c.testId ? " _(covered by a saved test)_" : ""}`), ""])
      : ["_None yet._", ""]),
  ].join("\n");
}
