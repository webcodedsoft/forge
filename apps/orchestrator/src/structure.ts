import { createHash } from "node:crypto";
import { exec } from "./sandbox.ts";

/*
 * Code structure review: after the agent's turn, before Forge's checks, look at the files this run
 * changed for signs the code needs reusable components or better separation:
 *   - long files (a page or component doing too much),
 *   - the same block of code repeated in several places (a component or helper waiting to be extracted),
 *   - client pages that fetch data inline (data access belongs in src/lib or a hook).
 * Findings go back to the agent for one tidy-up round (runs.ts). Generated and vendored files are skipped.
 */

const LONG_FILE = 300;
/** Pages and layouts should mostly compose components, so they're "long" sooner. */
const LONG_PAGE = 150;
/** More components than this defined in one file: some belong in their own files. */
const MANY_COMPONENTS = 3;
const WINDOW = 8; // lines in a repeated block
const MAX_FILES = 60;
const CODE = /\.(tsx|ts|jsx|js)$/;
const SKIP = /(^|\/)(node_modules|\.next|dist|build|coverage|\.forge|public)\/|\.d\.ts$|(^|\/)src\/lib\/forge-api\/|\.config\.(t|j)s$|(^|\/)(next-env|middleware)\.ts$|\.(test|spec)\.(t|j)sx?$/;

export type StructureIssue = { kind: "long-file" | "duplicate" | "inline-data"; text: string };

/** Lines that say nothing about structure (imports, braces, blank) don't count toward repeats. */
const meaningful = (line: string) => {
  const t = line.trim();
  return t.length > 3 && !/^(import |export \{|\}|\)|\]|<\/|\/\/|\*|\/\*)/.test(t) && !/^[{}()[\];,<>/]+$/.test(t);
};

/** `all`: review every tracked file instead of only this run's changes (for trying it out). */
export async function structureIssues(projectId: string, opts: { all?: boolean } = {}): Promise<StructureIssue[]> {
  // Files this run changed: modified or new compared with the last saved version.
  const st = opts.all
    ? await exec(projectId, ["git", "ls-files"])
    : await exec(projectId, ["git", "status", "--porcelain", "--untracked-files=all"]);
  if (st.exitCode !== 0) return [];
  const files = st.stdout
    .split("\n")
    .map((l) => (opts.all ? `?? ${l}` : l))
    .filter((l) => l.length > 3 && !l.startsWith(" D") && !l.startsWith("D "))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .map((f) => (f.includes(" -> ") ? f.split(" -> ")[1]! : f))
    .filter((f) => CODE.test(f) && !SKIP.test(f))
    .slice(0, MAX_FILES);
  if (!files.length) return [];

  const contents = new Map<string, string>();
  for (const f of files) {
    const r = await exec(projectId, ["sh", "-c", 'head -c 200000 -- "$1"', "sh", f]);
    if (r.exitCode === 0) contents.set(f, r.stdout);
  }

  const issues: StructureIssue[] = [];

  for (const [f, text] of contents) {
    const lines = text.split("\n").length;
    const isRoute = /(^|\/)src\/app\/(.*\/)?(page|layout)\.(t|j)sx?$/.test(f);
    // Components defined in this file: capitalised functions or arrow functions.
    const components = [...text.matchAll(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Z]\w*)\s*\(|^(?:export\s+)?const\s+([A-Z]\w*)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/gm)].map((m) => m[1] ?? m[2]);
    if (isRoute && lines > LONG_PAGE) {
      issues.push({
        kind: "long-file",
        text: `${f} is ${lines} lines: a page should compose components. Move its sections (e.g. sidebar, header, lists, cards) into components in src/components and its data/logic into src/lib.`,
      });
    } else if (lines > LONG_FILE) {
      issues.push({ kind: "long-file", text: `${f} is ${lines} lines: split it into focused components (and move logic into src/lib or a hook).` });
    }
    if (components.length > MANY_COMPONENTS) {
      issues.push({
        kind: "long-file",
        text: `${f} defines ${components.length} components (${components.slice(0, 6).join(", ")}${components.length > 6 ? ", …" : ""}): give the reusable ones their own files in src/components.`,
      });
    }
    // A client page that loads data itself.
    if (/(^|\/)src\/app\/.*\/?page\.(t|j)sx?$/.test(f) && /^\s*["']use client["']/.test(text) && /\bfetch\(|useEffect\([\s\S]{0,400}\b(fetch|Api\.|ServerApi)/.test(text)) {
      issues.push({
        kind: "inline-data",
        text: `${f} is a client page that loads data itself: move data access into src/lib (or a hook in src/hooks) and keep the page for layout and composition.`,
      });
    }
  }

  // Repeated blocks: the same WINDOW meaningful lines in two places (different files, or far apart).
  const seen = new Map<string, { file: string; line: number }>();
  const reported = new Set<string>();
  for (const [f, text] of contents) {
    const rows = text
      .split("\n")
      .map((l, i) => ({ l: l.trim().replace(/\s+/g, " "), i: i + 1 }))
      .filter((r) => meaningful(r.l));
    for (let k = 0; k + WINDOW <= rows.length; k++) {
      const block = rows.slice(k, k + WINDOW);
      const h = createHash("sha1").update(block.map((r) => r.l).join("\n")).digest("hex");
      const prev = seen.get(h);
      if (!prev) {
        seen.set(h, { file: f, line: block[0]!.i });
        continue;
      }
      if (prev.file === f && Math.abs(prev.line - block[0]!.i) < WINDOW * 2) continue;
      const key = [prev.file, f].sort().join("|");
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        kind: "duplicate",
        text:
          prev.file === f
            ? `${f} repeats the same block (lines ~${prev.line} and ~${block[0]!.i}): extract it into a component or helper and reuse it.`
            : `${prev.file} (~line ${prev.line}) and ${f} (~line ${block[0]!.i}) contain the same block: extract it into a shared component (src/components) or helper (src/lib).`,
      });
    }
  }
  return issues.slice(0, 12);
}

export function structurePrompt(issues: StructureIssue[]): string {
  return [
    "Forge reviewed the code you changed and found structure to tidy before it runs its checks:",
    ...issues.map((i) => `- ${i.text}`),
    "",
    "Refactor these now, keeping behaviour and look exactly the same: extract reusable components into src/components (or the " +
      "project's existing components folder), move data access and business logic into src/lib or hooks, and keep pages for " +
      "layout and composition. Use the project's existing folders and naming. Don't change anything else. Run pnpm typecheck " +
      "and pnpm lint afterwards. If a finding is a false alarm (e.g. the repeat is intentional), leave it and say why in one line.",
  ].join("\n");
}
