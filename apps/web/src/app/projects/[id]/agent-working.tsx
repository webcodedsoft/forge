"use client";

import type { RunEvent } from "@forge/protocol";
import { Square } from "lucide-react";
import { useEffect, useState } from "react";

/*
 * Shown at the bottom of the chat while the agent works: what it's doing right now (from the
 * latest event of the run), how long it has been going, and a moving accent so it's clearly alive.
 */

const VERBS: Record<string, string> = {
  Read: "Reading",
  Edit: "Editing",
  MultiEdit: "Editing",
  Write: "Writing",
  Glob: "Looking through the files",
  Grep: "Searching the code",
  WebFetch: "Reading a web page",
  WebSearch: "Searching the web",
  TodoWrite: "Planning the work",
  Task: "Working on a sub-task",
  mcp__forge__look_at_page: "Looking at the page",
  mcp__forge__save_to_library: "Saving to the library",
  mcp__forge__present_plan: "Writing up a plan",
};

/** What the agent is doing now, in a few words. */
export function currentActivity(events: RunEvent[], streaming: boolean): { title: string; detail?: string } {
  const start = events.findLastIndex((e) => e.type === "run.started");
  const run = start < 0 ? [] : events.slice(start + 1);
  const done = new Set(run.flatMap((e) => (e.type === "tool.result" ? [e.toolUseId] : [])));
  for (let i = run.length - 1; i >= 0; i--) {
    const e = run[i]!;
    if (e.type === "check.started") return { title: "Running Forge's checks", detail: "Types, lint, build and the page" };
    if (e.type === "check.result") return { title: e.ok ? "Saving the version" : "Fixing what the checks found" };
    if (e.type === "tool.call" && !done.has(e.toolUseId)) {
      const summary = e.summary?.replace(/^attachment · /, "") || undefined;
      if (e.tool === "Bash") return { title: "Running a command", detail: summary };
      if (e.tool.startsWith("mcp__browser__")) return { title: "Using the app", detail: summary };
      return { title: VERBS[e.tool] ?? "Working", detail: summary };
    }
    if (e.type === "tool.result" || e.type === "assistant.message") break;
  }
  return streaming ? { title: "Writing a reply" } : { title: "Thinking" };
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

export function AgentWorking({
  startedAt,
  title,
  detail,
  onStop,
  stopping,
}: {
  startedAt?: string;
  title: string;
  detail?: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const since = startedAt ? Date.parse(startedAt) : NaN;
  return (
    <div className="agent-working sticky bottom-0 z-10" role="status" aria-live="polite">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="agent-orb" aria-hidden>
          <span />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 text-[13px] font-semibold">
            <span key={title} className="agent-title truncate">
              {title}
            </span>
            <span className="agent-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </p>
          {detail && <p className="truncate font-mono text-[11.5px] text-ink-3">{detail}</p>}
        </div>
        {Number.isFinite(since) && <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3">{elapsed(now - since)}</span>}
        {onStop && (
          <button type="button" className="btn btn-g btn-sm shrink-0" onClick={onStop} disabled={stopping} title="Stop the agent">
            <Square size={11} className="fill-current" aria-hidden />
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      <span className="agent-bar" aria-hidden />
    </div>
  );
}
