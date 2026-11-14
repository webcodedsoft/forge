"use client";

import type { BranchesResponse, Version } from "@forge/protocol";
import { Select } from "@/components/select";
import { GitBranch, GitCompare, Lightbulb, RotateCcw, Trash2, LayoutTemplate } from "lucide-react";
import { useEffect, useState } from "react";
import { BusyLabel, SkeletonCards } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { Modal, ModalActions } from "@/components/modal";
import { api } from "@/lib/api";
import type { ComparePair } from "./compare-view";

/**
 * Versions of the current line (main, or an idea), with: see what a version changed,
 * try an idea from a version (a branch), and restore (a new version; history is kept).
 */
export function VersionsPanel({
  projectId,
  refreshKey,
  disabled,
  onError,
  onCompare,
}: {
  projectId: string;
  /** Changes whenever a new commit lands or the line switches, so the list reloads. */
  refreshKey: number;
  disabled: boolean;
  onError: (msg: string) => void;
  onCompare: (pair: ComparePair) => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [lines, setLines] = useState<BranchesResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [ideaFrom, setIdeaFrom] = useState<string | null>(null);
  const [ideaName, setIdeaName] = useState("");
  // A new version goes back to page 1, where it appears.
  const pager = usePagination(versions, 10, refreshKey);

  useEffect(() => {
    let cancelled = false;
    const fail = (e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e));
    api.versions(projectId).then((v) => !cancelled && setVersions(v), fail);
    api.branches(projectId).then((b) => !cancelled && setLines(b), fail);
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, onError]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setConfirming(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!versions)
    return (
      <div className="p-4">
        <SkeletonCards n={3} />
      </div>
    );
  const onIdea = lines && lines.current !== lines.main;
  const ideas = lines?.branches.filter((b) => !b.main) ?? [];

  return (
    <div className="p-4 text-sm">
      {lines && (ideas.length > 0 || onIdea) && (
        <section className="card mb-3 p-3" aria-label="Lines of work">
          <div className="flex items-center gap-2">
            <GitBranch size={15} className="text-ink-3" aria-hidden />
            <span className="lab">Working on</span>
            <Select
              ariaLabel="Line of work"
              size="sm"
              className="min-w-0 flex-1"
              value={lines.current}
              disabled={disabled || busy !== null}
              onChange={(name) => void act("switch", () => api.switchBranch(projectId, name))}
              options={lines.branches.map((b) => ({
                value: b.name,
                label: b.main ? "Main line" : b.name,
                hint: b.main ? "The app as the team uses it" : "An idea, separate from the main line",
                icon: b.main ? <GitBranch size={14} /> : <Lightbulb size={14} />,
              }))}
            />
          </div>
          {onIdea && (
            <div className="mt-2.5 flex flex-col gap-2 rounded-md bg-primary-weak px-3 py-2.5 text-[13px]">
              <p>
                You&apos;re trying the idea <code className="font-mono">{lines.current}</code>. New changes go here; the main line is untouched.
              </p>
              {confirming === "use" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ink-2">The main line will match this idea, as a new version.</span>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-p btn-sm" onClick={() => void act("use", () => api.useBranch(projectId, lines.current))}>
                    Use this idea
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-p btn-sm"
                    disabled={disabled || (busy !== null && busy !== "use")}
                    aria-busy={busy === "use"}
                    onClick={() => setConfirming("use")}
                  >
                    <BusyLabel busy={busy === "use"} busyText="Bringing in…">
                      Use in the main line
                    </BusyLabel>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={disabled || busy !== null}
                    onClick={() => void act("switch", () => api.switchBranch(projectId, lines.main))}
                  >
                    Back to the main line
                  </button>
                </div>
              )}
            </div>
          )}
          {ideas.some((b) => !b.current) && (
            <ul className="mt-2 flex flex-col">
              {ideas
                .filter((b) => !b.current)
                .map((b) => (
                  <li key={b.name} className="flex items-center gap-2 py-1 text-[13px]">
                    <Lightbulb size={13} className="text-ink-3" aria-hidden />
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</code>
                    {confirming === `del:${b.name}` ? (
                      <>
                        <button type="button" className="btn btn-g btn-sm" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void act("del", () => api.deleteBranch(projectId, b.name))}>
                          Delete idea
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-g btn-sm btn-icon"
                        aria-label={`Delete the idea ${b.name}`}
                        disabled={disabled || busy !== null}
                        onClick={() => setConfirming(`del:${b.name}`)}
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}
      <SaveAsTemplate projectId={projectId} disabled={disabled} onError={onError} />
      <ol className="space-y-2">
        {pager.items.map((v, i) => {
          const first = pager.from - 1 + i === versions.length - 1;
          return (
            <li key={v.sha} className="card p-3">
              <p className="line-clamp-2">{v.message}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                <code className="font-mono">{v.sha.slice(0, 7)}</code> · {new Date(v.at).toLocaleString()}
                {v.current && <span className="pill pill-pri">current</span>}
                {first && <span className="pill">Starting point</span>}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {!first && (
                  <button type="button" className="btn btn-sm" onClick={() => onCompare({ from: `${v.sha}^`, to: v.sha })} data-tip="What this version changed">
                    <GitCompare size={13} aria-hidden />
                    Changes
                  </button>
                )}
                {!v.current && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onCompare({ from: v.sha, to: versions[0]!.sha })}
                    data-tip="Compare this version with the current one"
                  >
                    Compare with current
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={disabled || busy !== null}
                  onClick={() => {
                    setIdeaFrom(ideaFrom === v.sha ? null : v.sha);
                    setIdeaName("");
                  }}
                  data-tip="Start a separate line from this version; the main line stays as it is"
                >
                  <Lightbulb size={13} aria-hidden />
                  Try an idea
                </button>
                {!v.current && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={disabled || (busy !== null && busy !== `restore:${v.sha}`)}
                    aria-busy={busy === `restore:${v.sha}`}
                    onClick={() => setConfirming(confirming === v.sha ? null : v.sha)}
                    data-tip={disabled ? "Wait for the agent to finish" : "Make the app match this version"}
                  >
                    {busy !== `restore:${v.sha}` && <RotateCcw size={13} aria-hidden />}
                    <BusyLabel busy={busy === `restore:${v.sha}`} busyText="Restoring…">
                      Restore
                    </BusyLabel>
                  </button>
                )}
              </div>
              {ideaFrom === v.sha && (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = ideaName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
                    if (!name) return;
                    setIdeaFrom(null);
                    void act("idea", () => api.createBranch(projectId, name, v.sha));
                  }}
                >
                  <input
                    className="in h-8 min-w-0 flex-1 py-0 text-[13px]"
                    placeholder="Name the idea, e.g. dark-menu"
                    aria-label="Name of the idea"
                    value={ideaName}
                    onChange={(e) => setIdeaName(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" className="btn btn-p btn-sm" disabled={!ideaName.trim()}>
                    Start idea
                  </button>
                </form>
              )}
              {confirming === v.sha && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <span className="flex-1">
                    The app will go back to how it was at this version. Later versions stay in the list, so you can undo this.
                  </span>
                  <button type="button" className="btn btn-g btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-p btn-sm" onClick={() => void act(`restore:${v.sha}`, () => api.restoreVersion(projectId, v.sha))}>
                    Restore
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <Pagination pager={pager} noun="versions" compact />
    </div>
  );
}

/** Saves the current version as a team template that new projects can start from. */
function SaveAsTemplate({ projectId, disabled, onError }: { projectId: string; disabled: boolean; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const t = await api.createTemplate({ projectId, name, description: description || undefined });
      setSaved(t.name);
      setOpen(false);
      setName("");
      setDescription("");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="card mb-3 flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="text-ink-2">
          {saved ? <>Saved as the team template &quot;{saved}&quot;.</> : "Reuse this app as a starting point for new projects."}
        </span>
        <button disabled={disabled} onClick={() => setOpen(true)} className="btn btn-sm shrink-0">
          <LayoutTemplate size={13} aria-hidden />
          Save as template
        </button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        busy={saving}
        icon={<LayoutTemplate size={19} aria-hidden />}
        title="Save as a team template"
        description="New projects can start from it. It keeps the code, API connections and this project's notes. Secret values aren't copied, only their names."
      >
        <form onSubmit={save} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="lab">Template name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team poll" required maxLength={80} className="in" autoFocus />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">What it&apos;s for (optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="in min-h-20" />
          </label>
          <ModalActions>
            <button type="button" onClick={() => setOpen(false)} className="btn btn-g" disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={!name.trim()} aria-busy={saving} className="btn btn-p">
              <BusyLabel busy={saving} busyText="Saving…">
                Save template
              </BusyLabel>
            </button>
          </ModalActions>
        </form>
      </Modal>
    </>
  );
}
