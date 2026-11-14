"use client";

import { FlaskConical, Gauge, ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/loading";
import { api } from "@/lib/api";

/*
 * "Test the app": tell the test agent what to check and what to leave alone, and how thorough to
 * be, before it starts.
 *   Quick  goes straight to what you named (or the latest change) and stops when it knows
 *          whether it works: about a minute
 *   Full   every feature plus edge cases: several minutes
 * What you type is remembered per project in this browser, so the next test starts from it.
 */

type Depth = "quick" | "full";
type Saved = { only: string; skip: string; depth: Depth };

const keyFor = (projectId: string) => `forge.test-scope.${projectId}`;
function load(projectId: string): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(projectId)) ?? "{}") as Partial<Saved>;
    return { only: v.only ?? "", skip: v.skip ?? "", depth: v.depth === "full" ? "full" : "quick" };
  } catch {
    return { only: "", skip: "", depth: "quick" };
  }
}

export function TestButton({
  projectId,
  running,
  onStarted,
  onError,
}: {
  projectId: string;
  /** The agent is busy. */
  running: boolean;
  /** A test started: show the chat. */
  onStarted: () => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Saved>({ only: "", skip: "", depth: "quick" });
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const close = (e: MouseEvent) => box.current && !e.composedPath().includes(box.current) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  async function start() {
    setBusy(true);
    try {
      const only = scope.only.trim();
      const skip = scope.skip.trim();
      await api.startQa(projectId, { depth: scope.depth, ...(only ? { only } : {}), ...(skip ? { skip } : {}) });
      try {
        localStorage.setItem(keyFor(projectId), JSON.stringify({ only, skip, depth: scope.depth }));
      } catch {
        /* private browsing: nothing is remembered */
      }
      setOpen(false);
      onStarted();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const quick = scope.depth === "quick";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        disabled={running && !open}
        title={running ? "Wait for the agent to finish" : "A test agent clicks through the app and reports problems. Say what to test first."}
        aria-expanded={open}
        onClick={() => {
          if (!open) setScope(load(projectId));
          setOpen((o) => !o);
        }}
        className="btn btn-sm"
      >
        <FlaskConical size={14} aria-hidden />
        Test the app
      </button>
      {open && (
        <form
          className="pop absolute right-0 top-10 z-40 flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-3 p-3.5 text-[13px]"
          role="dialog"
          aria-label="Test the app"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !running) void start();
          }}
        >
          <div className="seg w-full" role="radiogroup" aria-label="How thorough">
            <button type="button" role="radio" aria-checked={quick} className="mode flex-1 justify-center" onClick={() => setScope({ ...scope, depth: "quick" })}>
              <Gauge size={14} aria-hidden />
              Quick
            </button>
            <button type="button" role="radio" aria-checked={!quick} className="mode flex-1 justify-center" onClick={() => setScope({ ...scope, depth: "full" })}>
              <ListChecks size={14} aria-hidden />
              Full
            </button>
          </div>
          <p className="lab">
            {quick
              ? "About a minute. Goes straight to what you name below (or the latest change) and stops once it knows whether it works."
              : "Several minutes. Every feature, then edge cases: empty and wrong input, double clicks, reloading, keyboard."}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="lab">What to test (optional)</span>
            <textarea
              ref={first}
              className="in min-h-16 px-2.5 py-1.5 text-[13px]"
              value={scope.only}
              maxLength={2000}
              onChange={(e) => setScope({ ...scope, only: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy && !running) void start();
              }}
              placeholder={quick ? "e.g. Voting on Tuesday and the Leading badge" : "Leave empty to test everything"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">What to leave alone (optional)</span>
            <textarea
              className="in min-h-12 px-2.5 py-1.5 text-[13px]"
              value={scope.skip}
              maxLength={2000}
              onChange={(e) => setScope({ ...scope, skip: e.target.value })}
              placeholder="e.g. The suggest-a-restaurant form, it isn't finished"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="btn btn-g btn-sm" onClick={() => setScope({ only: "", skip: "", depth: scope.depth })} disabled={!scope.only && !scope.skip}>
              Clear
            </button>
            <button type="submit" className="btn btn-p btn-sm" disabled={running} aria-busy={busy}>
              {busy ? <Spinner size={13} /> : <FlaskConical size={13} aria-hidden />}
              {busy ? "Starting…" : quick ? "Start quick test" : "Start full test"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
