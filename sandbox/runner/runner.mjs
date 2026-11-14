// Forge agent runner. Runs inside a project sandbox container.
//
// Input (env FORGE_INPUT_B64: base64 of one JSON object):
//   { prompt: string, sessionId?: string, model: string, appendSystemPrompt?: string, maxBudgetUsd?: number }
// Output (stdout, JSON Lines). Every line has `kind` and `at`:
//   session     { sessionId }
//   delta       { text }                       streamed assistant text
//   assistant   { text }                       complete assistant text block
//   tool_call   { toolUseId, tool, input }
//   tool_result { toolUseId, ok, output }
//   usage       { inputTokens, outputTokens, cacheReadTokens, costUsd, contextTokens }
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

/**
 * Wait until the page has stopped changing after an action (no DOM change for 150 ms), at most
 * `max` ms. Usually returns in a fraction of the fixed pause it replaces.
 */
async function settle(p, max = 800) {
  await p
    .evaluate(
      (limit) =>
        new Promise((resolve) => {
          let quiet;
          const finish = () => {
            obs.disconnect();
            clearTimeout(hard);
            resolve();
          };
          const obs = new MutationObserver(() => {
            clearTimeout(quiet);
            quiet = setTimeout(finish, 150);
          });
          obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          quiet = setTimeout(finish, 150);
          const hard = setTimeout(finish, limit);
        }),
      max,
    )
    .catch(() => p.waitForTimeout(250)); // the page navigated while waiting
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
    // Made to stand out on any page: a large magenta arrow with a white edge, a dark shadow (so it
    // shows on light and on dark backgrounds) and a soft pulsing halo around its tip.
    c.style.cssText = "position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.2,.8,.2,1);transform:translate(640px,400px)";
    c.innerHTML =
      '<span style="position:absolute;left:-13px;top:-13px;width:34px;height:34px;border-radius:50%;background:rgba(255,45,146,.28);box-shadow:0 0 0 2px rgba(255,45,146,.55);animation:__forgeHalo 1.4s ease-in-out infinite"></span>' +
      '<svg width="32" height="32" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))"><path d="M4 2l7.5 19 2.6-7.8L22 10.6z" fill="#ff2d92" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
    const s = document.createElement("style");
    s.textContent =
      "@keyframes __forgeRipple{from{transform:scale(.4);opacity:1}to{transform:scale(1.8);opacity:0}}" +
      "@keyframes __forgeHalo{0%,100%{transform:scale(.75);opacity:.9}50%{transform:scale(1.15);opacity:.45}}";
    // What the agent is doing, next to the cursor (it fades out a moment after the step).
    const tag = document.createElement("div");
    tag.setAttribute("aria-hidden", "true");
    tag.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;max-width:320px;padding:4px 9px;border-radius:7px;background:#ff2d92;color:#fff;font:600 12px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 0 0 1.5px #fff,0 3px 10px rgba(0,0,0,.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:transform .45s cubic-bezier(.2,.8,.2,1),opacity .25s";
    document.documentElement.append(s, c, tag);
    let pos = [640, 400];
    let hideTimer = 0;
    const place = () => {
      // Right of and below the cursor; flipped left/up near the window's edges.
      const w = tag.offsetWidth || 160, h = tag.offsetHeight || 24;
      const x = pos[0] + 28 + w > innerWidth - 8 ? pos[0] - w - 10 : pos[0] + 28;
      const y = pos[1] + 34 + h > innerHeight - 8 ? pos[1] - h - 8 : pos[1] + 34;
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
        r.style.cssText = "position:fixed;left:" + (x - 16) + "px;top:" + (y - 16) + "px;width:32px;height:32px;border-radius:50%;border:3px solid #ff2d92;box-shadow:0 0 0 1.5px #fff;z-index:2147483646;pointer-events:none;animation:__forgeRipple .6s ease-out forwards";
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
  // Short limits: the element was just found (see find), so these only cover a page that is still moving.
  await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => undefined);
  const box = await loc.boundingBox({ timeout: 1000 }).catch(() => null);
  if (!box) return;
  cursor.x = Math.round(box.x + box.width / 2);
  cursor.y = Math.round(box.y + box.height / 2);
  await p.evaluate(([x, y]) => window.__forgeCursor?.move(x, y), [cursor.x, cursor.y]).catch(() => undefined);
  await p.mouse.move(cursor.x, cursor.y, { steps: 6 });
  await p.waitForTimeout(220);
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

// The page as last shown to the agent. After a click or a key press usually little changes, so
// the agent gets only what changed (every result stays in its context for the rest of the run).
let lastSeen = { url: "", lines: [] };
const MAX_TREE = 9000;

/** Lines added and removed between two accessibility trees, or null when most of the page changed. */
function treeChanges(before, after) {
  const count = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before), b = count(after);
  const added = [], removed = [];
  for (const l of after) {
    if ((a.get(l) ?? 0) > 0) a.set(l, a.get(l) - 1);
    else added.push(l);
  }
  for (const l of before) {
    if ((b.get(l) ?? 0) > 0) b.set(l, b.get(l) - 1);
    else removed.push(l);
  }
  if (added.length + removed.length > Math.max(12, after.length * 0.5)) return null;
  return { added, removed };
}

