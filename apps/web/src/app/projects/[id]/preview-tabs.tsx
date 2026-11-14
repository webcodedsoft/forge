"use client";

import { ChevronDown, Columns2, Diamond, Globe, Pin, Plus, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { AppRoute } from "@/lib/routes";

/*
 * Chrome-style tabs for pages of the app, with Flowkite's tab menu: split view, pin,
 * move, tab groups (coloured chips that collapse), and the close options.
 */

export type PreviewTab = { id: string; path: string; title: string; pinned?: boolean; group?: string };
export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";
export type TabGroup = { id: string; name: string; color: GroupColor; collapsed?: boolean };

export const GROUP_COLORS: { key: GroupColor; label: string }[] = [
  { key: "grey", label: "Grey" },
  { key: "blue", label: "Blue" },
  { key: "red", label: "Red" },
  { key: "yellow", label: "Yellow" },
  { key: "green", label: "Green" },
  { key: "pink", label: "Pink" },
  { key: "purple", label: "Purple" },
  { key: "cyan", label: "Cyan" },
  { key: "orange", label: "Orange" },
];
const groupColor = (c: GroupColor) => `var(--group-${c})`;
const groupName = (g: TabGroup) => g.name.trim() || "Unnamed group";

/* ---------------------------- pure tab operations ---------------------------- */

/** Pinned tabs first; each group's tabs kept together. */
export function normalizeTabs(tabs: PreviewTab[], groups: TabGroup[]): PreviewTab[] {
  const known = new Set(groups.map((g) => g.id));
  // Pinned tabs and tabs of groups that no longer exist are ungrouped.
  const clean = tabs.map((t) => (t.pinned || (t.group && !known.has(t.group)) ? { ...t, group: undefined } : t));
  const pinned = clean.filter((t) => t.pinned);
  const rest = clean.filter((t) => !t.pinned);
  const out: PreviewTab[] = [];
  const placed = new Set<string>();
  for (const t of rest) {
    if (placed.has(t.id)) continue;
    if (t.group) {
      for (const g of rest.filter((x) => x.group === t.group)) {
        out.push(g);
        placed.add(g.id);
      }
    } else {
      out.push(t);
      placed.add(t.id);
    }
  }
  return [...pinned, ...out];
}
const move = (tabs: PreviewTab[], id: string, to: number) => {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0 || to === from) return tabs;
  const next = [...tabs];
  const [t] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, t!);
  return next;
};

type MenuEntry =
  | { kind: "item"; label: string; run: () => void; disabled?: boolean; lead?: React.ReactNode; extra?: React.ReactNode; separator?: boolean }
  | { kind: "heading"; label: string }
  | { kind: "colors"; value: GroupColor; pick: (c: GroupColor) => void };

