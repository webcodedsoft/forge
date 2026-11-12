"use client";

import { Spinner } from "@/components/loading";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Contrast,
  EyeOff,
  Keyboard,
  Minimize2,
  Moon,
  MoreHorizontal,
  MousePointerClick,
  PanelBottom,
  Pencil,
  MessageCircle,
  Sun,
  Type,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
/** The previewed app's theme (not Forge's): auto follows the system. */
export type PreviewTheme = "auto" | "light" | "dark";
const themeListeners = new Set<() => void>();
const themeKey = (projectId: string) => `forge-preview-theme:${projectId}`;
const readTheme = (projectId: string): PreviewTheme => {
  try {
    const v = localStorage.getItem(themeKey(projectId));
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
};
export function setPreviewTheme(projectId: string, mode: PreviewTheme) {
  try {
    localStorage.setItem(themeKey(projectId), mode);
  } catch {
    /* storage unavailable */
  }
  themeListeners.forEach((fn) => fn());
}
/** Remembered per project in this browser. */
export function usePreviewTheme(projectId: string): PreviewTheme {
  return useSyncExternalStore(
    (fn) => {
      themeListeners.add(fn);
      return () => void themeListeners.delete(fn);
    },
    () => readTheme(projectId),
    () => "auto" as PreviewTheme,
  );
}

export type ReviewTool = "select" | "text" | "draw" | "comment";
export type ToolbarPlacement = "dock" | "minimize" | "hide";

/* Toolbar settings, remembered in this browser. */
type Prefs = { placement: ToolbarPlacement; shortcuts: boolean };
const KEY = "forge-review-toolbar";
const DEFAULTS: Prefs = { placement: "dock", shortcuts: true };
let cache: Prefs | null = null;
const listeners = new Set<() => void>();
const readPrefs = (): Prefs => {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    cache = {
      placement: v?.placement === "minimize" || v?.placement === "hide" ? v.placement : "dock",
      shortcuts: v?.shortcuts !== false,
    };
  } catch {
    cache = DEFAULTS;
  }
  return cache;
};
export function setToolbarPrefs(next: Partial<Prefs>) {
  cache = { ...readPrefs(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn());
}
export function useToolbarPrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    readPrefs,
    () => DEFAULTS,
  );
}

const TOOLS: { id: ReviewTool; label: string; key: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "select", label: "Select element", key: "S", icon: MousePointerClick },
  { id: "text", label: "Edit text", key: "T", icon: Type },
  { id: "draw", label: "Draw", key: "D", icon: Pencil },
  { id: "comment", label: "Comment", key: "C", icon: MessageCircle },
];

