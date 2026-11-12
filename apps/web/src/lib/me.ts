"use client";

import type { Me } from "@forge/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { setOpenProjectsOwner } from "./open-projects";

// One shared fetch per page load. The server snapshot is always null, so role-based UI
// renders the same on the server and during hydration, then fills in.
let cached: Me | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load() {
  if (cached || inflight) return;
  inflight = api.me().then(
    (m) => {
      cached = m;
      setOpenProjectsOwner(m.id);
      listeners.forEach((fn) => fn());
    },
    () => {
      inflight = null; // signed out or offline: try again next time
    },
  );
}

/** The signed-in user and their workspace role (null until loaded). */
export function useMe(): Me | null {
  const me = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => cached,
    () => null,
  );
  useEffect(load, []);
  return me;
}

export const isAdmin = (me: Me | null) => me?.role === "admin";
export const canCreateProjects = (me: Me | null) => me?.role === "admin" || me?.role === "builder";
