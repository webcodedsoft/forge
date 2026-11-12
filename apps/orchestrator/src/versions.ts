import type { Version } from "@forge/protocol";
import { nanoid } from "nanoid";
import { appendEvent } from "./events.ts";
import { activeRunId, RunConflictError } from "./runs.ts";
import { ensureComparePort, ensureSandbox, exec, previewUrl } from "./sandbox.ts";
import { secretEnv } from "./secrets.ts";

/*
 * Versions are the commits in the project's repo. Restoring never rewrites
 * history: it adds a new commit whose files match the chosen version.
 */

const SHA = /^[0-9a-f]{7,40}$/;
const SEP = "\x1f";

export class VersionError extends Error {}

export async function listVersions(projectId: string, limit = 100): Promise<Version[]> {
  await ensureSandbox(projectId);
  const r = await exec(projectId, [
    "git",
    "log",
    `-n${limit}`,
    `--pretty=format:%H${SEP}%s${SEP}%aI${SEP}%an`,
  ]);
  if (r.exitCode !== 0) throw new Error(r.stderr || "git log failed");
  const lines = r.stdout.split("\n").filter(Boolean);
  return lines.map((line, i) => {
    const [sha = "", message = "", at = "", author = ""] = line.split(SEP);
    return { sha, message, at, author, current: i === 0 };
  });
}

export async function restoreVersion(projectId: string, sha: string, user: { name: string }) {
  if (!SHA.test(sha)) throw new VersionError("Invalid version id.");
  if (activeRunId(projectId)) throw new RunConflictError("Wait for the agent to finish before restoring a version.");
  await ensureSandbox(projectId);

  const full = await exec(projectId, ["git", "rev-parse", "--verify", `${sha}^{commit}`]);
  if (full.exitCode !== 0) throw new VersionError("That version does not exist in this project.");
  const target = full.stdout.trim();
  const short = target.slice(0, 7);
  const message = `Restore version ${short}`;

  // read-tree -u --reset makes the index and the tracked files match the target
  // (files added later are removed); ignored files such as node_modules stay.
  const r = await exec(projectId, [
    "sh",
    "-c",
    'git read-tree -u --reset "$1" && git add -A && if git diff --cached --quiet; then echo NOCHANGE; else git commit -q -m "$2" && git rev-parse HEAD; fi',
    "sh",
    target,
    message,
  ]);
  if (r.exitCode !== 0) throw new Error(`Restore failed: ${r.stderr || r.stdout}`);
  const out = r.stdout.trim();
  if (out === "NOCHANGE") return { sha: target, changed: false };
  const newSha = out.split("\n").pop()!;

  // Reinstall dependencies if the restore changed them.
  await exec(projectId, [
    "sh",
    "-c",
    "git diff --quiet HEAD~1 HEAD -- package.json pnpm-lock.yaml || pnpm install --prefer-offline >/tmp/restore-install.log 2>&1",
  ]);

  await appendEvent({
    type: "commit",
    projectId,
    runId: `restore-${nanoid(8)}`,
    sha: newSha,
    message,
    restoredFrom: target,
    userName: user.name,
  });
  return { sha: newSha, changed: true };
}

/* ------------------------------- comparing ------------------------------- */

export type DiffFile = { path: string; status: "added" | "modified" | "deleted"; added: number | null; deleted: number | null };

/** Resolves a version id (or "<sha>^" for its parent) to a full sha, or throws. */
async function resolve(projectId: string, ref: string): Promise<string> {
  const parent = ref.endsWith("^");
  const base = parent ? ref.slice(0, -1) : ref;
  if (!SHA.test(base)) throw new VersionError("Invalid version id.");
  const r = await exec(projectId, ["git", "rev-parse", "--verify", "--quiet", `${base}${parent ? "^" : ""}^{commit}`]);
  if (r.exitCode !== 0) throw new VersionError(parent ? "That version has no earlier version to compare with." : "That version does not exist in this project.");
  return r.stdout.trim();
}

