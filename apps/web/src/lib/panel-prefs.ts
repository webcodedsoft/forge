"use client";

import { useSyncExternalStore } from "react";

/** The builder's left panel: width and whether it's collapsed, remembered in this browser. */
export type PanelPrefs = { width: number; collapsed: boolean };

export const PANEL_DEFAULT = 420;
export const PANEL_MIN = 300;
export const PANEL_MAX = 760;
const KEY = "forge-chat-panel";
const DEFAULTS: PanelPrefs = { width: PANEL_DEFAULT, collapsed: false };

let cache: PanelPrefs | null = null;
const listeners = new Set<() => void>();

function read(): PanelPrefs {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    cache = {
      width: Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number(v?.width) || PANEL_DEFAULT)),
      collapsed: Boolean(v?.collapsed),
    };
  } catch {
    cache = DEFAULTS;
  }
  return cache;
}

export function setPanelPrefs(next: Partial<PanelPrefs>, persist = true) {
  cache = { ...read(), ...next };
  cache.width = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(cache.width)));
  if (persist) {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* storage unavailable: lasts for this page */
    }
  }
  listeners.forEach((fn) => fn());
}

export function usePanelPrefs(): PanelPrefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    read,
    () => DEFAULTS,
  );
}
