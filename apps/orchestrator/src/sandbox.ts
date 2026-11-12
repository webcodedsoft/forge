import { secretEnv } from "./secrets.ts";
import { activeRunId } from "./runs.ts";
import { dataToken } from "./datasources.ts";
import type { SandboxState } from "@forge/protocol";
import Docker from "dockerode";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pack } from "tar-stream";
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";

/*
 * One Docker container per project, from the forge-sandbox image.
 *   /workspace     project repo (named volume forge-ws-<id>)
 *   /home/forge    agent session state (named volume forge-home-<id>)
 * The Next.js dev server listens on :3000, published to a random loopback port.
 * :3001 is the compare preview (an older version, run from a git worktree; see versions.ts).
 */

export const docker = new Docker();
const IMAGE = process.env.FORGE_SANDBOX_IMAGE ?? "forge-sandbox:dev";
const PROJECT_ID = /^[a-z0-9]{6,32}$/;

export const containerName = (projectId: string) => `forge-proj-${projectId}`;
export const previewUrl = (projectId: string) => env.PREVIEW_URL_TEMPLATE.replace("{id}", projectId);
/** Preview host suffix, e.g. ".preview.localhost" or ".preview.forge.example.com". */
export const previewHostSuffix = new URL(env.PREVIEW_URL_TEMPLATE.replace("{id}", "x")).hostname.slice(1);

function assertId(projectId: string) {
  if (!PROJECT_ID.test(projectId)) throw new Error(`Invalid project id for a sandbox: ${projectId}`);
}

