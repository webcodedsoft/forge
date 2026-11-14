import { createProxyServer } from "http-proxy-3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { env } from "./env.ts";
import { z } from "zod";
import { recordProblems } from "./problems.ts";
import { previewHostSuffix, previewPort } from "./sandbox.ts";
import {
  memberPass,
  PASS_COOKIE,
  passCookie,
  passForShareToken,
  readCookie,
  shareStillValid,
  verifyEnterToken,
  verifyPass,
} from "./preview-access.ts";

/*
 * Preview proxy: http://<projectId>.preview.localhost:<PREVIEW_PORT>/ → the
 * project's Next.js dev server (HTTP and the HMR websocket).
 * Bound to loopback; previews are only reachable from this machine for now.
 */

// <projectId><suffix>, e.g. abc123.preview.localhost:7777 or abc123.preview.forge.example.com;
// <projectId>--compare<suffix> is the compare preview (an older version, see versions.ts).
const HOST = new RegExp(`^([a-z0-9]{6,32})(--compare)?${previewHostSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::\\d+)?$`);

const proxy = createProxyServer({ ws: true, xfwd: true });
proxy.on("error", (err, _req, res) => {
  if (res && "writeHead" in res && !res.headersSent) {
    (res as ServerResponse).writeHead(502, { "content-type": "text/html; charset=utf-8" });
    (res as ServerResponse).end(STARTING);
  } else {
    res?.destroy?.();
  }
  if (!String(err.message).includes("ECONNREFUSED")) console.error("preview proxy:", err.message);
});

/**
 * Forge's own page in the preview frame while the app can't be shown (starting, paused). It
 * matches Forge's look in both themes and says nothing about what runs the app.
 */
