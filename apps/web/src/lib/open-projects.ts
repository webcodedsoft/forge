"use client";

import { useSyncExternalStore } from "react";

/*
 * Projects open as tabs (like Flowkite's open items), remembered in this browser per
 * account (so a teammate signing in on the same browser never sees someone else's tabs).
 * Opening a project adds it; closing a tab removes it. Up to 8, newest last.
 */

export type OpenProject = { id: string; name: string };

let owner: string | null = null;
const key = () => `forge-open-projects:${owner}`;

/** Called once the signed-in user is known (lib/me.ts); until then the list is empty. */
export function setOpenProjectsOwner(userId: string) {
  if (owner === userId) return;
  owner = userId;
  cache = null;
  try {
    localStorage.removeItem("forge-open-projects"); // the old, shared list
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn());
}
const MAX = 8;
const listeners = new Set<() => void>();
let cache: OpenProject[] | null = null;
const EMPTY: OpenProject[] = [];

function read(): OpenProject[] {
  if (!owner) return EMPTY;
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(key()) ?? "[]");
    cache = Array.isArray(v) ? v.filter((p) => typeof p?.id === "string" && typeof p?.name === "string").slice(-MAX) : [];
  } catch {
    cache = [];
  }
  return cache!;
}

function write(list: OpenProject[]) {
  if (!owner) return;
  cache = list.slice(-MAX);
  try {
    localStorage.setItem(key(), JSON.stringify(cache));
  } catch {
    /* storage unavailable: tabs last for this page only */
  }
  listeners.forEach((fn) => fn());
}

export function openProject(p: OpenProject) {
  const list = read();
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0 && list[i]!.name === p.name) return;
  write(i >= 0 ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]);
}

export function closeProject(id: string) {
  write(read().filter((x) => x.id !== id));
}

export function useOpenProjects(): OpenProject[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    read,
    () => EMPTY,
  );
}
