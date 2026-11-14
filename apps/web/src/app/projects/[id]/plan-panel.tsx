"use client";

import type { PlanPayload, RunEvent } from "@forge/protocol";
import { Check, ClipboardList, Minimize2, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { BusyLabel } from "@/components/loading";
import { Markdown } from "@/components/markdown";
import { api } from "@/lib/api";

/*
 * The Plan panel: the agent's plan (present_plan) as steps people can keep or untick, reword, add
 * to, and annotate before approving. It opens over the preview while the agent waits; the chat
 * shows a short card that reopens it.
 */

type PauseEvent = Extract<RunEvent, { type: "pause" }>;
type Step = { key: string; title: string; detail?: string; origin: "agent" | "user"; on: boolean; optional?: boolean; original?: string };

const fromPayload = (p: PlanPayload): Step[] =>
  (p.steps ?? []).map((s) => ({ key: s.id, title: s.title, detail: s.detail, origin: "agent", on: !s.optional, optional: s.optional, original: s.title }));

export function PlanPanel({
  projectId,
  pause,
  onClose,
  onError,
}: {
  projectId: string;
  pause: PauseEvent;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const payload = pause.payload as PlanPayload;
  const [steps, setSteps] = useState<Step[]>(() => fromPayload(payload));
  const [editing, setEditing] = useState<string | null>(null);
  const [newStep, setNewStep] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<"approve" | "revise" | null>(null);

  const kept = steps.filter((s) => s.on);
  const update = (key: string, patch: Partial<Step>) => setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const add = () => {
    const title = newStep.trim();
    if (!title) return;
    setSteps((list) => [...list, { key: `u${Date.now()}`, title, origin: "user", on: true }]);
    setNewStep("");
  };

  async function send(decision: "approve" | "revise") {
    setSending(decision);
    try {
      await api.answerPause(projectId, pause.pauseId, {
        decision,
        steps: kept.map((s) => ({
          title: s.title,
          ...(s.detail ? { detail: s.detail } : {}),
          origin: s.origin,
          ...(s.origin === "agent" && s.title !== s.original ? { edited: true } : {}),
        })),
        removed: steps.filter((s) => !s.on && s.origin === "agent").map((s) => s.original ?? s.title),
        ...(note.trim() ? { feedback: note.trim() } : {}),
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setSending(null);
    }
  }

  return (
    <aside className="plan-panel absolute inset-0 z-30 flex flex-col bg-paper/95 backdrop-blur-sm" aria-label="Plan for your approval">
      <div className="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col p-4 sm:p-6">
        <header className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-weak text-primary">
            <ClipboardList size={19} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-primary">Plan for your approval</p>
            <h2 className="text-[19px] font-semibold leading-snug">{payload.title}</h2>
          </div>
          <button type="button" className="btn btn-g btn-sm" onClick={onClose} title="Hide the plan (it stays waiting in the chat)">
            <Minimize2 size={14} aria-hidden />
            Hide
          </button>
        </header>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {payload.summary && <Markdown className="text-[14px] leading-relaxed text-ink-2">{payload.summary}</Markdown>}

          <div className="mt-5 flex items-center justify-between">
            <p className="text-[13.5px] font-semibold">Steps</p>
            <p className="text-[12.5px] text-ink-3">
              {kept.length} of {steps.length} selected
            </p>
          </div>
          <ol className="mt-2 flex flex-col gap-1.5">
            {steps.map((s, i) => (
              <li
                key={s.key}
                className={`group flex items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-colors ${
                  s.on ? "border-line bg-surface" : "border-dashed border-line bg-transparent opacity-60"
                }`}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={s.on}
                  aria-label={`${s.on ? "Remove" : "Keep"} step ${i + 1}: ${s.title}`}
                  onClick={() => update(s.key, { on: !s.on })}
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border transition-colors ${
                    s.on ? "border-primary bg-primary text-primary-fg" : "border-line-2 bg-surface hover:border-ink-3"
                  }`}
                >
                  {s.on && <Check size={13} strokeWidth={3} aria-hidden />}
                </button>
                <div className="min-w-0 flex-1">
                  {editing === s.key ? (
                    <input
                      autoFocus
                      className="in h-8 w-full text-[13.5px]"
                      defaultValue={s.title}
                      aria-label={`Step ${i + 1}`}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim();
                        if (v) update(s.key, { title: v });
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`block w-full text-left text-[13.5px] font-medium ${s.on ? "text-ink" : "text-ink-2 line-through"}`}
                      onClick={() => setEditing(s.key)}
                      title="Click to reword"
                    >
                      <span className="mr-1.5 text-ink-3">{i + 1}.</span>
                      {s.title}
                    </button>
                  )}
                  {s.detail && <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{s.detail}</p>}
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {s.optional && <span className="pill text-[10.5px]">Optional</span>}
                    {s.origin === "user" && <span className="pill pill-pri text-[10.5px]">Added by you</span>}
                    {s.origin === "agent" && s.original && s.title !== s.original && (
                      <span className="pill text-[10.5px]">
                        Edited
                        <button type="button" className="ml-1 hover:text-ink" title="Undo the edit" onClick={() => update(s.key, { title: s.original! })}>
                          <RotateCcw size={10} aria-label="Undo the edit" />
                        </button>
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                  <button type="button" className="btn btn-g btn-icon btn-sm size-7" aria-label={`Reword step ${i + 1}`} onClick={() => setEditing(s.key)}>
                    <Pencil size={13} aria-hidden />
                  </button>
                  {s.origin === "user" && (
                    <button
                      type="button"
                      className="btn btn-g btn-icon btn-sm size-7"
                      aria-label={`Delete step ${i + 1}`}
                      onClick={() => setSteps((list) => list.filter((x) => x.key !== s.key))}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              className="in h-9 min-w-0 flex-1 text-[13.5px]"
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              placeholder="Add a step, e.g. “Show a success message after saving”"
              aria-label="New step"
            />
            <button type="submit" className="btn btn-sm h-9" disabled={!newStep.trim()}>
              <Plus size={14} aria-hidden />
              Add step
            </button>
          </form>

          <label className="mt-5 flex flex-col gap-1.5">
            <span className="text-[13.5px] font-semibold">Anything else?</span>
            <textarea
              className="in min-h-20 text-[13.5px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Notes for the agent: constraints, preferences, what to leave alone…"
            />
          </label>
        </div>

        <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <p className="mr-auto flex items-center gap-1.5 text-[12.5px] text-ink-3">
            <Sparkles size={13} aria-hidden />
            The agent builds only the selected steps.
          </p>
          <button type="button" className="btn btn-sm" aria-busy={sending === "revise"} disabled={sending !== null} onClick={() => void send("revise")}>
            <BusyLabel busy={sending === "revise"} busyText="Sending…">
              Ask for changes
            </BusyLabel>
          </button>
          <button
            type="button"
            className="btn btn-p btn-sm"
            aria-busy={sending === "approve"}
            disabled={sending !== null || kept.length === 0}
            onClick={() => void send("approve")}
          >
            <BusyLabel busy={sending === "approve"} busyText="Starting…">
              <Check size={14} aria-hidden />
              Approve and build {kept.length} step{kept.length === 1 ? "" : "s"}
            </BusyLabel>
          </button>
        </footer>
      </div>
    </aside>
  );
}

/** The plan's short card in the chat; opens the panel. */
export function PlanSummaryCard({ pause, open, onOpen }: { pause: PauseEvent; open: boolean; onOpen: () => void }) {
  const payload = pause.payload as PlanPayload;
  const n = payload.steps?.length ?? 0;
  return (
    <div className="card flex items-center gap-3 border-primary p-3.5 shadow-[0_0_0_3px_var(--primary-ring)]">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-weak text-primary">
        <ClipboardList size={17} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-primary">Plan ready for your approval</p>
        <p className="truncate font-medium">{payload.title}</p>
        <p className="text-[12px] text-ink-3">
          {n} step{n === 1 ? "" : "s"} · the agent waits for you
        </p>
      </div>
      <button type="button" className="btn btn-p btn-sm shrink-0" onClick={onOpen} disabled={open}>
        {open ? "Open" : "Review plan"}
      </button>
    </div>
  );
}

