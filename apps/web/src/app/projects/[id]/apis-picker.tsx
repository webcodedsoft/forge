"use client";

import type { ApiConnection, DataSource } from "@forge/protocol";
import { Database, FileSpreadsheet, Plug } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BusyLabel, Skeleton } from "@/components/loading";
import { api } from "@/lib/api";

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Header button + popover: which of our APIs and company data sources this project uses. */
export function ApisPicker({ projectId, disabled, onError }: { projectId: string; disabled: boolean; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [apis, setApis] = useState<ApiConnection[] | null>(null);
  const [sources, setSources] = useState<DataSource[] | null>(null);
  const [enabled, setEnabled] = useState<{ apis: string[]; data: string[] }>({ apis: [], data: [] });
  const [draft, setDraft] = useState<{ apis: string[]; data: string[] }>({ apis: [], data: [] });
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([api.projectConnections(projectId), api.projectDataSources(projectId)]).then(
      ([a, d]) => setEnabled({ apis: a.connectionIds, data: d.sourceIds }),
      () => undefined,
    );
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    api.connections().then(setApis, (e) => onError(e.message));
    api.dataSources().then(setSources, (e) => onError(e.message));
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    // Clicks inside the preview iframe never reach this document; the window losing focus to it does.
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setOpen(false), 0);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open, onError]);

  async function save() {
    setSaving(true);
    try {
      const next = { ...enabled };
      if (!sameSet(draft.apis, enabled.apis)) next.apis = (await api.setProjectConnections(projectId, draft.apis)).connectionIds;
      if (!sameSet(draft.data, enabled.data)) {
        await api.setProjectDataSources(projectId, draft.data);
        next.data = draft.data;
      }
      setEnabled(next);
      setOpen(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const changed = !sameSet(draft.apis, enabled.apis) || !sameSet(draft.data, enabled.data);
  const total = enabled.apis.length + enabled.data.length;
  const toggle = (k: "apis" | "data", id: string, on: boolean) => setDraft((d) => ({ ...d, [k]: on ? [...d[k], id] : d[k].filter((x) => x !== id) }));

  const loadingRows = (
    <div className="flex flex-col gap-2 py-1" role="status" aria-label="Loading">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-2.5">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="skel-line flex-1" />
        </div>
      ))}
    </div>
  );

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => {
          if (!open) setDraft(enabled);
          setOpen(!open);
        }}
        className="btn btn-sm"
        aria-expanded={open}
        data-tip="APIs and company data this app can use"
      >
        <Plug size={14} aria-hidden />
        APIs & data{total ? ` (${total})` : ""}
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-40 flex w-[22rem] flex-col gap-3 p-3.5 text-[13px]" role="dialog" aria-label="APIs and data">
          <section className="flex flex-col gap-1.5">
            <p className="lab flex items-center gap-1.5">
              <Plug size={13} aria-hidden />
              APIs
            </p>
            {apis === null ? (
              loadingRows
            ) : apis.length === 0 ? (
              <p className="text-ink-2">
                No APIs registered yet.{" "}
                <Link href="/settings/apis" className="text-primary underline">
                  Add one
                </Link>
              </p>
            ) : (
              <ul className="flex max-h-44 flex-col overflow-auto">
                {apis.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
                      <input type="checkbox" className="mt-0.5 accent-[var(--primary)]" checked={draft.apis.includes(c.id)} onChange={(e) => toggle("apis", c.id, e.target.checked)} />
                      <span className="min-w-0">
                        <code className="font-mono">{c.name}</code>
                        <span className="ml-1.5 text-ink-2">{c.title}</span>
                        <span className="lab block">{c.operations} operations</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <p className="lab flex items-center gap-1.5">
              <Database size={13} aria-hidden />
              Company data (read-only)
            </p>
            {sources === null ? (
              loadingRows
            ) : sources.length === 0 ? (
              <p className="text-ink-2">
                No data sources yet.{" "}
                <Link href="/settings/data" className="text-primary underline">
                  Add one
                </Link>
              </p>
            ) : (
              <ul className="flex max-h-44 flex-col overflow-auto">
                {sources.map((s) => (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
                      <input type="checkbox" className="mt-0.5 accent-[var(--primary)]" checked={draft.data.includes(s.id)} onChange={(e) => toggle("data", s.id, e.target.checked)} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          {s.kind === "sheet" ? <FileSpreadsheet size={13} className="text-ink-3" aria-hidden /> : <Database size={13} className="text-ink-3" aria-hidden />}
                          <code className="font-mono">{s.name}</code>
                          <span className="truncate text-ink-2">{s.title}</span>
                        </span>
                        <span className="lab block">
                          {s.tables.length} table{s.tables.length === 1 ? "" : "s"}
                          {s.error ? " · last check failed" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
            <span className="flex gap-3">
              <Link href="/settings/apis" className="text-xs text-ink-2 hover:text-ink">
                Manage APIs
              </Link>
              <Link href="/settings/data" className="text-xs text-ink-2 hover:text-ink">
                Manage data
              </Link>
            </span>
            <button
              type="button"
              disabled={!changed || disabled}
              aria-busy={saving}
              title={disabled ? "Wait for the agent to finish" : undefined}
              onClick={save}
              className="btn btn-p btn-sm"
            >
              <BusyLabel busy={saving} busyText="Updating the app…">
                Save
              </BusyLabel>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
