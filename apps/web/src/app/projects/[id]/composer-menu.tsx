"use client";

import type { ProjectModels, RunMode } from "@forge/protocol";
import { ATTACH_ACCEPT } from "@/lib/uploads";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Code2,
  CornerDownLeft,
  Diamond,
  Download,
  FileText,
  FlaskConical,
  FolderKanban,
  Hammer,
  HeartPulse,
  HelpCircle,
  History,
  MessageCircle,
  MessagesSquare,
  Palette,
  Paperclip,
  Plus,
  Rocket,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AppRoute } from "@/lib/routes";

export type ProjectAction = { id: string; label: string; run: () => void };

/** Icons for the project actions builder passes in (by id). */
const ACTION_ICONS: Record<string, React.ReactNode> = {
  comments: <MessagesSquare size={15} aria-hidden />,
  versions: <History size={15} aria-hidden />,
  brain: <Brain size={15} aria-hidden />,
  health: <HeartPulse size={15} aria-hidden />,
  code: <Code2 size={15} aria-hidden />,
  test: <FlaskConical size={15} aria-hidden />,
  download: <Download size={15} aria-hidden />,
};
const actionIcon = (id: string) => ACTION_ICONS[id] ?? <ChevronRight size={15} aria-hidden />;

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
      if (box.current && !e.composedPath().includes(box.current)) onOpenChange(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, onOpenChange]);

  type Row = { key: string; label: string; desc?: string; hint?: string; icon: React.ReactNode; trailing?: React.ReactNode; run: () => void };
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
        projectActions.map((a) => ({ key: a.id, label: a.label, icon: actionIcon(a.id), run: a.run })),
      );
    const root: Row[] = [
      {
        key: "project",
        label: "Project",
        desc: "Comments, versions, health, code and more",
        icon: <FolderKanban size={15} aria-hidden />,
        trailing: <ChevronRight size={15} aria-hidden />,
        run: () => (setView("project"), setQuery("")),
      },
      {
        key: "help",
        label: "Help center",
        desc: "Guides and answers",
        icon: <HelpCircle size={15} aria-hidden />,
        trailing: <ArrowUpRight size={15} aria-hidden />,
        run: () => window.open("/help", "_blank", "noopener"),
      },
      {
        key: "context",
        label: "Add context",
        desc: "Point the agent at a page or file",
        icon: <AtSign size={15} aria-hidden />,
        trailing: (
          <span className="flex items-center gap-1.5 text-ink-3">
            @ <ChevronRight size={15} aria-hidden />
          </span>
        ),
        run: () => (setView("context"), setQuery("")),
      },
      ...(canAttach
        ? [
            {
              key: "attach",
              label: "Attach files",
              desc: "Images, PDFs, Word, Excel, PowerPoint, text",
              icon: <Paperclip size={15} aria-hidden />,
              run: () => document.getElementById(pickerId)?.click(),
            },
          ]
        : []),
    ];
    // Searching from the top level also finds pages, files and project actions.
    if (!q) return root;
    return [
      ...root.filter((r) => r.label.toLowerCase().includes(q)),
      ...filter(projectActions.map((a) => ({ key: a.id, label: a.label, hint: "Project", icon: actionIcon(a.id), run: a.run }))),
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
        accept={ATTACH_ACCEPT}
        onChange={(e) => {
          if (e.target.files?.length) onAttach(e.target.files);
          e.target.value = "";
        }}
      />
      {open && (
        <div className="menu-pop pop absolute bottom-11 left-0 z-40 flex w-[22rem] flex-col overflow-hidden">
          <div className="flex items-center gap-2.5 border-b border-line px-3.5">
            {view !== "root" ? (
              <button
                type="button"
                aria-label="Back"
                className="grid size-7 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
                onClick={() => (setView("root"), setQuery(""))}
              >
                <ArrowLeft size={15} aria-hidden />
              </button>
            ) : (
              <Search size={16} className="shrink-0 text-ink-3" aria-hidden />
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
              placeholder={view === "context" ? "Search pages and files…" : view === "project" ? "Search project actions…" : "Search or jump to…"}
              aria-label="Search"
              className="menu-search h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
            />
            {view !== "root" && <span className="pill shrink-0 text-[11px]">{view === "project" ? "Project" : "Add context"}</span>}
          </div>
          <ul role="listbox" className="max-h-80 overflow-y-auto p-1.5">
            {rows.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-2">Nothing matches “{query.trim()}”.</li>}
            {rows.map((r, i) => {
              const on = i === active;
              return (
                <li
                  key={r.key}
                  role="option"
                  aria-selected={on}
                  onMouseMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 ${r.desc ? "py-2" : "py-1.5"} transition-colors ${on ? "bg-primary-weak" : ""}`}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-lg border transition-colors ${
                      on ? "border-transparent bg-primary text-primary-fg" : "border-line bg-surface-2 text-ink-2"
                    }`}
                  >
                    {r.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13.5px] font-medium ${on ? "text-primary" : "text-ink"}`}>{r.label}</span>
                    {r.desc && <span className="block truncate text-[12px] text-ink-3">{r.desc}</span>}
                  </span>
                  {r.hint && <span className="shrink-0 text-[11.5px] text-ink-3">{r.hint}</span>}
                  {r.trailing && <span className={`shrink-0 ${on ? "text-primary" : "text-ink-3"}`}>{r.trailing}</span>}
                </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[11.5px] text-ink-3">
            <span className="flex items-center gap-1">
              <ArrowUp size={11} aria-hidden />
              <ArrowDown size={11} aria-hidden />
              move
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft size={11} aria-hidden />
              choose
            </span>
            <span className="ml-auto whitespace-nowrap">
              <kbd className="rounded border border-line px-1 font-mono">@</kbd> in the prompt adds context
            </span>
          </div>
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
export function ModeSelect({
  mode,
  onChange,
  autonomous,
  onAutonomous,
}: {
  mode: RunMode;
  onChange: (m: RunMode) => void;
  /** The project's Autonomous switch; omitted for people who can't change it. */
  autonomous?: boolean;
  onAutonomous?: (on: boolean) => void;
}) {
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
      if (box.current && !e.composedPath().includes(box.current)) setOpen(false);
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
          {onAutonomous && (
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(autonomous)}
              onClick={() => onAutonomous(!autonomous)}
              className="mt-1 flex w-full items-start gap-3 rounded-md border-t border-line px-3 pb-2 pt-2.5 text-left hover:bg-surface-2"
            >
              <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-md ${autonomous ? "bg-primary text-primary-fg" : "bg-surface-2 text-ink-2"}`}>
                <Rocket size={15} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Autonomous</span>
                <span className="block text-[13px] text-ink-2">
                  Build start to finish without stopping for plan approval or questions. Plan mode still asks.
                </span>
              </span>
              <span
                className={`mt-1 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${autonomous ? "bg-primary" : "bg-line-2"}`}
                aria-hidden
              >
                <span className={`size-4 rounded-full bg-white shadow transition-transform ${autonomous ? "translate-x-4" : ""}`} />
              </span>
            </button>
          )}
          <p className="mt-1 border-t border-line px-3 pb-1 pt-2 text-xs text-ink-3">
            Switch modes with <kbd className="rounded border border-line-2 px-1 font-mono">⌥</kbd>{" "}
            <kbd className="rounded border border-line-2 px-1 font-mono">P</kbd>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The model picker next to the mode picker: the models an admin allows (Settings › Integrations ›
 * AI model), each with a hint and a cost level. Only shown when there's more than one.
 */
export function ModelPicker({ data, value, onChange, mode }: { data: ProjectModels; value: string; onChange: (key: string) => void; mode: RunMode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !e.composedPath().includes(box.current)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (data.models.length < 2) return null;
  const current = data.models.find((m) => m.key === value) ?? data.models.find((m) => m.key === data.defaultKey) ?? data.models[0]!;
  // "Claude Opus 5.5" → "Opus 5.5" on the button (the menu shows full names).
  // and "gpt-4.1-2025-04-14" → "gpt-4.1" (the date is noise on a small button).
  const short = current.label.replace(/^(Claude|ChatGPT)\s+/i, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const groups = (["anthropic", "openai"] as const)
    .map((p) => ({ p, title: p === "anthropic" ? "Claude" : "ChatGPT", items: data.models.filter((m) => m.provider === p) }))
    .filter((g) => g.items.length);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="btn btn-sm max-w-40"
        aria-expanded={open}
        aria-label={`Model: ${current.label}. Change model`}
        title={`${current.label}: ${current.hint}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Sparkles size={13} className="@max-[28rem]:hidden" aria-hidden />
        <span className="truncate">{short}</span>
        <ChevronDown size={13} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="menu-pop pop absolute bottom-10 left-0 z-40 w-[min(20rem,calc(100vw-2rem))] overflow-hidden" role="listbox" aria-label="Model">
          <p className="border-b border-line px-3.5 py-2.5 text-[12px] text-ink-3">Model for your next message. The project remembers it.</p>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {groups.map((g) => (
              <div key={g.p}>
                {groups.length > 1 && <p className="lab px-2.5 pb-1 pt-2">{g.title}</p>}
                {g.items.map((m) => {
                  const on = m.key === current.key;
                  // Chat-only models can't build: only usable in Chat mode.
                  const blocked = !m.canCode && mode !== "chat";
                  return (
                    <button
                      key={m.key}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={!m.available || blocked}
                      onClick={() => {
                        onChange(m.key);
                        setOpen(false);
                      }}
                      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                        on ? "bg-primary-weak" : "hover:bg-surface-2"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1.5 text-[13.5px] font-medium ${on ? "text-primary" : "text-ink"}`}>
                          <span className="truncate">{m.label}</span>
                          {m.key === data.defaultKey && <span className="pill text-[10px]">Default</span>}
                        </span>
                        <span className="block text-[12px] text-ink-3">
                          {!m.available ? "Not available: no API key" : blocked ? "Chat only: switch to Chat mode to use it" : m.hint}
                        </span>
                        <span
                          className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-medium ${
                            m.canCode ? "bg-primary-weak text-primary" : "bg-surface-2 text-ink-2"
                          }`}
                        >
                          {m.canCode ? <Code2 size={10} aria-hidden /> : <MessageCircle size={10} aria-hidden />}
                          {m.canCode ? "Coding and chat" : "Chat only"}
                        </span>
                      </span>
                      <span
                        className={`mt-0.5 shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          m.cost === 1 ? "bg-ok-weak text-ok" : m.cost === 3 ? "bg-warn-weak text-warn" : "bg-surface-2 text-ink-2"
                        }`}
                      >
                        {["", "Low", "Medium", "High"][m.cost]} cost
                      </span>
                      {on && <Check size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Autonomous toggle in the prompt box: when on, the agent builds start to finish without
 * stopping for plan approval or questions. It doesn't apply to Plan (which asks) or Chat (no changes).
 */
export function AutoToggle({ on, mode, onChange }: { on: boolean; mode: RunMode; onChange: (on: boolean) => void }) {
  const applies = mode !== "plan" && mode !== "chat";
  const title = on
    ? applies
      ? "Autonomous is on: the agent builds start to finish without stopping to ask. Click to turn off."
      : `Autonomous is on, but ${mode === "plan" ? "Plan mode still asks for approval" : "Chat mode doesn't change anything"}. Click to turn off.`
    : "Autonomous is off: the agent may show a plan or ask questions. Click to build start to finish without stopping.";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Autonomous"
      title={title}
      onClick={() => onChange(!on)}
      className={`btn btn-sm gap-1.5 transition-colors ${
        on ? (applies ? "border-primary bg-primary-weak text-primary" : "border-dashed border-primary/50 text-primary/70") : "text-ink-2"
      }`}
    >
      <Rocket size={13} aria-hidden />
      <span className="@max-[28rem]:hidden">Auto</span>
      <span className={`flex h-3.5 w-6 items-center rounded-full p-px transition-colors ${on ? "bg-primary" : "bg-line-2"}`} aria-hidden>
        <span className={`size-3 rounded-full bg-white shadow-sm transition-transform ${on ? "translate-x-2.5" : ""}`} />
      </span>
    </button>
  );
}