/** Floating toolbar over the preview: select, edit text, draw, comment, and its own settings. */
export function ReviewToolbar({
  active,
  onTool,
  canBuild,
  drawing,
  theme,
  onTheme,
}: {
  /** The previewed app's theme. */
  theme: PreviewTheme;
  onTheme: (mode: PreviewTheme) => void;
  active: ReviewTool | null;
  onTool: (tool: ReviewTool | null) => void;
  canBuild: boolean;
  /** While drawing: actions for the drawing. */
  drawing?: { onDone: () => void; onClear: () => void; busy: boolean };
}) {
  const prefs = useToolbarPrefs();
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  if (prefs.placement === "hide") return null;
  const tools = TOOLS.filter((t) => canBuild || t.id === "comment");

  if (prefs.placement === "minimize") {
    return (
      <button
        type="button"
        onClick={() => setToolbarPrefs({ placement: "dock" })}
        className="pop absolute bottom-4 right-4 z-20 flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold"
        aria-label="Show the review toolbar"
        title="Show the review toolbar"
      >
        <ChevronLeft size={15} aria-hidden />
        Tools
      </button>
    );
  }

  const item = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[14px] hover:bg-surface-2";
  return (
    <div ref={box} className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      {menu && (
        <div className="pop absolute bottom-14 left-1/2 w-60 -translate-x-1/2 p-1.5" role="menu">
          {(
            [
              ["dock", "Dock", PanelBottom],
              ["minimize", "Minimize", Minimize2],
              ["hide", "Hide", EyeOff],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={prefs.placement === id}
              className={item}
              onClick={() => {
                setToolbarPrefs({ placement: id });
                setMenu(false);
              }}
            >
              <Icon size={15} aria-hidden />
              <span className="flex-1">{label}</span>
              {prefs.placement === id && <Check size={15} aria-hidden />}
            </button>
          ))}
          <p className="lab border-t border-line px-2.5 pb-1 pt-2.5 uppercase tracking-wide">App theme</p>
          {(
            [
              ["auto", "Auto", Contrast],
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
            ] as [PreviewTheme, string, typeof Sun][]
          ).map(([id, label, Icon]) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={theme === id} className={item} onClick={() => onTheme(id)}>
              <Icon size={15} aria-hidden />
              <span className="flex-1">{label}</span>
              {theme === id && <Check size={15} aria-hidden />}
            </button>
          ))}
          <label className={`${item} mt-1 cursor-pointer border-t border-line pt-2.5`}>
            <Keyboard size={15} aria-hidden />
            <span className="flex-1">Keyboard shortcuts</span>
            <input
              type="checkbox"
              role="switch"
              checked={prefs.shortcuts}
              onChange={(e) => setToolbarPrefs({ shortcuts: e.target.checked })}
              className="peer sr-only"
            />
            <span aria-hidden className="relative h-5 w-9 rounded-full bg-line-2 transition-colors peer-checked:bg-primary after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
          </label>
        </div>
      )}

      <div className="pop flex items-center gap-0.5 rounded-full p-1.5" role="toolbar" aria-label="Review tools">
        {drawing && active === "draw" ? (
          <>
            <span className="flex items-center gap-1.5 px-2.5 text-[13px] font-semibold">
              <Pencil size={14} className="text-primary" aria-hidden />
              Drawing
            </span>
            <button type="button" className="btn btn-g btn-sm rounded-full" onClick={drawing.onClear} disabled={drawing.busy}>
              Clear
            </button>
            <button type="button" className="btn btn-g btn-sm rounded-full" onClick={() => onTool(null)} disabled={drawing.busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-p btn-sm rounded-full" onClick={drawing.onDone} disabled={drawing.busy}>
              {(drawing.busy) && <Spinner size={13} />}
              {drawing.busy ? "Attaching…" : "Attach to request"}
            </button>
          </>
        ) : (
          <>
            {tools.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={active === t.id}
                aria-label={`${t.label}${prefs.shortcuts ? ` (${t.key})` : ""}`}
                title={`${t.label}${prefs.shortcuts ? ` (${t.key})` : ""}`}
                onClick={() => onTool(active === t.id ? null : t.id)}
                className={`flex size-9 items-center justify-center rounded-full ${active === t.id ? "bg-primary text-primary-fg" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                <t.icon size={17} />
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-line" aria-hidden />
            <button
              type="button"
              aria-label="Toolbar settings"
              title="Toolbar settings"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
              className="flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <MoreHorizontal size={17} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Minimize the toolbar"
              title="Minimize"
              onClick={() => setToolbarPrefs({ placement: "minimize" })}
              className="flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <ChevronRight size={17} aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Freehand drawing layer over the preview. Strokes are in CSS pixels of the layer. */
export function DrawLayer({
  strokes,
  onStrokes,
  scale = 1,
}: {
  strokes: { x: number; y: number }[][];
  onStrokes: (s: { x: number; y: number }[][]) => void;
  /** The frame's display scale: points are stored in the page's own pixels. */
  scale?: number;
}) {
  const [current, setCurrent] = useState<{ x: number; y: number }[] | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const point = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const toPath = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return (
    <svg
      ref={svg}
      className="absolute inset-0 z-10 h-full w-full cursor-crosshair touch-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setCurrent([point(e)]);
      }}
      onPointerMove={(e) => current && setCurrent([...current, point(e)])}
      onPointerUp={() => {
        if (current && current.length > 1) onStrokes([...strokes, current]);
        setCurrent(null);
      }}
      role="img"
      aria-label="Drawing over the preview"
    >
      {[...strokes, ...(current ? [current] : [])].map((s, i) => (
        <path key={i} d={toPath(s)} fill="none" stroke="#e5484d" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