/** `full`: always the whole page (opening a page, or the agent asked to look). */
/**
 * The element a step names, once it is on the page. A name that matches nothing fails within
 * 1.5 s (not after the 30 to 40 s of waiting it used to take) and says what could be meant instead.
 */
async function find(t) {
  const p = await getPage();
  const visible = (loc, ms) => loc.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
  const primary = await locate(t);
  if (await visible(primary, 1200)) return primary;
  // The name is often right and the role or kind of lookup wrong (a "searchbox" that is a plain
  // text field, a label that is really a placeholder). Try the other ways of finding that name.
  const name = (t.name || t.label || t.text || "").trim();
  if (name && !t.selector) {
    const others = [
      p.getByLabel(name),
      p.getByPlaceholder(name),
      ...["textbox", "searchbox", "combobox", "button", "link", "tab", "checkbox", "menuitem"].filter((r) => r !== t.role).map((r) => p.getByRole(r, { name })),
      p.getByTitle(name),
      p.getByText(name),
    ];
    for (const o of others) if (await visible(o.first(), 150)) return o.first();
  }
  const aria = await p.locator("body").ariaSnapshot({ timeout: 3000 }).catch(() => "");
  const kinds = /^\s*-\s*(button|link|tab|checkbox|radio|switch|textbox|searchbox|combobox|slider|spinbutton|menuitem|option)\b\s*("[^"]*")?/;
  const names = [...new Set(aria.split("\n").flatMap((l) => { const m = kinds.exec(l); return m && m[2] ? [`${m[1]} ${m[2]}`] : []; }))].slice(0, 40);
  throw new Error(
    `Nothing on the page (${new URL(p.url()).pathname}) matches ${nameOf(t)}${t.role ? ` (role ${t.role})` : ""}. Use an exact name from the page` +
      (names.length ? `. Things you can use here: ${names.join(", ")}` : "; call snapshot to see it."),
  );
}

/** Replace a field's content, typing it out so people watching see it appear (short pauses; long text is pasted). */
async function typeVisibly(loc, value) {
  await loc.fill("", { timeout: 3000 });
  if (value.length <= 60) await loc.pressSequentially(value, { delay: 25, timeout: 6000 });
  else await loc.fill(value, { timeout: 3000 });
}

/** A control that is switched off can't be used: say so at once instead of waiting for it. */
async function mustBeEnabled(loc, t, verb) {
  if (await loc.isDisabled({ timeout: 500 }).catch(() => false)) {
    const why = await loc.getAttribute("title", { timeout: 500 }).catch(() => null);
    throw new Error(`“${nameOf(t)}” is disabled, so it can't be ${verb}${why ? ` (its tooltip says: ${why})` : ""}. That may be intended or a problem: judge from what you were asked to test.`);
  }
}

// One browser, one page: actions run one after another, in the order they were asked for, even
// when the model asks for several at once (which would otherwise race on the same page).
let browserQueue = Promise.resolve();
const inTurn = (handler) => (...args) => {
  const run = browserQueue.then(() => handler(...args));
  browserQueue = run.catch(() => undefined);
  return run;
};
const SCREENS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1280, height: 800 } };

