"use client";

import type { Project } from "@forge/protocol";
import { ArrowDown, ArrowUp, BarChart3, BookOpen, CornerDownLeft, Database, FolderKanban, Library, Plug, Puzzle, Search, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { ProjectBadge } from "./project-badge";

type Entry = { id: string; label: string; hint: string; href: string; icon: React.ReactNode; group: "Projects" | "Pages" };

const PAGES: Entry[] = [
  { id: "p-home", label: "Projects", hint: "Home", href: "/", icon: <FolderKanban size={16} aria-hidden />, group: "Pages" },
  { id: "p-lib", label: "Templates & library", hint: "Page", href: "/settings/library", icon: <Library size={16} aria-hidden />, group: "Pages" },
  { id: "p-brain", label: "Team brain", hint: "Page", href: "/settings/brain", icon: <BookOpen size={16} aria-hidden />, group: "Pages" },
  { id: "p-apis", label: "API connections", hint: "Page", href: "/settings/apis", icon: <Plug size={16} aria-hidden />, group: "Pages" },
  { id: "p-data", label: "Data sources", hint: "Page", href: "/settings/data", icon: <Database size={16} aria-hidden />, group: "Pages" },
  { id: "p-usage", label: "Usage", hint: "Page", href: "/settings/usage", icon: <BarChart3 size={16} aria-hidden />, group: "Pages" },
  { id: "p-team", label: "Team", hint: "Page", href: "/settings/team", icon: <Users size={16} aria-hidden />, group: "Pages" },
  { id: "p-int", label: "Integrations", hint: "Page", href: "/settings/integrations", icon: <Puzzle size={16} aria-hidden />, group: "Pages" },
];

/** The "Go to anything" search box; ⌘K / Ctrl+K opens it from anywhere. */
export function CommandPalette({ placeholder = "Go to a project or page" }: { placeholder?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    // ⌘K pressed inside the app preview (an iframe) arrives as this event instead.
    const onForward = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("forge:open-palette", onForward);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("forge:open-palette", onForward);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    api.listProjects().then(setProjects, () => undefined);
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const entries = useMemo(() => {
    const all: Entry[] = [
      ...projects.map((p) => ({
        id: p.id,
        label: p.name,
        hint: p.repo ?? "Project",
        href: `/projects/${p.id}`,
        icon: <ProjectBadge id={p.id} name={p.name} size={22} />,
        group: "Projects" as const,
      })),
      ...PAGES,
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((e) => e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q)) : all;
  }, [projects, query]);

  const go = (e: Entry | undefined) => {
    if (!e) return;
    setOpen(false);
    setQuery("");
    router.push(e.href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 min-w-48 max-w-md flex-1 items-center gap-2 rounded-md bg-surface-2 px-3 text-left text-[13px] text-ink-3"
      >
        <Search size={15} aria-hidden />
        {placeholder}
        <kbd className="ml-auto font-mono text-xs">⌘K</kbd>
      </button>
      {open &&
        createPortal(
          // In <body>, so a parent with a transform or backdrop filter (the project top bar) can't trap it.
          <div
            className="palette-backdrop fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
            onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
          >
            <div role="dialog" aria-modal="true" aria-label="Go to" className="palette pop flex h-[min(560px,78vh)] w-full max-w-2xl flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-3 border-b border-line px-4">
                <Search size={18} className="text-ink-3" aria-hidden />
                <input
                  ref={input}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOpen(false);
                    else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActive((a) => Math.min(entries.length - 1, a + 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActive((a) => Math.max(0, a - 1));
                    } else if (e.key === "Enter") go(entries[active]);
                  }}
                  placeholder={placeholder}
                  aria-label={placeholder}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls="palette-list"
                  aria-activedescendant={entries[active] ? `pal-${entries[active].id}` : undefined}
                  className="h-14 flex-1 bg-transparent text-[16px] outline-none"
                />
                <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3">Esc</kbd>
              </div>
              <ul id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
                {entries.length === 0 && <li className="px-3 py-10 text-center text-ink-2">Nothing matches “{query.trim()}”.</li>}
                {entries.map((e, i) => (
                  <li key={e.id} role="presentation">
                    {(i === 0 || entries[i - 1]!.group !== e.group) && (
                      <p className={`lab px-3 pb-1.5 ${i === 0 ? "pt-1" : "pt-3"}`} aria-hidden>
                        {e.group}
                      </p>
                    )}
                    <div
                      id={`pal-${e.id}`}
                      role="option"
                      aria-selected={i === active}
                      ref={(el) => {
                        if (i === active) el?.scrollIntoView({ block: "nearest" });
                      }}
                      onMouseMove={() => i !== active && setActive(i)}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        go(e);
                      }}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] ${i === active ? "bg-primary-weak text-primary" : ""}`}
                    >
                      <span className="flex w-6 justify-center text-ink-2">{e.icon}</span>
                      <span className="truncate font-medium">{e.label}</span>
                      <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-ink-3">{e.hint}</span>
                      {i === active && <CornerDownLeft size={14} className="shrink-0" aria-hidden />}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2.5 text-[12px] text-ink-3">
                <span className="flex items-center gap-1.5">
                  <ArrowUp size={12} aria-hidden />
                  <ArrowDown size={12} aria-hidden />
                  to move
                </span>
                <span className="flex items-center gap-1.5">
                  <CornerDownLeft size={12} aria-hidden />
                  to open
                </span>
                <span className="ml-auto">
                  {entries.length} result{entries.length === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
