import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { ensureSandbox, exec, putFiles } from "./sandbox.ts";

/*
 * Files people attach (when starting a project or in the prompt box). Saved in .forge/uploads/
 * (git-excluded, so they never end up in a version). The agent opens them with its Read tool:
 *   images, PDFs, text, Markdown, CSV, JSON, SVG   read directly
 *   Word (.docx), Excel (.xlsx), PowerPoint (.pptx) Forge also writes a text copy (<file>.md),
 *                                                  which is what the agent reads; the original stays
 * The agent may copy an attachment into public/ when it's meant to appear in the app (a logo, a photo).
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class UploadError extends Error {}

type Kind = "image" | "pdf" | "text" | "docx" | "xlsx" | "pptx";

const BY_EXT: Record<string, Kind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "text",
  pdf: "pdf",
  txt: "text",
  md: "text",
  markdown: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  html: "text",
  css: "text",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
};

/** What kind of file this is, from its type or (browsers often send none) its extension. */
export function uploadKind(name: string, type: string): Kind | null {
  const t = type.toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp)$/.test(t)) return "image";
  if (t === "image/svg+xml") return "text";
  if (t === "application/pdf") return "pdf";
  if (t.includes("wordprocessingml")) return "docx";
  if (t.includes("spreadsheetml")) return "xlsx";
  if (t.includes("presentationml")) return "pptx";
  if (t.startsWith("text/") || t === "application/json") return "text";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return BY_EXT[ext] ?? null;
}

export const UNSUPPORTED_MESSAGE =
  "Attach images (PNG, JPG, GIF, WebP, SVG), PDFs, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), or text files (TXT, Markdown, CSV, JSON). Older .doc/.xls/.ppt files: save them in the newer format first.";

/** Plain text of a Word, Excel or PowerPoint file, as Markdown. */
async function textOf(kind: "docx" | "xlsx" | "pptx", data: Buffer, name: string): Promise<string> {
  if (kind === "docx") {
    const r = await mammoth.extractRawText({ buffer: data });
    return `# ${name}\n\n${r.value.replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }
  if (kind === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data as unknown as ArrayBuffer);
    const parts = [`# ${name}`];
    for (const ws of wb.worksheets) {
      const rows: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (rows.length >= 2000) return;
        const cells = (row.values as unknown[]).slice(1).map((v) => {
          const x = v && typeof v === "object" ? ((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? "") : v;
          const s = x instanceof Date ? x.toISOString().slice(0, 10) : String(x ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        });
        rows.push(cells.join(","));
      });
      parts.push(`## Sheet: ${ws.name}${rows.length >= 2000 ? " (first 2000 rows)" : ""}`, ["```csv", ...rows, "```"].join("\n"));
    }
    return parts.join("\n\n") + "\n";
  }
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const parts = [`# ${name}`];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.files[f]!.async("string");
    // Each paragraph (<a:p>) on its own line, with its runs' text (<a:t>) joined.
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(""))
      .map((t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim())
      .filter(Boolean);
    parts.push(`## Slide ${i + 1}`, paras.join("\n") || "(no text)");
  }
  return parts.join("\n\n") + "\n";
}

export type SavedUpload = {
  /** What the agent reads (the text copy for Office files). */
  path: string;
  name: string;
  size: number;
  type: string;
  /** The original file, when `path` is a text copy of it. */
  original?: string;
};

export async function saveUpload(projectId: string, name: string, type: string, data: Buffer): Promise<SavedUpload> {
  const kind = uploadKind(name, type);
  if (!kind) throw new UploadError(UNSUPPORTED_MESSAGE);
  if (data.length > MAX_UPLOAD_BYTES) throw new UploadError("Files can be up to 20 MB.");
  const clean = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "file";
  const path = `.forge/uploads/${Date.now().toString(36)}-${clean}`;
  const files: { path: string; content: Buffer | string }[] = [{ path, content: data }];
  let readable = path;
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    let text: string;
    try {
      text = await textOf(kind, data, name);
    } catch {
      throw new UploadError(`Couldn't read ${name}. Is it a valid ${kind === "docx" ? "Word" : kind === "xlsx" ? "Excel" : "PowerPoint"} file?`);
    }
    readable = `${path}.md`;
    files.push({ path: readable, content: text });
  }
  await ensureSandbox(projectId);
  await exec(projectId, [
    "sh",
    "-c",
    "mkdir -p .git/info && (grep -qx '.forge/uploads/' .git/info/exclude 2>/dev/null || echo '.forge/uploads/' >> .git/info/exclude)",
  ]);
  await putFiles(projectId, files);
  return { path: readable, name, size: data.length, type: type || kind, ...(readable !== path ? { original: path } : {}) };
}
