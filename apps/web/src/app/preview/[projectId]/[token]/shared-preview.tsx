"use client";

import { Clock, LinkIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ForgeMark } from "@/components/forge-mark";
import { ForgeLoader } from "@/components/loading";

/*
 * The page behind a preview share link. The address bar keeps the share link; the app runs in a
 * frame on its own preview address (orchestrator preview-access.ts), never on Forge's, so its code
 * can't act as anyone signed in to Forge.
 */

type Share = { projectName: string; expiresAt: string; frameUrl: string };

function timeLeft(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min left`;
  if (h < 48) return `${Math.round(h)} h left`;
  return `${Math.round(h / 24)} days left`;
}

export function SharedPreview() {
  const { projectId, token } = useParams<{ projectId: string; token: string }>();
  const [share, setShare] = useState<Share | null | "gone">(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/public/preview-shares/${encodeURIComponent(projectId)}/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then((r): Promise<Share | "gone"> => (r.ok ? (r.json() as Promise<Share>) : Promise.resolve("gone")))
      .then(
        (s) => live && setShare(s),
        () => live && setShare("gone"),
      );
    return () => {
      live = false;
    };
  }, [projectId, token]);

  if (share === null) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper">
        <ForgeLoader label="Opening the preview…" />
      </main>
    );
  }

  if (share === "gone") {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper p-6">
        <div className="card flex max-w-sm flex-col items-center gap-3 p-8 text-center">
          <ForgeMark size={40} />
          <h1 className="text-[17px] font-semibold">This preview link doesn&apos;t work any more</h1>
          <p className="text-[13.5px] text-ink-2">It has expired or was turned off. Ask the person who shared it for a new link.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col bg-paper">
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line bg-surface px-3 text-[13px]">
        <ForgeMark size={22} />
        <span className="min-w-0 truncate font-semibold">{share.projectName}</span>
        <span className="hidden items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2 sm:flex">
          <LinkIcon size={11} aria-hidden />
          Shared preview
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3" title={`Expires ${new Date(share.expiresAt).toLocaleString()}`}>
          <Clock size={12} aria-hidden />
          {timeLeft(share.expiresAt)}
        </span>
      </header>
      <iframe src={share.frameUrl} title={`${share.projectName} preview`} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </main>
  );
}
