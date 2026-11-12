"use client";

import { Check, ChevronDown, Laptop, Maximize2, Monitor, RotateCcw, Smartphone, Tablet } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** A screen to preview the app on. Responsive: the frame fills the space, or a size set by hand. */
export type Viewport = { preset: string; width: number | null; height: number | null; rotated: boolean };

type Preset = { id: string; label: string; w: number; h: number; kind: "phone" | "tablet" | "desktop" };
export const PRESETS: Preset[] = [
  { id: "iphone-se", label: "iPhone SE", w: 375, h: 667, kind: "phone" },
  { id: "iphone-15", label: "iPhone 15", w: 393, h: 852, kind: "phone" },
  { id: "pixel-8", label: "Pixel 8", w: 412, h: 915, kind: "phone" },
  { id: "galaxy-s23", label: "Galaxy S23", w: 360, h: 780, kind: "phone" },
  { id: "ipad-mini", label: "iPad mini", w: 768, h: 1024, kind: "tablet" },
  { id: "ipad-air", label: "iPad Air", w: 820, h: 1180, kind: "tablet" },
  { id: "ipad-pro", label: "iPad Pro 12.9″", w: 1024, h: 1366, kind: "tablet" },
  { id: "laptop", label: "Laptop", w: 1280, h: 800, kind: "desktop" },
  { id: "desktop", label: "Desktop", w: 1440, h: 900, kind: "desktop" },
  { id: "full-hd", label: "Full HD", w: 1920, h: 1080, kind: "desktop" },
];
const ICON = { phone: Smartphone, tablet: Tablet, desktop: Laptop };

/** Width × height to render (null = fill the available space on that axis). */
export function viewportSize(v: Viewport): { width: number | null; height: number | null } {
  const p = PRESETS.find((x) => x.id === v.preset);
  if (!p) return { width: v.width, height: v.height };
  return v.rotated ? { width: p.h, height: p.w } : { width: p.w, height: p.h };
}

/* Remembered in this browser. */
const KEY = "forge-viewport";
const DEFAULT: Viewport = { preset: "responsive", width: null, height: null, rotated: false };
let cache: Viewport | null = null;
const listeners = new Set<() => void>();
const read = (): Viewport => {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const ok = v && (v.preset === "responsive" || PRESETS.some((p) => p.id === v.preset));
    cache = ok
      ? { preset: v.preset, width: Number(v.width) || null, height: Number(v.height) || null, rotated: Boolean(v.rotated) }
      : DEFAULT;
  } catch {
    cache = DEFAULT;
  }
  return cache!;
};
export function setViewport(next: Partial<Viewport>, persist = true) {
  cache = { ...read(), ...next };
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* storage unavailable */
    }
  }
  listeners.forEach((fn) => fn());
}
export function useViewport(): Viewport {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    read,
    () => DEFAULT,
  );
}

const clampSize = (n: number) => Math.max(240, Math.min(3840, Math.round(n)));

/** Screen picker + W × H fields + rotate. `actual` is the size the frame has right now. */
export function ViewportPicker({ actual, scale }: { actual: { width: number; height: number }; scale: number }) {
  const v = useViewport();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const preset = PRESETS.find((p) => p.id === v.preset);
  const PresetIcon = preset ? ICON[preset.kind] : Maximize2;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setOpen(false), 0);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);

  // Typing a size switches to Responsive at that size.
  const setDim = (dim: "width" | "height", value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    setViewport({ preset: "responsive", rotated: false, width: actual.width, height: actual.height, [dim]: clampSize(n) });
  };

  return (
    <div ref={box} className="relative flex items-center gap-1">
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-tip="Choose a screen size to preview on"
      >
        <PresetIcon size={14} aria-hidden />
        <span className="hidden lg:inline">{preset ? preset.label : "Responsive"}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      <div className="flex h-[30px] items-center gap-0.5 rounded-md bg-surface-2 px-1.5 font-mono text-xs text-ink-2">
        <input
          key={`w-${actual.width}`}
          aria-label="Preview width"
          data-tip="Width in pixels"
          defaultValue={actual.width}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => Number(e.target.value) !== actual.width && setDim("width", e.target.value)}
          className="w-11 bg-transparent text-right text-ink outline-none"
          inputMode="numeric"
        />
        <span aria-hidden>×</span>
        <input
          key={`h-${actual.height}`}
          aria-label="Preview height"
          data-tip="Height in pixels"
          defaultValue={actual.height}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => Number(e.target.value) !== actual.height && setDim("height", e.target.value)}
          className="w-11 bg-transparent text-ink outline-none"
          inputMode="numeric"
        />
        {scale < 0.995 && (
          <span className="ml-1 text-ink-3" data-tip="Scaled down to fit the space">
            {Math.round(scale * 100)}%
          </span>
        )}
      </div>
      <button
        type="button"
        className="btn btn-g btn-sm btn-icon"
        aria-label="Rotate"
        disabled={!preset}
        onClick={() => setViewport({ rotated: !v.rotated })}
      >
        <RotateCcw size={14} aria-hidden />
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-40 max-h-[70vh] w-64 overflow-y-auto p-1.5" role="menu" aria-label="Screen size">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!preset}
            onClick={() => {
              setViewport({ preset: "responsive", width: null, height: null, rotated: false });
              setOpen(false);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-surface-2"
          >
            <Maximize2 size={14} className="text-ink-3" aria-hidden />
            <span className="flex-1">
              <span className="block font-semibold">Responsive</span>
              <span className="block text-xs text-ink-3">Fills the space · drag the edges to resize</span>
            </span>
            {!preset && <Check size={14} className="text-primary" aria-hidden />}
          </button>
          {(["phone", "tablet", "desktop"] as const).map((kind) => (
            <div key={kind}>
              <p className="lab border-t border-line px-2.5 pb-1 pt-2 capitalize">{kind === "phone" ? "Phones" : kind === "tablet" ? "Tablets" : "Desktops"}</p>
              {PRESETS.filter((p) => p.kind === kind).map((p) => {
                const Icon = kind === "desktop" && p.w >= 1440 ? Monitor : ICON[kind];
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={v.preset === p.id}
                    onClick={() => {
                      setViewport({ preset: p.id, rotated: false });
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"
                  >
                    <Icon size={14} className="text-ink-3" aria-hidden />
                    <span className="flex-1">{p.label}</span>
                    <span className="font-mono text-[11px] text-ink-3">
                      {p.w}×{p.h}
                    </span>
                    {v.preset === p.id && <Check size={14} className="text-primary" aria-hidden />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
