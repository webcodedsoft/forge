"use client";

import { KeyRound } from "lucide-react";
import { type ProjectSecret, SECRET_NAME } from "@forge/protocol";
import { useEffect, useRef, useState } from "react";
import { BusyLabel, Skeleton } from "@/components/loading";
import { api } from "@/lib/api";

/**
 * Header button + popover for the project's secrets (environment variables).
 * Values are write-only: once saved they can be replaced or removed, never read back.
 */
export function SecretsButton({
  projectId,
  disabled,
  refreshKey,
  onError,
}: {
  projectId: string;
  disabled: boolean;
  /** Bumps when the feed reports a secret change, so other viewers' lists refresh. */
  refreshKey: number;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [secrets, setSecrets] = useState<ProjectSecret[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listSecrets(projectId).then(setSecrets, () => undefined);
  }, [projectId, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !e.composedPath().includes(box.current)) setOpen(false);
    };
    // Clicks inside the preview iframe never reach this document; the window losing focus to it does.
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setOpen(false), 0);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);

  const cleanName = name.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const nameOk = SECRET_NAME.test(cleanName);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const target = replacing ?? cleanName;
    if (!target || !value) return;
    setBusy(true);
    try {
      setSecrets(await api.setSecret(projectId, target, value));
      setName("");
      setValue("");
      setReplacing(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(n: string) {
    setBusy(true);
    try {
      setSecrets(await api.deleteSecret(projectId, n));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const count = secrets?.length ?? 0;
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="API keys and settings for this app"
        className="btn btn-sm"
      >
        <KeyRound size={14} aria-hidden />
        Secrets{count ? ` (${count})` : ""}
      </button>
      {open && (
        <div className="pop absolute right-0 z-20 mt-2 w-96 p-3.5 text-sm">
          <p className="h2">Secrets and settings</p>
          <p className="lab mt-1 font-normal">
            Environment variables for this app, stored encrypted. The app reads them as <code>process.env.NAME</code>; the
            agent sees only the names. Values can be replaced but not viewed. Saving restarts the app.
          </p>
          <p className="mt-2 rounded-md bg-warn-weak px-2.5 py-2 text-xs text-warn">
            Use test or development keys here, never production ones: the agent writes this app&apos;s code, and app code
            can read its own settings.
          </p>

          <ul className="mt-3 space-y-1.5">
            {secrets === null ? (
              <li className="flex flex-col gap-1.5 py-1" role="status" aria-label="Loading">
                <Skeleton className="skel-line w-3/5" />
                <Skeleton className="skel-line h-[0.65em] w-2/5 opacity-70" />
              </li>
            ) : secrets.length === 0 ? (
              <li className="rounded-md border border-dashed border-line-2 px-3 py-3 text-center text-xs text-ink-2">No secrets yet.</li>
            ) : (
              secrets.map((s) => (
                <li key={s.name} className="flex items-center gap-2 rounded-md border border-line bg-surface-2 py-1.5 pl-2.5 pr-1">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">{s.name}</span>
                    <span className="block text-[11px] text-ink-2">
                      {s.public ? "Visible in the browser · " : ""}
                      {s.updatedBy}, {new Date(s.updatedAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-ink-3" aria-hidden>
                    ••••••
                  </span>
                  <button
                    disabled={busy || disabled}
                    onClick={() => {
                      setReplacing(s.name);
                      setValue("");
                    }}
                    className="btn btn-g btn-sm h-7 px-2 text-xs"
                  >
                    Replace
                  </button>
                  <button
                    disabled={busy || disabled}
                    onClick={() => remove(s.name)}
                    aria-label={`Remove ${s.name}`}
                    className="btn btn-g btn-sm btn-danger h-7 px-2 text-xs"
                  >
                    Remove
                  </button>
                </li>
              ))
            )}
          </ul>

          <form onSubmit={save} className="mt-3 space-y-2 border-t border-line pt-3">
            {replacing ? (
              <p className="text-xs text-ink-2">
                New value for <span className="font-mono text-ink">{replacing}</span>{" "}
                <button type="button" onClick={() => setReplacing(null)} className="text-primary underline hover:text-ink">
                  cancel
                </button>
              </p>
            ) : (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="NAME, e.g. STRIPE_API_KEY"
                aria-label="Secret name"
                autoComplete="off"
                spellCheck={false}
                className="in w-full px-2.5 py-1.5 font-mono text-xs"
              />
            )}
            {/* A textarea, not a password field: password managers would offer to save project
                secrets as website logins, and values like PEM keys span several lines.
                The value is visible while typing and hidden once saved. */}
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value (hidden after saving)"
              aria-label="Secret value"
              autoComplete="off"
              spellCheck={false}
              rows={2}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              className="in block w-full resize-y px-2.5 py-1.5 font-mono text-xs"
            />
            {!replacing && name && !nameOk && (
              <p className="text-xs text-danger">Use letters, digits and underscores, starting with a letter.</p>
            )}
            {!replacing && cleanName.startsWith("NEXT_PUBLIC_") && (
              <p className="text-xs text-warn">NEXT_PUBLIC_ values are sent to every visitor&apos;s browser. Don&apos;t use this for keys.</p>
            )}
            <div className="flex items-center justify-between">
              <span className="lab text-[11px]">{disabled ? "Wait for the agent to finish." : ""}</span>
              <button
                disabled={busy || disabled || !value || (!replacing && !nameOk)}
                aria-busy={busy}
                className="btn btn-p btn-sm"
              >
                <BusyLabel busy={busy} busyText="Saving…">
                  {replacing ? "Replace value" : "Add secret"}
                </BusyLabel>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
