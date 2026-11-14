"use client";

import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/loading";

/*
 * Is the preview reachable? When Forge's preview server can't be reached (it restarts, the
 * connection drops), the browser would show its own "refused to connect" page inside the frame.
 * The builder checks /__forge/ping instead and shows Forge's panel until the preview is back,
 * then reloads the frame.
 */

type State = "checking" | "ok" | "down";

const OK_EVERY = 10_000;
const DOWN_EVERY = 2_500;

/**
 * Whether the preview server answers at all. "no-cors": any answer counts (the response is opaque);
 * only a refused or timed-out connection fails, which is exactly when the frame would show the
 * browser's error page.
 */
async function ping(previewUrl: string): Promise<boolean> {
  try {
    await fetch(new URL("/__forge/ping", previewUrl), { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

/** `onBack` runs when the preview comes back after being unreachable (reload the frame then). */
export function usePreviewReachable(previewUrl: string | null | undefined, onBack: () => void): { state: State; retry: () => void } {
  const [state, setState] = useState<State>("checking");
  const last = useRef<State>("checking");
  const back = useRef(onBack);
  useEffect(() => {
    back.current = onBack;
  }, [onBack]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!previewUrl) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      // Don't poll in a hidden tab; check again when it's shown.
      if (document.hidden) {
        timer = setTimeout(run, OK_EVERY);
        return;
      }
      const ok = await ping(previewUrl);
      if (!live) return;
      const next: State = ok ? "ok" : "down";
      if (next === "ok" && last.current === "down") back.current();
      last.current = next;
      setState(next);
      timer = setTimeout(run, ok ? OK_EVERY : DOWN_EVERY);
    };
    void run();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [previewUrl, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { state, retry };
}

/** Covers the preview frame while it can't be reached. */
export function PreviewOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="fade-in absolute inset-0 z-20 grid place-items-center bg-surface-2 p-6 text-center" role="status">
      <div className="flex max-w-xs flex-col items-center">
        <Spinner size={30} className="spinner-pri mb-4" />
        <p className="text-[15px] font-semibold text-ink">Reconnecting to the preview…</p>
        <p className="mt-1 text-[13px] text-ink-2">Your app and its changes are safe. The preview comes back on its own in a moment.</p>
        <button type="button" className="btn btn-sm mt-4" onClick={onRetry}>
          <RotateCw size={13} aria-hidden />
          Try again now
        </button>
      </div>
    </div>
  );
}
