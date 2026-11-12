// Forge green-build checks. Runs inside a project sandbox, in /workspace.
//
// Prints one JSON line to stdout:
//   { ok: boolean, checks: { install, typecheck, lint, unit, e2e: { ok, skipped?, output } } }
// A version is saved only when `ok` is true.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium } from "playwright-core";

// Files are shared with the app's own user (same group); keep them group-writable.
process.umask(0o002);

const ROOT = "/workspace";
// "localhost", not 127.0.0.1: Next's dev server treats 127.0.0.1 as a foreign
// origin and rejects its HMR websocket, which shows up as a console error.
const DEV_URL = "http://localhost:3000";
const TAIL = 4000;
const MAX_ROUTES = 8;

const tail = (s) => (s.length > TAIL ? "…" + s.slice(-TAIL) : s);

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += `\n[forge] timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: tail(out.trim()) });
    });
  });
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

// Imported repos describe themselves in .forge/project.json (package manager,
// framework, scripts, and the checks that already failed at import time).
const configPath = join(ROOT, ".forge/project.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const pm = config?.packageManager ?? "pnpm";
const BASELINE = process.env.FORGE_BASELINE === "1";
const baselineFailing = new Set(BASELINE ? [] : config?.baselineFailing ?? []);
const runScript = (name) => (pm === "yarn" ? ["corepack", ["yarn", name]] : [pm, ["run", name]]);

// Static routes from the App Router: every page.tsx under src/app, skipping
// dynamic ([id]), private (_folder), parallel (@slot) and api segments.
function staticRoutes() {
  if (config && config.framework !== "next") return ["/"];
  const appDir = existsSync(join(ROOT, "src/app")) ? join(ROOT, "src/app") : join(ROOT, "app");
  if (!existsSync(appDir)) return ["/"];
  const routes = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name.startsWith("_") || name.startsWith("[") || name.startsWith("@") || name === "api") continue;
        walk(full);
      } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(name)) {
        const segs = relative(appDir, dir)
          .split("/")
          .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
        routes.push("/" + segs.join("/"));
      }
    }
  };
  walk(appDir);
  return [...new Set(routes)].sort((a, b) => a.length - b.length).slice(0, MAX_ROUTES);
}

async function waitForDevServer(timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await fetch(DEV_URL, { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

const IGNORED_CONSOLE = [/favicon/i, /\[HMR\]/, /React DevTools/i, /\[Fast Refresh\]/i];

async function smoke() {
  if (!(await waitForDevServer())) return { ok: false, output: "The dev server did not respond on port 3000." };
  const chromeDir = readdirSync("/ms-playwright").find((d) => /^chromium-\d+$/.test(d));
  const archDir = chromeDir && readdirSync(`/ms-playwright/${chromeDir}`).find((d) => d.startsWith("chrome-linux"));
  const browser = await chromium.launch({
    executablePath: `/ms-playwright/${chromeDir}/${archDir}/chrome`,
    args: ["--no-sandbox"],
  });
  const problems = [];
  const routes = staticRoutes();
  try {
    for (const route of routes) {
      const page = await browser.newPage();
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
        problems.push(`${route}: console error: ${text.slice(0, 500)}`);
      });
      page.on("pageerror", (err) => problems.push(`${route}: uncaught error: ${String(err.message).slice(0, 500)}`));
      try {
        // Dev compiles on first request, so allow a generous timeout.
        const res = await page.goto(DEV_URL + route, { waitUntil: "load", timeout: 120_000 });
        if (!res) problems.push(`${route}: no response`);
        else if (res.status() >= 400) problems.push(`${route}: HTTP ${res.status()}`);
        await page.waitForTimeout(1500); // let client components hydrate and effects run
      } catch (err) {
        problems.push(`${route}: failed to load: ${String(err.message).split("\n")[0]}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const header = `Checked ${routes.length} page(s): ${routes.join(", ")}`;
  return problems.length ? { ok: false, output: tail(`${header}\n${problems.join("\n")}`) } : { ok: true, output: header };
}

const skipped = (output) => ({ ok: true, skipped: true, output });
const installCmd = {
  pnpm: ["pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--reporter=append-only"]],
  npm: ["npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"]],
  yarn: ["corepack", ["yarn", "install"]],
}[pm];
const hasTsconfig = existsSync(join(ROOT, "tsconfig.json"));
const testScript = scripts.test && !/no test specified/.test(scripts.test);

const checks = {};
checks.install = await run(...installCmd, 300_000);
checks.typecheck = scripts.typecheck
  ? await run(...runScript("typecheck"), 240_000)
  : hasTsconfig
    ? await run("npx", ["tsc", "--noEmit"], 240_000)
    : skipped("No TypeScript config");
checks.lint = scripts.lint ? await run(...runScript("lint"), 240_000) : skipped("No lint script");
checks.unit = testScript ? await run(...runScript("test"), 300_000) : skipped("No test script");
checks.e2e = await smoke().catch((err) => ({ ok: false, output: `Smoke test crashed: ${err.message}` }));

// Checks that already failed when the repo was imported don't block saving:
// the agent shouldn't be forced to fix unrelated, pre-existing problems.
for (const [name, c] of Object.entries(checks)) {
  if (!c.ok && baselineFailing.has(name)) {
    checks[name] = { ok: true, advisory: true, output: `Already failing when the repo was imported (not blocking).\n${c.output}` };
  }
}

const ok = Object.values(checks).every((c) => c.ok);
process.stdout.write(JSON.stringify({ ok, checks }) + "\n");
