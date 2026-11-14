"use client";

import type { RunEvent } from "@forge/protocol";
import { Bug, Camera, Code2, Eye, FlaskConical, Globe, Keyboard, type LucideIcon, MousePointerClick, Sparkles, TextCursorInput } from "lucide-react";
import { useMemo } from "react";

/*
 * The QA agent's browser, live, with a caption saying what it is doing right now ("Clicking
 * “Vote for Sushi Bar”") and the last few steps under it. Everything comes from the run's tool
 * calls, so the caption matches the chat. The runner also draws the same label next to the cursor
 * inside the browser (runner.mjs pointAt), so it shows in the picture as well.
 */

type Step = { id: string; icon: LucideIcon; text: string; tone?: "issue" | "test"; done: boolean };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The element a step points at, as people would name it. */
function target(i: Record<string, unknown>): string {
  return str(i.name) || str(i.label) || str(i.text) || (str(i.role) ? `the ${str(i.role)}` : "") || str(i.selector) || "an element";
}

/** One QA tool call in plain words. Null for calls that aren't worth showing (planning notes). */
export function qaStep(tool: string, input: unknown): Omit<Step, "id" | "done"> | null {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "mcp__browser__open":
      return { icon: Globe, text: `Opening ${str(i.path) || "/"}` };
    case "mcp__browser__click":
      return { icon: MousePointerClick, text: `Clicking “${short(target(i))}”` };
    case "mcp__browser__fill":
      return { icon: TextCursorInput, text: `Typing “${short(str(i.value), 40)}” into “${short(target(i), 40)}”` };
    case "mcp__browser__press":
      return { icon: Keyboard, text: `Pressing ${str(i.key) || "a key"}` };
    case "mcp__browser__snapshot":
      return { icon: Eye, text: "Reading the page" };
    case "mcp__browser__screenshot":
      return { icon: Camera, text: "Checking how it looks" };
    case "mcp__browser__report_issue":
      return { icon: Bug, text: `Found a ${str(i.severity) || "problem"}: ${short(str(i.title), 70)}`, tone: "issue" };
    case "mcp__browser__propose_test":
      return { icon: FlaskConical, text: `Writing a test: ${short(str(i.title), 70)}`, tone: "test" };
    case "Read":
      return { icon: Code2, text: `Reading the code: ${short(str(i.file_path).replace(/^\/workspace\//, ""), 50)}` };
    case "Grep":
    case "Glob":
      return { icon: Code2, text: "Looking through the code" };
    default:
      return null;
  }
}

function useQaSteps(events: RunEvent[], runId: string) {
  return useMemo(() => {
    const steps: Step[] = [];
    const finished = new Set<string>();
    let issues = 0;
    for (const e of events) {
      if (e.runId !== runId) continue;
      if (e.type === "tool.result") finished.add(e.toolUseId);
      if (e.type !== "tool.call") continue;
      const s = qaStep(e.tool, e.input);
      if (!s) continue;
      if (s.tone === "issue") issues++;
      steps.push({ ...s, id: e.toolUseId, done: false });
    }
    for (const s of steps) s.done = finished.has(s.id);
    const actions = steps.filter((s) => s.icon !== Code2).length;
    return { steps, issues, actions };
  }, [events, runId]);
}

export function QaLiveView({ frame, events, runId }: { frame: string; events: RunEvent[]; runId: string }) {
  const { steps, issues, actions } = useQaSteps(events, runId);
  const last = steps[steps.length - 1];
  // Between steps the agent is deciding what to do next.
  const now = last && !last.done ? last : null;
  const Icon = now?.icon ?? Sparkles;
  const recent = steps.slice(now ? -4 : -3, now ? -1 : undefined).reverse();

  return (
    <div className="pop mx-auto flex h-full max-w-5xl flex-col overflow-hidden bg-[#111318] text-[#e8eaef]">
      <p className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span className="size-2 animate-pulse rounded-full bg-[#f26363]" aria-hidden />
        QA agent&apos;s browser (live)
        <span className="ml-auto text-[#9aa0ad]">
          {actions} step{actions === 1 ? "" : "s"}
          {issues > 0 && (
            <span className="ml-2 text-[#f2a463]">
              · {issues} problem{issues === 1 ? "" : "s"} found
            </span>
          )}
        </span>
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/jpeg;base64,${frame}`} alt="Live view of the QA agent testing the app" className="min-h-0 w-full flex-1 object-contain" />
      <div className="border-t border-white/10 px-3 py-2" role="status" aria-live="polite">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold">
          <span
            className={`grid size-6 shrink-0 place-items-center rounded-md ${
              now?.tone === "issue" ? "bg-[#f2a463]/20 text-[#f2a463]" : now?.tone === "test" ? "bg-[#6dd39b]/20 text-[#6dd39b]" : "bg-[#7c4dff]/25 text-[#b9a2ff]"
            }`}
            aria-hidden
          >
            <Icon size={14} />
          </span>
          <span key={now?.id ?? "thinking"} className="agent-title min-w-0 truncate">
            {now ? now.text : steps.length ? "Deciding what to check next" : "Getting ready to test"}
          </span>
          <span className="agent-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </p>
        {recent.length > 0 && (
          <ol className="mt-1.5 flex flex-col gap-0.5 pl-8" aria-label="Previous steps">
            {recent.map((s, i) => (
              <li
                key={s.id}
                className={`flex items-center gap-1.5 truncate text-[11.5px] ${s.tone === "issue" ? "text-[#f2a463]" : "text-[#9aa0ad]"}`}
                style={{ opacity: 1 - i * 0.25 }}
              >
                <s.icon size={11} className="shrink-0" aria-hidden />
                <span className="truncate">{s.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
