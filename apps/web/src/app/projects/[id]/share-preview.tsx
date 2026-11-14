"use client";

import type { PreviewShare, PreviewShareDuration } from "@forge/protocol";
import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BusyLabel, SkeletonRows } from "@/components/loading";
import { Modal, ModalActions } from "@/components/modal";
import { api } from "@/lib/api";

/*
 * "Share preview link…": links that let anyone (no Forge account) view this project's preview until
 * they expire. Each active link can be copied again (Forge keeps it encrypted; links made before
 * that can't be shown). Revoking one cuts access right away.
 */

const DURATIONS: { id: PreviewShareDuration; label: string }[] = [
  { id: "1h", label: "1 hour" },
  { id: "24h", label: "1 day" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

function until(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min left`;
  if (h < 48) return `${h} h left`;
  return `${Math.round(h / 24)} days left`;
}

export function SharePreviewModal({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const [shares, setShares] = useState<PreviewShare[] | null>(null);
  const [duration, setDuration] = useState<PreviewShareDuration>("24h");
  const [label, setLabel] = useState("");
  const [allowFeedback, setAllowFeedback] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<PreviewShare | null>(null);
  /** The link that was just copied ("new" for the one just created), for the "Copied" state. */
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = (key: string, url: string) =>
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
      },
      () => setError("Couldn't copy. Select the link and copy it yourself."),
    );

  const load = useCallback(() => api.previewShares(projectId).then(setShares, (e) => setError(e instanceof Error ? e.message : String(e))), [projectId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function create() {
    setBusy("create");
    setError(null);
    try {
      const s = await api.createPreviewShare(projectId, { duration, allowFeedback, ...(label.trim() ? { label: label.trim() } : {}) });
      setCreated(s);
      setCopied(null);
      setLabel("");
      if (s.url) await copy("new", s.url);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setCreated(null);
        onClose();
      }}
      title="Share the preview"
      description="Anyone with the link can view this app until it expires, and leave feedback if you allow it. They can't see the chat, code or settings."
      icon={<Link2 size={20} aria-hidden />}
      busy={busy === "create"}
    >
      <div className="flex flex-col gap-4">
        {created?.url && (
          <div className="rounded-[10px] border border-primary/40 bg-primary-weak/50 p-3">
            <p className="text-[13px] font-semibold">{copied === "new" ? "Link copied" : "Your new link"}</p>
            <div className="mt-1.5 flex gap-2">
              <input className="in h-9 min-w-0 flex-1 font-mono text-[12px]" readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <button
                type="button"
                className="btn btn-sm h-9"
                onClick={() => void copy("new", created.url!)}
              >
                {copied === "new" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                {copied === "new" ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="lab mt-1.5">Expires {new Date(created.expiresAt).toLocaleString()}. You can copy it again later under Active links.</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="lab">Link works for</span>
          <div className="seg w-full" role="radiogroup" aria-label="Link works for">
            {DURATIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={duration === d.id}
                className="mode flex-1 justify-center"
                onClick={() => setDuration(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <input
            className="in h-9 text-[13.5px]"
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional), e.g. For the client review"
            aria-label="Label"
          />
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={allowFeedback} onChange={(e) => setAllowFeedback(e.target.checked)} />
            <span>
              Let visitors leave feedback
              <span className="block text-[12px] text-ink-3">They pin notes to parts of the app under a name they type. The notes appear in Comments.</span>
            </span>
          </label>
          {error && (
            <p className="text-[13px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <div>
          <p className="lab mb-1.5">Active links</p>
          {shares === null ? (
            <SkeletonRows n={2} />
          ) : shares.length === 0 ? (
            <p className="text-[13px] text-ink-3">No active links.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
              {shares.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium">{s.label || "Preview link"}</p>
                    <p className="text-[12px] text-ink-3">
                      {until(s.expiresAt)} · opened {s.uses} time{s.uses === 1 ? "" : "s"} · by {s.createdBy}
                      {s.allowFeedback ? " · feedback on" : ""}
                    </p>
                  </div>
                  {s.url ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void copy(s.id, s.url!)}
                      aria-label={`Copy the link${s.label ? ` “${s.label}”` : ""}`}
                      data-tip={s.url}
                    >
                      {copied === s.id ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                      {copied === s.id ? "Copied" : "Copy"}
                    </button>
                  ) : (
                    <span className="text-[11.5px] text-ink-3" title="Made before Forge kept links. It still works; make a new one to get a link you can copy.">
                      Can&apos;t be shown
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-g btn-sm btn-danger"
                    aria-busy={busy === s.id}
                    onClick={() => {
                      setBusy(s.id);
                      api
                        .revokePreviewShare(projectId, s.id)
                        .then(load, (e) => setError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setBusy(null));
                    }}
                  >
                    <BusyLabel busy={busy === s.id}>
                      <Trash2 size={13} aria-hidden />
                      Turn off
                    </BusyLabel>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <ModalActions>
        <button type="button" className="btn btn-g btn-sm" onClick={onClose}>
          Done
        </button>
        <button type="button" className="btn btn-p btn-sm" aria-busy={busy === "create"} onClick={() => void create()}>
          <BusyLabel busy={busy === "create"} busyText="Creating…">
            <Link2 size={14} aria-hidden />
            Create link
          </BusyLabel>
        </button>
      </ModalActions>
    </Modal>
  );
}