async function snapshot(note, full = false) {
  const p = await getPage();
  const aria = await p.locator("body").ariaSnapshot({ timeout: 5000 }).catch((e) => `(snapshot failed: ${e.message})`);
  const errs = consoleErrors.splice(0);
  const url = p.url();
  const lines = aria.split("\n");
  const changes = !full && url === lastSeen.url && lastSeen.lines.length ? treeChanges(lastSeen.lines, lines) : null;
  lastSeen = { url, lines };
  let body;
  if (changes && !changes.added.length && !changes.removed.length) body = "The page did not change.";
  else if (changes) {
    const cut = (list) => list.slice(0, 60).join("\n") + (list.length > 60 ? `\n… (${list.length - 60} more lines)` : "");
    body =
      "What changed on the page (the rest is as you last saw it; call snapshot for the whole page):" +
      (changes.added.length ? `\nNow shown:\n${cut(changes.added)}` : "") +
      (changes.removed.length ? `\nNo longer shown:\n${cut(changes.removed)}` : "");
  } else body = `Page (accessibility tree):\n${aria.slice(0, MAX_TREE)}${aria.length > MAX_TREE ? "\n… (cut off; the page is longer)" : ""}`;
  return text(`${note ? note + "\n" : ""}URL: ${url}\nTitle: ${await p.title()}\n\n${body}` + (errs.length ? `\n\nNew console errors:\n- ${errs.join("\n- ")}` : ""));
}

const target = {
  role: z.string().optional().describe("ARIA role, e.g. button, link, textbox, tab, checkbox"),
  name: z.string().optional().describe("Accessible name to match with role"),
  label: z.string().optional().describe("Form field label"),
  text: z.string().optional().describe("Visible text"),
  selector: z.string().optional().describe("CSS selector (last resort)"),
};

/** A browser tool: its calls run one at a time (see inTurn). */
const bt = (name, description, schema, handler) => tool(name, description, schema, inTurn(handler));

