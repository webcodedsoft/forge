"use client";

import type { GitHubIncoming, PrFeedback } from "@forge/protocol";
import { ArrowDownToLine, CircleAlert, CircleCheck, ExternalLink, MessageSquareText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/loading";
import { api } from "@/lib/api";

/*
 * The way back from GitHub, shown in the GitHub menu once the project has a repository:
 *   Changes on GitHub   commits engineers made there; "Bring them in" merges them into the
 *                       project (the agent resolves conflicts, Forge's checks decide)
 *   Review feedback     unresolved review comments and failing checks; "Send to the agent"
 */

const one = (s: string) => s.split("\n")[0]!.slice(0, 90);

export function GitHubRoundTrip({
  projectId,
  disabled,
  disabledReason,
  onStarted,
}: {
  projectId: string;
  /** The agent is working or there are unsaved changes. */
  disabled: boolean;
  disabledReason?: string;
  /** A run started: close the menu and show the chat. */
  onStarted: () => void;
}) {
  const [incoming, setIncoming] = useState<GitHubIncoming | null>(null);
  const [feedback, setFeedback] = useState<PrFeedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<{ incoming?: string; feedback?: string; action?: string }>({});
  const [busy, setBusy] = useState<"pull" | "send" | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [withChecks, setWithChecks] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setErrors({});
    const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
    return Promise.all([
      api.gitHubIncoming(projectId).then(setIncoming, (e) => setErrors((x) => ({ ...x, incoming: text(e) }))),
      api.gitHubFeedback(projectId).then(
        (f) => {
          setFeedback(f);
          setPicked(null);
        },
        (e) => setErrors((x) => ({ ...x, feedback: text(e) })),
      ),
    ]).finally(() => setLoading(false));
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    if (!feedback) return [];
    return [
      ...feedback.threads.map((t) => ({
        id: t.id,
        sent: t.sent,
        url: t.comments[0]?.url ?? "",
        title: `${t.path}${t.line ? `:${t.line}` : ""}`,
        text: `${t.comments[0]?.author}: ${one(t.comments[0]?.body ?? "")}`,
        extra: t.comments.length > 1 ? `${t.comments.length - 1} repl${t.comments.length === 2 ? "y" : "ies"}` : "",
      })),
      ...feedback.reviews.map((r) => ({ id: r.id, sent: r.sent, url: r.url, title: `Review · ${r.state.toLowerCase().replace(/_/g, " ")}`, text: `${r.author}: ${one(r.body)}`, extra: "" })),
      ...feedback.comments.map((c) => ({ id: c.id, sent: c.sent, url: c.url, title: "Comment", text: `${c.author}: ${one(c.body)}`, extra: "" })),
    ];
  }, [feedback]);
  // By default: everything not yet handed to the agent.
  const chosen = picked ?? new Set(items.filter((i) => !i.sent).map((i) => i.id));
  const failing = feedback?.checks.filter((c) => c.state === "failing") ?? [];
  const pending = feedback?.checks.filter((c) => c.state === "pending").length ?? 0;
  const sendCount = chosen.size + (withChecks ? failing.length : 0);

  async function run(kind: "pull" | "send", fn: () => Promise<unknown>) {
    setBusy(kind);
    setErrors((x) => ({ ...x, action: undefined }));
    try {
      await fn();
      onStarted();
    } catch (e) {
      setErrors((x) => ({ ...x, action: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <section aria-labelledby="gh-incoming" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h3 id="gh-incoming" className="flex items-center gap-1.5 font-semibold">
            <ArrowDownToLine size={14} className="text-ink-2" aria-hidden />
            Changes on GitHub
          </h3>
          <button type="button" className="btn btn-g btn-sm btn-icon ml-auto h-6 w-6" aria-label="Check GitHub again" disabled={loading || busy !== null} onClick={() => void load()}>
            {loading ? <Spinner size={12} /> : <RefreshCw size={12} aria-hidden />}
          </button>
        </div>
        {errors.incoming ? (
          <p className="text-danger">{errors.incoming}</p>
        ) : !incoming ? (
          <p className="text-ink-3">Checking {loading ? "…" : ""}</p>
        ) : incoming.behind === 0 ? (
          <p className="flex items-center gap-1.5 text-ink-2">
            <CircleCheck size={13} className="text-ok" aria-hidden />
            This project has everything on <code className="font-mono">{incoming.branch}</code>.
          </p>
        ) : (
          <>
            <p className="text-ink-2">
              {incoming.behind}
              {incoming.more ? "+" : ""} change{incoming.behind === 1 ? "" : "s"} on <code className="font-mono">{incoming.branch}</code> {incoming.behind === 1 ? "isn't" : "aren't"} in this
              project yet:
            </p>
            <ul className="max-h-28 overflow-y-auto rounded-md border border-line">
              {incoming.commits.slice(0, 20).map((c) => (
                <li key={c.sha} className="flex gap-2 border-b border-line px-2 py-1 text-[12px] last:border-b-0">
                  <span className="min-w-0 flex-1 truncate" title={c.message}>
                    {c.message}
                  </span>
                  <span className="shrink-0 text-ink-3">{c.author}</span>
                </li>
              ))}
            </ul>
            <p className="lab">
              Forge merges them in. If they clash with what was built here, the agent sorts it out; the result is saved only when Forge&apos;s checks pass.
            </p>
            <button
              type="button"
              className="btn btn-p btn-sm self-end"
              disabled={disabled || busy !== null}
              aria-busy={busy === "pull"}
              data-tip={disabled ? disabledReason : undefined}
              onClick={() => void run("pull", () => api.pullFromGitHub(projectId))}
            >
              {busy === "pull" ? <Spinner size={13} /> : <ArrowDownToLine size={13} aria-hidden />}
              {busy === "pull" ? "Merging…" : "Bring them in"}
            </button>
          </>
        )}
      </section>

      <section aria-labelledby="gh-feedback" className="flex flex-col gap-1.5 border-t border-line pt-3">
        <h3 id="gh-feedback" className="flex items-center gap-1.5 font-semibold">
          <MessageSquareText size={14} className="text-ink-2" aria-hidden />
          Review feedback
          {feedback?.pr && (
            <a href={feedback.pr.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-xs font-normal text-primary underline">
              #{feedback.pr.number}
              <ExternalLink size={11} aria-hidden />
            </a>
          )}
        </h3>
        {errors.feedback ? (
          <p className="text-danger">{errors.feedback}</p>
        ) : !feedback ? (
          <p className="text-ink-3">Checking {loading ? "…" : ""}</p>
        ) : (
          <>
            {feedback.pr && feedback.pr.state !== "OPEN" && <p className="text-ink-2">The pull request is {feedback.pr.state.toLowerCase()}.</p>}
            {feedback.pr?.reviewDecision === "CHANGES_REQUESTED" && <p className="pill pill-warn self-start">Changes requested</p>}
            {feedback.pr?.reviewDecision === "APPROVED" && <p className="pill pill-ok self-start">Approved</p>}
            {items.length === 0 && failing.length === 0 ? (
              <p className="flex items-center gap-1.5 text-ink-2">
                <CircleCheck size={13} className="text-ok" aria-hidden />
                {feedback.pr ? "No open review comments" : "No pull request (this project pushes to main)"}
                {feedback.checks.length ? `; ${pending ? `${pending} check${pending === 1 ? "" : "s"} still running` : "checks pass"}.` : "."}
              </p>
            ) : (
              <>
                <ul className="max-h-44 overflow-y-auto rounded-md border border-line">
                  {items.map((i) => (
                    <li key={i.id} className="border-b border-line last:border-b-0">
                      <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-[12px]">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={chosen.has(i.id)}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.target.checked) next.add(i.id);
                            else next.delete(i.id);
                            setPicked(next);
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-[11px] text-ink-2">{i.title}</span>
                            {i.sent && <span className="pill text-[10px]">Sent before</span>}
                            {i.extra && <span className="text-ink-3">{i.extra}</span>}
                          </span>
                          <span className="line-clamp-2 break-words">{i.text}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                  {failing.length > 0 && (
                    <li>
                      <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-[12px]">
                        <input type="checkbox" className="mt-0.5" checked={withChecks} onChange={(e) => setWithChecks(e.target.checked)} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 text-danger">
                            <CircleAlert size={12} aria-hidden />
                            {failing.length} failing check{failing.length === 1 ? "" : "s"}
                          </span>
                          <span className="line-clamp-2 break-words text-ink-2">{failing.map((c) => c.name).join(", ")}</span>
                        </span>
                      </label>
                    </li>
                  )}
                </ul>
                <button
                  type="button"
                  className="btn btn-p btn-sm self-end"
                  disabled={disabled || busy !== null || sendCount === 0}
                  aria-busy={busy === "send"}
                  data-tip={disabled ? disabledReason : "The agent addresses each point; you then send the new version to GitHub from here"}
                  onClick={() => void run("send", () => api.addressGitHubFeedback(projectId, { ids: [...chosen], checks: withChecks && failing.length > 0 }))}
                >
                  {busy === "send" && <Spinner size={13} />}
                  {busy === "send" ? "Starting…" : `Send ${sendCount} to the agent`}
                </button>
              </>
            )}
            {!feedback.checksAvailable && <p className="lab">The checks on GitHub couldn&apos;t be read. The Forge GitHub app may need permission to read them.</p>}
          </>
        )}
      </section>
      {errors.action && (
        <p className="rounded-md bg-danger-weak p-2.5 text-danger" role="alert">
          {errors.action}
        </p>
      )}
    </div>
  );
}
