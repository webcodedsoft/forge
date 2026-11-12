import type { GitHubStatus, ImportProjectInput, Project } from "@forge/protocol";
import { createOrgRepo, githubInstallationToken, IntegrationError } from "./integrations.ts";
import { scanProject } from "./security.ts";
import { runSavedTests } from "./tests.ts";
import { eq } from "drizzle-orm";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { customAlphabet } from "nanoid";
import { extract } from "tar-stream";
import { db, schema } from "./db/index.ts";
import { appendEvent } from "./events.ts";
import { activeRunId, RunConflictError } from "./runs.ts";
import { docker, containerName, exec } from "./sandbox.ts";

/*
 * Imported GitHub repos. The user's GitHub credentials (gh CLI on this Mac)
 * never enter a project container:
 *   - clone, push and `gh pr create` run on the host, in data/repos/<projectId>;
 *   - the container gets a copy of that clone (without node_modules);
 *   - versions made in the container come back as a git bundle.
 */

const execFileP = promisify(execFile);
export const REPOS_DIR = resolve(fileURLToPath(new URL("../../../data/repos", import.meta.url)));
const newProjectId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const MAX_REPO_KB = 300_000;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
// Use gh as git's credential helper for this command only; no global git config changes.
const GIT_AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export class GitHubError extends Error {}

// With GitHub connected (Settings › Integrations) git and gh use the Forge app's installation token,
// passed in the environment (never on the command line); otherwise the gh login on this machine.
const GH_HELPER = GIT_AUTH[3]!;
const APP_HELPER = 'credential.helper=!f() { echo username=x-access-token; echo "password=$FORGE_GH_TOKEN"; }; f';

