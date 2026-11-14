"use client";

import { TriangleAlert } from "lucide-react";
import type { CommentAnchor, PresenceUser, ProjectComment } from "@forge/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { BusyLabel } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { api } from "@/lib/api";

export type Thread = ProjectComment & { n: number; replies: ProjectComment[] };

/** Groups comments into threads (roots in creation order, numbered from 1) with their replies. */
export function toThreads(comments: ProjectComment[]): Thread[] {
  const roots = comments.filter((c) => !c.parentId);
  return roots.map((r, i) => ({ ...r, n: i + 1, replies: comments.filter((c) => c.parentId === r.id) }));
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Comments tab: threads pinned to elements in the preview, plus the form for a new one. */
export function CommentsPanel({
  projectId,
  threads,
  meId,
  activeId,
  onActivate,
  draft,
  onDraftDone,
  onAskAgent,
  onError,
  missingPins,
}: {
  projectId: string;
  threads: Thread[];
  /** Comments whose spot the preview can't find on the page it shows (the page changed since). */
  missingPins?: Set<string>;
  meId: string | undefined;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  draft: CommentAnchor | null;
  onDraftDone: () => void;
  /** Omitted for viewers: only builders can hand a comment to the agent. */
  onAskAgent?: (thread: Thread) => void;
  onError: (msg: string) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const visible = useMemo(() => threads.filter((t) => showResolved || !t.resolved), [threads, showResolved]);
  const resolvedCount = threads.filter((t) => t.resolved).length;
  const PAGE = 8;
  const pager = usePagination(visible, PAGE, showResolved);
  // A thread picked from its pin in the preview: show the page it is on.
  const [seenActive, setSeenActive] = useState(activeId);
  if (activeId !== seenActive) {
    setSeenActive(activeId);
    const at = visible.findIndex((t) => t.id === activeId);
    if (at >= 0) pager.setPage(Math.floor(at / PAGE) + 1);
  }

  return (
    <div className="space-y-3 p-4 text-sm">
      {draft && <NewComment projectId={projectId} anchor={draft} onDone={onDraftDone} onError={onError} />}
      {!draft && visible.length === 0 && (
        <p className="card px-3 py-4 text-center text-ink-2">
          No open comments. Click <span className="font-medium text-ink">Comment</span> above the preview, then
          click any part of the app to leave a note for the team.
        </p>
      )}
      {pager.items.map((t) => (
        <ThreadCard
          key={t.id}
          projectId={projectId}
          thread={t}
          meId={meId}
          active={t.id === activeId}
          onActivate={() => onActivate(t.id === activeId ? null : t.id)}
          onAskAgent={onAskAgent ? () => onAskAgent(t) : undefined}
          onError={onError}
          pinMissing={missingPins?.has(t.id)}
        />
      ))}
      <Pagination pager={pager} noun="comments" compact />
      {resolvedCount > 0 && (
        <button onClick={() => setShowResolved((s) => !s)} className="btn btn-g btn-sm">
          {showResolved ? "Hide resolved" : `Show ${resolvedCount} resolved`}
        </button>
      )}
    </div>
  );
}

function NewComment({
  projectId,
  anchor,
  onDone,
  onError,
}: {
  projectId: string;
  anchor: CommentAnchor;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), [anchor]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api.createComment(projectId, { body, anchor });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="card space-y-2 border-primary p-3 shadow-[0_0_0_3px_var(--primary-ring)]">
      <p className="lab">
        New comment on <span className="font-mono text-ink">{anchor.label}</span>
        {anchor.page !== "/" && <> · {anchor.page}</>}
      </p>
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(e);
        }}
        placeholder="What should change here? Your teammates see this on the element."
        rows={3}
        className="in w-full px-2.5 py-1.5"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="btn btn-g btn-sm">
          Cancel
        </button>
        <button disabled={!body.trim()} aria-busy={saving} className="btn btn-p btn-sm">
          <BusyLabel busy={saving} busyText="Posting…">
            Post comment
          </BusyLabel>
        </button>
      </div>
    </form>
  );
}

