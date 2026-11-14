"use client";

import type { CommentAnchor, ProjectComment, SharedPreviewInfo } from "@forge/protocol";
import { Clock, LinkIcon, MessageSquarePlus, MessagesSquare, MousePointerClick, X } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ForgeMark } from "@/components/forge-mark";
import { BusyLabel, ForgeLoader } from "@/components/loading";

/*
 * The page behind a preview share link. The address bar keeps the share link; the app runs in a
 * frame on its own preview address (orchestrator preview-access.ts), never on Forge's, so its code
 * can't act as anyone signed in to Forge.
 *
 * Feedback: a visitor (no Forge account) clicks "Leave feedback", then a part of the app, and
 * writes a note under their name. It lands in the project's Comments for the team; the visitor
 * sees the notes left through this link and the team's replies to them.
 */

type Thread = ProjectComment & { n: number; replies: ProjectComment[] };
type Picked = { tag: string; text: string; path: string; section: string; url: string; html: string };

const NAME_KEY = "forge.guest-name";

function timeLeft(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min left`;
  if (h < 48) return `${Math.round(h)} h left`;
  return `${Math.round(h / 24)} days left`;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function SharedPreview() {
  const { projectId, token } = useParams<{ projectId: string; token: string }>();
  const [share, setShare] = useState<SharedPreviewInfo | null | "gone">(null);
  const base = `/api/public/preview-shares/${encodeURIComponent(projectId)}/${encodeURIComponent(token)}`;

  useEffect(() => {
    let live = true;
    fetch(base, { cache: "no-store" })
      .then((r): Promise<SharedPreviewInfo | "gone"> => (r.ok ? (r.json() as Promise<SharedPreviewInfo>) : Promise.resolve("gone")))
      .then(
        (s) => live && setShare(s),
        () => live && setShare("gone"),
      );
    return () => {
      live = false;
    };
  }, [base]);

  const info = share && share !== "gone" ? share : null;
  const frameOrigin = useMemo(() => (info ? new URL(info.frameUrl).origin : null), [info]);
  const frame = useRef<HTMLIFrameElement>(null);

  const [comments, setComments] = useState<ProjectComment[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<CommentAnchor | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only shown in forms that appear after the link has loaded, so reading it here is safe.
  const [name, setName] = useState(() => (typeof window === "undefined" ? "" : readName()));
  const scrollToPin = useRef(false);

  const threads = useMemo<Thread[]>(() => {
    const roots = comments.filter((c) => !c.parentId);
    return roots.map((r, i) => ({ ...r, n: i + 1, replies: comments.filter((c) => c.parentId === r.id) }));
  }, [comments]);

  const load = useCallback(() => {
    if (!info?.feedback) return;
    fetch(`${base}/comments`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ProjectComment[]>) : Promise.reject(new Error("gone"))))
      .then(setComments, () => undefined);
  }, [base, info?.feedback]);
  // The team's replies arrive by checking again every 20 seconds.
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const post = useCallback(
    (message: unknown) => {
      if (frameOrigin) frame.current?.contentWindow?.postMessage(message, frameOrigin);
    },
    [frameOrigin],
  );

  const sendPins = useCallback(() => {
    const pins = threads
      .filter((t) => t.anchor && !t.resolved)
      .map((t) => ({
        id: t.id,
        n: t.n,
        page: t.anchor!.page,
        selector: t.anchor!.selector,
        tag: t.anchor!.tag,
        html: t.anchor!.html,
        text: t.anchor!.text,
        section: t.anchor!.section,
        title: `${t.userName}: ${t.body.slice(0, 80)}`,
        active: t.id === active,
      }));
    post({ type: "forge:pins", pins, scroll: scrollToPin.current });
    scrollToPin.current = false;
  }, [threads, active, post]);
  useEffect(sendPins, [sendPins]);

  useEffect(() => {
    post({ type: "forge:inspect", on: picking, mode: "select" });
  }, [picking, post]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameOrigin || e.origin !== frameOrigin) return;
      const data = e.data as { type?: string; element?: Picked; id?: string } | null;
      if (data?.type === "forge:selected" && data.element) {
        const el = data.element;
        const label = `<${el.tag}>${el.text ? ` "${el.text.slice(0, 40)}"` : ""}${el.section ? ` in ${el.section.slice(0, 40)}` : ""}`;
        setDraft({
          page: el.url,
          selector: el.path.slice(0, 1000),
          label: label.slice(0, 300),
          tag: el.tag.slice(0, 40),
          text: el.text.slice(0, 200),
          section: el.section.slice(0, 120),
          html: el.html.slice(0, 1200),
        });
        setPicking(false);
        setPanelOpen(true);
      } else if (data?.type === "forge:pin-click" && typeof data.id === "string") {
        setActive(data.id);
        setPanelOpen(true);
      } else if (data?.type === "forge:inspector-ready") {
        sendPins();
        if (picking) post({ type: "forge:inspect", on: true, mode: "select" });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameOrigin, sendPins, picking, post]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  async function send(input: { body: string; anchor: CommentAnchor } | { body: string; parentId: string }, as: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`${base}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, name: as }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Your comment could not be sent.");
      }
      try {
        localStorage.setItem(NAME_KEY, as);
      } catch {
        /* private browsing: the name is asked again next time */
      }
      setName(as);
      load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

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

  const open = threads.filter((t) => !t.resolved).length;

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
        {share.feedback && (
          <>
            <button
              type="button"
              className={`btn btn-sm ${picking ? "btn-p" : ""}`}
              aria-pressed={picking}
              onClick={() => {
                setDraft(null);
                setPicking((p) => !p);
              }}
            >
              <MessageSquarePlus size={14} aria-hidden />
              {picking ? "Click a part of the app…" : "Leave feedback"}
            </button>
            <button type="button" className="btn btn-g btn-sm" aria-expanded={panelOpen} onClick={() => setPanelOpen((o) => !o)}>
              <MessagesSquare size={14} aria-hidden />
              <span className="hidden sm:inline">Feedback</span>
              {open > 0 && <span className="pill pill-count text-[11px]">{open}</span>}
            </button>
          </>
        )}
      </header>
      {picking && (
        <p className="flex shrink-0 items-center justify-center gap-2 bg-primary-weak px-3 py-1.5 text-[12.5px] text-ink" role="status">
          <MousePointerClick size={13} aria-hidden />
          Click the part of the app your feedback is about. Press Esc to cancel.
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <iframe ref={frame} src={share.frameUrl} title={`${share.projectName} preview`} className="min-h-0 min-w-0 flex-1 border-0 bg-white" />
        {share.feedback && panelOpen && (
          <aside aria-label="Feedback" className="flex w-[340px] max-w-[85vw] shrink-0 flex-col border-l border-line bg-surface">
            <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[13px] font-semibold">Feedback</span>
              <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Close feedback" onClick={() => setPanelOpen(false)}>
                <X size={15} aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
              {error && (
                <p className="rounded-md bg-danger-weak px-2.5 py-2 text-[13px] text-danger" role="alert">
                  {error}
                </p>
              )}
              {draft && (
                <DraftForm
                  anchor={draft}
                  name={name}
                  onCancel={() => setDraft(null)}
                  onSend={async (body, as) => {
                    if (await send({ body, anchor: draft }, as)) setDraft(null);
                  }}
                />
              )}
              {!draft && threads.length === 0 && (
                <p className="card px-3 py-4 text-center text-[13px] text-ink-2">
                  Nothing here yet. Press <span className="font-medium text-ink">Leave feedback</span>, then click the part of the app you mean.
                </p>
              )}
              {threads.map((t) => (
                <ThreadCard
                  key={t.id}
                  thread={t}
                  active={t.id === active}
                  name={name}
                  onActivate={() => {
                    scrollToPin.current = t.id !== active;
                    setActive(t.id === active ? null : t.id);
                  }}
                  onReply={(body, as) => send({ body, parentId: t.id }, as)}
                />
              ))}
            </div>
            <p className="shrink-0 border-t border-line px-3 py-2 text-[11.5px] text-ink-3">
              The team that built this app sees your feedback with the name you give.
            </p>
          </aside>
        )}
      </div>
    </main>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="in h-8 w-full px-2.5 text-[13px]"
      value={value}
      maxLength={60}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Your name"
      aria-label="Your name"
      autoComplete="name"
    />
  );
}

