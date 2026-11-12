"use client";

import type { Project } from "@forge/protocol";
import { BarChart3, BookOpen, FolderKanban, Library, Plug, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ProjectBadge } from "./project-badge";

type Entry = { id: string; label: string; hint: string; href: string; icon: React.ReactNode };

const PAGES: Entry[] = [
  { id: "p-home", label: "Projects", hint: "Home", href: "/", icon: <FolderKanban size={16} aria-hidden /> },
  { id: "p-lib", label: "Templates & library", hint: "Page", href: "/settings/library", icon: <Library size={16} aria-hidden /> },
  { id: "p-brain", label: "Team brain", hint: "Page", href: "/settings/brain", icon: <BookOpen size={16} aria-hidden /> },
  { id: "p-apis", label: "API connections", hint: "Page", href: "/settings/apis", icon: <Plug size={16} aria-hidden /> },
  { id: "p-usage", label: "Usage", hint: "Page", href: "/settings/usage", icon: <BarChart3 size={16} aria-hidden /> },
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
        icon: <ProjectBadge id={p.id} name={p.name} size={20} />,
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
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh]"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div role="dialog" aria-modal="true" aria-label="Go to" className="pop w-full max-w-lg overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={16} className="text-ink-3" aria-hidden />
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
                className="h-12 flex-1 bg-transparent text-[15px] outline-none"
              />
            </div>
            <ul id="palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
              {entries.length === 0 && <li className="px-3 py-6 text-center text-ink-2">Nothing matches.</li>}
              {entries.map((e, i) => (
                <li
                  key={e.id}
                  id={`pal-${e.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    go(e);
                  }}
                  className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 ${i === active ? "bg-primary-weak text-primary" : ""}`}
                >
                  <span className="flex w-5 justify-center text-ink-2">{e.icon}</span>
                  <span className="font-medium">{e.label}</span>
                  <span className="ml-auto truncate text-xs text-ink-3">{e.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
