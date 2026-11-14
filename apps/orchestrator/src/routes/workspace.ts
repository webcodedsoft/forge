import { Hono } from "hono";
import { MAX_UPLOAD_BYTES, saveUpload, UploadError } from "../uploads.ts";
import { FigmaError, importFigmaFrame } from "../figma.ts";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import { activeRunId } from "../runs.ts";
import { ensureSandbox, exec, putFiles, restartDevServer } from "../sandbox.ts";

/*
 * Read the project's files (Code view, "Add context"), attach files to a request,
 * download the latest saved version, and restart the app server.
 * Mounted at /api/projects; roles are checked in index.ts (reads: viewer, writes: builder).
 */

const MAX_FILES = 5000;
const MAX_VIEW_BYTES = 512 * 1024;

/** Runs inside the project container with the checks' Playwright and Chromium; prints a base64 PNG. */
const SCREENSHOT_SCRIPT = `
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/opt/forge/checks/");
const { chromium } = require("playwright-core");
const o = JSON.parse(process.env.FORGE_SHOT);
const dir = readdirSync("/ms-playwright").find((d) => /^chromium-\\d+$/.test(d));
const arch = readdirSync("/ms-playwright/" + dir).find((d) => d.startsWith("chrome-linux"));
const browser = await chromium.launch({ executablePath: "/ms-playwright/" + dir + "/" + arch + "/chrome" });
try {
  // Same colours as the user sees: emulate their colour scheme; a theme forced in Forge also sets
  // the <html> class/color-scheme hooks, like the preview inspector does.
  const page = await browser.newPage({ viewport: { width: o.width, height: o.height }, colorScheme: o.colorScheme });
  await page.goto("http://localhost:3000" + o.path, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
  if (o.forced) {
    await page.evaluate((mode) => {
      const root = document.documentElement;
      root.classList.toggle("dark", mode === "dark");
      root.classList.toggle("light", mode === "light");
      root.style.colorScheme = mode;
    }, o.colorScheme);
  }
  await page.evaluate(([x, y]) => window.scrollTo(x, y), [o.scrollX, o.scrollY]);
  await page.waitForTimeout(300);
  process.stdout.write((await page.screenshot({ type: "png" })).toString("base64"));
} finally {
  await browser.close();
}
`;

const safePath = (p: string) =>
  p.length > 0 && p.length < 500 && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "") && !/[\0\n]/.test(p);