function DraftForm({
  anchor,
  name,
  onSend,
  onCancel,
}: {
  anchor: CommentAnchor;
  name: string;
  onSend: (body: string, name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [as, setAs] = useState(name);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), [anchor]);
  const ready = body.trim().length > 0 && as.trim().length > 0;

  return (
    <form
      className="card space-y-2 border-primary p-3 shadow-[0_0_0_3px_var(--primary-ring)]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        void onSend(body.trim(), as.trim()).finally(() => setBusy(false));
      }}
    >
      <p className="lab">
        Feedback on <span className="font-mono text-ink">{anchor.label}</span>
        {anchor.page !== "/" && <> · {anchor.page}</>}
      </p>
      <textarea
        ref={ref}
        value={body}
        maxLength={4000}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What should change here, or what did you expect?"
        aria-label="Your feedback"
        rows={3}
        className="in w-full px-2.5 py-1.5"
      />
      <NameField value={as} onChange={setAs} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-g btn-sm">
          Cancel
        </button>
        <button disabled={!ready} aria-busy={busy} className="btn btn-p btn-sm">
          <BusyLabel busy={busy} busyText="Sending…">
            Send feedback
          </BusyLabel>
        </button>
      </div>
    </form>
  );
}

function ThreadCard({
  thread,
  active,
  name,
  onActivate,
  onReply,
}: {
  thread: Thread;
  active: boolean;
  name: string;
  onActivate: () => void;
  onReply: (body: string, name: string) => Promise<boolean>;
}) {
  const [reply, setReply] = useState("");
  // The name typed here, until one is remembered from an earlier comment.
  const [typed, setTyped] = useState<string | null>(null);
  const as = typed ?? name;
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <div ref={ref} className={`card p-3 ${active ? "border-primary shadow-[0_0_0_3px_var(--primary-ring)]" : ""} ${thread.resolved ? "opacity-60" : ""}`}>
      <button type="button" onClick={onActivate} className="flex w-full items-start gap-2 text-left" title="Show where this is in the app">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full rounded-bl-sm bg-primary text-[10px] font-bold text-primary-fg">{thread.n}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
          {thread.anchor?.label ?? "element"}
          {thread.anchor && thread.anchor.page !== "/" ? ` · ${thread.anchor.page}` : ""}
        </span>
        {thread.resolved && <span className="pill pill-ok">Done</span>}
      </button>
      {[thread, ...thread.replies].map((c) => (
        <div key={c.id} className="mt-2">
          <p className="text-xs">
            <span className="font-medium">{c.userName}</span>
            {!c.guest && <span className="pill ml-1.5 text-[10.5px]">Team</span>} <span className="text-ink-3">{when(c.createdAt)}</span>
          </p>
          <p className="whitespace-pre-wrap break-words">{c.body}</p>
        </div>
      ))}
      <form
        className="mt-3 flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reply.trim() || !as.trim() || busy) return;
          setBusy(true);
          void onReply(reply.trim(), as.trim())
            .then((ok) => ok && setReply(""))
            .finally(() => setBusy(false));
        }}
      >
        {!name && reply && <NameField value={as} onChange={setTyped} />}
        <div className="flex gap-2">
          <input
            value={reply}
            maxLength={4000}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            aria-label={`Reply to feedback ${thread.n}`}
            className="in h-8 min-w-0 flex-1 px-2.5 text-xs"
          />
          {reply.trim() && (
            <button className="btn btn-sm" disabled={!as.trim()} aria-busy={busy}>
              <BusyLabel busy={busy}>Send</BusyLabel>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
