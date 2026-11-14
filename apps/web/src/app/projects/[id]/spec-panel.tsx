"use client";

import type { ProjectSpec, SpecCriterion } from "@forge/protocol";
import { Check, CircleDashed, FlaskConical, Pencil, Plus, ScrollText, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BusyLabel, SkeletonCards, Spinner } from "@/components/loading";
import { Markdown } from "@/components/markdown";
import { api } from "@/lib/api";

/*
 * Spec tab: the living spec. A summary of what the app does and its acceptance criteria, grouped
 * by area. The build agent keeps it current as it works; the team can edit it here. A criterion
 * linked to a saved test shows whether that test passes, so the list doubles as "does the app
 * still do what we agreed".
 */

const STATUS: Record<SpecCriterion["status"], { cls: string; text: string; tip: string }> = {
  passing: { cls: "pill pill-ok", text: "Passing", tip: "Its saved test passed on the latest replay" },
  failing: { cls: "pill pill-bad", text: "Failing", tip: "Its saved test failed on the latest replay" },
  not_run: { cls: "pill", text: "Not run yet", tip: "It has a saved test that hasn't been replayed yet" },
  untested: { cls: "pill pill-warn", text: "No test", tip: "Nothing checks this automatically yet" },
};

export function SpecPanel({
  projectId,
  canBuild,
  running,
  refreshKey,
  onStarted,
  onError,
}: {
  projectId: string;
  canBuild: boolean;
  running: boolean;
  /** Bumps when the spec changes or tests were replayed. */
  refreshKey: number;
  /** A run started from here: show the chat. */
  onStarted: () => void;
  onError: (msg: string) => void;
}) {
  const [spec, setSpec] = useState<ProjectSpec | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingSummary, setEditingSummary] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; area: string; text: string } | null>(null);
  const [adding, setAdding] = useState<{ area: string; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.spec(projectId).then(
      (s) => !cancelled && setSpec(s),
      (e) => !cancelled && onError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, onError]);

  /** Runs an action; a returned spec replaces the one shown. Resolves true when it worked. */
  async function act(key: string, fn: () => Promise<unknown>, started = false): Promise<boolean> {
    setBusy(key);
    try {
      const r = await fn();
      if (started) onStarted();
      else if (r && typeof r === "object" && "criteria" in r) setSpec(r as ProjectSpec);
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const areas = useMemo(() => [...new Set((spec?.criteria ?? []).map((c) => c.area))], [spec]);

  if (!spec)
    return (
      <div className="p-4">
        <SkeletonCards n={3} />
      </div>
    );

  const total = spec.criteria.length;
  const untested = total - spec.tested;
  const empty = total === 0 && !spec.summary;
  const locked = running || busy !== null;

  return (
    <div className="flex flex-col gap-5 p-4 text-sm">
      <section aria-labelledby="spec-h" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="spec-h" className="h2 flex items-center gap-2">
            <ScrollText size={16} className="text-ink-2" aria-hidden />
            What this app does
          </h2>
          {canBuild && editingSummary === null && !empty && (
            <button type="button" className="btn btn-g btn-sm ml-auto" disabled={busy !== null} onClick={() => setEditingSummary(spec.summary)}>
              <Pencil size={13} aria-hidden />
              Edit
            </button>
          )}
        </div>
        <p className="lab">
          The agent keeps this current as it builds, must keep every criterion true, and the QA agent tests against it. Projects made in Forge also get it as{" "}
          <code className="font-mono">docs/SPEC.md</code> with each saved version.
        </p>
        {editingSummary !== null ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act("summary", () => api.setSpecSummary(projectId, editingSummary)).then((ok) => ok && setEditingSummary(null));
            }}
          >
            <textarea
              className="in min-h-40 font-mono text-[12.5px]"
              value={editingSummary}
              maxLength={6000}
              onChange={(e) => setEditingSummary(e.target.value)}
              aria-label="Summary (Markdown)"
              placeholder="What the app is for and who uses it, then a bullet per main feature. Markdown works."
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-g btn-sm" onClick={() => setEditingSummary(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-p btn-sm" aria-busy={busy === "summary"}>
                <BusyLabel busy={busy === "summary"} busyText="Saving…">
                  Save summary
                </BusyLabel>
              </button>
            </div>
          </form>
        ) : spec.summary ? (
          <div className="card px-3 py-2.5 text-[13.5px]">
            <Markdown>{spec.summary}</Markdown>
          </div>
        ) : empty ? (
          <div className="card flex flex-col items-center gap-3 px-4 py-6 text-center">
            <p className="max-w-xs text-ink-2">
              No spec yet. The agent starts one with its next change, or it can read the app now and write down what it does today.
            </p>
            {canBuild && (
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  className="btn btn-p btn-sm"
                  disabled={locked}
                  onClick={() => void act("draft", () => api.draftSpec(projectId), true)}
                  data-tip={running ? "Wait for the agent to finish" : "The agent reads the app and writes the summary and criteria. No code changes."}
                >
                  {busy === "draft" ? <Spinner size={13} /> : <Sparkles size={13} aria-hidden />}
                  Write the spec from the app
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setEditingSummary("")}>
                  Write it myself
                </button>
              </div>
            )}
          </div>
        ) : (
          canBuild && (
            <button type="button" className="btn btn-sm self-start" onClick={() => setEditingSummary("")}>
              <Plus size={13} aria-hidden />
              Add a summary
            </button>
          )
        )}
        {spec.updatedAt && (
          <p className="lab">
            Last changed {new Date(spec.updatedAt).toLocaleString()}
            {spec.updatedBy ? ` by ${spec.updatedBy}` : ""}
          </p>
        )}
      </section>

      {!empty && (
        <section aria-labelledby="criteria-h" className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="criteria-h" className="h2">
              Acceptance criteria
            </h2>
            {total > 0 && (
              <span className="lab">
                {total} · {spec.passing} passing{spec.failing ? ` · ${spec.failing} failing` : ""}
                {untested ? ` · ${untested} without a test` : ""}
              </span>
            )}
            {canBuild && untested > 0 && (
              <button
                type="button"
                className="btn btn-sm ml-auto"
                disabled={locked}
                onClick={() => void act("cover", () => api.coverSpec(projectId), true)}
                data-tip={
                  running
                    ? "Wait for the agent to finish"
                    : `The QA agent walks through ${Math.min(10, untested)} of them in a browser and writes a test for each; passing tests are saved`
                }
              >
                {busy === "cover" ? <Spinner size={13} /> : <FlaskConical size={13} aria-hidden />}
                Write tests for {Math.min(10, untested)}
              </button>
            )}
          </div>
          {total > 0 && (
            <div
              className="flex h-1.5 overflow-hidden rounded-full bg-surface-2"
              role="img"
              aria-label={`${spec.passing} of ${total} criteria pass their test, ${spec.failing} fail, ${untested} have no test`}
            >
              <span className="bg-ok" style={{ width: `${(spec.passing / total) * 100}%` }} />
              <span className="bg-danger" style={{ width: `${(spec.failing / total) * 100}%` }} />
            </div>
          )}
          {total === 0 && <p className="card px-3 py-4 text-center text-ink-2">No criteria yet. Add the first one below, or ask the agent for a change.</p>}

          {areas.map((area) => (
            <div key={area} className="flex flex-col gap-1.5">
              <h3 className="lab mt-1 uppercase tracking-wide">{area}</h3>
              <ul className="flex flex-col gap-1.5">
                {spec.criteria
                  .filter((c) => c.area === area)
                  .map((c) => {
                    const st = STATUS[c.status];
                    if (editing?.id === c.id) {
                      return (
                        <li key={c.id}>
                          <CriterionForm
                            value={editing}
                            areas={areas}
                            busy={busy === `edit${c.id}`}
                            submitLabel="Save"
                            onChange={(v) => setEditing({ id: c.id, ...v })}
                            onCancel={() => setEditing(null)}
                            onSubmit={() =>
                              void act(`edit${c.id}`, () => api.updateCriterion(projectId, c.id, { area: editing.area.trim(), text: editing.text.trim() })).then(
                                (ok) => ok && setEditing(null),
                              )
                            }
                          />
                        </li>
                      );
                    }
                    return (
                      <li key={c.id} className="card p-2.5">
                        <div className="flex items-start gap-2">
                          {c.status === "passing" ? (
                            <Check size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden />
                          ) : c.status === "failing" ? (
                            <X size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
                          ) : (
                            <CircleDashed size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                          )}
                          <p className="min-w-0 flex-1 leading-snug">{c.text}</p>
                          <span className={`${st.cls} shrink-0 text-[11px]`} title={st.tip}>
                            {st.text}
                          </span>
                        </div>
                        {c.status === "failing" && c.error && <p className="ml-[23px] mt-1 text-[12.5px] text-danger">{c.error}</p>}
                        {c.testTitle && <p className="lab ml-[23px] mt-1">Test: {c.testTitle}</p>}
                        {canBuild &&
                          (confirmDelete === c.id ? (
                            <div className="ml-[23px] mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                              <span className="flex-1">Remove this from the spec? Its test, if any, stays in Health.</span>
                              <button type="button" className="btn btn-g btn-sm" onClick={() => setConfirmDelete(null)}>
                                Keep
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => {
                                  setConfirmDelete(null);
                                  void act(`del${c.id}`, () => api.deleteCriterion(projectId, c.id));
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          ) : (
                            <div className="ml-[23px] mt-2 flex flex-wrap gap-1.5">
                              {c.status === "failing" && (
                                <button
                                  type="button"
                                  className="btn btn-p btn-sm"
                                  disabled={locked}
                                  onClick={() =>
                                    void act(
                                      `fix${c.id}`,
                                      () =>
                                        api.startRun(
                                          projectId,
                                          `The app no longer meets this acceptance criterion from the spec (${c.area}): "${c.text}"\n\nIts saved test "${c.testTitle}" fails: ${c.error ?? "no details"}\n\nFind the cause and fix the app so the criterion holds again. Don't change the criterion or weaken the test.`,
                                        ),
                                      true,
                                    )
                                  }
                                >
                                  <Wand2 size={13} aria-hidden />
                                  Fix
                                </button>
                              )}
                              {c.status === "untested" && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={locked}
                                  onClick={() => void act(`cover${c.id}`, () => api.coverSpec(projectId, [c.id]), true)}
                                  data-tip={running ? "Wait for the agent to finish" : "The QA agent walks through it in a browser and writes a test"}
                                >
                                  {busy === `cover${c.id}` ? <Spinner size={13} /> : <FlaskConical size={13} aria-hidden />}
                                  Write a test
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-g btn-sm btn-icon ml-auto"
                                aria-label="Edit this criterion"
                                disabled={busy !== null}
                                onClick={() => setEditing({ id: c.id, area: c.area, text: c.text })}
                              >
                                <Pencil size={13} aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="btn btn-g btn-sm btn-icon"
                                aria-label="Remove this criterion"
                                disabled={busy !== null}
                                onClick={() => setConfirmDelete(c.id)}
                              >
                                <Trash2 size={13} aria-hidden />
                              </button>
                            </div>
                          ))}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}

          {canBuild &&
            (adding ? (
              <CriterionForm
                value={adding}
                areas={areas}
                busy={busy === "add"}
                submitLabel="Add criterion"
                onChange={setAdding}
                onCancel={() => setAdding(null)}
                onSubmit={() =>
                  void act("add", () => api.addCriterion(projectId, { area: adding.area.trim(), text: adding.text.trim() })).then(
                    (ok) => ok && setAdding({ area: adding.area, text: "" }),
                  )
                }
              />
            ) : (
              <button type="button" className="btn btn-sm self-start" onClick={() => setAdding({ area: areas[areas.length - 1] ?? "", text: "" })}>
                <Plus size={13} aria-hidden />
                Add a criterion
              </button>
            ))}
        </section>
      )}
    </div>
  );
}

function CriterionForm({
  value,
  areas,
  busy,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: { area: string; text: string };
  areas: string[];
  busy: boolean;
  submitLabel: string;
  onChange: (v: { area: string; text: string }) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ready = value.area.trim().length > 0 && value.text.trim().length >= 3;
  return (
    <form
      className="card flex flex-col gap-2 border-primary p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSubmit();
      }}
    >
      <input
        className="in h-8 px-2.5 text-[13px]"
        list="spec-areas"
        value={value.area}
        maxLength={60}
        onChange={(e) => onChange({ ...value, area: e.target.value })}
        placeholder="Area, e.g. Voting"
        aria-label="Area"
      />
      <datalist id="spec-areas">
        {areas.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <textarea
        className="in min-h-16 px-2.5 py-1.5 text-[13px]"
        value={value.text}
        maxLength={400}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="One thing a user can do or see, e.g. A visitor can vote once per day per restaurant."
        aria-label="Criterion"
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-g btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-p btn-sm" disabled={!ready} aria-busy={busy}>
          <BusyLabel busy={busy} busyText="Saving…">
            {submitLabel}
          </BusyLabel>
        </button>
      </div>
    </form>
  );
}
