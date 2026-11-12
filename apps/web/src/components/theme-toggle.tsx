"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

export type ThemeMode = "auto" | "light" | "dark";
type Theme = "light" | "dark";

/*
 * The theme lives on <html data-theme>; layout.tsx sets it before paint from the saved
 * choice ("forge-theme": light | dark | auto). Auto follows the system setting, live.
 */
const listeners = new Set<() => void>();
const media = () => (typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)"));
const current = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const storedMode = (): ThemeMode => {
  try {
    const v = localStorage.getItem("forge-theme");
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  const m = media();
  const onSystem = () => {
    if (storedMode() === "auto") {
      document.documentElement.dataset.theme = m?.matches ? "dark" : "light";
      listeners.forEach((l) => l());
    }
  };
  m?.addEventListener("change", onSystem);
  return () => {
    listeners.delete(fn);
    m?.removeEventListener("change", onSystem);
  };
};

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem("forge-theme", mode);
  } catch {
    /* private mode: lasts until reload */
  }
  document.documentElement.dataset.theme = mode === "auto" ? (media()?.matches ? "dark" : "light") : mode;
  listeners.forEach((fn) => fn());
}

/** The chosen mode (auto / light / dark). */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, storedMode, () => "auto" as ThemeMode);
}

/** Light/dark switch (remembered in this browser). */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => "light" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn btn-g btn-icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setThemeMode(next)}
    >
      {theme === "dark" ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
    </button>
  );
}
