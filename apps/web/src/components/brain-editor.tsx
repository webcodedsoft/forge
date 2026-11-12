"use client";

import type { BrainDoc } from "@forge/protocol";
import { BookOpen, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { BusyLabel } from "@/components/loading";
import { CodeEditor } from "@/components/code-editor";
import { Markdown } from "@/components/markdown";
import { Modal, ModalActions } from "@/components/modal";
import { api } from "@/lib/api";

/** On/off switch (a checkbox styled as a switch). */
function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2" data-tip={checked ? "The agent follows this" : "The agent ignores this for now"}>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span
        aria-hidden
        className="relative h-5 w-9 rounded-full bg-line-2 transition-colors peer-checked:bg-primary peer-focus-visible:shadow-[0_0_0_3px_var(--primary-ring)] after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
      />
      {checked ? "On" : "Off"}
    </label>
  );
}

/** View/edit one brain doc. Calls onChange after save, toggle or delete. */
export function BrainDocCard({
  doc,
  onChange,
  onError,
  readOnly = false,
}: {
  doc: BrainDoc;
  onChange: () => void;
  onError: (m: string) => void;
  /** Hide the edit controls (people who can't change this doc). */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const long = doc.content.split("\n").length > 10 || doc.content.length > 700;
  const ids = useId();

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={`card fade-in p-4 transition-opacity ${doc.enabled ? "" : "opacity-60"}`}>
      {editing ? (
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1.5" htmlFor={`${ids}-t`}>
            <span className="lab">Title</span>
            <input id={`${ids}-t`} className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </label>
          <label className="flex flex-col gap-1.5" htmlFor={`${ids}-c`}>
            <span className="lab">Instructions (Markdown)</span>
            <CodeEditor id={`${ids}-c`} language="markdown" value={content} onChange={(v) => setContent(v.slice(0, 20000))} wrap lineNumbers={false} minHeight={220} maxHeight={480} ariaLabel="Instructions (Markdown)" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="btn btn-g btn-sm">
              Cancel
            </button>
            <button
              type="button"
              disabled={!title.trim()}
              aria-busy={busy === "save"}
              onClick={() =>
                run("save", async () => {
                  await api.updateBrainDoc(doc.id, { title: title.trim(), content, enabled: doc.enabled });
                  setEditing(false);
                })
              }
              className="btn btn-p btn-sm"
            >
              <BusyLabel busy={busy === "save"}>Save</BusyLabel>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <h3 className="h2 min-w-0 flex-1">{doc.title}</h3>
            {readOnly ? (
              <span className={`pill ${doc.enabled ? "pill-ok" : ""}`}>{doc.enabled ? "On" : "Off"}</span>
            ) : (
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch
                  checked={doc.enabled}
                  disabled={busy !== null}
                  label={`${doc.title}: the agent follows it`}
                  onChange={(on) => void run("toggle", () => api.updateBrainDoc(doc.id, { title: doc.title, content: doc.content, enabled: on }))}
                />
                <button type="button" onClick={() => setEditing(true)} className="btn btn-g btn-sm btn-icon" aria-label={`Edit ${doc.title}`}>
                  <Pencil size={14} aria-hidden />
                </button>
                {confirm ? (
                  <>
                    <button type="button" className="btn btn-g btn-sm" onClick={() => setConfirm(false)}>
                      Keep
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" aria-busy={busy === "delete"} onClick={() => void run("delete", () => api.deleteBrainDoc(doc.id))}>
                      <BusyLabel busy={busy === "delete"}>Delete</BusyLabel>
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirm(true)} className="btn btn-g btn-sm btn-icon" aria-label={`Delete ${doc.title}`}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className={`relative mt-2 ${long && !expanded ? "max-h-48 overflow-hidden" : ""}`}>
            <Markdown className="text-[13.5px] leading-relaxed text-ink">{doc.content || "_Empty_"}</Markdown>
            {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" aria-hidden />}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {long && (
              <button type="button" className="btn btn-g btn-sm" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
                <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
                {expanded ? "Show less" : "Show all"}
              </button>
            )}
            <p className="lab ml-auto">
              Updated by {doc.updatedBy} · {new Date(doc.updatedAt).toLocaleString()}
            </p>
          </div>
        </>
      )}
    </article>
  );
}

/** Button + modal to add a new doc (team doc, or project doc when projectId is set). */
export function NewBrainDoc({ projectId, onCreated, onError }: { projectId?: string; onCreated: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] border-2 border-dashed border-line-2 px-3 py-3 text-[13px] font-semibold text-ink-2 transition-colors hover:border-primary hover:bg-primary-weak/50 hover:text-primary"
      >
        <Plus size={15} aria-hidden />
        {projectId ? "Add a note for this project" : "Add a team doc"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        size="lg"
        icon={<BookOpen size={19} aria-hidden />}
        title={projectId ? "Add a note for this project" : "Add a team doc"}
        description={projectId ? "The agent follows it in this project only." : "The agent follows it in every project, from the next prompt."}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.createBrainDoc({ title: title.trim(), content, enabled: true, projectId });
              setTitle("");
              setContent("");
              setOpen(false);
              onCreated();
            } catch (err) {
              onError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="flex flex-col gap-1.5" htmlFor={`${ids}-t`}>
            <span className="lab">Title</span>
            <input id={`${ids}-t`} className="in" placeholder="e.g. Brand colours" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} autoFocus />
          </label>
          <label className="flex flex-col gap-1.5" htmlFor={`${ids}-c`}>
            <span className="lab">Instructions (Markdown)</span>
            <CodeEditor
              id={`${ids}-c`}
              language="markdown"
              value={content}
              onChange={(v) => setContent(v.slice(0, 20000))}
              placeholder={"- Use our primary purple for main buttons\n- Dates as 12 Nov 2026"}
              wrap
              lineNumbers={false}
              minHeight={220}
              maxHeight={420}
              ariaLabel="Instructions (Markdown)"
            />
          </label>
          <ModalActions left="Short, concrete rules work best.">
            <button type="button" onClick={() => setOpen(false)} className="btn btn-g" disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-p" aria-busy={busy}>
              <BusyLabel busy={busy}>Add</BusyLabel>
            </button>
          </ModalActions>
        </form>
      </Modal>
    </>
  );
}
