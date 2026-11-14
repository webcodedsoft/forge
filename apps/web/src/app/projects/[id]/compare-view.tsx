"use client";

import { onPreviewAccessRequest, usePreviewEntry } from "./preview-entry";
import type { Version, VersionCompare, VersionDiffFile } from "@forge/protocol";
import { Select } from "@/components/select";
import { ArrowRight, Columns2, FileCode2, Minus, Plus, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Skeleton, SkeletonRows, Spinner } from "@/components/loading";
import { api } from "@/lib/api";

/*
 * Changes: compare two versions of the app.
 *   Code          the files that differ and the line-by-line changes
 *   Side by side  the older version running next to the app as it is now
 * `from` may be "<sha>^" (the version before <sha>), which is how "what did this version change?" opens.
 */

export type ComparePair = { from: string; to: string };

const short = (ref: string) => (ref.endsWith("^") ? `before ${ref.slice(0, 7)}` : ref.slice(0, 7));

export function CompareView({
  projectId,
  pair,
  onPair,
  previewUrl,
  refreshKey,
}: {
  projectId: string;
  pair: ComparePair | null;
  onPair: (p: ComparePair) => void;
  /** The current app's preview (base URL). */
  previewUrl: string | null;
  refreshKey: number;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [mode, setMode] = useState<"code" | "side">("code");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.versions(projectId).then(
      (v) => !cancelled && setVersions(v),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  // Default: the latest version against the one before it.
  const effective: ComparePair | null = pair ?? (versions && versions.length > 1 ? { from: versions[1]!.sha, to: versions[0]!.sha } : null);

  if (error) return <p className="text-danger">{error}</p>;
  if (!versions) return <SkeletonRows n={2} className="card" />;
  if (!effective) return <p className="text-ink-2">There is only one version so far. Changes appear here once the agent saves another.</p>;

  const options = versions.map((v) => ({
    value: v.sha,
    label: `${v.sha.slice(0, 7)} · ${v.message.slice(0, 60)}`,
    hint: `${v.current ? "Current · " : ""}${new Date(v.at).toLocaleString()}`,
  }));
  const fromIsParent = effective.from.endsWith("^");

  return (
    <div className="pop mx-auto flex h-full max-w-6xl flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="lab">From</span>
          <Select
            ariaLabel="Compare from"
            size="sm"
            searchable
            className="w-64 max-w-full"
            menuWidth="24rem"
            value={fromIsParent ? "" : effective.from}
            onChange={(v) => v && onPair({ from: v, to: effective.to })}
            options={[...(fromIsParent ? [{ value: "", label: `The version before ${effective.from.slice(0, 7)}` }] : []), ...options]}
          />
        </div>
        <ArrowRight size={14} className="text-ink-3" aria-hidden />
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="lab">To</span>
          <Select
            ariaLabel="Compare to"
            size="sm"
            searchable
            className="w-64 max-w-full"
            menuWidth="24rem"
            value={effective.to}
            onChange={(v) => onPair({ from: effective.from, to: v })}
            options={options}
          />
        </div>
        <div className="seg ml-auto" role="tablist" aria-label="Compare as">
          <button role="tab" aria-selected={mode === "code"} className="mode" onClick={() => setMode("code")}>
            <FileCode2 size={14} aria-hidden />
            Code
          </button>
          <button role="tab" aria-selected={mode === "side"} className="mode" onClick={() => setMode("side")}>
            <Columns2 size={14} aria-hidden />
            Side by side
          </button>
        </div>
      </div>
      {mode === "code" ? (
        <CodeChanges projectId={projectId} pair={effective} />
      ) : (
        <SideBySide projectId={projectId} older={effective.from} previewUrl={previewUrl} toIsCurrent={versions[0]?.sha === effective.to} />
      )}
    </div>
  );
}

/* --------------------------------- code ---------------------------------- */

function CodeChanges({ projectId, pair }: { projectId: string; pair: ComparePair }) {
  const key = `${pair.from}..${pair.to}`;
  const [result, setResult] = useState<{ key: string; data?: VersionCompare; error?: string } | null>(null);
  const [picked, setPicked] = useState<{ key: string; path: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.compareVersions(projectId, pair.from, pair.to).then(
      (data) => !cancelled && setResult({ key, data }),
      (e) => !cancelled && setResult({ key, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, pair.from, pair.to, key]);

  const current = result?.key === key ? result : null;
  const files = current?.data?.files ?? [];
  const path = picked?.key === key && files.some((f) => f.path === picked.path) ? picked.path : files[0]?.path;
  const totals = files.reduce((t, f) => ({ added: t.added + (f.added ?? 0), deleted: t.deleted + (f.deleted ?? 0) }), { added: 0, deleted: 0 });

  if (!current)
    return (
      <p className="flex items-center gap-2 p-4 text-ink-2" role="status">
        <Spinner size={14} className="spinner-pri" />
        Comparing {short(pair.from)} with {short(pair.to)}…
      </p>
    );
  if (current.error) return <p className="p-4 text-danger">{current.error}</p>;
  if (files.length === 0) return <p className="p-4 text-ink-2">These two versions have the same files.</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="max-h-48 shrink-0 overflow-y-auto border-b border-line md:max-h-none md:w-72 md:border-b-0 md:border-r" aria-label="Changed files">
        <p className="lab border-b border-line px-3 py-2">
          {files.length} file{files.length === 1 ? "" : "s"} changed · <span className="text-ok">+{totals.added}</span>{" "}
          <span className="text-danger">−{totals.deleted}</span>
        </p>
        <ul>
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setPicked({ key, path: f.path })}
                aria-current={f.path === path ? "true" : undefined}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${f.path === path ? "bg-primary-weak text-primary" : "hover:bg-surface-2"}`}
              >
                <StatusMark status={f.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 font-mono text-[11px]">
                  {f.added === null ? (
                    <span className="text-ink-3">binary</span>
                  ) : (
                    <>
                      <span className="text-ok">+{f.added}</span> <span className="text-danger">−{f.deleted}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {path && <FileDiff projectId={projectId} pair={pair} file={files.find((f) => f.path === path)!} />}
    </div>
  );
}

function StatusMark({ status }: { status: VersionDiffFile["status"] }) {
  const s = { added: ["A", "text-ok", "Added"], modified: ["M", "text-warn", "Changed"], deleted: ["D", "text-danger", "Deleted"] }[status];
  return (
    <span className={`w-3 shrink-0 font-mono text-[11px] font-bold ${s[1]}`} title={s[2]} aria-label={s[2]}>
      {s[0]}
    </span>
  );
}

type DiffLine = { kind: "hunk" | "ctx" | "add" | "del"; text: string; old?: number; new?: number };

/** Unified diff → lines with old/new line numbers. Header lines are dropped. */
function parseDiff(diff: string): { lines: DiffLine[]; binary: boolean } {
  const lines: DiffLine[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: h[3]!.trim() });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), new: n++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), old: o++ });
    else if (raw.startsWith(" ")) lines.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
  }
  return { lines, binary: /^Binary files /m.test(diff) };
}

function FileDiff({ projectId, pair, file }: { projectId: string; pair: ComparePair; file: VersionDiffFile }) {
  const key = `${pair.from}..${pair.to}:${file.path}`;
  const [state, setState] = useState<{ key: string; diff?: string; truncated?: boolean; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.fileDiff(projectId, pair.from, pair.to, file.path).then(
      (r) => !cancelled && setState({ key, diff: r.diff, truncated: r.truncated }),
      (e) => !cancelled && setState({ key, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, pair.from, pair.to, file.path, key]);
  const parsed = useMemo(() => (state?.key === key && state.diff !== undefined ? parseDiff(state.diff) : null), [state, key]);

  return (
    <section className="min-h-0 min-w-0 flex-1 overflow-auto bg-surface" aria-label={`Changes in ${file.path}`}>
      <p className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-surface px-3 py-2 font-mono text-xs">
        <StatusMark status={file.status} />
        {file.path}
      </p>
      {state?.key !== key ? (
        <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading">
          {[72, 55, 64, 40, 58].map((w) => (
            <Skeleton key={w} className="skel-line" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : state.error ? (
        <p className="p-4 text-danger">{state.error}</p>
      ) : parsed?.binary || file.added === null ? (
        <p className="p-4 text-ink-2">This is a binary file (an image or similar), so there are no lines to show.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
          <tbody>
            {parsed!.lines.map((l, i) =>
              l.kind === "hunk" ? (
                <tr key={i} className="bg-primary-weak/60 text-ink-3">
                  <td colSpan={3} className="px-3 py-0.5">
                    ⋯ {l.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={l.kind === "add" ? "bg-ok-weak" : l.kind === "del" ? "bg-danger-weak" : ""}>
                  <td className="w-10 select-none px-2 text-right align-top text-ink-3">{l.old ?? ""}</td>
                  <td className="w-10 select-none px-2 text-right align-top text-ink-3">{l.new ?? ""}</td>
                  <td className="whitespace-pre-wrap break-all pr-3 align-top">
                    <span className={`inline-block w-4 select-none ${l.kind === "add" ? "text-ok" : l.kind === "del" ? "text-danger" : "text-ink-3"}`} aria-hidden>
                      {l.kind === "add" ? <Plus size={10} className="inline" /> : l.kind === "del" ? <Minus size={10} className="inline" /> : " "}
                    </span>
                    <span className="sr-only">{l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}</span>
                    {l.text}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {state?.truncated && <p className="p-3 text-xs text-ink-3">This file&apos;s changes are very long; only the first part is shown.</p>}
    </section>
  );
}

/* ------------------------------ side by side ----------------------------- */

function SideBySide({
  projectId,
  older,
  previewUrl,
  toIsCurrent,
}: {
  projectId: string;
  older: string;
  previewUrl: string | null;
  toIsCurrent: boolean;
}) {
  const [state, setState] = useState<{ ref: string; url?: string; sha?: string; error?: string } | null>(null);
  const [path, setPath] = useState("/");
  const [reload, setReload] = useState(0);
  // Both previews are private: each frame opens through its own entry link (preview-entry.ts).
  const [accessEpoch, setAccessEpoch] = useState(0);
  const olderEntry = usePreviewEntry(projectId, Boolean(state?.url && state.ref === older), { compare: true, next: path, reloadKey: `${path}:${accessEpoch}` });
  const currentEntry = usePreviewEntry(projectId, Boolean(previewUrl), { next: path, reloadKey: `${path}:${accessEpoch}` });
  useEffect(() => {
    const origins = [previewUrl && new URL(previewUrl).origin, state?.url && new URL(state.url).origin].filter(Boolean) as string[];
    if (!origins.length) return;
    return onPreviewAccessRequest(origins, () => setAccessEpoch((n) => n + 1));
  }, [previewUrl, state?.url]);

  useEffect(() => {
    let cancelled = false;
    api.startComparePreview(projectId, older).then(
      (r) => !cancelled && setState({ ref: older, url: r.url, sha: r.sha }),
      (e) => !cancelled && setState({ ref: older, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, older, reload]);
  // Leaving side by side stops the older version's server.
  useEffect(() => () => void api.stopComparePreview(projectId).catch(() => undefined), [projectId]);

  const ready = state?.ref === older ? state : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-[13px]">
        <label className="flex items-center gap-1.5">
          <span className="lab">Page</span>
          <input
            className="in h-7 w-40 py-0 font-mono text-xs"
            defaultValue={path}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim() || "/";
                setPath(v.startsWith("/") ? v : `/${v}`);
              }
            }}
            aria-label="Page to show on both sides"
          />
        </label>
        <button type="button" className="btn btn-g btn-sm" onClick={() => setReload((r) => r + 1)} data-tip="Restart the older version">
          <RotateCw size={13} aria-hidden />
          Reload
        </button>
        {!toIsCurrent && <span className="lab">The right side is the app as it is now.</span>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-line md:grid-cols-2">
        <figure className="flex min-h-[40vh] flex-col bg-surface">
          <figcaption className="lab border-b border-line px-3 py-1.5">Older · {ready?.sha ? ready.sha.slice(0, 7) : short(older)}</figcaption>
          {ready?.error ? (
            <p className="p-4 text-danger">{ready.error}</p>
          ) : ready?.url ? (
            olderEntry ? (
              <iframe key={`${olderEntry}${reload}`} src={olderEntry} title="Older version" className="min-h-0 w-full flex-1 bg-white" />
            ) : (
              <p className="flex items-center gap-2 p-4 text-ink-2">
                <Spinner size={14} className="spinner-pri" />
                Opening…
              </p>
            )
          ) : (
            <p className="flex items-center gap-2 p-4 text-ink-2">
              <Spinner size={14} className="spinner-pri" />
              Starting the older version. The first load takes about half a minute.
            </p>
          )}
        </figure>
        <figure className="flex min-h-[40vh] flex-col bg-surface">
          <figcaption className="lab border-b border-line px-3 py-1.5">Now</figcaption>
          {previewUrl ? (
            currentEntry ? (
              <iframe key={currentEntry} src={currentEntry} title="Current version" className="min-h-0 w-full flex-1 bg-white" />
            ) : (
              <p className="flex items-center gap-2 p-4 text-ink-2">
                <Spinner size={14} className="spinner-pri" />
                Opening…
              </p>
            )
          ) : (
            <p className="p-4 text-ink-2">The app isn&apos;t running.</p>
          )}
        </figure>
      </div>
    </div>
  );
}