async function inspect(projectId: string) {
  try {
    return await docker.getContainer(containerName(projectId)).inspect();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/** Host port the preview proxy should forward to, or null if not running. `compare`: the compare preview. */
export async function previewPort(projectId: string, compare = false): Promise<number | null> {
  const info = await inspect(projectId);
  if (!info?.State.Running) return null;
  const binding = info.NetworkSettings.Ports?.[compare ? "3001/tcp" : "3000/tcp"]?.[0];
  return binding ? Number(binding.HostPort) : null;
}

/** Containers made before the compare preview existed don't publish :3001; ensureSandbox replaces them. */
export async function ensureComparePort(projectId: string) {
  await ensureSandbox(projectId);
}

export async function sandboxState(projectId: string): Promise<SandboxState> {
  const info = await inspect(projectId);
  if (!info) return "missing";
  return info.State.Running ? "running" : "stopped";
}

type ExecOptions = { env?: string[]; user?: string; workdir?: string };

/** Run a command in the sandbox and collect its output. */
/** Non-root commands create group-writable files, shared by the agent (forge) and the app (forgeapp). */
const withSharedUmask = (cmd: string[], user = "forge") =>
  user === "root" ? cmd : ["sh", "-c", 'umask 002; exec "$@"', "sh", ...cmd];

export async function exec(projectId: string, cmd: string[], opts: ExecOptions = {}) {
  const container = docker.getContainer(containerName(projectId));
  const e = await container.exec({
    Cmd: withSharedUmask(cmd, opts.user),
    Env: opts.env,
    User: opts.user ?? "forge",
    WorkingDir: opts.workdir ?? "/workspace",
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await e.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  err.on("data", (c: Buffer) => errChunks.push(c));
  docker.modem.demuxStream(stream, out, err);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  const { ExitCode } = await e.inspect();
  return {
    exitCode: ExitCode ?? -1,
    stdout: Buffer.concat(chunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  };
}

/** Run a long command, calling onLine for each stdout line. Resolves with the exit code. */
export async function execLines(
  projectId: string,
  cmd: string[],
  opts: ExecOptions,
  onLine: (line: string) => void,
  onStderr?: (text: string) => void,
): Promise<number> {
  const container = docker.getContainer(containerName(projectId));
  const e = await container.exec({
    Cmd: withSharedUmask(cmd, opts.user),
    Env: opts.env,
    User: opts.user ?? "forge",
    WorkingDir: opts.workdir ?? "/workspace",
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await e.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);
  if (onStderr) err.on("data", (c: Buffer) => onStderr(c.toString("utf8")));
  const rl = createInterface({ input: out, crlfDelay: Infinity });
  rl.on("line", onLine);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });
  out.end();
  err.end();
  const { ExitCode } = await e.inspect();
  return ExitCode ?? -1;
}

/**
 * Write files into /workspace in one tar upload (no argument-size limits), owned
 * by the sandbox user. Parent directories are created as needed.
 */
export async function putFiles(projectId: string, files: { path: string; content: string | Buffer }[]) {
  const p = pack();
  const dirs = new Set<string>();
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.split("/").includes("..")) throw new Error(`Unsafe path: ${f.path}`);
    const parts = f.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const d of [...dirs].sort()) p.entry({ name: d, type: "directory", mode: 0o2775, uid: 10001, gid: 10001 });
  for (const f of files) p.entry({ name: f.path, mode: 0o664, uid: 10001, gid: 10001 }, f.content);
  p.finalize();
  // tar-stream v3 emits a streamx stream; dockerode wants a Node stream or Buffer.
  const chunks: Buffer[] = [];
  for await (const chunk of p) chunks.push(Buffer.from(chunk as Uint8Array));
  await docker.getContainer(containerName(projectId)).putArchive(Buffer.concat(chunks), { path: "/workspace" });
}

const starting = new Map<string, Promise<void>>();

/*
 * Imported repos are copied in by a seeder that github.ts registers (keeps the
 * GitHub code out of this module), then prepared in the background: install
 * dependencies, start the dev server, record which checks already failed.
 */
type Seeder = (projectId: string) => Promise<void>;
let importSeeder: Seeder | null = null;
export const setImportSeeder = (fn: Seeder) => {
  importSeeder = fn;
};
/** Projects started from a team template are seeded by templates.ts. */
let templateSeeder: Seeder | null = null;
export const setTemplateSeeder = (fn: Seeder) => {
  templateSeeder = fn;
};

type Preparing = { stage: string; error?: string; done: Promise<void> };
const preparing = new Map<string, Preparing>();

/** Stage text while an imported project is being prepared, or its error. */
export const prepareStatus = (projectId: string) => {
  const p = preparing.get(projectId);
  return p ? { stage: p.stage, error: p.error } : null;
};

/** Resolves when background preparation (if any) has finished; throws if it failed. */
export async function waitPrepared(projectId: string) {
  const p = preparing.get(projectId);
  if (!p) return;
  await p.done;
  if (p.error) throw new Error(p.error);
}

/** Create/start the project's container, seed it from the template, and run the dev server. */
export function ensureSandbox(projectId: string): Promise<void> {
  assertId(projectId);
  let p = starting.get(projectId);
  if (!p) {
    p = doEnsure(projectId).finally(() => starting.delete(projectId));
    starting.set(projectId, p);
  }
  return p;
}

/**
 * A container made from an older sandbox image (or without the compare port) is replaced, so
 * runner and checks updates reach existing projects. Never while the agent or the checks are
 * working in it. The workspace and home are named volumes: nothing is lost.
 */
async function replaceIfOutdated(info: NonNullable<Awaited<ReturnType<typeof inspect>>>, projectId: string): Promise<boolean> {
  const current = await docker
    .getImage(IMAGE)
    .inspect()
    .then((i) => i.Id)
    .catch(() => null);
  const outdated = (current && info.Image !== current) || !info.HostConfig.PortBindings?.["3001/tcp"];
  if (!outdated || activeRunId(projectId)) return false;
  const c = docker.getContainer(containerName(projectId));
  if (info.State.Running) {
    const busy = await exec(projectId, ["sh", "-c", 'pgrep -f "[/]opt/forge/(runner/runner|checks/checks).mjs" >/dev/null && echo busy; true']);
    if (busy.stdout.includes("busy")) return false;
    await c.stop({ t: 5 });
  }
  await c.remove();
  console.log(`sandbox ${projectId}: replaced a container from an older image`);
  return true;
}

async function doEnsure(projectId: string) {
  let info = await inspect(projectId);
  if (info && (await replaceIfOutdated(info, projectId))) info = null;
  if (!info) {
    await docker.createContainer({
      name: containerName(projectId),
      Image: IMAGE,
      Labels: { "forge.project": projectId },
      // Generated apps allow their preview origin for Next's dev server (HMR) via this.
      Env: [`FORGE_PREVIEW_ORIGINS=*${previewHostSuffix}`],
      ExposedPorts: { "3000/tcp": {}, "3001/tcp": {} },
      HostConfig: {
        // Reach the orchestrator's model proxy (Docker Desktop has this name built in; Linux needs it mapped).
        ExtraHosts: ["host.docker.internal:host-gateway"],
        Binds: [`forge-ws-${projectId}:/workspace`, `forge-home-${projectId}:/home/forge`],
        PortBindings: {
          "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          "3001/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
        },
        Memory: 3 * 1024 ** 3,
        NanoCpus: 2_000_000_000,
        PidsLimit: 2048,
        RestartPolicy: { Name: "no" },
      },
    });
    info = await inspect(projectId);
  }
  if (!info!.State.Running) await docker.getContainer(containerName(projectId)).start();

  const [proj] = await db
    .select({ source: schema.project.source, templateId: schema.project.templateId })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));

  // Seed the workspace on first start: the template, or the imported repo.
  const seeded = (await exec(projectId, ["test", "-d", "/workspace/.git"])).exitCode === 0;
  if (!seeded) {
    if (proj?.source === "github") {
      if (!importSeeder) throw new Error("Import seeding is not available.");
      await importSeeder(projectId);
    } else if (proj?.templateId) {
      if (!templateSeeder) throw new Error("Template seeding is not available.");
      await templateSeeder(projectId);
    } else {
      const seed = await exec(projectId, [
        "sh",
        "-c",
        'cp -a /opt/forge/template/. /workspace/ && git init -q && git add -A && git commit -qm "Start from the Forge template"',
      ]);
      if (seed.exitCode !== 0) throw new Error(`Seeding the workspace failed: ${seed.stderr || seed.stdout}`);
    }
  }

  // Once per workspace: make it group-writable (setgid dirs) so the app user can work in it too.
  const SHARED = "/workspace/.git/forge-shared-perms-v1";
  if ((await exec(projectId, ["test", "-f", SHARED])).exitCode !== 0) {
    const r = await exec(
      projectId,
      ["sh", "-c", `chmod -R g+rwX /workspace && find /workspace -type d -exec chmod g+s {} + && touch ${SHARED} && chown forge:forge ${SHARED}`],
      { user: "root" },
    );
    if (r.exitCode !== 0) throw new Error(`Preparing workspace permissions failed: ${r.stderr.slice(0, 300)}`);
  }

  const prepared = (await exec(projectId, ["test", "-f", "/workspace/.forge/prepared"])).exitCode === 0;
  if (proj?.source === "github" && !prepared) {
    if (!preparing.has(projectId)) startPreparing(projectId);
    return; // the dev server starts when preparation is done
  }
  await ensureDevServer(projectId);
}

