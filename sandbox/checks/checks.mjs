// Forge green-build checks. Runs inside a project sandbox, in /workspace.
//
// Prints one JSON line to stdout:
//   { ok: boolean, checks: { install, typecheck, lint, unit, e2e: { ok, skipped?, output } } }
// A version is saved only when `ok` is true.
//
// While the smoke test has each page open it also records a review of it (never blocking):
// screenshots at desktop and phone width and an accessibility scan (axe-core, WCAG 2.1 A/AA),
// written to FORGE_REVIEW_DIR (default /tmp/forge-review) with a review.json index. Forge
// compares the screenshots with the previous version's (orchestrator review.ts).
// FORGE_ONLY=review runs just the smoke test and review (after a restore, for example).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/* ---------------------------------- review ---------------------------------- */

const REVIEW_DIR = process.env.FORGE_REVIEW_DIR || "/tmp/forge-review";
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
const MAX_SHOT_HEIGHT = 3000;
let axeSource = null;
try {
  axeSource = createRequire(import.meta.url)("axe-core").source;
} catch {
  /* an older sandbox image without axe-core: screenshots only */
}
const slugOf = (route) => (route === "/" ? "home" : route.slice(1).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 80) || "page");

/** Screenshots (desktop, phone) and an accessibility scan of the page that's open. Never throws. */
async function reviewPage(page, route, review) {
  const slug = slugOf(route);
  try {
    if (axeSource) {
      await page.evaluate(axeSource);
      const result = await page.evaluate(() =>
        // eslint-disable-next-line no-undef
        axe.run(
          { exclude: [["nextjs-portal"]] },
          { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] },
        ),
      );
      for (const v of result.violations ?? []) {
        review.a11y.push({
          route,
          rule: v.id,
          impact: v.impact ?? "minor",
          help: String(v.help ?? "").slice(0, 300),
          helpUrl: String(v.helpUrl ?? "").slice(0, 300),
          count: v.nodes.length,
          nodes: v.nodes.slice(0, 3).map((n) => ({
            target: String((n.target ?? []).join(" ")).slice(0, 300),
            html: String(n.html ?? "").slice(0, 300),
            summary: String(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 400),
          })),
        });
      }
      review.a11yChecked = true;
    }
  } catch (err) {
    review.notes.push(`${route}: accessibility scan failed: ${String(err.message).split("\n")[0]}`);
  }
  try {
    // Next's dev indicator and overlays aren't part of the app.
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => undefined);
    const shots = {};
    for (const [name, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      await page.waitForTimeout(350);
      const full = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)).catch(() => size.height);
      const height = Math.max(size.height, Math.min(MAX_SHOT_HEIGHT, full));
      const file = `${slug}--${name}.png`;
      await page.screenshot({
        path: join(REVIEW_DIR, file),
        type: "png",
        fullPage: true,
        clip: { x: 0, y: 0, width: size.width, height },
        animations: "disabled",
        caret: "hide",
      });
      shots[name] = { file, width: size.width, height };
    }
    review.pages.push({ route, slug, shots });
  } catch (err) {
    review.notes.push(`${route}: screenshot failed: ${String(err.message).split("\n")[0]}`);
  }
}

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
  const review = { at: new Date().toISOString(), pages: [], a11y: [], a11yChecked: false, notes: [] };
  rmSync(REVIEW_DIR, { recursive: true, force: true });
  mkdirSync(REVIEW_DIR, { recursive: true });
  try {
    for (const route of routes) {
      // Reduced motion and a fixed size keep the screenshots comparable between versions.
      const page = await browser.newPage({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 1, reducedMotion: "reduce" });
      let loaded = false;
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
        else loaded = true;
        await page.waitForTimeout(1500); // let client components hydrate and effects run
      } catch (err) {
        problems.push(`${route}: failed to load: ${String(err.message).split("\n")[0]}`);
      }
      if (loaded) await reviewPage(page, route, review);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  try {
    writeFileSync(join(REVIEW_DIR, "review.json"), JSON.stringify(review));
  } catch {
    /* the review is optional */
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

const REVIEW_ONLY = process.env.FORGE_ONLY === "review";
const checks = {};
if (!REVIEW_ONLY) {
  checks.install = await run(...installCmd, 300_000);
  checks.typecheck = scripts.typecheck
    ? await run(...runScript("typecheck"), 240_000)
    : hasTsconfig
      ? await run("npx", ["tsc", "--noEmit"], 240_000)
      : skipped("No TypeScript config");
  checks.lint = scripts.lint ? await run(...runScript("lint"), 240_000) : skipped("No lint script");
  checks.unit = testScript ? await run(...runScript("test"), 300_000) : skipped("No test script");
}
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