const qaTools = createSdkMcpServer({
  name: "browser",
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    bt("open", "Open a path of the running app (e.g. / or /about) and return the page's accessibility tree.", { path: z.string() }, async ({ path }) => {
      const p = await getPage();
      const res = await p.goto(APP_URL + (path.startsWith("/") ? path : `/${path}`), { waitUntil: "load", timeout: 120_000 });
      await showLabel(`Opened ${path.startsWith("/") ? path : `/${path}`}`, 2200);
      await settle(p, 1200);
      return snapshot(`HTTP ${res?.status() ?? "?"}`, true);
    }),
    bt("snapshot", "Return the whole current page (accessibility tree) and any new console errors. click, fill and press already tell you what changed.", {}, async () => snapshot(undefined, true)),
    bt("click", "Click an element, then return what changed on the page.", target, async (t) => {
      const loc = await find(t);
      await mustBeEnabled(loc, t, "clicked");
      await pointAt(loc, true, `Clicking “${nameOf(t)}”`);
      await loc.click({ timeout: 3000 });
      await settle(await getPage());
      return snapshot();
    }),
    bt("fill", "Type into a field (replacing its content), then return what changed on the page.", { ...target, value: z.string() }, async (t) => {
      const loc = await find(t);
      await mustBeEnabled(loc, t, "typed into");
      await pointAt(loc, true, `Typing “${String(t.value).slice(0, 30)}”`);
      await typeVisibly(loc, t.value);
      return snapshot();
    }),
    bt("press", "Press a key (e.g. Enter, Escape, Tab) on the focused element.", { key: z.string() }, async ({ key }) => {
      await showLabel(`Pressing ${key}`, 2000);
      await (await getPage()).keyboard.press(key);
      await settle(await getPage());
      return snapshot();
    }),
    bt(
      "steps",
      "Do several actions in a row and get back what changed on the page at the end. Much faster than one call per action: " +
        "use it whenever you know the next few actions (fill a form and submit it, click through tabs, add three items). " +
        "It stops at the first action that fails and tells you which one. Up to 10 actions.",
      {
        steps: z
          .array(
            z.object({
              action: z.enum(["open", "click", "fill", "press"]),
              path: z.string().optional().describe("open: the app path"),
              target: z.object(target).optional().describe("click, fill: the element"),
              value: z.string().optional().describe("fill: the text to type"),
              key: z.string().optional().describe("press: the key"),
            }),
          )
          .min(1)
          .max(10),
      },
      async ({ steps }) => {
        const p = await getPage();
        const done = [];
        let failed = "";
        for (const [i, s] of steps.entries()) {
          try {
            if (s.action === "open") {
              const path = (s.path ?? "/").startsWith("/") ? (s.path ?? "/") : `/${s.path}`;
              const res = await p.goto(APP_URL + path, { waitUntil: "load", timeout: 120_000 });
              await showLabel(`Opened ${path}`, 1800);
              await settle(p, 1000);
              done.push(`${i + 1}. Opened ${path} (HTTP ${res?.status() ?? "?"})`);
            } else if (s.action === "click") {
              const loc = await find(s.target ?? {});
              await mustBeEnabled(loc, s.target ?? {}, "clicked");
              await pointAt(loc, true, `Clicking “${nameOf(s.target ?? {})}”`);
              await loc.click({ timeout: 3000 });
              await settle(p);
              done.push(`${i + 1}. Clicked “${nameOf(s.target ?? {})}”`);
            } else if (s.action === "fill") {
              const loc = await find(s.target ?? {});
              await mustBeEnabled(loc, s.target ?? {}, "typed into");
              await pointAt(loc, true, `Typing “${String(s.value ?? "").slice(0, 30)}”`);
              await typeVisibly(loc, String(s.value ?? ""));
              done.push(`${i + 1}. Typed “${String(s.value ?? "").slice(0, 40)}” into “${nameOf(s.target ?? {})}”`);
            } else {
              await showLabel(`Pressing ${s.key}`, 1500);
              await p.keyboard.press(String(s.key ?? "Enter"));
              await settle(p);
              done.push(`${i + 1}. Pressed ${s.key}`);
            }
          } catch (e) {
            failed = `${i + 1}. FAILED (${s.action}${s.target ? ` “${nameOf(s.target)}”` : ""}): ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}. The remaining ${steps.length - i - 1} action(s) were not done.`;
            break;
          }
        }
        return snapshot([...done, failed].filter(Boolean).join("\n"));
      },
    ),
    bt(
      "screen",
      "Change the browser's screen size to check how the app looks and works on a phone, a tablet or a desktop. Returns the page at that size; take a screenshot afterwards to judge the layout. Set it back to desktop when you're done.",
      { size: z.enum(["phone", "tablet", "desktop"]) },
      async ({ size }) => {
        const p = await getPage();
        await p.setViewportSize(SCREENS[size]);
        await showLabel(`${size[0].toUpperCase()}${size.slice(1)} size (${SCREENS[size].width} px wide)`, 2500);
        await settle(p, 1000);
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth).catch(() => 0);
        return snapshot(`Screen: ${size}, ${SCREENS[size].width} x ${SCREENS[size].height}.${overflow > 4 ? ` The page is ${overflow} px wider than the screen (it scrolls sideways).` : " The page fits the width."}`, true);
      },
    ),
    bt("screenshot", "Take a screenshot of the current viewport to check layout and visuals.", {}, async () => {
      // JPEG: a fraction of a PNG's size, and plenty to judge layout.
      const buf = await (await getPage()).screenshot({ type: "jpeg", quality: 70 });
      return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] };
    }),
    bt(
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
    bt(
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
// How much the conversation holds now: what the latest model call read (new + cached) plus what it wrote.
let contextTokens = 0;
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
      // Stop a run that spends more than Forge allows for one request.
      ...(input.maxBudgetUsd > 0 ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      // Testing: a ceiling on model calls, so a test can't wander on.
      ...(input.maxTurns > 0 ? { maxTurns: input.maxTurns } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: QA ? { browser: qaTools } : { forge: forgeTools },
      allowedTools: QA
        ? ["Read", "Glob", "Grep", "TodoWrite", ...["open", "snapshot", "click", "fill", "press", "steps", "screen", "screenshot", "report_issue", "propose_test"].map((n) => `mcp__browser__${n}`)]
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
      // excludeDynamicSections: the working directory and git status go into the first message
      // instead, so the system prompt is the same for every project and conversation and the
      // provider's prompt cache is shared between them.
      systemPrompt: { type: "preset", preset: "claude_code", append: input.appendSystemPrompt ?? "", excludeDynamicSections: true },
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

      case "assistant": {
        // Sub-agents have their own context; only the main conversation counts.
        const u = msg.message?.usage;
        if (u && !msg.parent_tool_use_id) {
          contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) emit({ kind: "assistant", text: block.text });
          else if (block.type === "tool_use") emit({ kind: "tool_call", toolUseId: block.id, tool: block.name, input: block.input });
        }
        break;
      }

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
          contextTokens,
        });
        finished = true;
        emit(
          msg.subtype === "success"
            ? { kind: "done", status: "completed", result: msg.result }
            : QA && msg.subtype === "error_max_turns"
              ? // The test used all its steps: what it found so far still counts.
                { kind: "done", status: "completed", result: "The test reached its step limit before finishing. The problems listed are what it found until then; run a full test, or tell it what to focus on, to cover more." }
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
