import { File as FileIcon, FileImage, FileSpreadsheet, FileText, Presentation } from "lucide-react";
import { useState } from "react";
import { api } from "./api";

/*
 * Attachments: files people add to a request, when starting a project (home page) or in the
 * builder's prompt box. Saved in the project (.forge/uploads/) for the agent; Word, Excel and
 * PowerPoint files also get a text copy the agent reads (orchestrator uploads.ts).
 */

export type Attachment = { path: string; name: string; type: string };

export const MAX_ATTACHMENT_MB = 20;
export const MAX_ATTACHMENTS = 8;
/** For <input type="file" accept=…>. */
export const ATTACH_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,text/*,application/json";

const EXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** Browsers often send no type for .md, .csv… */
export const typeOf = (f: File) => f.type || EXT_TYPES[f.name.split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream";

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

/** Checks before uploading (size, count). Returns the problem, or null. */
export function attachmentProblem(files: File[], already = 0): string | null {
  if (files.length + already > MAX_ATTACHMENTS) return `Attach up to ${MAX_ATTACHMENTS} files per request.`;
  const big = files.find((f) => f.size > MAX_ATTACHMENT_MB * 1024 * 1024);
  return big ? `${big.name} is larger than ${MAX_ATTACHMENT_MB} MB.` : null;
}

/** Upload files to a project, one after another. */
export async function uploadFiles(projectId: string, files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of files) {
    const saved = await api.upload(projectId, { name: f.name, type: typeOf(f), dataBase64: await toBase64(f) });
    out.push({ path: saved.path, name: f.name, type: saved.type });
  }
  return out;
}

/** The line send() adds to a request; splitAttachments() in the builder reads it back. */
export const attachmentSuffix = (list: Attachment[]) =>
  list.length ? `\n\n(Attached files, open them with the Read tool: ${list.map((a) => a.path).join(", ")})` : "";

/** An icon for a file chip. */
export function AttachmentIcon({ name, type, size = 13 }: { name: string; type?: string; size?: number }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const t = type ?? "";
  if (t.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return <FileImage size={size} aria-hidden />;
  if (t.includes("spreadsheet") || ["xlsx", "csv", "tsv"].includes(ext)) return <FileSpreadsheet size={size} aria-hidden />;
  if (t.includes("presentation") || ext === "pptx") return <Presentation size={size} aria-hidden />;
  if (t.includes("pdf") || t.includes("word") || ["pdf", "docx", "md", "txt"].includes(ext)) return <FileText size={size} aria-hidden />;
  return <FileIcon size={size} aria-hidden />;
}

/** Whether an attachment path is an image we can show (a thumbnail). */
export const isImagePath = (path: string) => /^\.forge\/uploads\/[a-z0-9]+-[\w.-]+\.(png|jpe?g|gif|webp|svg)$/i.test(path);

/** Where the browser loads an attached image from (orchestrator workspace.ts). */
export const attachmentUrl = (projectId: string, path: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/uploads/file?path=${encodeURIComponent(path)}`;

/**
 * A small preview of an attached image; opens the full image in a new tab. Falls back to the
 * file icon if the image can't be loaded (e.g. the project's container was reset).
 */
export function AttachmentThumb({ projectId, path, name, size = 40, className = "" }: { projectId: string; path: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <AttachmentIcon name={name} size={Math.min(16, size)} />;
  return (
    <a
      href={attachmentUrl(projectId, path)}
      target="_blank"
      rel="noreferrer"
      title={`Open ${name}`}
      className={`block shrink-0 overflow-hidden rounded-md border border-line bg-surface-2 transition-opacity hover:opacity-85 ${className}`}
      style={{ width: size, height: size }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset */}
      <img src={attachmentUrl(projectId, path)} alt={name} loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
    </a>
  );
}

/** A larger preview of an attached image (an expanded feed row). Says so if it can't be loaded. */
export function AttachmentPreview({ projectId, path, name }: { projectId: string; path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p className="mt-1.5 flex items-center gap-2 rounded bg-surface p-2 text-[12px] text-ink-3">
        <FileImage size={14} aria-hidden />
        This image isn&apos;t available any more.
      </p>
    );
  return (
    <a href={attachmentUrl(projectId, path)} target="_blank" rel="noreferrer" className="mt-1.5 block w-fit" title={`Open ${name}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated API image */}
      <img
        src={attachmentUrl(projectId, path)}
        alt={name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-56 max-w-full rounded-md border border-line bg-surface object-contain"
      />
    </a>
  );
}