export const workspace = new Hono<AppEnv>()
  // Tracked and new (not ignored) files, so node_modules and build output never show.
  .get("/:id/files", async (c) => {
    const id = c.req.param("id");
    await ensureSandbox(id);
    const r = await exec(id, ["git", "ls-files", "-co", "--exclude-standard"]);
    if (r.exitCode !== 0) return c.json({ error: "Could not list the files." }, 500);
    const files = r.stdout
      .split("\n")
      .filter((f) => f && !f.startsWith(".forge/library/") && !f.startsWith(".forge/uploads/"))
      .sort()
      .slice(0, MAX_FILES);
    return c.json({ files });
  })
  .get("/:id/files/content", async (c) => {
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    if (!safePath(path)) return c.json({ error: "Invalid path." }, 400);
    // Only files git knows about (or would): never ignored files such as env files.
    const known = await exec(id, ["git", "ls-files", "-co", "--exclude-standard", "--", path]);
    if (known.stdout.trim() !== path) return c.json({ error: "not_found" }, 404);
    const size = Number((await exec(id, ["stat", "-c", "%s", "--", path])).stdout.trim());
    if (!Number.isFinite(size)) return c.json({ error: "not_found" }, 404);
    if (size > MAX_VIEW_BYTES) return c.json({ path, size, tooLarge: true, content: null });
    const r = await exec(id, ["cat", "--", path]);
    const binary = r.stdout.slice(0, 8000).includes("\u0000") || r.stdout.includes("�");
    return c.json({ path, size, binary, content: binary ? null : r.stdout });
  })
  // Attach a file to the next request (uploads.ts): images, PDFs, Office files, text.
  .post("/:id/uploads", async (c) => {
    const parsed = z
      .object({ name: z.string().min(1).max(200), type: z.string().max(200), dataBase64: z.string().max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Files can be up to 20 MB." }, 400);
    try {
      return c.json(await saveUpload(c.req.param("id"), parsed.data.name, parsed.data.type, Buffer.from(parsed.data.dataBase64, "base64")), 201);
    } catch (err) {
      if (err instanceof UploadError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // An attached image, for thumbnails in the feed. Only images in .forge/uploads/.
  .get("/:id/uploads/file", async (c) => {
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    const m = /^\.forge\/uploads\/[a-z0-9]+-[\w.-]+\.(png|jpe?g|gif|webp|svg)$/i.exec(path);
    if (!m || !safePath(path)) return c.json({ error: "not_found" }, 404);
    await ensureSandbox(id);
    const r = await exec(id, ["sh", "-c", 'test -f "$1" && test "$(stat -c %s "$1")" -le $2 && base64 -w0 "$1"', "sh", path, String(MAX_UPLOAD_BYTES)]);
    if (r.exitCode !== 0 || !r.stdout) return c.json({ error: "not_found" }, 404);
    const ext = m[1]!.toLowerCase();
    const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    return c.body(Buffer.from(r.stdout.trim(), "base64"), 200, {
      "Content-Type": type,
      // Upload paths include a timestamp, so the file at a path never changes.
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      // An SVG opened on its own can't run scripts.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  })
  // Figma → app: import a frame (image + spec) as attachments for the next request.
  .post("/:id/figma", async (c) => {
    const body = z.object({ url: z.string().url().max(2000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Paste a Figma frame link." }, 400);
    try {
      return c.json({ attachments: await importFigmaFrame(c.req.param("id"), body.data.url) });
    } catch (err) {
      if (err instanceof FigmaError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // The latest saved version as a .zip (committed files only).
  .get("/:id/download", async (c) => {
    const id = c.req.param("id");
    await ensureSandbox(id);
    const r = await exec(id, ["sh", "-c", "git archive --format=zip HEAD | base64 -w0"]);
    if (r.exitCode !== 0 || !r.stdout) return c.json({ error: "Nothing saved to download yet." }, 400);
    const name = (c.req.query("name") ?? id).replace(/[^\w.-]+/g, "-").slice(0, 60) || id;
    return new Response(Buffer.from(r.stdout, "base64"), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}.zip"` },
    });
  })
  // A screenshot of a page as the user sees it (size and scroll), for drawing on.
  .post("/:id/screenshot", async (c) => {
    const id = c.req.param("id");
    const parsed = z
      .object({
        path: z.string().startsWith("/").max(500),
        width: z.number().int().min(200).max(2400),
        height: z.number().int().min(200).max(2400),
        scrollX: z.number().min(0).max(100000).default(0),
        scrollY: z.number().min(0).max(100000).default(0),
        colorScheme: z.enum(["light", "dark"]).default("light"),
        forced: z.boolean().default(false),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid screenshot request." }, 400);
    await ensureSandbox(id);
    const r = await exec(id, ["node", "--input-type=module", "-e", SCREENSHOT_SCRIPT], {
      env: [`FORGE_SHOT=${JSON.stringify(parsed.data)}`],
    });
    const png = r.stdout.trim();
    if (r.exitCode !== 0 || !png) return c.json({ error: `Could not take a screenshot: ${r.stderr.slice(-300)}` }, 500);
    return c.json({ png });
  })
  .post("/:id/sandbox/restart", async (c) => {
    const id = c.req.param("id");
    if (activeRunId(id)) return c.json({ error: "Wait for the agent to finish first." }, 409);
    await restartDevServer(id);
    return c.json({ ok: true });
  });