/** Files that differ between two versions, with added/deleted line counts (null for binary files). */
export async function compareVersions(projectId: string, fromRef: string, toRef: string) {
  await ensureSandbox(projectId);
  const [from, to] = await Promise.all([resolve(projectId, fromRef), resolve(projectId, toRef)]);
  const [status, numstat] = await Promise.all([
    exec(projectId, ["git", "diff", "--no-renames", "--name-status", "-z", from, to]),
    exec(projectId, ["git", "diff", "--no-renames", "--numstat", "-z", from, to]),
  ]);
  if (status.exitCode !== 0) throw new Error(status.stderr || "git diff failed");
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const rec of numstat.stdout.split("\0").filter(Boolean)) {
    const [a, d, ...rest] = rec.split("\t");
    counts.set(rest.join("\t"), { added: a === "-" ? null : Number(a), deleted: d === "-" ? null : Number(d) });
  }
  const parts = status.stdout.split("\0").filter(Boolean);
  const files: DiffFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!;
    const path = parts[i + 1]!;
    const c = counts.get(path) ?? { added: null, deleted: null };
    files.push({ path, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", ...c });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { from, to, files };
}

const MAX_DIFF = 400_000;
const SAFE_PATH = (p: string) => p.length > 0 && p.length < 500 && !p.startsWith("/") && !p.split("/").includes("..") && !/[\0\n]/.test(p);

/** The unified diff of one file between two versions (cut off when very large). */
export async function fileDiff(projectId: string, fromRef: string, toRef: string, path: string) {
  if (!SAFE_PATH(path)) throw new VersionError("Invalid file path.");
  await ensureSandbox(projectId);
  const [from, to] = await Promise.all([resolve(projectId, fromRef), resolve(projectId, toRef)]);
  const r = await exec(projectId, ["git", "diff", "--no-renames", "--no-color", "-U4", from, to, "--", path]);
  if (r.exitCode !== 0) throw new Error(r.stderr || "git diff failed");
  const truncated = r.stdout.length > MAX_DIFF;
  return { diff: truncated ? r.stdout.slice(0, MAX_DIFF) : r.stdout, truncated };
}

/* -------------------------------- branches ------------------------------- */
/*
 * "Try an idea from here": a branch starting at an older version. The workspace switches to it,
 * the agent keeps working there, and the main line is untouched. "Use this idea" brings the
 * branch's files onto the main line as one new version (like a restore: history is kept).
 */

const BRANCH = /^[a-z0-9][a-z0-9-]{0,39}$/;
export type Branch = { name: string; sha: string; at: string; current: boolean; main: boolean };

async function mainBranch(projectId: string): Promise<string> {
  const set = await exec(projectId, ["git", "config", "--get", "forge.mainBranch"]);
  if (set.exitCode === 0 && set.stdout.trim()) return set.stdout.trim();
  const cur = await exec(projectId, ["git", "symbolic-ref", "--short", "HEAD"]);
  const name = cur.stdout.trim() || "main";
  await exec(projectId, ["git", "config", "forge.mainBranch", name]);
  return name;
}

export async function listBranches(projectId: string): Promise<{ current: string; main: string; branches: Branch[] }> {
  await ensureSandbox(projectId);
  const main = await mainBranch(projectId);
  const cur = (await exec(projectId, ["git", "symbolic-ref", "--short", "HEAD"])).stdout.trim();
  const r = await exec(projectId, ["git", "branch", `--format=%(refname:short)${SEP}%(objectname)${SEP}%(committerdate:iso-strict)`]);
  const branches = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", sha = "", at = ""] = line.split(SEP);
      return { name, sha, at, current: name === cur, main: name === main };
    })
    // Main first, then ideas newest first.
    .sort((a, b) => Number(b.main) - Number(a.main) || b.at.localeCompare(a.at));
  return { current: cur, main, branches };
}

async function assertQuiet(projectId: string, what: string) {
  if (activeRunId(projectId)) throw new RunConflictError(`Wait for the agent to finish before ${what}.`);
  const st = await exec(projectId, ["git", "status", "--porcelain"]);
  if (st.stdout.trim()) throw new VersionError(`There are unsaved changes. Save or discard them before ${what}.`);
}

