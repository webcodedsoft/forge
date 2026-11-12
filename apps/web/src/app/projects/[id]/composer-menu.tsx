"use client";

import type { RunMode } from "@forge/protocol";
import {
  ArrowLeft,
  ArrowUpRight,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Diamond,
  FileText,
  Hammer,
  HelpCircle,
  MessageCircle,
  Palette,
  Paperclip,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AppRoute } from "@/lib/routes";

export type ProjectAction = { id: string; label: string; run: () => void };

/**
 * The "+" menu in the prompt box: search, Project ▸, Help center, Add context ▸ (pages and
 * files, inserted as @references), and Attach files.
 */
export function ComposerMenu({
  open,
  onOpenChange,
  startIn,
  initialQuery,
  routes,
  files,
  projectActions,
  onInsert,
  onAttach,
  canAttach,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Open straight into "Add context" (typing @ in the prompt). */
  startIn?: "root" | "context";
  initialQuery?: string;
  routes: AppRoute[];
  files: string[];
  projectActions: ProjectAction[];
  onInsert: (text: string) => void;
  onAttach: (files: FileList) => void;
  canAttach: boolean;
}) {
  const [view, setView] = useState<"root" | "project" | "context">("root");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pickerId = useId();

  // Reset to the requested view each time the menu opens.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const openKey = open ? `${startIn ?? "root"}|${initialQuery ?? ""}` : null;
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (open) {
      setView(startIn ?? "root");
      setQuery(initialQuery ?? "");
      setActive(0);
    }
  }

  useEffect(() => {
    if (!open) return;
    setTimeout(() => search.current?.focus(), 0);
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, onOpenChange]);

  type Row = { key: string; label: string; hint?: string; icon: React.ReactNode; trailing?: React.ReactNode; run: () => void };
  const q = query.trim().toLowerCase();
  const rows: Row[] = (() => {
    const contextRows: Row[] = [
      ...routes.map((r) => ({
        key: `page:${r.path}`,
        label: r.path,
        hint: "Page",
        icon: <Diamond size={15} aria-hidden />,
        run: () => onInsert(`@${r.path} `),
      })),
      ...files.map((f) => ({
        key: `file:${f}`,
        label: f,
        hint: "File",
        icon: <FileText size={15} aria-hidden />,
        run: () => onInsert(`@${f} `),
      })),
    ];
    const filter = (list: Row[]) => (q ? list.filter((r) => r.label.toLowerCase().includes(q)) : list);
    if (view === "context") return filter(contextRows).slice(0, 60);
    if (view === "project")
      return filter(
        projectActions.map((a) => ({ key: a.id, label: a.label, icon: <ChevronRight size={15} aria-hidden />, run: a.run })),
      );
    const root: Row[] = [
      { key: "project", label: "Project", icon: <Diamond size={15} aria-hidden />, trailing: <ChevronRight size={15} aria-hidden />, run: () => (setView("project"), setQuery("")) },
      {
        key: "help",
        label: "Help center",
        icon: <HelpCircle size={15} aria-hidden />,
        trailing: <ArrowUpRight size={15} aria-hidden />,
        run: () => window.open("/help", "_blank", "noopener"),
      },
      {
        key: "context",
        label: "Add context",
        icon: <AtSign size={15} aria-hidden />,
        trailing: (
          <span className="flex items-center gap-1.5 text-ink-3">
            @ <ChevronRight size={15} aria-hidden />
          </span>
        ),
        run: () => (setView("context"), setQuery("")),
      },
      ...(canAttach
        ? [{ key: "attach", label: "Attach files", icon: <Paperclip size={15} aria-hidden />, run: () => document.getElementById(pickerId)?.click() }]
        : []),
    ];
    // Searching from the top level also finds pages, files and project actions.
    if (!q) return root;
    return [
      ...root.filter((r) => r.label.toLowerCase().includes(q)),
      ...filter(projectActions.map((a) => ({ key: a.id, label: a.label, hint: "Project", icon: <ChevronRight size={15} aria-hidden />, run: a.run }))),
      ...filter(contextRows).slice(0, 30),
    ];
  })();

  const pick = (r: Row | undefined) => {
    if (!r) return;
    const stays = r.key === "project" || r.key === "context";
    r.run();
    if (!stays) onOpenChange(false);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label="Add context, attach files and more"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="btn btn-sm btn-icon rounded-full"
      >
        <Plus size={16} aria-hidden />
      </button>
      <input
        id={pickerId}
        type="file"
        multiple
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json"
        onChange={(e) => {
          if (e.target.files?.length) onAttach(e.target.files);
          e.target.value = "";
        }}
      />
      {open && (
        <div className="pop absolute bottom-10 left-0 z-40 w-80 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-3">
            {view !== "root" ? (
              <button type="button" aria-label="Back" className="text-ink-2 hover:text-ink" onClick={() => (setView("root"), setQuery(""))}>
                <ArrowLeft size={15} aria-hidden />
              </button>
            ) : (
              <Search size={15} className="text-ink-3" aria-hidden />
            )}
            <input
              ref={search}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") onOpenChange(false);
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(rows.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  pick(rows[active]);
                } else if (e.key === "Backspace" && !query && view !== "root") setView("root");
              }}
              placeholder={view === "context" ? "Search pages and files…" : view === "project" ? "Search…" : "Search…"}
              aria-label="Search"
              className="h-11 flex-1 bg-transparent text-[14px] outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-72 overflow-y-auto p-1.5">
            {rows.length === 0 && <li className="px-3 py-3 text-[13px] text-ink-2">Nothing matches.</li>}
            {rows.map((r, i) => (
              <li
                key={r.key}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[14px] ${i === active ? "bg-surface-2" : ""}`}
              >
                <span className="text-ink-2">{r.icon}</span>
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.hint && <span className="text-xs text-ink-3">{r.hint}</span>}
                {r.trailing && <span className="text-ink-2">{r.trailing}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const MODES: { id: RunMode; label: string; help: string; icon: typeof Hammer }[] = [
  { id: "build", label: "Build", help: "Make changes directly", icon: Hammer },
  { id: "chat", label: "Chat", help: "Ask anything, explore ideas. Nothing changes", icon: MessageCircle },
  { id: "plan", label: "Plan", help: "Detailed spec for complex builds, then build after you approve", icon: ClipboardList },
  { id: "design", label: "Design", help: "Build a screenshot or Figma frame into working UI. Paste a Figma frame link to import it", icon: Palette },
];

/** Build / Chat / Plan / Design picker next to Send. ⌥P cycles through the modes. */
export function ModeSelect({ mode, onChange }: { mode: RunMode; onChange: (m: RunMode) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === "KeyP" || e.key.toLowerCase() === "p")) {
        e.preventDefault();
        const i = MODES.findIndex((m) => m.id === mode);
        onChange(MODES[(i + 1) % MODES.length]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onChange]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn btn-sm" aria-expanded={open} aria-label={`Mode: ${mode}. Change mode`} onClick={() => setOpen((o) => !o)}>
        {(() => {
          const M = MODES.find((m) => m.id === mode)!;
          return (
            <>
              <M.icon size={14} aria-hidden />
              {M.label}
            </>
          );
        })()}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="pop absolute bottom-10 right-0 z-40 w-72 overflow-hidden p-1.5" role="listbox" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === mode}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-surface-2"
            >
              <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-md ${m.id === mode ? "bg-primary text-primary-fg" : "bg-surface-2 text-ink-2"}`}>
                <m.icon size={15} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{m.label}</span>
                <span className="block text-[13px] text-ink-2">{m.help}</span>
              </span>
              {m.id === mode && <Check size={16} className="mt-0.5 text-primary" aria-hidden />}
            </button>
          ))}
          <p className="mt-1 border-t border-line px-3 pb-1 pt-2 text-xs text-ink-3">
            Switch modes with <kbd className="rounded border border-line-2 px-1 font-mono">⌥</kbd>{" "}
            <kbd className="rounded border border-line-2 px-1 font-mono">P</kbd>
          </p>
        </div>
      )}
    </div>
  );
}
