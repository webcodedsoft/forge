"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/*
 * Previews are private (orchestrator preview-access.ts). A preview frame first opens a short-lived
 * entry link, which gives this browser a pass for that preview and then shows the page. The link
 * is fetched again when `reloadKey` changes (a reload, or the preview asking for access again).
 */
export function usePreviewEntry(projectId: string, active: boolean, opts: { compare?: boolean; next?: string; reloadKey?: unknown }): string | null {
  const [entry, setEntry] = useState<{ key: string; url: string } | null>(null);
  const want = active ? JSON.stringify([projectId, opts.compare ?? false, opts.reloadKey ?? 0]) : null;
  useEffect(() => {
    if (!want) return;
    let live = true;
    api.previewAccess(projectId, { compare: opts.compare, next: opts.next ?? "/" }).then(
      (r) => live && setEntry({ key: want, url: r.url }),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // `next` is read when the link is made; changing pages later happens inside the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  return entry && entry.key === want ? entry.url : null;
}

/** Calls `onAsk` when a preview frame says this browser has no pass (it expired, or never got one). */
export function onPreviewAccessRequest(previewOrigins: string[], onAsk: () => void): () => void {
  const handler = (e: MessageEvent) => {
    if (previewOrigins.includes(e.origin) && (e.data as { type?: string } | null)?.type === "forge:preview-access") onAsk();
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