async function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  let childEnv: NodeJS.ProcessEnv = process.env;
  if (cmd === "gh" || args.includes(GH_HELPER)) {
    const conn = await githubInstallationToken().catch(() => null);
    if (conn) {
      childEnv = { ...process.env, GH_TOKEN: conn.token, FORGE_GH_TOKEN: conn.token };
      args = args.map((a) => (a === GH_HELPER ? APP_HELPER : a));
    }
  }
  try {
    const { stdout } = await execFileP(cmd, args, { cwd: opts.cwd, env: childEnv, timeout: opts.timeout ?? 120_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitHubError((e.stderr || e.message).trim().split("\n").slice(-3).join(" "));
  }
}

export function parseRepo(input: string): string {
  const m = input.trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  const repo = m?.[1];
  if (!repo || !REPO.test(repo)) throw new GitHubError('Enter the repository as "owner/name" or its github.com URL.');
  return repo;
}

/* --------------------------------- import --------------------------------- */

export type ProjectConfig = {
  source: "github";
  repo: string;
  branch: string;
  packageManager: "pnpm" | "npm" | "yarn";
  framework: "next" | "vite" | "cra" | "unknown";
  install: string;
  dev: string;
  scripts: { typecheck: string | null; lint: string | null; test: string | null };
  /** Checks that already failed when the repo was imported; they don't block saving. */
  baselineFailing: string[];
};

async function detectStack(dir: string, repo: string, branch: string): Promise<ProjectConfig> {
  if (!existsSync(join(dir, "package.json"))) {
    throw new GitHubError("No package.json at the repository root. Forge can import JavaScript/TypeScript web apps for now.");
  }
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const declared = String(pkg.packageManager ?? "");

  const packageManager: ProjectConfig["packageManager"] =
    declared.startsWith("pnpm") || existsSync(join(dir, "pnpm-lock.yaml"))
      ? "pnpm"
      : declared.startsWith("yarn") || existsSync(join(dir, "yarn.lock"))
        ? "yarn"
        : "npm";
  const framework: ProjectConfig["framework"] = deps.next ? "next" : deps.vite ? "vite" : deps["react-scripts"] ? "cra" : "unknown";

  const install = {
    pnpm: "pnpm install --prefer-offline",
    npm: "npm install --no-audit --no-fund",
    yarn: "corepack yarn install",
  }[packageManager];
  const runScript = (s: string) => (packageManager === "yarn" ? `corepack yarn ${s}` : `${packageManager} run ${s}`);
  const dev = {
    next: "node node_modules/next/dist/bin/next dev -H 0.0.0.0 -p 3000",
    vite: "node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 3000 --strictPort",
    cra: `PORT=3000 HOST=0.0.0.0 BROWSER=none ${runScript("start")}`,
    unknown: `PORT=3000 HOST=0.0.0.0 ${runScript("dev")}`,
  }[framework];

  const testScript = scripts.test && !/no test specified/.test(scripts.test) ? "test" : null;
  return {
    source: "github",
    repo,
    branch,
    packageManager,
    framework,
    install,
    dev,
    scripts: {
      typecheck: scripts.typecheck ? "typecheck" : null,
      lint: scripts.lint ? "lint" : null,
      test: testScript,
    },
    baselineFailing: [],
  };
}

export async function importProject(input: ImportProjectInput, user: { id: string; name: string }): Promise<Project> {
  const repo = parseRepo(input.repo);
  if (input.branch && !BRANCH.test(input.branch)) throw new GitHubError("That branch name is not valid.");

  const meta = JSON.parse(
    await run("gh", ["api", `repos/${repo}`, "--jq", "{size: .size, default_branch: .default_branch, name: .name, description: .description}"]).catch(
      (e) => {
        throw new GitHubError(`Could not open ${repo} on GitHub: ${(e as Error).message}`);
      },
    ),
  ) as { size: number; default_branch: string; name: string; description: string | null };
  if (meta.size > MAX_REPO_KB) throw new GitHubError(`${repo} is too large to import (${Math.round(meta.size / 1024)} MB).`);
  const branch = input.branch || meta.default_branch;

  const id = newProjectId();
  const dir = join(REPOS_DIR, id);
  await mkdir(REPOS_DIR, { recursive: true });
  try {
    await run("gh", ["repo", "clone", repo, dir, "--", "--branch", branch], { timeout: 600_000 });
    const workBranch = `forge/${id}`;
    await run("git", ["-C", dir, "checkout", "-q", "-b", workBranch]);
    // Forge's own files stay out of the user's repo.
    await appendFile(join(dir, ".git", "info", "exclude"), "\n.forge/\n");
    const config = await detectStack(dir, repo, branch);
    await mkdir(join(dir, ".forge"), { recursive: true });
    await writeFile(join(dir, ".forge", "project.json"), JSON.stringify(config, null, 2));

    const [row] = await db
      .insert(schema.project)
      .values({
        id,
        name: input.name || meta.name,
        description: meta.description,
        ownerId: user.id,
        source: "github",
        repo,
        baseBranch: branch,
        workBranch,
      })
      .returning();
    return {
      id: row!.id,
      name: row!.name,
      description: row!.description,
      ownerId: row!.ownerId,
      ownerName: user.name,
      status: row!.status,
      source: "github",
      repo,
      baseBranch: branch,
      workBranch,
      prUrl: null,
      createdAt: row!.createdAt.toISOString(),
      updatedAt: row!.updatedAt.toISOString(),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Copy the host clone into the project's empty /workspace (registered as the sandbox seeder). */
export async function seedFromClone(projectId: string) {
  const dir = join(REPOS_DIR, projectId);
  if (!existsSync(dir)) throw new GitHubError("The imported repository is missing on this machine.");
  // macOS tar would add Apple extended attributes (e.g. com.apple.provenance) and
  // ._ files, which the Linux container cannot store; leave them out.
  const tar = spawn(
    "tar",
    ["-c", "--no-xattrs", "--no-mac-metadata", "-C", dir, "--exclude=./node_modules", "--exclude=*/node_modules", "."],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  await docker.getContainer(containerName(projectId)).putArchive(tar.stdout, { path: "/workspace" });
  const r = await exec(projectId, ["chown", "-R", "forge:forge", "/workspace"], { user: "root" });
  if (r.exitCode !== 0) throw new Error(`Fixing file ownership failed: ${r.stderr}`);
}

/* ------------------------------- pull requests ------------------------------ */

async function readBundleFromContainer(projectId: string, dest: string) {
  const r = await exec(projectId, ["sh", "-c", "rm -f /tmp/forge.bundle && git bundle create -q /tmp/forge.bundle HEAD"]);
  if (r.exitCode !== 0) throw new Error(`Packing the project's versions failed: ${r.stderr || r.stdout}`);
  const archive = await docker.getContainer(containerName(projectId)).getArchive({ path: "/tmp/forge.bundle" });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveP, reject) => {
    const ex = extract();
    ex.on("entry", (_header, stream, next) => {
      stream.on("data", (c: unknown) => {
        chunks.push(Buffer.from(c as Uint8Array));
      });
      stream.on("end", next);
      stream.resume();
    });
    ex.on("finish", resolveP);
    ex.on("error", reject);
    archive.pipe(ex);
  });
  await writeFile(dest, Buffer.concat(chunks));
}

export async function openOrUpdatePullRequest(projectId: string, user: { name: string }) {
  const [p] = await db.select().from(schema.project).where(eq(schema.project.id, projectId));
  if (!p) throw new GitHubError("Project not found.");
  if (p.source !== "github" || !p.repo || !p.baseBranch || !p.workBranch) {
    throw new GitHubError("Only projects imported from GitHub can open pull requests.");
  }
  if (activeRunId(projectId)) throw new RunConflictError("Wait for the agent to finish first.");
  const dirty = await exec(projectId, ["git", "status", "--porcelain"]);
  if (dirty.stdout.trim()) throw new GitHubError("There are unsaved changes. Save or discard them first.");

  const dir = join(REPOS_DIR, projectId);
  const bundle = join(dir, ".git", "forge.bundle");
  await readBundleFromContainer(projectId, bundle);
  // The host clone is Forge's own; move its work branch to the container's HEAD.
  await run("git", ["-C", dir, "fetch", "-q", bundle, "HEAD"]);
  await run("git", ["-C", dir, "reset", "-q", "--hard", "FETCH_HEAD"]);
  await rm(bundle, { force: true });

  await run("git", ["-C", dir, ...GIT_AUTH, "fetch", "-q", "origin", p.baseBranch], { timeout: 300_000 });
  const commits = Number(await run("git", ["-C", dir, "rev-list", "--count", `origin/${p.baseBranch}..HEAD`]));
  if (!commits) throw new GitHubError("There are no saved changes to send yet.");
  await run("git", ["-C", dir, ...GIT_AUTH, "push", "-q", "-u", "origin", p.workBranch], { timeout: 300_000 });

  let url = p.prUrl;
  let number = p.prNumber;
  let action: "opened" | "updated" = "updated";
  const state = number
    ? await run("gh", ["pr", "view", String(number), "--repo", p.repo, "--json", "state", "--jq", ".state"]).catch(() => "")
    : "";
  if (!number || state !== "OPEN") {
    const log = await run("git", ["-C", dir, "log", "--reverse", "--format=- %s", `origin/${p.baseBranch}..HEAD`]);
    const body = [
      `Changes made in Forge for **${p.name}**.`,
      "",
      "Each item below was checked by Forge (install, typecheck, lint, tests, page smoke test) before it was saved:",
      "",
      log,
    ].join("\n");
    url = await run("gh", ["pr", "create", "--repo", p.repo, "--base", p.baseBranch, "--head", p.workBranch, "--title", p.name, "--body", body], {
      timeout: 120_000,
    });
    number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
    action = "opened";
    await db.update(schema.project).set({ prUrl: url, prNumber: number }).where(eq(schema.project.id, projectId));
  }

  await appendEvent({
    type: "pull_request",
    projectId,
    runId: `pr-${newProjectId().slice(0, 8)}`,
    action,
    url: url!,
    number: number!,
    commits,
    userName: user.name,
  });
  return { url, number, action, commits };
}

/* ------------------------------ push to GitHub ----------------------------- */
/*
 * Forge doesn't deploy apps; the team's code goes to the company's GitHub.
 *   made in Forge  the first push creates a private repo in the connected organization (Settings ›
 *                  Integrations); every push updates its main
 *   imported       changes go out as a pull request (above)
 * Before either: the saved tests are replayed and the security check runs. Failing tests or
 * critical/high findings block the push; a project admin can push anyway (it's recorded).
 */

export class PushBlockedError extends Error {
  constructor(
    message: string,
    readonly failingTests: string[],
    readonly securityBlocking: number,
  ) {
    super(message);
  }
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export async function gitHubStatus(projectId: string): Promise<GitHubStatus> {
  const [p] = await db.select().from(schema.project).where(eq(schema.project.id, projectId));
  if (!p) throw new GitHubError("Project not found.");
  return {
    source: p.source === "github" ? "github" : "template",
    repo: p.repo,
    url: p.repo ? `https://github.com/${p.repo}` : null,
    org: (await githubInstallationToken().catch(() => null))?.account ?? null,
  };
}

/** Replay saved tests and scan; throws PushBlockedError unless everything passes (or `override`). */
async function pushGate(projectId: string, override: boolean) {
  const [results, report] = await Promise.all([runSavedTests(projectId, "push"), scanProject(projectId)]);
  const failingTests = (results ?? []).filter((r) => !r.ok).map((r) => r.title);
  if ((failingTests.length || report.blocking) && !override) {
    const parts = [
      failingTests.length === 1 ? "1 saved test fails" : failingTests.length ? `${failingTests.length} saved tests fail` : "",
      report.blocking ? `the security check found ${report.blocking} serious problem${report.blocking === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    throw new PushBlockedError(`Not pushed: ${parts.join(" and ")}. Fix them in the Health tab, then push again.`, failingTests, report.blocking);
  }
  return { overridden: Boolean(failingTests.length || report.blocking) };
}

export async function pushToGitHub(
  projectId: string,
  user: { name: string },
  opts: { name?: string; override?: boolean },
): Promise<{ url: string; repo: string; created: boolean; commits: number; pullRequest?: boolean }> {
  const [p] = await db.select().from(schema.project).where(eq(schema.project.id, projectId));
  if (!p) throw new GitHubError("Project not found.");
  if (activeRunId(projectId)) throw new RunConflictError("Wait for the agent to finish first.");
  const dirty = await exec(projectId, ["git", "status", "--porcelain"]);
  if (dirty.stdout.trim()) throw new GitHubError("There are unsaved changes. Save or discard them first.");

  const gate = await pushGate(projectId, Boolean(opts.override));

  // Imported repos: a pull request, as before.
  if (p.source === "github") {
    const pr = await openOrUpdatePullRequest(projectId, user);
    return { url: pr.url!, repo: p.repo!, created: false, commits: pr.commits, pullRequest: true };
  }

  let repo = p.repo;
  let created = false;
  if (!repo) {
    const name = (opts.name ?? "").trim();
    if (!REPO_NAME.test(name)) throw new GitHubError("Give the repository a name: letters, numbers, dots, dashes or underscores.");
    try {
      repo = await createOrgRepo(name, `${p.name} (made in Forge)`.slice(0, 300));
    } catch (err) {
      if (err instanceof IntegrationError) throw new GitHubError(err.message);
      throw err;
    }
    created = true;
    await db.update(schema.project).set({ repo, baseBranch: "main" }).where(eq(schema.project.id, projectId));
  }

  // Forge's own clone on this Mac (credentials stay here): the container's versions arrive as a bundle.
  const dir = join(REPOS_DIR, projectId);
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(dir, { recursive: true });
    await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
  }
  const remote = `https://github.com/${repo}.git`;
  await run("git", ["-C", dir, "remote", "remove", "origin"]).catch(() => undefined);
  await run("git", ["-C", dir, "remote", "add", "origin", remote]);
  const bundle = join(dir, ".git", "forge.bundle");
  await readBundleFromContainer(projectId, bundle);
  await run("git", ["-C", dir, "fetch", "-q", bundle, "HEAD"]);
  await run("git", ["-C", dir, "reset", "-q", "--hard", "FETCH_HEAD"]);
  await rm(bundle, { force: true });

  // How many versions GitHub doesn't have yet (all of them for a new or empty repo).
  const remoteHead = await run("git", ["-C", dir, ...GIT_AUTH, "ls-remote", "origin", "refs/heads/main"]).then((o) => o.split(/\s/)[0] || "");
  let commits: number;
  if (remoteHead) {
    await run("git", ["-C", dir, ...GIT_AUTH, "fetch", "-q", "origin", "main"], { timeout: 300_000 });
    const behind = Number(await run("git", ["-C", dir, "rev-list", "--count", "HEAD..origin/main"]));
    if (behind) {
      throw new GitHubError(
        `GitHub's main has ${behind} change${behind === 1 ? "" : "s"} that weren't made in Forge, so Forge won't overwrite them. Ask an engineer to merge them, or push from a new repo.`,
      );
    }
    commits = Number(await run("git", ["-C", dir, "rev-list", "--count", "origin/main..HEAD"]));
    if (!commits) throw new GitHubError("GitHub already has every saved version.");
  } else {
    commits = Number(await run("git", ["-C", dir, "rev-list", "--count", "HEAD"]));
  }
  await run("git", ["-C", dir, ...GIT_AUTH, "push", "-q", "-u", "origin", "HEAD:refs/heads/main"], { timeout: 300_000 });

  const url = `https://github.com/${repo}`;
  await appendEvent({
    type: "github.push",
    projectId,
    runId: `push-${newProjectId().slice(0, 8)}`,
    repo,
    url,
    commits,
    created,
    ...(gate.overridden ? { overridden: true } : {}),
    userName: user.name,
  });
  return { url, repo, created, commits };
}