/** Background: install dependencies, start the app, record checks that already fail. */
function startPreparing(projectId: string) {
  const state: Preparing = { stage: "Installing dependencies", done: Promise.resolve() };
  state.done = (async () => {
    try {
      const install = await exec(projectId, ["sh", "-c", 'eval "$(jq -r .install .forge/project.json)" > /tmp/install.log 2>&1; s=$?; tail -c 3000 /tmp/install.log; exit $s']);
      if (install.exitCode !== 0) throw new Error(`Installing dependencies failed:\n${install.stdout.slice(-1500)}`);

      state.stage = "Starting the app";
      await ensureDevServer(projectId);

      state.stage = "Checking the imported code";
      const r = await exec(projectId, ["node", "/opt/forge/checks/checks.mjs"], { env: ["FORGE_BASELINE=1"] });
      const last = r.stdout.trim().split("\n").pop() ?? "{}";
      let failing: string[] = [];
      try {
        const result = JSON.parse(last) as { checks: Record<string, { ok: boolean }> };
        failing = Object.entries(result.checks).filter(([, c]) => !c.ok).map(([n]) => n);
      } catch {
        /* keep empty: everything stays blocking */
      }
      // Installing and checking can leave byproducts (a lockfile the repo doesn't
      // track, a tracked build-info file rewritten by tsc). Hide them locally so they
      // never show up as the user's changes or in the pull request.
      const hidden = await exec(projectId, [
        "sh",
        "-c",
        'git status --porcelain | while IFS= read -r line; do st=$(printf %s "$line" | cut -c1-2); p=$(printf %s "$line" | cut -c4-); ' +
          'if [ "$st" = "??" ]; then printf "/%s\\n" "$p" >> .git/info/exclude; else git update-index --skip-worktree -- "$p"; fi; echo "$p"; done',
      ]);
      const byproducts = hidden.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

      const save = await exec(projectId, [
        "node",
        "-e",
        'const fs=require("fs");const f="/workspace/.forge/project.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));c.baselineFailing=JSON.parse(process.argv[1]);c.hiddenImportByproducts=JSON.parse(process.argv[2]);fs.writeFileSync(f,JSON.stringify(c,null,2));fs.writeFileSync("/workspace/.forge/prepared",new Date().toISOString());',
        JSON.stringify(failing),
        JSON.stringify(byproducts),
      ]);
      if (save.exitCode !== 0) throw new Error(`Saving the import baseline failed: ${save.stderr}`);
      preparing.delete(projectId);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.stage = "Preparation failed";
      // Keep the failed entry briefly so the UI can show the error, then allow a retry.
      setTimeout(() => preparing.get(projectId) === state && preparing.delete(projectId), 60_000);
    }
  })();
  preparing.set(projectId, state);
}