/** Switch the workspace to a branch (reinstalling dependencies if they differ). */
async function checkout(projectId: string, args: string[]) {
  const before = (await exec(projectId, ["git", "rev-parse", "HEAD"])).stdout.trim();
  const r = await exec(projectId, ["git", "switch", "-q", ...args]);
  if (r.exitCode !== 0) throw new VersionError(`Could not switch: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  await exec(projectId, [
    "sh",
    "-c",
    'git diff --quiet "$1" HEAD -- package.json pnpm-lock.yaml || pnpm install --prefer-offline >/tmp/branch-install.log 2>&1',
    "sh",
    before,
  ]);
}

export async function createBranch(projectId: string, name: string, fromSha: string, user: { name: string }) {
  if (!BRANCH.test(name)) throw new VersionError("Use 1–40 lowercase letters, numbers or dashes for the idea's name.");
  await ensureSandbox(projectId);
  await assertQuiet(projectId, "trying an idea");
  const main = await mainBranch(projectId);
  if (name === main) throw new VersionError("That name is taken by the main line.");
  const sha = await resolve(projectId, fromSha);
  const exists = await exec(projectId, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  if (exists.exitCode === 0) throw new VersionError(`An idea called "${name}" already exists.`);
  await checkout(projectId, ["-c", name, sha]);
  await appendEvent({ type: "branch", projectId, runId: `branch-${nanoid(8)}`, action: "created", branch: name, sha, userName: user.name });
}

export async function switchBranch(projectId: string, name: string, user: { name: string }) {
  if (!BRANCH.test(name)) throw new VersionError("Invalid branch name.");
  await ensureSandbox(projectId);
  await assertQuiet(projectId, "switching");
  const cur = (await exec(projectId, ["git", "symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (cur === name) return;
  await checkout(projectId, [name]);
  const sha = (await exec(projectId, ["git", "rev-parse", "HEAD"])).stdout.trim();
  await appendEvent({ type: "branch", projectId, runId: `branch-${nanoid(8)}`, action: "switched", branch: name, sha, userName: user.name });
}

export async function deleteBranch(projectId: string, name: string, user: { name: string }) {
  if (!BRANCH.test(name)) throw new VersionError("Invalid branch name.");
  await ensureSandbox(projectId);
  const { current, main } = await listBranches(projectId);
  if (name === main) throw new VersionError("The main line can't be deleted.");
  if (name === current) throw new VersionError("Switch to another line before deleting this one.");
  const r = await exec(projectId, ["git", "branch", "-q", "-D", name]);
  if (r.exitCode !== 0) throw new VersionError(`Could not delete: ${r.stderr.trim().slice(0, 300)}`);
  await appendEvent({ type: "branch", projectId, runId: `branch-${nanoid(8)}`, action: "deleted", branch: name, userName: user.name });
}

/** Make the main line's files match an idea's latest version, as one new version on main, and switch to main. */
export async function useBranch(projectId: string, name: string, user: { name: string }) {
  if (!BRANCH.test(name)) throw new VersionError("Invalid branch name.");
  await ensureSandbox(projectId);
  await assertQuiet(projectId, "using this idea");
  const main = await mainBranch(projectId);
  if (name === main) throw new VersionError("This is already the main line.");
  const tip = await exec(projectId, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
  if (tip.exitCode !== 0) throw new VersionError(`There is no idea called "${name}".`);
  await checkout(projectId, [main]);
  const message = `Use idea "${name}"`;
  const r = await exec(projectId, [
    "sh",
    "-c",
    'git read-tree -u --reset "$1" && git add -A && if git diff --cached --quiet; then echo NOCHANGE; else git commit -q -m "$2" && git rev-parse HEAD; fi',
    "sh",
    tip.stdout.trim(),
    message,
  ]);
  if (r.exitCode !== 0) throw new Error(`Could not bring the idea in: ${r.stderr || r.stdout}`);
  await exec(projectId, [
    "sh",
    "-c",
    "git diff --quiet HEAD~1 HEAD -- package.json pnpm-lock.yaml 2>/dev/null || pnpm install --prefer-offline >/tmp/branch-install.log 2>&1",
  ]);
  const out = r.stdout.trim();
  if (out !== "NOCHANGE") {
    await appendEvent({ type: "commit", projectId, runId: `idea-${nanoid(8)}`, sha: out.split("\n").pop()!, message, userName: user.name });
  }
  await appendEvent({ type: "branch", projectId, runId: `branch-${nanoid(8)}`, action: "used", branch: name, userName: user.name });
}

/* ---------------------------- compare preview ---------------------------- */
/*
 * An older version runs next to the current one: a detached git worktree in /tmp with the
 * workspace's node_modules linked in, served by a second dev server on :3001. Webpack, because
 * Turbopack won't resolve a node_modules symlinked from outside the app's folder.
 * Only one compare preview per project at a time; it stops after 20 idle minutes.
 */
const compareTimers = new Map<string, ReturnType<typeof setTimeout>>();

export async function startComparePreview(projectId: string, ref: string) {
  if (activeRunId(projectId)) throw new RunConflictError("Wait for the agent to finish before opening an older version.");
  await ensureComparePort(projectId);
  const sha = await resolve(projectId, ref);
  const secrets = await secretEnv(projectId);
  const r = await exec(
    projectId,
    [
      "sh",
      "-c",
      [
        // Stop an earlier compare server first (and give its port a moment to free up).
        '{ P=$(cat /tmp/compare.pid 2>/dev/null); if [ -n "$P" ]; then kill -TERM -- -"$P" 2>/dev/null; sleep 1; fi; true; }',
        "rm -rf /tmp/forge-compare; git worktree prune",
        'git worktree add -q --detach /tmp/forge-compare "$1"',
        "ln -s /workspace/node_modules /tmp/forge-compare/node_modules",
        "cd /tmp/forge-compare",
        'nohup setsid node node_modules/next/dist/bin/next dev --webpack -H 0.0.0.0 -p 3001 > /tmp/compare.log 2>&1 & echo $! > /tmp/compare.pid',
      ].join(" && "),
      "sh",
      sha,
    ],
    { env: secrets },
  );
  if (r.exitCode !== 0) throw new Error(`Could not start the older version: ${(r.stderr || r.stdout).slice(0, 300)}`);
  clearTimeout(compareTimers.get(projectId));
  compareTimers.set(
    projectId,
    setTimeout(() => void stopComparePreview(projectId).catch(() => undefined), 20 * 60_000),
  );
  return { sha, url: previewUrl(projectId).replace(`//${projectId}.`, `//${projectId}--compare.`) };
}

export async function stopComparePreview(projectId: string) {
  clearTimeout(compareTimers.get(projectId));
  compareTimers.delete(projectId);
  await exec(projectId, [
    "sh",
    "-c",
    'P=$(cat /tmp/compare.pid 2>/dev/null); [ -n "$P" ] && kill -TERM -- -"$P" 2>/dev/null; rm -rf /tmp/forge-compare /tmp/compare.pid; git worktree prune; true',
  ]).catch(() => undefined);
}