const page = (title: string, body: string, refresh = false) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>${title}</title><style>` +
  `:root{--bg:#f6f7f9;--ink:#1b1d22;--ink2:#5d6270;--ring:#e3e5ea;--pri:#7c4dff}` +
  `@media (prefers-color-scheme:dark){:root{--bg:#111318;--ink:#e8eaef;--ink2:#9aa0ad;--ring:#262a33}}` +
  `html,body{height:100%;margin:0}body{display:grid;place-items:center;background:var(--bg);color:var(--ink);` +
  `font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}` +
  `.box{text-align:center;max-width:22rem;padding:24px}` +
  `.spin{width:34px;height:34px;margin:0 auto 18px;border-radius:50%;border:3px solid var(--ring);border-top-color:var(--pri);animation:s 0.9s linear infinite}` +
  `h1{font-size:16px;font-weight:600;margin:0 0 6px}p{margin:0;color:var(--ink2)}` +
  `@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.5s}}` +
  `</style></head><body><div class="box"><div class="spin" aria-hidden="true"></div><h1>${title}</h1><p>${body}</p></div></body></html>`;

const STARTING = page("Getting your app ready…", "It will appear here in a moment.", true);

/** A page that isn't a spinner (no access, link expired). */
const notice = (title: string, body: string, extra = "") =>
  page(title, body).replace('<div class="spin" aria-hidden="true"></div>', "").replace("</body>", `${extra}</body>`);

/*
 * Access (preview-access.ts): every request needs a pass cookie for this project, except the
 * ping and the entry links that hand passes out. Inside the builder's iframe, a missing pass asks
 * the builder (postMessage) to fetch a fresh entry link.
 */
function project(req: IncomingMessage): { id: string; compare: boolean } | null {
  const m = HOST.exec((req.headers.host ?? "").toLowerCase());
  return m ? { id: m[1]!, compare: Boolean(m[2]) } : null;
}

async function hasPass(req: IncomingMessage, projectId: string): Promise<boolean> {
  const pass = verifyPass(readCookie(req, PASS_COOKIE));
  if (!pass || pass.p !== projectId) return false;
  return pass.k === "member" || (pass.s ? await shareStillValid(pass.s) : false);
}

/** The app never sees Forge's pass cookie. */
function stripPass(req: IncomingMessage) {
  const c = req.headers.cookie;
  if (!c) return;
  const rest = c
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${PASS_COOKIE}=`));
  if (rest.length) req.headers.cookie = rest.join("; ");
  else delete req.headers.cookie;
}

const redirect = (res: ServerResponse, to: string, cookie?: string) => {
  res.writeHead(302, { location: to, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
  res.end();
};

/** Entry links: /__forge/enter?t=… (team members, from the builder) and /__forge/share/<token>. */
async function handleEntry(req: IncomingMessage, res: ServerResponse, proj: { id: string; compare: boolean }): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/__forge/enter") {
    const t = verifyEnterToken(url.searchParams.get("t") ?? undefined);
    if (!t || t.p !== proj.id || t.c !== proj.compare) {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      res.end(notice("This link has expired", "Open the project in Forge again to see its preview."));
      return true;
    }
    const next = url.searchParams.get("next") ?? "/";
    redirect(res, next.startsWith("/") && !next.startsWith("//") ? next : "/", passCookie(memberPass(proj.id), req));
    return true;
  }
  const share = /^\/__forge\/share\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname);
  if (share) {
    const pass = proj.compare ? null : await passForShareToken(proj.id, share[1]!);
    if (!pass) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(notice("This preview link doesn't work any more", "It has expired or was turned off. Ask the person who shared it for a new link."));
      return true;
    }
    redirect(res, "/", passCookie(pass, req));
    return true;
  }
  return false;
}

function deny(req: IncomingMessage, res: ServerResponse) {
  // In the builder's iframe: ask the builder for a fresh entry link instead of showing this.
  const inFrame = req.headers["sec-fetch-dest"] === "iframe";
  const ask = inFrame
    ? `<script>try{parent.postMessage({type:"forge:preview-access"},${JSON.stringify(FORGE_ORIGIN)})}catch(e){}</script>`
    : "";
  res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(notice("This preview is private", "Open it from the project in Forge, or ask a builder for a share link.", ask));
}

async function target(req: IncomingMessage): Promise<string | null> {
  const m = HOST.exec((req.headers.host ?? "").toLowerCase());
  if (!m) return null;
  const port = await previewPort(m[1]!, Boolean(m[2]));
  return port ? `http://127.0.0.1:${port}` : null;
}

/*
 * Visual edit: every HTML page gets a small inspector script. When the builder
 * turns "Select element" on (postMessage), the user's click is captured and the
 * element's details are posted back to the builder. Messages are only accepted
 * from, and sent to, the Forge origin.
 */
const FORGE_ORIGIN = new URL(env.BETTER_AUTH_URL).origin;
// The reporter loads first and synchronously, so it sees errors from the app's own startup.
const INSPECTOR_TAG = '<script src="/__forge/report.js"></script><script src="/__forge/inspector.js" defer></script>';

/*
 * Fix from logs: the reporter sends the app's browser errors and failed requests to
 * POST /__forge/problems on the preview's own origin (see problems.ts). It runs in the Forge
 * preview and when the app is opened in its own tab. Written with String.raw so regex
 * backslashes stay as written; it must not contain template placeholders.
 */
const REPORTER_JS = String.raw`(() => {
  if (window.__forgeReporter) return;
  window.__forgeReporter = true;
  const NOISE = /__forge|\[HMR\]|\[Fast Refresh\]|React DevTools|hot-reloader|webpack-hmr|turbopack/i;
  const SKIP_URL = /\/_next\/|__nextjs|[?&]_rsc=|\/__forge\/|\.hot-update\./;
  const fetchOrig = window.fetch;
  const queue = [];
  const seen = new Map();
  let sent = 0;
  let timer = 0;
  const flush = () => {
    timer = 0;
    if (!queue.length) return;
    const body = JSON.stringify(queue.splice(0, 20));
    try { fetchOrig("/__forge/problems", { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {}); } catch (_) {}
  };
  const report = (source, message, detail) => {
    message = String(message || "").trim().slice(0, 500);
    detail = String(detail || "");
    if (!message || NOISE.test(message) || NOISE.test(detail.slice(0, 300))) return;
    const key = source + "|" + message;
    const now = Date.now();
    if (now - (seen.get(key) || 0) < 10000) return;
    seen.set(key, now);
    if (++sent > 50) return;
    queue.push({ source, message, detail: detail.slice(0, 6000), page: location.pathname + location.search });
    if (!timer) timer = setTimeout(flush, 1000);
  };
  const text = (v) => {
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  };
  addEventListener("error", (e) => {
    const el = e.target;
    if (el && el !== window && el.tagName) {
      const src = el.src || el.href || "";
      if (src && !SKIP_URL.test(src)) report("network", "Could not load " + el.tagName.toLowerCase() + " " + src.replace(location.origin, ""), "");
      return;
    }
    report("browser", e.message || "Uncaught error", (e.error && e.error.stack) || (e.filename ? e.filename + ":" + e.lineno : ""));
  }, true);
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report("browser", (r && r.message) || "Unhandled promise rejection: " + text(r), (r && r.stack) || "");
  });
  const errorOrig = console.error;
  console.error = function (...args) {
    try {
      const err = args.find((a) => a instanceof Error);
      const all = args.map(text).join(" ");
      report("browser", err ? err.message : all.split("\n")[0], all);
    } catch (_) {}
    return errorOrig.apply(this, args);
  };
  const where = (url) => {
    try {
      const u = new URL(url, location.href);
      return { same: u.origin === location.origin, label: u.origin === location.origin ? u.pathname : u.origin + u.pathname, href: u.href };
    } catch (_) { return { same: true, label: String(url), href: String(url) }; }
  };
  const check = (method, url, status) => {
    const w = where(url);
    if (SKIP_URL.test(w.href)) return;
    if (status >= 500 || (w.same && status >= 400 && status !== 401 && status !== 403)) {
      report("network", String(method).toUpperCase() + " " + w.label + " answered " + status, "");
    }
  };
  const failed = (method, url, err) => {
    const w = where(url);
    if (SKIP_URL.test(w.href)) return;
    report("network", String(method).toUpperCase() + " " + w.label + " failed: " + ((err && err.message) || "network error"), "");
  };
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init && init.method) || (input && input.method) || "GET";
    try {
      const res = await fetchOrig.apply(this, arguments);
      check(method, url, res.status);
      return res;
    } catch (err) {
      if (!(err && err.name === "AbortError")) failed(method, url, err);
      throw err;
    }
  };
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__forgeReq = [m, u]; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    let aborted = false;
    this.addEventListener("abort", () => { aborted = true; });
    this.addEventListener("loadend", () => {
      const r = this.__forgeReq;
      if (!r || aborted) return;
      if (this.status === 0) failed(r[0], String(r[1]), null); else check(r[0], String(r[1]), this.status);
    });
    return XS.apply(this, arguments);
  };
  addEventListener("pagehide", flush);
})();`;

const ProblemReport = z.object({
  source: z.enum(["browser", "network"]), // "server" only comes from the dev server log
  message: z.string().max(2000),
  detail: z.string().max(20000).optional(),
  page: z.string().max(1000).optional(),
});
/** Valid entries of a batch (at most 20); anything else is dropped one by one. */
const problemReports = (body: unknown) =>
  (Array.isArray(body) ? body.slice(0, 20) : []).flatMap((x) => {
    const r = ProblemReport.safeParse(x);
    return r.success ? [r.data] : [];
  });

/** Read a small JSON body (the reporter's batches are a few KB). */
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const INSPECTOR_JS = `(() => {
  if (window.__forgeInspector || window.parent === window) return;
  window.__forgeInspector = true;
  // Hidden scrollbars while the app is shown in Forge's preview frame (scrolling still works with
  // the wheel, trackpad, touch and keys); opened on its own, the app keeps its scrollbars. Added
  // first in <head>, so scrollbar styles the app sets itself still win.
  try {
    const st = document.createElement("style");
    st.id = "forge-preview-scrollbars";
    st.textContent = "*{scrollbar-width:none}::-webkit-scrollbar{display:none;width:0;height:0}";
    (document.head || document.documentElement).prepend(st);
  } catch (e) {}
  const FORGE = ${JSON.stringify(FORGE_ORIGIN)};
  let on = false;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f97316;background:rgba(249,115,22,.08);border-radius:3px;display:none;transition:all .05s";
  const tag = document.createElement("div");
  tag.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#f97316;color:#fff;font:600 11px system-ui;padding:2px 6px;border-radius:3px;display:none";
  const mount = () => document.documentElement.append(box, tag);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  const hide = () => { box.style.display = tag.style.display = "none"; };
  const label = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
  // A CSS path to the element. It stops at a stable landmark when there is one (an id that isn't
  // generated, a data-testid, an aria-label), so changes elsewhere on the page don't break it.
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const landmark = (el) => {
    const id = el.id;
    if (id && !/^[:\\d]|^radix-|^headlessui-|:r[0-9a-z]+:/.test(id) && document.querySelectorAll("#" + esc(id)).length === 1) return "#" + esc(id);
    for (const a of ["data-testid", "data-test", "data-id"]) {
      const v = el.getAttribute(a);
      if (v && document.querySelectorAll("[" + a + '="' + v.replace(/"/g, "") + '"]').length === 1) return "[" + a + '="' + v.replace(/"/g, "") + '"]';
    }
    const al = el.getAttribute("aria-label");
    if (al && al.length < 80 && document.querySelectorAll(el.tagName.toLowerCase() + '[aria-label="' + al.replace(/"/g, "") + '"]').length === 1)
      return el.tagName.toLowerCase() + '[aria-label="' + al.replace(/"/g, "") + '"]';
    return null;
  };
  const path = (el) => { const parts = []; while (el && el.nodeType === 1 && parts.length < 12 && el !== document.body) {
      const mark = landmark(el); if (mark) { parts.unshift(mark); break; }
      const p = el.parentElement; const same = p ? [...p.children].filter((c) => c.tagName === el.tagName) : [];
      parts.unshift(el.tagName.toLowerCase() + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(el) + 1) + ")" : "")); el = p; }
    return parts.join(" > "); };
  const describe = (el) => {
    const heading = el.closest("section,article,main,form,li")?.querySelector("h1,h2,h3,h4");
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().replace(/\\s+/g, " ").slice(0, 200),
      role: el.getAttribute("role") || "",
      classes: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 300),
      path: path(el),
      section: heading ? heading.innerText.trim().slice(0, 120) : "",
      url: location.pathname,
      html: el.outerHTML.slice(0, 1200),
    };
  };
  // mode: "select" posts the clicked element; "text" edits the clicked text in place.
  let mode = "select";
  window.addEventListener("message", (e) => {
    if (e.origin !== FORGE || !e.data || e.data.type !== "forge:inspect") return;
    on = !!e.data.on; mode = e.data.mode === "text" ? "text" : "select";
    document.documentElement.style.cursor = on ? (mode === "text" ? "text" : "crosshair") : ""; if (!on) hide();
  });
  // Edit text in place: the element becomes editable; Enter or leaving it reports the change.
  const editText = (el) => {
    const before = el.innerText;
    const d = describe(el);
    el.setAttribute("contenteditable", "plaintext-only");
    el.style.outline = "2px solid #8b6cf6"; el.style.outlineOffset = "2px";
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const finish = (save) => {
      el.removeEventListener("keydown", onKey, true); el.removeEventListener("blur", onBlur);
      el.removeAttribute("contenteditable"); el.style.outline = ""; el.style.outlineOffset = "";
      const after = el.innerText;
      if (!save || after.trim() === before.trim()) { el.innerText = before; parent.postMessage({ type: "forge:text-cancel" }, FORGE); return; }
      parent.postMessage({ type: "forge:text-edit", element: d, before: before.trim().slice(0, 500), after: after.trim().slice(0, 500) }, FORGE);
    };
    const onKey = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      ev.stopPropagation();
    };
    const onBlur = () => finish(true);
    el.addEventListener("keydown", onKey, true); el.addEventListener("blur", onBlur);
  };
  document.addEventListener("mousemove", (e) => {
    if (!on || !(e.target instanceof Element)) return;
    const r = e.target.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    Object.assign(tag.style, { display: "block", left: r.left + "px", top: Math.max(0, r.top - 20) + "px" });
    tag.textContent = label(e.target);
  }, true);
  document.addEventListener("click", (e) => {
    if (!on || !(e.target instanceof Element)) return;
    e.preventDefault(); e.stopPropagation();
    on = false; document.documentElement.style.cursor = ""; hide();
    if (mode === "text") {
      // Edit the innermost element that has its own text.
      let el = e.target;
      while (el && el !== document.body && !(el.innerText || "").trim()) el = el.parentElement;
      if (el && el !== document.body) editText(el); else parent.postMessage({ type: "forge:text-cancel" }, FORGE);
      return;
    }
    parent.postMessage({ type: "forge:selected", element: describe(e.target) }, FORGE);
  }, true);
  // Review-toolbar shortcuts (S, T, D, C, Esc) also work while focus is in the preview.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof Element && (t.closest("input, textarea, select, [contenteditable]"))) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (["s", "t", "d", "c", "Escape"].includes(k)) parent.postMessage({ type: "forge:key", key: k }, FORGE);
  });
  // Preview theme (from Forge's review toolbar): force the app's light or dark styles, or follow
  // the system. Rewrites prefers-color-scheme media rules (originals kept for "auto") and sets
  // the usual class/attribute hooks, so both media-query and class-based dark modes respond.
  let themeMode = "auto";
  const origMedia = new WeakMap();
  // <html> class/style changes wait until React has hydrated (it marks <html> with __react* keys),
  // otherwise React reports a hydration mismatch. Non-React pages: after 4 s. The media rules
  // below are invisible to React, so they apply straight away.
  let rootReady = false;
  const waitForHydration = () => {
    const start = Date.now();
    const tick = () => {
      if (Object.keys(document.documentElement).some((k) => k.startsWith("__react")) || Date.now() - start > 4000) {
        rootReady = true; applyTheme();
      } else setTimeout(tick, 100);
    };
    tick();
  };
  if (document.readyState === "complete") waitForHydration(); else window.addEventListener("load", waitForHydration);
  const applyTheme = () => {
    const root = document.documentElement;
    if (!rootReady) { /* the media rules only, for now */ }
    else if (themeMode === "auto") { root.classList.remove("dark", "light"); root.style.colorScheme = ""; }
    else {
      root.classList.toggle("dark", themeMode === "dark"); root.classList.toggle("light", themeMode === "light");
      root.style.colorScheme = themeMode;
    }
    const visit = (rules) => {
      for (const r of rules) {
        if (r.media && r.cssRules) {
          if (!origMedia.has(r)) origMedia.set(r, r.media.mediaText);
          const orig = origMedia.get(r);
          let next = orig;
          if (themeMode !== "auto" && /prefers-color-scheme/.test(orig)) {
            // (Inside this template string, regex backslashes are doubled.)
            const wantsDark = /prefers-color-scheme:\\s*dark/.test(orig);
            next = (themeMode === "dark") === wantsDark ? orig.replace(/\\(\\s*prefers-color-scheme:\\s*(dark|light)\\s*\\)/g, "all") : "not all";
          }
          if (r.media.mediaText !== next) r.media.mediaText = next;
        }
        if (r.cssRules) visit(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) { try { visit(sh.cssRules); } catch (_) { /* cross-origin sheet */ } }
  };
  setInterval(() => { if (themeMode !== "auto") applyTheme(); }, 1000); // new styles after hot reloads
  window.addEventListener("message", (e) => {
    if (e.origin === FORGE && e.data && e.data.type === "forge:theme") {
      themeMode = ["light", "dark"].includes(e.data.mode) ? e.data.mode : "auto"; applyTheme();
    }
  });

  // Drawing on the preview: Forge asks where the page is scrolled to, to screenshot that view.
  window.addEventListener("message", (e) => {
    if (e.origin === FORGE && e.data && e.data.type === "forge:get-scroll") {
      parent.postMessage({ type: "forge:scroll", x: scrollX, y: scrollY, path: location.pathname + location.search }, FORGE);
    }
  });
  // Comment pins: numbered markers on commented elements of the current page.
  let pins = [];
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
  const mountLayer = () => document.documentElement.append(layer);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountLayer); else mountLayer();
  const find = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
  // Finding a pinned element when the page has changed since the comment (its saved path may now
  // miss, or point at something else): check the saved path against what was saved about the
  // element (tag, classes, text), else search by those within the same card/section heading.
  const classOf = (html) => { const m = /class="([^"]*)"/.exec(html || ""); return m ? m[1] : null; };
  const headingOf = (el) => { const h = el.closest("section,article,main,form,li")?.querySelector("h1,h2,h3,h4"); return h ? h.innerText.trim().slice(0, 120) : ""; };
  const norm = (t) => (t || "").trim().replace(/\\s+/g, " ").slice(0, 200);
  const matches = (el, p) => {
    if (!el || el.tagName.toLowerCase() !== (p.tag || el.tagName.toLowerCase())) return false;
    const cls = classOf(p.html);
    if (cls !== null && String(el.getAttribute("class") || "") !== cls) return false;
    if (p.text && norm(el.innerText) !== p.text) return false;
    return true;
  };
  const locate = (p) => {
    const direct = find(p.selector);
    if (direct && (!p.tag || matches(direct, p))) return { el: direct, healed: false };
    if (!p.tag) return { el: direct, healed: false };
    const cls = classOf(p.html);
    let list = [...document.querySelectorAll(p.tag)].filter((el) => matches(el, p));
    if (!cls && !p.text) return { el: null, healed: false };
    if (list.length > 1 && p.section) list = list.filter((el) => headingOf(el) === p.section);
    return list.length === 1 ? { el: list[0], healed: true } : { el: null, healed: false };
  };
  // The part of the element that's actually visible: clipped by every scrolling or overflow-hidden
  // ancestor and by the window. null when none of it shows (e.g. scrolled out of a card list).
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    let top = r.top, left = r.left, bottom = r.bottom, right = r.right;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const ar = a.getBoundingClientRect();
      top = Math.max(top, ar.top); left = Math.max(left, ar.left); bottom = Math.min(bottom, ar.bottom); right = Math.min(right, ar.right);
      if (bottom <= top || right <= left) return null;
    }
    top = Math.max(top, 0); left = Math.max(left, 0); bottom = Math.min(bottom, innerHeight); right = Math.min(right, innerWidth);
    return bottom > top && right > left ? { top, left, bottom, right, width: right - left, height: bottom - top } : null;
  };
  const healed = new Set();
  let lastMissing = "";
  const drawPins = () => {
    const here = pins.filter((p) => p.page === location.pathname);
    const missing = [];
    while (layer.children.length > here.length) layer.lastChild.remove();
    here.forEach((p, i) => {
      let b = layer.children[i];
      if (!b) {
        b = document.createElement("button");
        b.type = "button";
        b.style.cssText = "position:fixed;pointer-events:auto;width:22px;height:22px;border-radius:11px 11px 11px 2px;border:2px solid #fff;color:#fff;font:700 11px system-ui;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);padding:0";
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); parent.postMessage({ type: "forge:pin-click", id: b.dataset.id }, FORGE); });
        layer.append(b);
      }
      const found = locate(p);
      const el = found.el;
      // Found again after the page changed: save its new path so it's found directly next time.
      if (el && found.healed && !healed.has(p.id)) {
        healed.add(p.id);
        parent.postMessage({ type: "forge:pin-reanchor", id: p.id, selector: path(el) }, FORGE);
      }
      if (!el) missing.push(p.id);
      // The pin sits on the element's top-right corner and moves with it. When that corner is
      // scrolled out of view (or clipped by a scrolling area), the pin hides rather than sticking
      // to the edge.
      const clip = el && visibleRect(el);
      const r = el && el.getBoundingClientRect();
      const inView = clip && r && r.right - 2 >= clip.left && r.right - 2 <= clip.right + 1 && r.top + 2 >= clip.top - 1 && r.top + 2 <= clip.bottom;
      if (!inView) { b.style.display = "none"; return; }
      b.dataset.id = p.id; b.textContent = String(p.n); b.title = p.title || "";
      b.style.background = p.active ? "#ea580c" : "#f97316";
      b.style.outline = p.active ? "3px solid rgba(249,115,22,.35)" : "none";
      Object.assign(b.style, { display: "block", left: Math.max(2, r.right - 12) + "px", top: Math.max(2, r.top - 12) + "px" });
    });
    // Tell the builder which pins can't be placed on this page (only when that changes).
    const key = missing.join(",");
    if (key !== lastMissing) { lastMissing = key; parent.postMessage({ type: "forge:pins-missing", ids: missing, page: location.pathname }, FORGE); }
  };
  // Redraw on every scroll frame (inner scroll areas too) and on resize, so pins move with the
  // page; the interval catches content that appears or moves without scrolling.
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawPins(); }); };
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
  setInterval(drawPins, 250);
  window.addEventListener("message", (e) => {
    if (e.origin !== FORGE || !e.data || e.data.type !== "forge:pins") return;
    pins = Array.isArray(e.data.pins) ? e.data.pins : []; drawPins();
    const focus = pins.find((p) => p.active && p.page === location.pathname);
    if (focus && e.data.scroll) find(focus.selector)?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  // Browser bar: report where the app is (also for client-side navigation), and take
  // back / forward / reload / go commands from Forge.
  let lastLoc = "";
  const reportLocation = () => {
    const loc = location.pathname + location.search + location.hash;
    if (loc === lastLoc) return;
    lastLoc = loc;
    parent.postMessage({ type: "forge:location", path: loc, title: document.title }, FORGE);
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); setTimeout(reportLocation, 0); return r; };
  }
  window.addEventListener("popstate", reportLocation);
  window.addEventListener("hashchange", reportLocation);
  setInterval(reportLocation, 1000); // catches anything the hooks miss
  window.addEventListener("message", (e) => {
    if (e.origin !== FORGE || !e.data || e.data.type !== "forge:nav") return;
    const a = e.data.action;
    if (a === "back") history.back();
    else if (a === "forward") history.forward();
    else if (a === "reload") location.reload();
    else if (a === "go" && typeof e.data.path === "string" && e.data.path.startsWith("/") && !e.data.path.startsWith("//")) location.assign(e.data.path);
  });

  // Forge's ⌘K / Ctrl+K works while focus is in the preview too.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); parent.postMessage({ type: "forge:open-palette" }, FORGE); }
  }, true);
  parent.postMessage({ type: "forge:inspector-ready" }, FORGE);
  reportLocation();
})();`;

const isDocumentRequest = (req: IncomingMessage) =>
  req.method === "GET" &&
  (req.headers["sec-fetch-dest"] === "iframe" ||
    req.headers["sec-fetch-dest"] === "document" ||
    (!req.headers["sec-fetch-dest"] && String(req.headers.accept ?? "").includes("text/html")));

/** Fetch an HTML page uncompressed and add the inspector script. */
async function serveDocument(req: IncomingMessage, res: ServerResponse, base: string) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string" && !["accept-encoding", "host", "connection"].includes(k)) headers.set(k, v);
  }
  const upstream = await fetch(base + (req.url ?? "/"), { headers, redirect: "manual" });
  const type = upstream.headers.get("content-type") ?? "";
  const out: Record<string, string | string[]> = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k)) out[k] = v;
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  if (!type.includes("text/html")) {
    res.writeHead(upstream.status, out);
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  }
  let html = await upstream.text();
  html = html.includes("</head>") ? html.replace("</head>", `${INSPECTOR_TAG}</head>`) : INSPECTOR_TAG + html;
  res.writeHead(upstream.status, out);
  res.end(html);
}

