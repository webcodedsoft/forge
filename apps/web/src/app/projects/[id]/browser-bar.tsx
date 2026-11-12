"use client";

import { ArrowLeft, ArrowRight, Lock, RotateCw } from "lucide-react";
import { useId, useImperativeHandle, useRef, useState } from "react";
import type { AppRoute } from "@/lib/routes";

export type BrowserBarHandle = {
  /** Put a path in the address bar for editing, selecting its first [param] (e.g. /projects/[id]). */
  edit: (path: string) => void;
};

/** Back / forward / reload and an editable address (suggests the app's pages). */
export function BrowserBar({
  ref,
  path,
  routes,
  canBack,
  canForward,
  onBack,
  onForward,
  onReload,
  onGo,
  disabled,
  live,
}: {
  ref?: React.Ref<BrowserBarHandle>;
  path: string;
  routes: AppRoute[];
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onGo: (path: string) => void;
  disabled?: boolean;
  /** Connection / agent state shown as a dot in the address bar. */
  live: { color: string; label: string };
}) {
  const [draft, setDraft] = useState(path);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const shown = editing ? draft : path;

  useImperativeHandle(ref, () => ({
    edit: (p: string) => {
      setDraft(p);
      setEditing(true);
      setTimeout(() => {
        input.current?.focus();
        const at = p.indexOf("[");
        if (at >= 0) input.current?.setSelectionRange(at, p.indexOf("]", at) + 1);
      }, 0);
    },
  }));

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Back" title="Back" disabled={disabled || !canBack} onClick={onBack}>
        <ArrowLeft size={15} aria-hidden />
      </button>
      <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Forward" title="Forward" disabled={disabled || !canForward} onClick={onForward}>
        <ArrowRight size={15} aria-hidden />
      </button>
      <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Reload this page" title="Reload this page" disabled={disabled} onClick={onReload}>
        <RotateCw size={14} aria-hidden />
      </button>
      <form
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-2 px-3 focus-within:ring-[3px] focus-within:ring-[var(--primary-ring)]"
        onSubmit={(e) => {
          e.preventDefault();
          const clean = draft.trim();
          setEditing(false);
          onGo(clean.startsWith("/") ? clean : `/${clean}`);
          input.current?.blur();
        }}
      >
        <span className={`size-2 shrink-0 rounded-full ${live.color}`} role="img" aria-label={live.label} title={live.label} />
        <Lock size={12} className="shrink-0 text-ink-3" aria-hidden />
        <input
          ref={input}
          aria-label="Page address"
          list={listId}
          value={shown}
          disabled={disabled}
          onFocus={(e) => {
            if (!editing) {
              setDraft(path);
              setEditing(true);
              setTimeout(() => e.target.select(), 0);
            }
          }}
          onBlur={() => setTimeout(() => setEditing(false), 150)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && input.current?.blur()}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
        />
        <datalist id={listId}>
          {routes.map((r) => (
            <option key={r.path} value={r.path} />
          ))}
        </datalist>
      </form>
    </div>
  );
}