export function PreviewTabs({
  tabs,
  groups,
  activeId,
  splitId,
  routes,
  onSelect,
  onOpen,
  onChange,
  onCloseMany,
  onSplit,
}: {
  tabs: PreviewTab[];
  groups: TabGroup[];
  activeId: string;
  /** The tab shown in the right half of split view, if any. */
  splitId: string | null;
  routes: AppRoute[];
  onSelect: (id: string) => void;
  /** Open a page in a new tab. */
  onOpen: (route: AppRoute) => void;
  /** Tabs/groups changed (order, pins, groups). */
  onChange: (tabs: PreviewTab[], groups: TabGroup[]) => void;
  onCloseMany: (ids: string[]) => void;
  onSplit: (id: string | null) => void;
}) {
  const [menu, setMenu] = useState<{ kind: "tab" | "group" | "new" | "all"; id?: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (box.current && !e.composedPath().includes(box.current)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setMenu(null), 0);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [menu]);

  const label = (t: PreviewTab) => t.title || t.path;
  const set = (nextTabs: PreviewTab[], nextGroups = groups) => {
    // Groups with no tabs left go away.
    const used = new Set(nextTabs.map((t) => t.group).filter(Boolean));
    const g = nextGroups.filter((x) => used.has(x.id));
    onChange(normalizeTabs(nextTabs, g), g);
  };
  const openMenu = (e: React.MouseEvent, kind: "tab" | "group", id: string) => {
    e.preventDefault();
    const r = box.current!.getBoundingClientRect();
    setMenu({ kind, id, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const tabEntries = (t: PreviewTab): MenuEntry[] => {
    const i = tabs.findIndex((x) => x.id === t.id);
    const others = tabs.filter((x) => x.id !== t.id && !x.pinned).map((x) => x.id);
    const toRight = tabs.slice(i + 1).filter((x) => !x.pinned).map((x) => x.id);
    const unpinned = tabs.filter((x) => !x.pinned).map((x) => x.id);
    const otherGroups = groups.filter((g) => g.id !== t.group);
    return [
      {
        kind: "item",
        label: "Open in split view",
        lead: <Columns2 size={14} className="text-ink-3" aria-hidden />,
        extra: <span className="pill pill-pri py-0 text-[11px]">Beta</span>,
        disabled: t.id === activeId || t.id === splitId,
        run: () => onSplit(t.id),
      },
      ...(splitId ? [{ kind: "item" as const, label: "Close split view", run: () => onSplit(null) }] : []),
      {
        kind: "item",
        label: t.pinned ? "Unpin tab" : "Pin tab",
        lead: <Pin size={14} className="text-ink-3" aria-hidden />,
        separator: true,
        run: () => set(tabs.map((x) => (x.id === t.id ? { ...x, pinned: !t.pinned, group: undefined } : x))),
      },
      { kind: "item", label: "Move left", separator: true, disabled: i === 0, run: () => set(move(tabs, t.id, i - 1)) },
      { kind: "item", label: "Move right", disabled: i === tabs.length - 1, run: () => set(move(tabs, t.id, i + 1)) },
      { kind: "item", label: "Move to start", disabled: i === 0, run: () => set(move(tabs, t.id, 0)) },
      { kind: "item", label: "Move to end", disabled: i === tabs.length - 1, run: () => set(move(tabs, t.id, tabs.length - 1)) },
      // A pinned tab can't be in a group.
      ...(t.pinned
        ? []
        : [
            {
              kind: "item" as const,
              label: "Add to new group",
              separator: true,
              run: () => {
                const id = `g${Date.now().toString(36)}`;
                const color = GROUP_COLORS[groups.length % GROUP_COLORS.length]!.key;
                set(
                  tabs.map((x) => (x.id === t.id ? { ...x, group: id } : x)),
                  [...groups, { id, name: "", color }],
                );
                setRenaming(id);
              },
            },
            ...(otherGroups.length ? [{ kind: "heading" as const, label: "Add to group" }] : []),
            ...otherGroups.map(
              (g): MenuEntry => ({
                kind: "item",
                label: groupName(g),
                lead: <span className="size-2.5 rounded-full" style={{ background: groupColor(g.color) }} aria-hidden />,
                run: () => {
                  // Join the end of that group's run.
                  const moved = tabs.map((x) => (x.id === t.id ? { ...x, group: g.id } : x));
                  const without = moved.filter((x) => x.id !== t.id);
                  const lastIdx = without.map((x) => x.group).lastIndexOf(g.id);
                  without.splice(lastIdx + 1, 0, moved.find((x) => x.id === t.id)!);
                  set(without);
                },
              }),
            ),
            ...(t.group ? [{ kind: "item" as const, label: "Remove from group", run: () => set(tabs.map((x) => (x.id === t.id ? { ...x, group: undefined } : x))) }] : []),
          ]),
      { kind: "item", label: "Close tab", separator: true, disabled: tabs.length <= 1, run: () => onCloseMany([t.id]) },
      { kind: "item", label: "Close other tabs", disabled: others.length === 0, run: () => onCloseMany(others) },
      { kind: "item", label: "Close tabs to the right", disabled: toRight.length === 0, run: () => onCloseMany(toRight) },
      { kind: "item", label: "Close all tabs", disabled: unpinned.length === 0, run: () => onCloseMany(unpinned) },
    ];
  };
  const groupEntries = (g: TabGroup): MenuEntry[] => [
    { kind: "item", label: "Rename", run: () => setRenaming(g.id) },
    { kind: "colors", value: g.color, pick: (color) => onChange(tabs, groups.map((x) => (x.id === g.id ? { ...x, color } : x))) },
    {
      kind: "item",
      label: "Ungroup",
      separator: true,
      run: () => set(tabs.map((x) => (x.group === g.id ? { ...x, group: undefined } : x)), groups.filter((x) => x.id !== g.id)),
    },
    { kind: "item", label: "Close group", run: () => onCloseMany(tabs.filter((x) => x.group === g.id).map((x) => x.id)) },
  ];

  const renderMenu = (entries: MenuEntry[]) => (
    <div className="pop absolute z-40 w-60 p-1.5" role="menu" style={{ left: Math.max(0, (menu?.x ?? 0) - 8), top: (menu?.y ?? 0) + 6 }}>
      {entries.map((m, i) => {
        if (m.kind === "heading") {
          return (
            <p key={`h${i}`} className="lab px-2.5 pb-1 pt-2">
              {m.label}
            </p>
          );
        }
        if (m.kind === "colors") {
          return (
            <div key="colors" role="group" aria-label="Colour" className="flex flex-wrap gap-1.5 px-2.5 py-2">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-label={c.label}
                  aria-pressed={m.value === c.key}
                  title={c.label}
                  onClick={() => m.pick(c.key)}
                  className={`size-5 rounded-full ${m.value === c.key ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""}`}
                  style={{ background: groupColor(c.key) }}
                />
              ))}
            </div>
          );
        }
        return (
          <Fragment key={m.label + i}>
            {m.separator && i > 0 && <div className="my-1 border-t border-line" />}
            <button
              type="button"
              role="menuitem"
              disabled={m.disabled}
              onClick={() => {
                setMenu(null);
                m.run();
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="flex w-4 justify-center">{m.lead}</span>
              <span className="flex-1">{m.label}</span>
              {m.extra}
            </button>
          </Fragment>
        );
      })}
    </div>
  );

  // Render pinned tabs, then group chips before each group's run of tabs.
  const items: React.ReactNode[] = [];
  let lastGroup: string | undefined;
  for (const t of tabs) {
    const g = t.group ? groups.find((x) => x.id === t.group) : undefined;
    if (g && g.id !== lastGroup) {
      const count = tabs.filter((x) => x.group === g.id).length;
      items.push(
        renaming === g.id ? (
          <input
            key={`chip-${g.id}`}
            autoFocus
            defaultValue={g.name}
            placeholder="Name this group"
            aria-label="Group name"
            onBlur={(e) => {
              onChange(tabs, groups.map((x) => (x.id === g.id ? { ...x, name: e.target.value.slice(0, 40) } : x)));
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
            className="mb-1 h-6 w-32 shrink-0 rounded-md border px-2 text-xs outline-none"
            style={{ borderColor: groupColor(g.color) }}
          />
        ) : (
          <button
            key={`chip-${g.id}`}
            type="button"
            aria-expanded={!g.collapsed}
            aria-label={`${groupName(g)}, ${count} tab${count === 1 ? "" : "s"}. ${g.collapsed ? "Expand" : "Collapse"} the group`}
            onClick={() => onChange(tabs, groups.map((x) => (x.id === g.id ? { ...x, collapsed: !x.collapsed } : x)))}
            onContextMenu={(e) => openMenu(e, "group", g.id)}
            className="mb-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold"
            style={{ background: groupColor(g.color), color: "var(--group-fg)" }}
          >
            {g.name.trim() || (g.collapsed ? "" : " ")}
            {g.collapsed && <span className="tabular-nums opacity-80">{count}</span>}
          </button>
        ),
      );
    }
    lastGroup = g?.id;
    if (g?.collapsed && t.id !== activeId) continue;
    const active = t.id === activeId;
    const inSplit = t.id === splitId;
    items.push(
      <div
        key={t.id}
        onContextMenu={(e) => openMenu(e, "tab", t.id)}
        className={`group relative flex h-8 shrink items-center gap-1.5 rounded-t-lg text-[13px] ${t.pinned ? "w-10 justify-center px-0" : "min-w-[110px] max-w-[220px] pl-3 pr-1"} ${
          active ? "bg-paper text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
        }`}
        title={`${label(t)}\n${t.path}${t.pinned ? "\nPinned" : ""}`}
      >
        {g ? (
          <span className="absolute inset-x-1.5 top-0 h-[3px] rounded-b-full" style={{ background: groupColor(g.color) }} aria-hidden />
        ) : (
          active && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t-lg bg-primary" aria-hidden />
        )}
        <button
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={t.pinned ? `${label(t)} (pinned)` : undefined}
          onClick={() => onSelect(t.id)}
          className={`flex min-w-0 items-center gap-1.5 text-left ${t.pinned ? "justify-center" : "flex-1"}`}
        >
          {inSplit ? (
            <Columns2 size={13} className="shrink-0 text-primary" aria-hidden />
          ) : (
            <Globe size={13} className={`shrink-0 ${active ? "text-primary" : "text-ink-3"}`} aria-hidden />
          )}
          {!t.pinned && <span className={`truncate ${active ? "font-semibold" : ""}`}>{label(t)}</span>}
        </button>
        {!t.pinned && tabs.length > 1 && (
          <button
            type="button"
            aria-label={`Close ${label(t)}`}
            onClick={() => onCloseMany([t.id])}
            className={`flex size-[22px] shrink-0 items-center justify-center rounded text-ink-3 hover:bg-surface hover:text-ink ${active ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </div>,
    );
  }

  const menuTab = menu?.kind === "tab" ? tabs.find((t) => t.id === menu.id) : undefined;
  const menuGroup = menu?.kind === "group" ? groups.find((g) => g.id === menu.id) : undefined;

  return (
    <div ref={box} className="relative flex min-w-0 flex-1 items-end gap-0.5">
      <div role="tablist" aria-label="Open pages" className="flex min-w-0 items-end gap-0.5 overflow-hidden">
        {items}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        aria-expanded={menu?.kind === "new"}
        onClick={(e) => {
          const r = box.current!.getBoundingClientRect();
          setMenu(menu?.kind === "new" ? null : { kind: "new", x: e.clientX - r.left, y: 30 });
        }}
        className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <Plus size={15} aria-hidden />
      </button>
      {tabs.length > 3 && (
        <button
          type="button"
          aria-label="All open tabs"
          aria-expanded={menu?.kind === "all"}
          onClick={() => setMenu(menu?.kind === "all" ? null : { kind: "all", x: 0, y: 30 })}
          className="mb-0.5 ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          {tabs.length} tabs
          <ChevronDown size={13} aria-hidden />
        </button>
      )}

      {menuTab && renderMenu(tabEntries(menuTab))}
      {menuGroup && renderMenu(groupEntries(menuGroup))}
      {menu?.kind === "new" && (
        <div className="pop absolute z-40 max-h-80 w-80 overflow-y-auto p-1.5" role="menu" aria-label="Open a page" style={{ left: Math.max(0, menu.x - 24), top: 36 }}>
          <p className="lab px-3 pb-1 pt-1.5">Open a page in a new tab</p>
          {routes.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-2">No pages found yet.</p>}
          {routes.map((r) => (
            <button
              key={r.path}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpen(r);
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-surface-2"
            >
              <Diamond size={14} className="shrink-0 text-ink-3" aria-hidden />
              <span className="font-mono text-[13px]">{r.path}</span>
              {r.dynamic && <span className="pill">needs a value</span>}
              <span className="ml-auto truncate font-mono text-[11px] text-ink-3">{r.file}</span>
            </button>
          ))}
        </div>
      )}
      {menu?.kind === "all" && (
        <div className="pop absolute right-0 top-9 z-40 max-h-80 w-72 overflow-y-auto p-1.5" role="menu" aria-label="All open tabs">
          <p className="lab px-3 pb-1 pt-1.5">All open tabs</p>
          {tabs.map((t) => (
            <div key={t.id} className={`flex items-center rounded-md ${t.id === activeId ? "bg-primary-weak text-primary" : "hover:bg-surface-2"}`}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onSelect(t.id);
                }}
                className="min-w-0 flex-1 px-3 py-2 text-left"
              >
                <span className="block truncate text-[13px] font-semibold">
                  {t.pinned && <Pin size={11} className="mr-1 inline" aria-hidden />}
                  {label(t)}
                </span>
                <span className="block truncate font-mono text-[11px] opacity-70">{t.path}</span>
              </button>
              {tabs.length > 1 && (
                <button type="button" aria-label={`Close ${label(t)}`} onClick={() => onCloseMany([t.id])} className="mr-1 rounded p-1 hover:bg-surface">
                  <X size={13} aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
