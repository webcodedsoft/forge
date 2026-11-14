// Forge agent runner. Runs inside a project sandbox container.
//
// Input (env FORGE_INPUT_B64: base64 of one JSON object):
//   { prompt: string, sessionId?: string, model: string, appendSystemPrompt?: string }
// Output (stdout, JSON Lines). Every line has `kind` and `at`:
//   session     { sessionId }
//   delta       { text }                       streamed assistant text
//   assistant   { text }                       complete assistant text block
//   tool_call   { toolUseId, tool, input }
//   tool_result { toolUseId, ok, output }
//   usage       { inputTokens, outputTokens, cacheReadTokens, costUsd }
//   pause       { pauseId, pauseKind: question|plan, payload }   waiting for the user
//   spec_update { update }                     changes to the living spec (applied when the version is saved)
//   done        { status: completed|failed|cancelled, result?, error? }
// Diagnostics go to stderr only.
//
// Pauses: the agent's ask_user / present_plan tools emit a `pause` line, then wait
// for the orchestrator to write /tmp/forge-answers/<pauseId>.json.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";

// Files are shared with the app's own user (same group); keep them group-writable.
process.umask(0o002);

const ANSWER_DIR = "/tmp/forge-answers";
const PAUSE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const MAX_TOOL_OUTPUT = 8000;

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, at: new Date().toISOString() }) + "\n");

const toText = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return JSON.stringify(content ?? "");
};
const clip = (s) => (s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + `\n… (${s.length - MAX_TOOL_OUTPUT} more chars)` : s);

let input;
try {
  const raw = process.env.FORGE_INPUT_B64
    ? Buffer.from(process.env.FORGE_INPUT_B64, "base64").toString("utf8")
    : readFileSync(0, "utf8");
  input = JSON.parse(raw);
} catch (err) {
  emit({ kind: "done", status: "failed", error: `Invalid runner input: ${err.message}` });
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  emit({ kind: "done", status: "failed", error: "ANTHROPIC_API_KEY is not set. Add it to forge/.env and restart the orchestrator." });
  process.exit(1);
}

const abortController = new AbortController();
let cancelled = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    cancelled = true;
    abortController.abort();
  });
}