function ThreadCard({
  projectId,
  thread,
  meId,
  active,
  onActivate,
  onAskAgent,
  onError,
  pinMissing,
}: {
  projectId: string;
  thread: Thread;
  meId: string | undefined;
  active: boolean;
  onActivate: () => void;
  onAskAgent?: () => void;
  onError: (msg: string) => void;
  pinMissing?: boolean;
}) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      className={`card p-3 ${active ? "border-primary shadow-[0_0_0_3px_var(--primary-ring)]" : ""} ${thread.resolved ? "opacity-60" : ""}`}
    >
      <button onClick={onActivate} className="flex w-full items-start gap-2 text-left" title="Show this comment's pin in the preview">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full rounded-bl-sm bg-primary text-[10px] font-bold text-primary-fg">
          {thread.n}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
          {thread.anchor?.label ?? "element"}
          {thread.anchor && thread.anchor.page !== "/" ? ` · ${thread.anchor.page}` : ""}
        </span>
        {thread.resolved && <span className="pill pill-ok">Resolved</span>}
      </button>
      {pinMissing && !thread.resolved && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-warn-weak px-2 py-1.5 text-[12px] text-ink-2">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          The page changed since this comment, so its pin can&apos;t be placed. The comment is kept.
        </p>
      )}

      {[thread, ...thread.replies].map((c) => (
        <div key={c.id} className="mt-2">
          <p className="text-xs">
            <span className="font-medium">{c.userName}</span>
            {c.guest && (
              <span className="pill pill-pri ml-1.5 text-[10.5px]" title={c.via ? `Left through the share link “${c.via}”` : "Left through a preview share link"}>
                Guest
              </span>
            )}{" "}
            <span className="text-ink-3">{when(c.createdAt)}</span>
            {((meId && c.userId === meId) || (c.guest && onAskAgent)) && (
              <button
                disabled={busy}
                onClick={() => run(() => api.deleteComment(projectId, c.id))}
                className="ml-2 text-ink-2 hover:text-danger disabled:opacity-50"
                aria-label={c.id === thread.id ? "Delete this thread" : "Delete this reply"}
              >
                Delete
              </button>
            )}
          </p>
          <p className="whitespace-pre-wrap">{c.body}</p>
        </div>
      ))}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reply.trim()) return;
          void run(async () => {
            await api.createComment(projectId, { body: reply, parentId: thread.id });
            setReply("");
          });
        }}
      >
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply…"
          aria-label={`Reply to comment ${thread.n}`}
          className="in min-w-0 flex-1 px-2.5 py-1.5 text-xs"
        />
      </form>
      <div className="mt-2 flex justify-end gap-2">
        <button
          disabled={busy}
          onClick={() => run(() => api.updateComment(projectId, thread.id, { resolved: !thread.resolved }))}
          className="btn btn-sm"
        >
          {thread.resolved ? "Reopen" : "Resolve"}
        </button>
        {!thread.resolved && onAskAgent && (
          <button onClick={onAskAgent} className="btn btn-p btn-sm">
            Ask the agent to fix this
          </button>
        )}
      </div>
    </div>
  );
}

/** Teammates with this project open, as initials; you are listed last. */
export function PresenceStack({ users, meId }: { users: PresenceUser[]; meId: string | undefined }) {
  if (users.length === 0) return null;
  const ordered = [...users.filter((u) => u.id !== meId), ...users.filter((u) => u.id === meId)];
  const others = ordered.filter((u) => u.id !== meId).length;
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  const hue = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  return (
    <div
      className="flex items-center"
      title={ordered.map((u) => (u.id === meId ? `${u.name} (you)` : u.name)).join(", ")}
      aria-label={others ? `${others} other ${others === 1 ? "person" : "people"} here` : "Only you are here"}
    >
      {ordered.slice(0, 5).map((u) => (
        <span
          key={u.id}
          className="-ml-1.5 grid size-6 place-items-center rounded-full border-2 border-surface text-[10px] font-semibold text-white first:ml-0"
          style={{ background: `hsl(${hue(u.id)} 55% 45%)` }}
        >
          {initials(u.name)}
        </span>
      ))}
      {ordered.length > 5 && <span className="ml-1 text-xs text-ink-2">+{ordered.length - 5}</span>}
    </div>
  );
}