export function startPreviewProxy() {
  const server = createServer(async (req, res) => {
    // Forge checks the preview is reachable before showing it (the builder's preview-health.ts).
    if (req.url === "/__forge/ping") {
      res.writeHead(204, { "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end();
    }
    // Only Forge may set the user's API token (Entra phase); never trust one from the browser.
    delete req.headers["x-forge-access-token"];
    const proj = project(req);
    if (proj) {
      if (await handleEntry(req, res, proj).catch(() => false)) return;
      if (!(await hasPass(req, proj.id).catch(() => false))) return deny(req, res);
      stripPass(req);
    }
    const t = await target(req).catch(() => null);
    if (!t) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
      return res.end(page("Preview is paused", "It wakes up when the project is open in Forge.", true));
    }
    if (req.url === "/__forge/report.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(REPORTER_JS);
    }
    if (req.url === "/__forge/problems" && req.method === "POST") {
      const m = HOST.exec((req.headers.host ?? "").toLowerCase());
      try {
        const reports = problemReports(await readJson(req));
        // Problems of an older version (the compare preview) don't count.
        if (m && !m[2] && reports.length) await recordProblems(m[1]!, reports);
      } catch {
        /* malformed or too large: drop it */
      }
      res.writeHead(204);
      return res.end();
    }
    if (req.url === "/__forge/inspector.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(INSPECTOR_JS);
    }
    if (isDocumentRequest(req)) {
      return serveDocument(req, res, t).catch((err) => {
        if (!String(err?.cause?.code ?? err.message).includes("ECONNREFUSED")) console.error("preview document:", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
          res.end(STARTING);
        }
      });
    }
    proxy.web(req, res, { target: t });
  });

  server.on("upgrade", async (req, socket, head) => {
    const proj = project(req);
    if (!proj || !(await hasPass(req, proj.id).catch(() => false))) return socket.destroy();
    stripPass(req);
    const t = await target(req).catch(() => null);
    if (!t) return socket.destroy();
    proxy.ws(req, socket, head, { target: t });
  });

  server.listen(env.PREVIEW_PORT, "127.0.0.1", () => {
    console.log(`preview proxy on 127.0.0.1:${env.PREVIEW_PORT} for *${previewHostSuffix}`);
  });
  return server;
}