/** Emit a pause and wait for the user's answer (or cancellation / timeout). */
async function pauseForUser(pauseKind, payload) {
  const pauseId = randomUUID().replace(/-/g, "").slice(0, 16);
  const file = `${ANSWER_DIR}/${pauseId}.json`;
  emit({ kind: "pause", pauseId, pauseKind, payload });
  const deadline = Date.now() + PAUSE_TIMEOUT_MS;
  while (!abortController.signal.aborted && Date.now() < deadline) {
    if (existsSync(file)) {
      const answer = JSON.parse(readFileSync(file, "utf8"));
      rmSync(file, { force: true });
      return { answered: true, answer };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { answered: false };
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

const forgeTools = createSdkMcpServer({
  name: "forge",
  version: "1.0.0",
  alwaysLoad: true,
  timeout: PAUSE_TIMEOUT_MS + 60_000,
  tools: [
    tool(
      "ask_user",
      "Ask the user up to 4 multiple-choice questions and wait for their answers. Use it when a request is " +
        "ambiguous in a way that changes what you build (audience, key features, data to store, look and feel). " +
        "Offer 2-4 concrete options per question, with the recommended option first. The user may also write their own answer.",
      {
        questions: z
          .array(
            z.object({
              id: z.string().describe("Short identifier, e.g. 'auth'"),
              question: z.string(),
              options: z.array(z.string()).min(2).max(4),
            }),
          )
          .min(1)
          .max(4),
      },
      async ({ questions }) => {
        const r = await pauseForUser("question", { questions });
        if (!r.answered) return text("The user did not answer. Make reasonable assumptions, state them, and continue.");
        const answers = r.answer?.answers ?? {};
        return text(
          "User answers:\n" + questions.map((q) => `- ${q.question}: ${answers[q.id] ?? "(no answer, use your judgment)"}`).join("\n"),
        );
      },
    ),
    tool(
      "present_plan",
      "Show the user a plan and wait for approval before building. Use it before building a new app or making a " +
        "large change (new pages, data model, auth); not for small edits. Never write a plan as a chat message and " +
        "ask whether to proceed: use this tool. The user can untick, edit and add steps, and leave a note.",
      {
        title: z.string().describe("Short name of what will be built"),
        summary: z.string().describe("Markdown, 1-3 sentences: what the user gets."),
        steps: z
          .array(
            z.object({
              title: z.string().describe("One concrete step, in plain words (what changes for the user)."),
              detail: z.string().optional().describe("Optional: how, in one or two sentences."),
              optional: z.boolean().optional().describe("True for nice-to-haves the user may skip."),
            }),
          )
          .min(1)
          .max(30),
      },
      async ({ title, summary, steps }) => {
        const withIds = steps.map((st, i) => ({ id: `s${i + 1}`, ...st }));
        const plan = [summary, "", ...withIds.map((st, i) => `${i + 1}. **${st.title}**${st.detail ? ` — ${st.detail}` : ""}${st.optional ? " _(optional)_" : ""}`)].join("\n");
        const r = await pauseForUser("plan", { title, summary, steps: withIds, plan });
        if (!r.answered) return text("The user did not respond to the plan. Do not build; summarize the plan and stop.");
        const { decision, feedback, steps: kept, removed, plan: edited } = r.answer ?? {};
        const list = (kept ?? [])
          .map((st, i) => `${i + 1}. ${st.title}${st.detail ? ` — ${st.detail}` : ""}${st.origin === "user" ? " (added by the user)" : st.edited ? " (edited by the user)" : ""}`)
          .join("\n");
        const extras = [
          removed?.length ? `The user removed these steps; do not do them:\n${removed.map((t) => `- ${t}`).join("\n")}` : "",
          feedback ? `The user's note:\n${feedback}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        if (decision === "approve") {
          const go =
            "Implement ALL of these steps now, one after another, in this turn. Do not stop between steps or phases to ask " +
            "for permission or confirmation: the approval covers the whole plan. Only ask if you are truly blocked.";
          if (list) return text(`The user approved this plan. Build exactly these steps, in this order, and nothing they removed:\n${list}${extras ? `\n\n${extras}` : ""}\n\n${go}`);
          return text(`${edited && edited !== plan ? `The user approved an edited plan. Build exactly this:\n\n${edited}` : "The user approved the plan."}\n\n${go}`);
        }
        return text(
          `The user wants changes to the plan before you build.${list ? `\nTheir version of the steps:\n${list}` : ""}${extras ? `\n\n${extras}` : ""}\nRevise the plan and present it again with present_plan.`,
        );
      },
    ),
    tool(
      "look_at_page",
      "See the app as the user will: screenshots of a page of the running app (desktop and/or phone width) plus " +
        "any browser errors. Use it after building or changing UI, to compare the result with the request and any " +
        "attached design, then fix what doesn't match. The dev server must already be serving the page.",
      {
        path: z.string().describe("App path, e.g. / or /settings"),
        viewports: z.array(z.enum(["desktop", "phone"])).min(1).max(2).default(["desktop", "phone"]),
        fullPage: z.boolean().default(true).describe("Capture the whole page (up to ~2400px tall), not just the first screen"),
      },
      async ({ path, viewports, fullPage }) => lookAtPage(path, viewports, fullPage),
    ),
    tool(
      "update_spec",
      "Update the project's living spec (its summary and acceptance criteria) so it matches the app. Call it once, after " +
        "finishing work that adds, changes or removes behaviour a user can observe. Not for styling, copy tweaks or refactors. " +
        "The update takes effect when this version is saved.",
      {
        summary: z.string().max(6000).optional().describe("Only when the app's purpose or main features changed: Markdown, a short paragraph plus a bullet per main feature."),
        add: z
          .array(
            z.object({
              area: z.string().max(60).describe('Short feature name the criterion belongs to, e.g. "Voting"'),
              text: z.string().max(400).describe("One plain, observable statement from the user's side"),
            }),
          )
          .max(60)
          .optional(),
        change: z
          .array(z.object({ id: z.string().describe("The criterion's id, e.g. c1a2b3"), text: z.string().max(400).optional(), area: z.string().max(60).optional() }))
          .max(60)
          .optional(),
        remove: z.array(z.string()).max(60).optional().describe("Ids of criteria whose feature no longer exists"),
      },
      async (update) => {
        const n = (a) => (Array.isArray(a) ? a.length : 0);
        if (!update.summary && !n(update.add) && !n(update.change) && !n(update.remove)) return text("Nothing to update: give a summary, add, change or remove.");
        emit({ kind: "spec_update", update });
        return text(`Recorded (${n(update.add)} added, ${n(update.change)} changed, ${n(update.remove)} removed${update.summary ? ", summary updated" : ""}). The spec is updated when this version is saved.`);
      },
    ),
    tool(
      "save_to_library",
      "Save a self-contained component to the team's component library so every project can reuse it. " +
        "Use it only when the user asks to save, share or reuse a component. List every file the component needs " +
        "(paths relative to the project root); the files are read from disk as they are now.",
      {
        name: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/).describe("kebab-case, e.g. 'restaurant-card'"),
        title: z.string().max(120).describe("Short human name, e.g. 'Restaurant card'"),
        description: z.string().max(1000).describe("What it does and when to use it, one or two sentences"),
        usage: z.string().max(4000).describe("Props and a short TSX usage example"),
        files: z.array(z.string()).min(1).max(20),
        dependencies: z.array(z.string()).max(20).default([]).describe("npm packages it needs beyond the base app, e.g. ['lucide-react']"),
      },
      async ({ name, title, description, usage, files, dependencies }) => {
        const read = [];
        for (const p of files) {
          const rel = p.replace(/^\.?\//, "");
          if (rel.startsWith("/") || rel.split("/").includes("..") || rel.startsWith(".forge/")) return text(`Not saved: unsafe path ${p}.`);
          if (!existsSync(`/workspace/${rel}`)) return text(`Not saved: ${rel} does not exist.`);
          read.push({ path: rel, content: readFileSync(`/workspace/${rel}`, "utf8") });
        }
        if (read.reduce((n, f) => n + f.content.length, 0) > 300_000) return text("Not saved: the files are larger than 300 KB in total.");
        emit({ kind: "library_save", component: { name, title, description, usage, files: read, dependencies } });
        return text(`Saved to the team library as "${name}" (${read.length} file${read.length === 1 ? "" : "s"}). Other projects can now reuse it.`);
      },
    ),
  ],
});

/* ------------------------- look_at_page (build agent) ------------------------- */
// A short-lived browser of its own (not the QA agent's live-streamed one).
async function lookAtPage(path, viewports, fullPage) {
  const { chromium } = await import("playwright-core");
  const { readdirSync } = await import("node:fs");
  const dir = readdirSync("/ms-playwright").find((d) => /^chromium-\d+$/.test(d));
  const arch = readdirSync(`/ms-playwright/${dir}`).find((d) => d.startsWith("chrome-linux"));
  const b = await chromium.launch({ executablePath: `/ms-playwright/${dir}/${arch}/chrome`, args: ["--no-sandbox"] });
  const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };
  const content = [];
  try {
    for (const v of viewports) {
      const page = await b.newPage({ viewport: sizes[v], deviceScaleFactor: 1 });
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
      page.on("pageerror", (e) => errors.push(`Uncaught: ${String(e.message).slice(0, 300)}`));
      const url = "http://localhost:3000" + (path.startsWith("/") ? path : `/${path}`);
      const res = await page.goto(url, { waitUntil: "load", timeout: 120_000 }).catch((e) => ({ status: () => `failed (${e.message.split("\n")[0]})` }));
      await page.waitForTimeout(900);
      const height = fullPage ? Math.min(2400, await page.evaluate(() => document.documentElement.scrollHeight).catch(() => sizes[v].height)) : sizes[v].height;
      const shot = await page.screenshot({
        type: "jpeg",
        quality: 72,
        fullPage,
        clip: { x: 0, y: 0, width: sizes[v].width, height: Math.max(height, sizes[v].height) },
      });
      content.push({
        type: "text",
        text:
          `${v} (${sizes[v].width}px wide) · HTTP ${typeof res?.status === "function" ? res.status() : "?"}${errors.length ? `\nBrowser errors:\n- ${errors.slice(0, 8).join("\n- ")}` : " · no browser errors"}` +
          (v === viewports[0] ? "\n(The round \"N\" button in a bottom corner is Next.js's dev indicator, not part of the app.)" : ""),
      });
      content.push({ type: "image", data: shot.toString("base64"), mimeType: "image/jpeg" });
      await page.close();
    }
  } finally {
    await b.close().catch(() => undefined);
  }
  return { content };
}

/* ------------------------------ QA mode tools ------------------------------ */
// A real browser the QA agent drives, kept open for the whole session.

const QA = input.mode === "qa";
// Chat mode: answer and explore with read-only tools; no edits, no commands.
const READ_ONLY = Boolean(input.readOnly);
// Autonomous projects: no plan approval or questions; the agent decides and keeps going.
const AUTONOMOUS = Boolean(input.autonomous);
const APP_URL = "http://localhost:3000";
let browser = null;
let page = null;
let consoleErrors = [];

async function getPage() {
  if (page) return page;
  const { chromium } = await import("playwright-core");
  const { readdirSync } = await import("node:fs");
  const dir = readdirSync("/ms-playwright").find((d) => /^chromium-\d+$/.test(d));
  const arch = readdirSync(`/ms-playwright/${dir}`).find((d) => d.startsWith("chrome-linux"));
  browser = await chromium.launch({ executablePath: `/ms-playwright/${dir}/${arch}/chrome`, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("__forge")) consoleErrors.push(m.text().slice(0, 400));
  });
  page.on("pageerror", (e) => consoleErrors.push(`Uncaught: ${String(e.message).slice(0, 400)}`));
  // A visible cursor so people watching can follow what the QA agent does.
  await page.addInitScript(CURSOR_SCRIPT);
  page.on("load", () => page.evaluate(([x, y]) => window.__forgeCursor?.move(x, y), [cursor.x, cursor.y]).catch(() => undefined));
  await startScreencast(page);
  return page;
}

/* Live view: stream the QA browser to the builder (~6 fps JPEG, not stored). */
async function startScreencast(p) {
  const cdp = await p.context().newCDPSession(p);
  let last = 0;
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    const now = Date.now();
    if (now - last < 160) return;
    last = now;
    emit({ kind: "qa_frame", data: f.data });
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 }).catch(() => undefined);
}

const cursor = { x: 640, y: 400 };
const CURSOR_SCRIPT = `(() => {
  if (window.__forgeCursor) return;
  const install = () => {
    const c = document.createElement("div");
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.2,.8,.2,1);transform:translate(640px,400px)";
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l7.5 19 2.6-7.8L22 10.6z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const s = document.createElement("style");
    s.textContent = "@keyframes __forgeRipple{from{transform:scale(.4);opacity:1}to{transform:scale(1.8);opacity:0}}";
    // What the agent is doing, next to the cursor (it fades out a moment after the step).
    const tag = document.createElement("div");
    tag.setAttribute("aria-hidden", "true");
    tag.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;max-width:320px;padding:4px 9px;border-radius:7px;background:rgba(17,19,24,.92);color:#fff;font:600 12px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:transform .45s cubic-bezier(.2,.8,.2,1),opacity .25s";
    document.documentElement.append(s, c, tag);
    let pos = [640, 400];
    let hideTimer = 0;
    const place = () => {
      // Right of and below the cursor; flipped left/up near the window's edges.
      const w = tag.offsetWidth || 160, h = tag.offsetHeight || 24;
      const x = pos[0] + 22 + w > innerWidth - 8 ? pos[0] - w - 10 : pos[0] + 22;
      const y = pos[1] + 26 + h > innerHeight - 8 ? pos[1] - h - 8 : pos[1] + 26;
      tag.style.transform = "translate(" + Math.max(8, x) + "px," + Math.max(8, y) + "px)";
    };
    window.__forgeCursor = {
      move(x, y) { c.style.transform = "translate(" + x + "px," + y + "px)"; pos = [x, y]; place(); },
      label(text, ms) {
        clearTimeout(hideTimer);
        if (!text) { tag.style.opacity = "0"; return; }
        tag.textContent = text; place(); tag.style.opacity = "1";
        hideTimer = setTimeout(() => { tag.style.opacity = "0"; }, ms || 2600);
      },
      click(x, y) {
        const r = document.createElement("div");
        r.setAttribute("aria-hidden", "true");
        r.style.cssText = "position:fixed;left:" + (x - 16) + "px;top:" + (y - 16) + "px;width:32px;height:32px;border-radius:50%;border:3px solid #f97316;z-index:2147483646;pointer-events:none;animation:__forgeRipple .6s ease-out forwards";
        document.documentElement.append(r);
        setTimeout(() => r.remove(), 700);
      },
    };
  };
  if (document.documentElement) install(); else document.addEventListener("DOMContentLoaded", install);
})();`;

/** Show what the agent is doing next to the cursor (in the picture people watch). */
async function showLabel(text, ms) {
  const p = await getPage();
  await p.evaluate(([t, d]) => window.__forgeCursor?.label(t, d), [text, ms]).catch(() => undefined);
}
const nameOf = (t) => (t.name || t.label || t.text || (t.role ? `the ${t.role}` : "") || t.selector || "an element").trim().slice(0, 60);

/** Glide the visible cursor to an element (and optionally show a click ripple), with a label. */
async function pointAt(loc, click, label) {
  const p = await getPage();
  if (label) await showLabel(label, 3200);
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  const box = await loc.boundingBox().catch(() => null);
  if (!box) return;
  cursor.x = Math.round(box.x + box.width / 2);
  cursor.y = Math.round(box.y + box.height / 2);
  await p.evaluate(([x, y]) => window.__forgeCursor?.move(x, y), [cursor.x, cursor.y]).catch(() => undefined);
  await p.mouse.move(cursor.x, cursor.y, { steps: 12 });
  await p.waitForTimeout(450);
  if (click) await p.evaluate(([x, y]) => window.__forgeCursor?.click(x, y), [cursor.x, cursor.y]).catch(() => undefined);
}

async function locate(t) {
  const p = await getPage();
  if (t.selector) return p.locator(t.selector).first();
  if (t.role) return p.getByRole(t.role, t.name ? { name: t.name } : {}).first();
  if (t.label) return p.getByLabel(t.label).first();
  if (t.text) return p.getByText(t.text).first();
  throw new Error("Give role (+ name), label, text or selector.");
}

async function snapshot(note) {
  const p = await getPage();
  const aria = await p.locator("body").ariaSnapshot({ timeout: 5000 }).catch((e) => `(snapshot failed: ${e.message})`);
  const errs = consoleErrors.splice(0);
  return text(
    `${note ? note + "\n" : ""}URL: ${p.url()}\nTitle: ${await p.title()}\n\nPage (accessibility tree):\n${aria.slice(0, 12000)}` +
      (errs.length ? `\n\nNew console errors:\n- ${errs.join("\n- ")}` : ""),
  );
}

const target = {
  role: z.string().optional().describe("ARIA role, e.g. button, link, textbox, tab, checkbox"),
  name: z.string().optional().describe("Accessible name to match with role"),
  label: z.string().optional().describe("Form field label"),
  text: z.string().optional().describe("Visible text"),
  selector: z.string().optional().describe("CSS selector (last resort)"),
};

const qaTools = createSdkMcpServer({
  name: "browser",
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    tool("open", "Open a path of the running app (e.g. / or /about) and return the page's accessibility tree.", { path: z.string() }, async ({ path }) => {
      const p = await getPage();
      const res = await p.goto(APP_URL + (path.startsWith("/") ? path : `/${path}`), { waitUntil: "load", timeout: 120_000 });
      await showLabel(`Opened ${path.startsWith("/") ? path : `/${path}`}`, 2200);
      await p.waitForTimeout(1200);
      return snapshot(`HTTP ${res?.status() ?? "?"}`);
    }),
    tool("snapshot", "Return the current page's accessibility tree and any new console errors.", {}, async () => snapshot()),
    tool("click", "Click an element, then return the updated page.", target, async (t) => {
      const loc = await locate(t);
      await pointAt(loc, true, `Clicking “${nameOf(t)}”`);
      await loc.click({ timeout: 5000 });
      await (await getPage()).waitForTimeout(800);
      return snapshot();
    }),
    tool("fill", "Type into a field (replacing its content), then return the updated page.", { ...target, value: z.string() }, async (t) => {
      const loc = await locate(t);
      await pointAt(loc, true, `Typing “${String(t.value).slice(0, 30)}”`);
      await loc.fill(t.value, { timeout: 5000 });
      return snapshot();
    }),
    tool("press", "Press a key (e.g. Enter, Escape, Tab) on the focused element.", { key: z.string() }, async ({ key }) => {
      await showLabel(`Pressing ${key}`, 2000);
      await (await getPage()).keyboard.press(key);
      await (await getPage()).waitForTimeout(600);
      return snapshot();
    }),
    tool("screenshot", "Take a screenshot of the current viewport to check layout and visuals.", {}, async () => {
      const buf = await (await getPage()).screenshot({ type: "png" });
      return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
    }),
    tool(
      "propose_test",
      [
        "Propose a repeatable test for a flow that works right now. Forge replays it after every new version, without you, and offers passing ones to the team to save.",
        "Use the same targets you used with click/fill (role + name, label, or text; a CSS selector only as a last resort) and add expect steps that check the outcome a user cares about.",
        "Start with an open step. Keep each test to one flow (3-20 steps).",
      ].join(" "),
      {
        title: z.string().describe('What it checks, e.g. "Voting twice moves the Leading badge"'),
        criterionId: z.string().optional().describe("The id of the spec criterion this test proves (e.g. c1a2b3), when it proves one"),
        steps: z
          .array(
            z.object({
              action: z.enum(["open", "click", "fill", "press", "expect"]),
              path: z.string().optional().describe("open: the app path"),
              target: z.object(target).optional().describe("click, fill, expect: the element"),
              value: z.string().optional().describe("fill: the text to type; expect contains: the text to find"),
              key: z.string().optional().describe("press: the key"),
              state: z.enum(["visible", "hidden", "contains"]).optional().describe("expect: what must be true"),
            }),
          )
          .min(1)
          .max(60),
      },
      async (test) => {
        emit({ kind: "qa_test", test });
        return text("Proposed. Forge will replay it once the test run ends.");
      },
    ),
    tool(
      "report_issue",
      "Report one problem you found. Call it once per distinct issue.",
      {
        severity: z.enum(["blocker", "major", "minor"]),
        title: z.string(),
        steps: z.string().describe("Exact steps to reproduce"),
        expected: z.string(),
        actual: z.string(),
      },
      async (issue) => {
        if (page) await showLabel(`Found a problem: ${String(issue.title).slice(0, 50)}`, 3500);
        emit({ kind: "qa_issue", issue });
        return text("Recorded.");
      },
    ),
  ],
});

let finished = false;
try {
  for await (const msg of query({
    prompt: input.prompt,
    options: {
      cwd: "/workspace",
      model: input.model,
      resume: QA ? undefined : input.sessionId || undefined,
      abortController,
      includePartialMessages: true,
      // The container is the security boundary: the agent may run any tool
      // inside it, and it has no access to the host.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: QA ? { browser: qaTools } : { forge: forgeTools },
      allowedTools: QA
        ? ["Read", "Glob", "Grep", "TodoWrite", ...["open", "snapshot", "click", "fill", "press", "screenshot", "report_issue", "propose_test"].map((n) => `mcp__browser__${n}`)]
        : [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite", "WebFetch", "WebSearch",
            "mcp__forge__ask_user", "mcp__forge__present_plan", "mcp__forge__save_to_library", "mcp__forge__look_at_page", "mcp__forge__update_spec",
          ],
      // The QA agent tests; it never changes the app.
      disallowedTools: QA
        ? ["Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]
        : READ_ONLY
          ? ["Write", "Edit", "Bash", "NotebookEdit", "mcp__forge__save_to_library", "mcp__forge__present_plan", "mcp__forge__update_spec"]
          : AUTONOMOUS
            ? ["mcp__forge__present_plan", "mcp__forge__ask_user"]
            : undefined,
      // Load the project's CLAUDE.md (which imports AGENTS.md).
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: input.appendSystemPrompt ?? "" },
    },
  })) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") emit({ kind: "session", sessionId: msg.session_id });
        break;

      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          emit({ kind: "delta", text: ev.delta.text });
        }
        break;
      }

      case "assistant":
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) emit({ kind: "assistant", text: block.text });
          else if (block.type === "tool_use") emit({ kind: "tool_call", toolUseId: block.id, tool: block.name, input: block.input });
        }
        break;

      case "user":
        if (Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result") {
              emit({ kind: "tool_result", toolUseId: block.tool_use_id, ok: !block.is_error, output: clip(toText(block.content)) });
            }
          }
        }
        break;

      case "result": {
        const u = msg.usage ?? {};
        emit({
          kind: "usage",
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          costUsd: msg.total_cost_usd ?? 0,
        });
        finished = true;
        emit(
          msg.subtype === "success"
            ? { kind: "done", status: "completed", result: msg.result }
            : { kind: "done", status: "failed", error: `Agent stopped: ${msg.subtype}` },
        );
        break;
      }
    }
  }
} catch (err) {
  if (!finished) {
    emit({ kind: "done", status: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : String(err?.message ?? err) });
  }
  console.error(err);
  await browser?.close().catch(() => undefined);
  process.exit(cancelled ? 0 : 1);
}
await browser?.close().catch(() => undefined);
if (!finished) emit({ kind: "done", status: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : "Agent ended without a result" });
