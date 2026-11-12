import { figmaToken } from "./integrations.ts";
import { ensureSandbox, exec, putFiles } from "./sandbox.ts";

/*
 * Figma → app. A frame link (Copy link on a frame in Figma) becomes two attachments for the agent:
 *   <name>.png     the frame rendered by Figma (2×; 1× if that's too big)
 *   <name>.md      a compact spec: layout (auto layout direction, gaps, padding), sizes, colours,
 *                  fonts, corner radii, and every text, as an indented outline
 * Fetched with the workspace's Figma access token (FIGMA_TOKEN). The token stays in Forge.
 */

export class FigmaError extends Error {}

const API = "https://api.figma.com/v1";
const MAX_PNG = 10 * 1024 * 1024;
const MAX_NODES = 600;

/** File key and node id from a figma.com design/file/proto link with ?node-id=12-34. */
export function parseFigmaUrl(raw: string): { key: string; nodeId: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new FigmaError("That isn't a Figma link.");
  }
  const m = /^\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,})(?:\/|$)/.exec(u.pathname);
  if (!/(^|\.)figma\.com$/.test(u.hostname) || !m) throw new FigmaError("That isn't a Figma link.");
  const node = u.searchParams.get("node-id");
  if (!node || !/^\d+[-:]\d+$/.test(node)) {
    throw new FigmaError("Link to one frame: in Figma, right-click the frame, choose Copy link, and paste that.");
  }
  return { key: m[1]!, nodeId: node.replace("-", ":") };
}

async function figma<T>(path: string): Promise<T> {
  const token = await figmaToken();
  if (!token) throw new FigmaError("Figma isn't connected yet. A workspace admin adds a Figma access token in Settings › Integrations.");
  const res = await fetch(API + path, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(60_000) });
  if (res.status === 403) throw new FigmaError("Figma refused: the access token can't open this file. Share the file with the token's account, or check the token.");
  if (res.status === 404) throw new FigmaError("Figma couldn't find that file or frame.");
  if (!res.ok) throw new FigmaError(`Figma answered ${res.status}. Try again in a moment.`);
  return (await res.json()) as T;
}

type Paint = { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; opacity?: number };
type FNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  children?: FNode[];
  absoluteBoundingBox?: { width: number; height: number };
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  cornerRadius?: number;
  fills?: Paint[];
  strokes?: Paint[];
  style?: { fontFamily?: string; fontWeight?: number; fontSize?: number; lineHeightPx?: number; textAlignHorizontal?: string };
};

const hex = (p: Paint) => {
  if (p.type !== "SOLID" || !p.color || p.visible === false) return null;
  const to = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  const a = (p.opacity ?? 1) * p.color.a;
  return `#${to(p.color.r)}${to(p.color.g)}${to(p.color.b)}${a < 0.99 ? to(a) : ""}`;
};

/** The node tree as an indented outline, plus the palette and fonts used. */
function spec(root: FNode): string {
  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  const lines: string[] = [];
  let count = 0;
  const walk = (n: FNode, depth: number) => {
    if (n.visible === false || count >= MAX_NODES) return;
    count++;
    const parts: string[] = [`${n.type.toLowerCase()} "${n.name}"`];
    const b = n.absoluteBoundingBox;
    if (b) parts.push(`${Math.round(b.width)}×${Math.round(b.height)}`);
    if (n.layoutMode && n.layoutMode !== "NONE") {
      const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((x) => Math.round(x ?? 0));
      parts.push(`${n.layoutMode === "HORIZONTAL" ? "row" : "column"} gap ${Math.round(n.itemSpacing ?? 0)} padding ${pad.join(" ")}`);
    }
    const fill = (n.fills ?? []).map(hex).find(Boolean);
    if (fill) {
      parts.push(n.type === "TEXT" ? `color ${fill}` : `bg ${fill}`);
      colors.set(fill, (colors.get(fill) ?? 0) + 1);
    }
    const stroke = (n.strokes ?? []).map(hex).find(Boolean);
    if (stroke) parts.push(`border ${stroke}`);
    if (n.cornerRadius) parts.push(`radius ${Math.round(n.cornerRadius)}`);
    if (n.type === "TEXT" && n.style) {
      const s = n.style;
      const font = `${s.fontFamily ?? "?"} ${s.fontWeight ?? 400} ${Math.round(s.fontSize ?? 0)}px`;
      parts.push(`font ${font}${s.lineHeightPx ? `/${Math.round(s.lineHeightPx)}px` : ""}${s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT" ? ` ${s.textAlignHorizontal.toLowerCase()}` : ""}`);
      fonts.set(font, (fonts.get(font) ?? 0) + 1);
    }
    if (n.characters) parts.push(`text: ${JSON.stringify(n.characters.slice(0, 300))}`);
    lines.push(`${"  ".repeat(depth)}- ${parts.join(" · ")}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} (${v}×)`)
      .join(", ");
  return [
    `# Figma frame: ${root.name}`,
    "",
    `Colours: ${top(colors, 16) || "none"}`,
    `Fonts: ${top(fonts, 12) || "none"}`,
    "",
    "## Layers (outline)",
    "",
    ...lines,
    ...(count >= MAX_NODES ? ["", `(Only the first ${MAX_NODES} layers are listed.)`] : []),
  ].join("\n");
}

/** Import a frame into the project's uploads; returns the attachments for the next request. */
export async function importFigmaFrame(projectId: string, url: string): Promise<{ path: string; name: string; type: string }[]> {
  const { key, nodeId } = parseFigmaUrl(url);
  const nodes = await figma<{ nodes: Record<string, { document: FNode } | null> }>(`/files/${key}/nodes?ids=${encodeURIComponent(nodeId)}`);
  const doc = nodes.nodes[nodeId]?.document;
  if (!doc) throw new FigmaError("Figma couldn't find that frame. Copy the link again from the frame itself.");

  let png: Buffer | null = null;
  for (const scale of [2, 1]) {
    const img = await figma<{ images: Record<string, string | null>; err?: string }>(`/images/${key}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`);
    const src = img.images[nodeId];
    if (!src) throw new FigmaError("Figma couldn't render that frame as an image.");
    const res = await fetch(src, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new FigmaError("Downloading the frame image from Figma failed.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= MAX_PNG) {
      png = buf;
      break;
    }
  }
  if (!png) throw new FigmaError("That frame is too large to import. Pick a smaller frame.");

  const base = (doc.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "frame").toLowerCase();
  const stamp = Date.now().toString(36);
  const files = [
    { path: `.forge/uploads/${stamp}-figma-${base}.png`, name: `${doc.name}.png`, type: "image/png", content: png },
    { path: `.forge/uploads/${stamp}-figma-${base}.md`, name: `${doc.name} (spec).md`, type: "text/markdown", content: Buffer.from(spec(doc) + `\n\nSource: ${url}\n`) },
  ];
  await ensureSandbox(projectId);
  await exec(projectId, [
    "sh",
    "-c",
    "mkdir -p .git/info && (grep -qx '.forge/uploads/' .git/info/exclude 2>/dev/null || echo '.forge/uploads/' >> .git/info/exclude)",
  ]);
  await putFiles(projectId, files.map((f) => ({ path: f.path, content: f.content })));
  return files.map(({ path, name, type }) => ({ path, name, type }));
}

export const _forTests = { spec };
