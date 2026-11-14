"use client";

import type { ReviewShot, VersionReview } from "@forge/protocol";
import { Monitor, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ForgeLoader } from "@/components/loading";
import { api } from "@/lib/api";

/*
 * "Look": how a version's pages look next to the version before it. Forge takes a screenshot of
 * every page at desktop and phone width when a version is saved (orchestrator review.ts) and
 * marks the pages whose pictures differ.
 *   Before and after   the two pictures side by side
 *   Differences        the earlier picture faded, with every changed pixel in pink
 */

const STATUS: Record<ReviewShot["status"], { cls: string; text: string }> = {
  changed: { cls: "pill pill-warn", text: "Changed" },
  new: { cls: "pill pill-pri", text: "New page" },
  removed: { cls: "pill pill-bad", text: "Removed" },
  same: { cls: "pill", text: "Same" },
};
const ORDER: Record<ReviewShot["status"], number> = { changed: 0, new: 1, removed: 2, same: 3 };

/** The page's overall status from its desktop and phone pictures. */
function pageStatus(shots: ReviewShot[]): ReviewShot["status"] {
  return [...shots].sort((a, b) => ORDER[a.status] - ORDER[b.status])[0]?.status ?? "same";
}

export function VersionLook({ projectId, sha, title, onClose }: { projectId: string; sha: string; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<VersionReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [viewport, setViewport] = useState<"desktop" | "phone">("desktop");
  const [mode, setMode] = useState<"sides" | "diff">("sides");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    api.review(projectId, sha).then(
      (r) => live && setReview(r),
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, sha]);

  const pages = useMemo(() => {
    const byRoute = new Map<string, ReviewShot[]>();
    for (const s of review?.shots ?? []) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s]);
    return [...byRoute.entries()]
      .map(([r, shots]) => ({ route: r, shots, status: pageStatus(shots) }))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.route.localeCompare(b.route));
  }, [review]);
  const current = pages.find((p) => p.route === route) ?? pages[0];
  const shot = current?.shots.find((s) => s.viewport === viewport) ?? current?.shots[0];
  const baseSha = review?.baseSha ?? null;
  const img = (version: string, name: string) => api.reviewImageUrl(projectId, version, name);
  // Same file name in both versions: a page keeps its name as long as its address stays the same.
  const before = shot && baseSha && shot.status !== "new" ? img(baseSha, shot.file) : null;
  const after = shot && shot.status !== "removed" ? img(sha, shot.file) : null;
  const diff = shot?.status === "changed" && shot.diffFile ? img(sha, shot.diffFile) : null;
  const changedCount = pages.filter((p) => p.status !== "same").length;

  return (
    <dialog
      ref={ref}
      aria-label="How this version looks"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto flex h-[calc(100dvh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/50"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">How this version looks</h2>
          <p className="truncate text-[12.5px] text-ink-2">
            {title} · <code className="font-mono">{sha.slice(0, 7)}</code>
            {baseSha ? (
              <>
                {" "}
                compared with <code className="font-mono">{baseSha.slice(0, 7)}</code>
              </>
            ) : (
              " · the first version with pictures"
            )}
          </p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Screen size">
          <button type="button" role="radio" aria-checked={viewport === "desktop"} className="mode" onClick={() => setViewport("desktop")}>
            <Monitor size={14} aria-hidden />
            Desktop
          </button>
          <button type="button" role="radio" aria-checked={viewport === "phone"} className="mode" onClick={() => setViewport("phone")}>
            <Smartphone size={14} aria-hidden />
            Phone
          </button>
        </div>
        <div className="seg" role="radiogroup" aria-label="View">
          <button type="button" role="radio" aria-checked={mode === "sides"} className="mode" onClick={() => setMode("sides")}>
            Before and after
          </button>
          <button type="button" role="radio" aria-checked={mode === "diff"} className="mode" disabled={!diff} onClick={() => setMode("diff")}>
            Differences
          </button>
        </div>
        <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>

      {error ? (
        <p className="m-auto max-w-sm p-6 text-center text-[13.5px] text-ink-2">{error}</p>
      ) : !review ? (
        <div className="m-auto">
          <ForgeLoader label="Loading the pictures…" />
        </div>
      ) : pages.length === 0 ? (
        <p className="m-auto max-w-sm p-6 text-center text-[13.5px] text-ink-2">No pictures were taken of this version.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label="Pages" className="flex shrink-0 gap-1 overflow-auto border-b border-line p-2 md:w-60 md:flex-col md:border-b-0 md:border-r">
            <p className="lab hidden px-2 py-1 md:block">
              {baseSha ? (changedCount ? `${changedCount} of ${pages.length} pages look different` : "Every page looks the same") : `${pages.length} pages`}
            </p>
            {pages.map((p) => (
              <button
                key={p.route}
                type="button"
                aria-current={p.route === current?.route ? "page" : undefined}
                onClick={() => setRoute(p.route)}
                className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${p.route === current?.route ? "bg-primary-weak text-ink" : "text-ink-2 hover:bg-surface-2"}`}
              >
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{p.route}</code>
                {(baseSha || p.status !== "same") && <span className={`${STATUS[p.status].cls} text-[10.5px]`}>{STATUS[p.status].text}</span>}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-auto bg-paper p-4">
            {shot && (
              <>
                <p className="lab mb-3">
                  {shot.status === "changed"
                    ? `${(Math.max(0.0001, shot.ratio ?? 0) * 100).toFixed(shot.ratio && shot.ratio >= 0.01 ? 0 : 2)}% of this ${shot.viewport} picture changed.`
                    : shot.status === "new"
                      ? "This page is new in this version."
                      : shot.status === "removed"
                        ? "This page existed before and is gone in this version."
                        : baseSha
                          ? `No visible change at ${shot.viewport} size.`
                          : "There is no earlier picture to compare with."}
                </p>
                {mode === "diff" && diff ? (
                  <Picture src={diff} label="Differences (changed pixels in pink)" phone={viewport === "phone"} />
                ) : (
                  <div className={`grid items-start gap-4 ${before && after ? "sm:grid-cols-2" : ""}`}>
                    {before && <Picture src={before} label="Before" phone={viewport === "phone"} />}
                    {after && <Picture src={after} label={before ? "After" : "This version"} phone={viewport === "phone"} />}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

function Picture({ src, label, phone }: { src: string; label: string; phone: boolean }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <figcaption className="lab">{label}</figcaption>
      {/* Screenshots served by Forge's own API (signed-in only); next/image has nothing to optimise here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={label} loading="lazy" className={`rounded-lg border border-line bg-white ${phone ? "w-full max-w-[390px]" : "w-full"}`} />
    </figure>
  );
}