export async function ensureDevServer(projectId: string) {
  // Project secrets reach only the dev server process (inherited by nohup below), with the
  // project's data-proxy address and token (company data sources).
  const secrets = [...(await secretEnv(projectId)), `FORGE_DATA_URL=${env.DATA_PROXY_URL_FOR_SANDBOX}`, `FORGE_DATA_TOKEN=${dataToken(projectId)}`];
  // The dev server, the agent and the checks all write .next (`next typegen` runs in typecheck),
  // and Turbopack changes modes and times there, which Linux allows only for a file's owner.
  // So everything runs as the one user `forge`; hand back anything a past setup left to another user.
  await exec(projectId, ["sh", "-c", "[ -d /workspace/.next ] && find /workspace/.next ! -user forge -exec chown forge:forge {} + ; true"], { user: "root" });
  const r = await exec(projectId, [
    "sh",
    "-c",
    // The command comes from .forge/project.json for imported repos; new apps run
    // the Next binary directly (`pnpm dev` runs a slow install check first).
    // A pidfile decides whether it is already running; pgrep -f would match
    // this very command line, which contains the launch command.
    "if [ -f /tmp/dev.pid ] && kill -0 \"$(cat /tmp/dev.pid)\" 2>/dev/null; then exit 0; fi; " +
      'CMD=$(jq -r ".dev // empty" .forge/project.json 2>/dev/null); ' +
      '[ -n "$CMD" ] || CMD="node node_modules/next/dist/bin/next dev -H 0.0.0.0 -p 3000"; ' +
      // setsid: its own process group, so a restart can stop the server and all its children.
      'nohup setsid sh -c "$CMD" > /tmp/dev.log 2>&1 & echo $! > /tmp/dev.pid',
  ], { env: secrets });
  if (r.exitCode !== 0) throw new Error(`Starting the dev server failed: ${r.stderr || r.stdout}`);
}

/** Restarts the app's dev server (e.g. after its secrets changed). No-op when the sandbox isn't running. */
export async function restartDevServer(projectId: string) {
  const info = await inspect(projectId);
  if (!info?.State.Running) return;
  // Stop the server's process group (it runs under setsid) and any leftover Next servers,
  // wait until they're gone, then start again with fresh env. As root, so nothing is out of reach.
  await exec(projectId, [
    "sh",
    "-c",
    'P=$(cat /tmp/dev.pid 2>/dev/null); if [ -n "$P" ]; then kill -TERM -- -"$P" 2>/dev/null; kill -TERM "$P" 2>/dev/null; fi; ' +
      "pkill -TERM -f '[n]ext-server|[n]ext dev'; " +
      'for i in 1 2 3 4 5 6 7 8 9 10; do { [ -n "$P" ] && kill -0 "$P" 2>/dev/null; } || pgrep -f "[n]ext-server" >/dev/null || break; sleep 0.3; done; true',
  ], { user: "root" });
  await ensureDevServer(projectId);
}

export async function stopSandbox(projectId: string) {
  const info = await inspect(projectId);
  if (info?.State.Running) await docker.getContainer(containerName(projectId)).stop({ t: 5 });
}
