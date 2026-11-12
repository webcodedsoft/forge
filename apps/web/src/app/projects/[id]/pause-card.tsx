"use client";

import type { PlanPayload, QuestionPayload, RunEvent } from "@forge/protocol";
import { useState } from "react";
import { BusyLabel } from "@/components/loading";
import { Markdown } from "@/components/markdown";
import { api } from "@/lib/api";

type PauseEvent = Extract<RunEvent, { type: "pause" }>;

/** Shown while the agent waits for the user: multiple-choice questions or a plan to approve. */
export function PauseCard({ projectId, pause, onError }: { projectId: string; pause: PauseEvent; onError: (msg: string) => void }) {
  return pause.kind === "plan" ? (
    <PlanCard projectId={projectId} pause={pause} payload={pause.payload as PlanPayload} onError={onError} />
  ) : (
    <QuestionsCard projectId={projectId} pause={pause} payload={pause.payload as QuestionPayload} onError={onError} />
  );
}

function QuestionsCard({
  projectId,
  pause,
  payload,
  onError,
}: {
  projectId: string;
  pause: PauseEvent;
  payload: QuestionPayload;
  onError: (msg: string) => void;
}) {
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(payload.questions.map((q) => [q.id, q.options[0] ?? ""])),
  );
  const [other, setOther] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    const answers = Object.fromEntries(
      payload.questions.map((q) => [q.id, choice[q.id] === "__other" ? (other[q.id] ?? "").trim() : choice[q.id] ?? ""]),
    );
    try {
      await api.answerPause(projectId, pause.pauseId, { answers });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4 border-primary p-3.5 shadow-[0_0_0_3px_var(--primary-ring)]">
      <p className="pill pill-pri">The agent has a few questions</p>
      {payload.questions.map((q) => (
        <fieldset key={q.id} className="space-y-1.5">
          <legend className="mb-1 font-medium">{q.question}</legend>
          {[...q.options, "__other"].map((opt, i) => (
            <label key={opt} className="flex items-start gap-2">
              <input
                type="radio"
                name={`${pause.pauseId}-${q.id}`}
                checked={choice[q.id] === opt}
                onChange={() => setChoice((c) => ({ ...c, [q.id]: opt }))}
                className="mt-1 accent-[var(--primary)]"
              />
              {opt === "__other" ? (
                <input
                  placeholder="Something else…"
                  value={other[q.id] ?? ""}
                  onFocus={() => setChoice((c) => ({ ...c, [q.id]: "__other" }))}
                  onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                  className="in w-full px-2.5 py-1 text-sm"
                />
              ) : (
                <span>
                  {opt}
                  {i === 0 && <span className="lab ml-1">(suggested)</span>}
                </span>
              )}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex justify-end">
        <button disabled={sending} aria-busy={sending} className="btn btn-p btn-sm">
          <BusyLabel busy={sending} busyText="Sending…">
            Send answers
          </BusyLabel>
        </button>
      </div>
    </form>
  );
}

function PlanCard({
  projectId,
  pause,
  payload,
  onError,
}: {
  projectId: string;
  pause: PauseEvent;
  payload: PlanPayload;
  onError: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "revise">("view");
  const [plan, setPlan] = useState(payload.plan);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);

  async function send(decision: "approve" | "revise") {
    setSending(true);
    try {
      await api.answerPause(
        projectId,
        pause.pauseId,
        decision === "approve" ? { decision, plan: plan !== payload.plan ? plan : undefined } : { decision, feedback },
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  return (
    <div className="card space-y-3 border-primary p-3.5 shadow-[0_0_0_3px_var(--primary-ring)]">
      <p className="pill pill-pri">Plan for your approval</p>
      <p className="font-medium">{payload.title}</p>
      {mode === "edit" ? (
        <textarea
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="in min-h-56 w-full p-2.5 font-mono text-xs"
        />
      ) : (
        <Markdown className="max-h-96 overflow-auto text-sm text-ink/90">{plan}</Markdown>
      )}
      {mode === "revise" && (
        <textarea
          autoFocus
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="What should change in the plan?"
          className="in min-h-20 w-full p-2.5 text-sm"
        />
      )}
      <div className="flex flex-wrap justify-end gap-2 text-sm">
        {mode === "revise" ? (
          <>
            <button onClick={() => setMode("view")} className="btn btn-g btn-sm">
              Cancel
            </button>
            <button
              disabled={!feedback.trim()}
              aria-busy={sending}
              onClick={() => send("revise")}
              className="btn btn-p btn-sm"
            >
              <BusyLabel busy={sending} busyText="Sending…">
                Send feedback
              </BusyLabel>
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setMode("revise")} className="btn btn-sm">
              Request changes
            </button>
            <button
              onClick={() => setMode(mode === "edit" ? "view" : "edit")}
              className="btn btn-sm"
            >
              {mode === "edit" ? "Done editing" : "Edit plan"}
            </button>
            <button aria-busy={sending} onClick={() => send("approve")} className="btn btn-p btn-sm">
              <BusyLabel busy={sending} busyText="Sending…">
                Approve and build
              </BusyLabel>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
