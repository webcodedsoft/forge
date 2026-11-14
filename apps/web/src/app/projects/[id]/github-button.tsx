"use client";

import type { GitHubStatus, PushBlocked } from "@forge/protocol";
import { ExternalLink, GitBranch, ShieldAlert } from "lucide-react";
import { Spinner } from "@/components/loading";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { GitHubRoundTrip } from "./github-roundtrip";

/*
 * Push to GitHub (Forge doesn't deploy; the company's GitHub is where code goes).
 *   made in Forge, no repo yet  → name it; Forge creates a private repo in the company org and pushes
 *   made in Forge, has a repo   → push new versions to its main
 *   imported                    → send changes as a pull request
 * Saved tests and the security check run first; failures block the push (project admins may override).
 * Once the project has a repository, the menu also shows the way back (github-roundtrip.tsx):
 * changes made on GitHub to bring in, and review feedback to hand to the agent.
 */

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "forge-app";

export function GitHubButton({
  projectId,
  projectName,
  disabled,
  disabledReason,
  refreshKey,
  onOpenHealth,
  onStarted,
}: {
  /** A run started from here (changes brought in, feedback sent): show the chat. */
  onStarted: () => void;
  projectId: string;
  projectName: string;
  disabled: boolean;
  disabledReason?: string;
  /** Bumps after a push, so the repo link appears. */
  refreshKey: number;
  onOpenHealth: () => void;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "done">("idle");
  const [result, setResult] = useState<{ url: string; text: string } | null>(null);
  const [blocked, setBlocked] = useState<PushBlocked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.gitHub(projectId).then(setStatus, () => undefined);
  }, [projectId, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !e.composedPath().includes(box.current) && phase !== "checking" && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && phase !== "checking" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open, phase]);

  if (!status) return null;
  const imported = status.source === "github";
  const needsRepo = !imported && !status.repo;

  async function push(override = false) {
    setPhase("checking");
    setError(null);
    setBlocked(null);
    setResult(null);
    try {
      const r = await api.pushToGitHub(projectId, { name: needsRepo ? name.trim() || slug(projectName) : undefined, override });
      setResult({
        url: r.url,
        text: r.pullRequest
          ? "Sent as a pull request."
          : r.created
            ? `Created ${r.repo} and pushed ${r.commits} version${r.commits === 1 ? "" : "s"}.`
            : `Pushed ${r.commits} new version${r.commits === 1 ? "" : "s"}.`,
      });
      setPhase("done");
      api.gitHub(projectId).then(setStatus, () => undefined);
    } catch (e) {
      setPhase("idle");
      if (e instanceof ApiError && e.status === 409 && e.body && typeof e.body === "object" && "failingTests" in e.body) setBlocked(e.body as PushBlocked);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="btn btn-p btn-sm"
        disabled={disabled && !open}
        onClick={() => {
          setOpen((o) => !o);
          setPhase("idle");
          setResult(null);
          setBlocked(null);
          setError(null);
        }}
        data-tip={disabled ? disabledReason : imported ? "Send the saved versions as a pull request" : "Push the saved versions to the company's GitHub"}
        aria-expanded={open}
      >
        <GitBranch size={14} aria-hidden />
        {imported ? "Pull request" : "Push to GitHub"}
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-40 flex max-h-[calc(100dvh-7rem)] w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-3 overflow-y-auto p-3.5 text-[13px]" role="dialog" aria-label="GitHub">
          {status.repo ? (
            <a href={status.url!} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-xs text-primary underline">
              {status.repo}
              <ExternalLink size={12} aria-hidden />
            </a>
          ) : needsRepo && !status.org ? (
            <p className="text-ink-2">
              GitHub isn&apos;t connected yet. A workspace admin connects the company&apos;s organization in{" "}
              <a href="/settings/integrations" className="font-semibold text-primary underline">
                Settings › Integrations
              </a>
              ; then you can push.
            </p>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="lab">New private repository in {status.org}</span>
              <input
                className="in h-9 py-0 font-mono text-[13px]"
                value={name}
                placeholder={slug(projectName)}
                onChange={(e) => setName(e.target.value)}
                aria-label="Repository name"
              />
            </label>
          )}
          <p className="lab">Forge replays the saved tests and runs the security check first. If either fails, nothing is pushed.</p>

          {blocked && (
            <div className="flex flex-col gap-2 rounded-md bg-danger-weak p-2.5" role="alert">
              <p className="flex items-start gap-1.5 font-semibold text-danger">
                <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
                {blocked.error}
              </p>
              {blocked.failingTests.length > 0 && (
                <ul className="list-disc pl-5 text-ink-2">
                  {blocked.failingTests.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setOpen(false);
                    onOpenHealth();
                  }}
                >
                  Open Health
                </button>
                {blocked.canOverride && (
                  <button type="button" className="btn btn-g btn-sm btn-danger" onClick={() => void push(true)} data-tip="Project admins only; the push is marked as overridden">
                    Push anyway
                  </button>
                )}
              </div>
            </div>
          )}
          {error && (
            <p className="rounded-md bg-danger-weak p-2.5 text-danger" role="alert">
              {error}
            </p>
          )}
          {result && (
            <p className="rounded-md bg-ok-weak p-2.5 text-ok" role="status">
              {result.text}{" "}
              <a href={result.url} target="_blank" rel="noreferrer" className="font-semibold underline">
                Open on GitHub
              </a>
            </p>
          )}
          {phase !== "done" && !(needsRepo && !status.org) && (
            <button type="button" className="btn btn-p btn-sm self-end" aria-busy={phase === "checking"} disabled={disabled} onClick={() => void push()}>
              {phase === "checking" ? (
                <>
                  <Spinner size={13} />
                  Checking and pushing…
                </>
              ) : imported ? (
                "Check and send"
              ) : needsRepo ? (
                "Check, create and push"
              ) : (
                "Check and push"
              )}
            </button>
          )}
          {status.repo && (
            <GitHubRoundTrip
              projectId={projectId}
              disabled={disabled}
              disabledReason={disabledReason}
              onStarted={() => {
                setOpen(false);
                onStarted();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
