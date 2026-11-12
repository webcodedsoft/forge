"use client";

import type { DataSourceDetails, DataSourceTable } from "@forge/protocol";
import { ArrowLeft, Pencil, Play, RefreshCw, Search, Table2, Terminal, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
import { BusyLabel, Skeleton, SkeletonRows } from "@/components/loading";
import { Modal, ModalActions } from "@/components/modal";
import { ProjectBadge } from "@/components/project-badge";
import { CodeEditor } from "@/components/code-editor";
import { ApiError, api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";
import { KIND_LABEL, kindIcon, toBase64 } from "../kinds";

type Result = { columns: string[]; rows: Record<string, unknown>[]; truncated?: boolean; nextPage?: string | null };

/** A table's name quoted for its database (for the sample query). */
function qualified(kind: DataSourceDetails["kind"], t: DataSourceTable) {
  const q = (s: string) => (kind === "mysql" ? `\`${s}\`` : kind === "mssql" ? `[${s}]` : `"${s.replace(/"/g, '""')}"`);
  return t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
}
const sampleSql = (kind: DataSourceDetails["kind"], t: DataSourceTable) =>
  kind === "mssql" ? `select top 20 * from ${qualified(kind, t)}` : `select * from ${qualified(kind, t)} limit 20`;

/** Settings › Data sources › one source: its tables (or Flowkite operations), sample rows, queries, projects. */
function DataSourcePageInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const admin = isAdmin(useMe());
  const [source, setSource] = useState<DataSourceDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(
    () =>
      api.dataSource(id).then(setSource, (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      }),
    [id, router],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const flowkite = source?.kind === "flowkite";
  const noun = flowkite ? "operation" : "table";
  const tables = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (source?.tables ?? []).filter((x) => !t || `${x.schema ?? ""}.${x.name} ${x.summary ?? ""}`.toLowerCase().includes(t));
  }, [source, q]);
  const current = source?.tables.find((t) => `${t.schema}.${t.name}` === picked) ?? source?.tables[0] ?? null;

  if (notFound) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <BackLink />
        <p className="mt-6 text-ink-2">That data source doesn&apos;t exist any more.</p>
      </main>
    );
  }
  if (!source) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6" aria-busy>
        <BackLink />
        <div className="mt-4 flex items-center gap-3">
          <Skeleton className="size-12 rounded-xl" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="skel-line w-80 opacity-70" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-[10px]" />
          ))}
        </div>
        <div className="card mt-6">
          <SkeletonRows n={5} />
        </div>
        {error && <p className="mt-4 text-danger">{error}</p>}
      </main>
    );
  }

  const totalRows = source.tables.reduce((n, t) => n + (t.rows ?? 0), 0);
  const hasRows = source.tables.some((t) => t.rows !== undefined);

  return (
    <main className="fade-in mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <BackLink />

      <header className="mt-4 flex flex-wrap items-start gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary-weak text-primary">{kindIcon(source.kind, 22)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="h1">{source.title}</h1>
            <code className="pill pill-pri font-mono">{source.name}</code>
            <span className="pill">{KIND_LABEL[source.kind]}</span>
            {source.error ? <span className="pill pill-bad">Can&apos;t connect</span> : <span className="pill pill-ok">Connected</span>}
          </div>
          <p className="lab mt-1.5">
            {source.where} · checked {new Date(source.refreshedAt).toLocaleString()} · added by {source.createdBy}
          </p>
        </div>
        {admin && (
          <div className="flex flex-wrap gap-1.5">
            {source.kind !== "sheet" && (
              <button
                type="button"
                className="btn btn-sm"
                aria-busy={busy === "refresh"}
                onClick={async () => {
                  setBusy("refresh");
                  setError(null);
                  try {
                    await api.refreshDataSource(source.id);
                    await load();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
                data-tip={`Reconnect and read the ${noun}s again`}
              >
                {busy === "refresh" ? (
                  <BusyLabel busy>Checking</BusyLabel>
                ) : (
                  <>
                    <RefreshCw size={13} aria-hidden /> Refresh
                  </>
                )}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden />
              Edit
            </button>
            <button type="button" className="btn btn-g btn-sm btn-icon" aria-label={`Remove ${source.title}`} onClick={() => setRemoving(true)}>
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        )}
      </header>

      {(error || source.error) && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{error ?? source.error}</span>
          {error && (
            <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
              <X size={14} aria-hidden />
            </button>
          )}
        </p>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="At a glance">
        {(
          [
            [`${noun[0]!.toUpperCase()}${noun.slice(1)}s`, String(source.tables.length)],
            [flowkite ? "Result columns" : "Columns", String(source.tables.reduce((n, t) => n + t.columns.length, 0))],
            ["Rows", hasRows ? totalRows.toLocaleString() : "—"],
            ["Used by", `${source.usedBy.length} project${source.usedBy.length === 1 ? "" : "s"}`],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="tile">
            <p className="lab">{label}</p>
            <p className="big">{value}</p>
          </div>
        ))}
      </section>

      <section className="card mt-6 grid overflow-hidden md:grid-cols-[17rem_1fr]" aria-label={`${noun}s`}>
        <aside className="flex max-h-[32rem] flex-col border-b border-line md:border-b-0 md:border-r">
          <label className="relative m-3 flex items-center">
            <Search size={14} className="pointer-events-none absolute left-3 text-ink-3" aria-hidden />
            <input className="in h-9 w-full pl-8 text-[13px]" placeholder={`Search ${source.tables.length} ${noun}s`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${noun}s`} />
          </label>
          <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
            {tables.length === 0 && <li className="px-4 py-3 text-[13px] text-ink-2">Nothing matches.</li>}
            {tables.map((t) => {
              const key = `${t.schema}.${t.name}`;
              const on = current && `${current.schema}.${current.name}` === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => setPicked(key)}
                    aria-current={on ? "true" : undefined}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] ${on ? "bg-primary-weak font-semibold text-primary" : "hover:bg-surface-2"}`}
                  >
                    {flowkite ? <Play size={13} className="shrink-0 opacity-70" aria-hidden /> : <Table2 size={13} className="shrink-0 opacity-70" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                      {t.schema && !flowkite ? <span className="opacity-60">{t.schema}.</span> : null}
                      {t.name}
                    </span>
                    {t.rows !== undefined && <span className="lab shrink-0">{t.rows.toLocaleString()}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <div className="min-w-0 p-4">
          {current ? (
            <TablePanel key={`${current.schema}.${current.name}`} source={source} table={current} admin={admin} />
          ) : (
            <p className="text-ink-2">No {noun}s were found{flowkite ? " that only read data" : ""}.</p>
          )}
        </div>
      </section>

      {admin && !flowkite && <QueryConsole source={source} />}

      <section className="card mt-6 p-4" aria-label="Projects using it">
        <h2 className="h2">Projects using it</h2>
        {source.usedBy.length === 0 ? (
          <p className="mt-1.5 text-[13px] text-ink-2">No project uses it yet. In a project, open APIs & data and tick it.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {source.usedBy.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="btn btn-sm">
                  <ProjectBadge id={p.id} name={p.name} size={16} />
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <EditModal
          source={source}
          onClose={() => setEditing(false)}
          onSaved={(s) => {
            setSource(s);
            setEditing(false);
          }}
        />
      )}
      <Modal open={removing} onClose={() => setRemoving(false)} busy={busy === "remove"} size="sm" icon={<Trash2 size={18} aria-hidden />} title={`Remove ${source.title}?`}>
        <p className="text-[13.5px] text-ink-2">
          {source.usedBy.length
            ? `${source.usedBy.length} project${source.usedBy.length === 1 ? " uses" : "s use"} it. Their apps will stop getting this data.`
            : "No project uses it."}{" "}
          The saved credentials are deleted.
        </p>
        <ModalActions>
          <button type="button" className="btn btn-g" onClick={() => setRemoving(false)} disabled={busy === "remove"}>
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-p bg-danger"
            aria-busy={busy === "remove"}
            onClick={async () => {
              setBusy("remove");
              try {
                await api.deleteDataSource(source.id);
                router.push("/settings/data");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(null);
                setRemoving(false);
              }
            }}
          >
            <BusyLabel busy={busy === "remove"}>Remove</BusyLabel>
          </button>
        </ModalActions>
      </Modal>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/settings/data" className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
      <ArrowLeft size={14} aria-hidden />
      Data sources
    </Link>
  );
}

/** One table: its columns and (admins) sample rows; for Flowkite, run the operation. */
function TablePanel({ source, table, admin }: { source: DataSourceDetails; table: DataSourceTable; admin: boolean }) {
  const flowkite = source.kind === "flowkite";
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(JSON.stringify({ page: { size: 20 } }, null, 2));
  const bodyId = useId();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (flowkite) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          throw new Error("The body isn't valid JSON.");
        }
        const r = await api.previewDataOperation(source.id, table.name, parsed);
        setResult({ columns: r.rows[0] ? Object.keys(r.rows[0]) : table.columns.map((c) => c.name), rows: r.rows, truncated: r.truncated, nextPage: r.nextPage });
      } else {
        setResult(await api.previewDataQuery(source.id, sampleSql(source.kind, table)));
      }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="flex flex-wrap items-center gap-2 font-mono text-[15px] font-semibold">
          {table.schema && !flowkite ? <span className="text-ink-3">{table.schema}.</span> : null}
          {table.name}
          {table.rows !== undefined && <span className="pill font-sans text-[11px]">{table.rows.toLocaleString()} rows</span>}
        </h3>
        {table.summary && <p className="mt-0.5 text-[13px] text-ink-2">{table.summary}</p>}
      </div>
      <div>
        <p className="lab mb-1.5">{flowkite ? "Returns" : "Columns"}</p>
        <ul className="flex flex-wrap gap-1.5">
          {table.columns.map((c) => (
            <li key={c.name} className="pill font-mono text-[11.5px]">
              {c.name}
              <span className="font-sans text-ink-3">{c.type}</span>
            </li>
          ))}
          {table.columns.length === 0 && <li className="text-[13px] text-ink-2">Not described.</li>}
        </ul>
      </div>
      {flowkite && table.inputs && table.inputs.length > 0 && (
        <div>
          <p className="lab mb-1.5">Takes</p>
          <ul className="flex flex-wrap gap-1.5">
            {table.inputs.map((i) => (
              <li key={i} className="pill pill-pri font-mono text-[11.5px]">
                {i}
              </li>
            ))}
          </ul>
        </div>
      )}
      {admin ? (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          {flowkite && (
            <label className="flex flex-col gap-1.5" htmlFor={bodyId}>
              <span className="lab">Body</span>
              <CodeEditor id={bodyId} language="json" value={body} onChange={setBody} onRun={() => void run()} minHeight={96} maxHeight={260} ariaLabel="Request body (JSON)" />
            </label>
          )}
          <button type="button" className="btn btn-sm self-start" aria-busy={busy} onClick={() => void run()}>
            {busy ? (
              <BusyLabel busy>{flowkite ? "Running" : "Loading rows"}</BusyLabel>
            ) : (
              <>
                <Play size={13} aria-hidden /> {flowkite ? "Run the operation" : result ? "Reload sample rows" : "Show sample rows"}
              </>
            )}
          </button>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          {busy && !result && (
            <div className="flex flex-col gap-1.5" role="status" aria-label="Loading">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-7" />
              ))}
            </div>
          )}
          {result && <ResultTable result={result} />}
        </div>
      ) : (
        <p className="lab border-t border-line pt-4">Workspace admins can look at sample rows.</p>
      )}
    </div>
  );
}

function ResultTable({ result }: { result: Result }) {
  if (result.rows.length === 0) return <p className="rounded-md border border-line p-3 text-[13px] text-ink-2">No rows.</p>;
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-line">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            {result.columns.map((c) => (
              <th key={c} className="whitespace-nowrap border-b border-line px-2.5 py-1.5 font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0 hover:bg-surface-2/50">
              {result.columns.map((c) => (
                <td key={c} className="max-w-64 truncate px-2.5 py-1.5 font-mono text-[12px]" title={r[c] === null || r[c] === undefined ? "" : String(r[c])}>
                  {r[c] === null || r[c] === undefined ? <span className="text-ink-3">null</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(result.truncated || result.nextPage) && <p className="lab border-t border-line px-2.5 py-1.5">Showing the first rows only.</p>}
    </div>
  );
}

function QueryConsole({ source }: { source: DataSourceDetails }) {
  const first = source.tables[0];
  const [sql, setSql] = useState(first ? sampleSql(source.kind, first) : "select 1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function runIt() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.previewDataQuery(source.id, sql));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-6 flex flex-col gap-3 p-4" aria-label="Query">
      <h2 className="h2 flex items-center gap-2">
        <Terminal size={16} aria-hidden />
        Query
      </h2>
      <label htmlFor={id} className="lab">
        Read-only SQL; the first 50 rows are shown. ⌘↵ runs it.
      </label>
      <CodeEditor id={id} language="sql" value={sql} onChange={setSql} onRun={() => void runIt()} minHeight={110} maxHeight={320} ariaLabel="SQL query" />
      <button type="button" className="btn btn-p btn-sm self-start" aria-busy={busy} onClick={() => void runIt()}>
        <BusyLabel busy={busy} busyText="Running…">
          Run
        </BusyLabel>
      </button>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {result && <ResultTable result={result} />}
    </section>
  );
}

function EditModal({ source, onClose, onSaved }: { source: DataSourceDetails; onClose: () => void; onSaved: (s: DataSourceDetails) => void }) {
  const [title, setTitle] = useState(source.title);
  const [secret, setSecret] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileId = useId();
  const db = source.kind === "postgres" || source.kind === "mssql" || source.kind === "mysql";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateDataSource(source.id, {
        ...(title.trim() !== source.title ? { title: title.trim() } : {}),
        ...(db && secret ? { password: secret } : {}),
        ...(source.kind === "flowkite" && secret ? { apiKey: secret.trim() } : {}),
        ...(source.kind === "sheet" && file ? { fileName: file.name, dataBase64: await toBase64(file) } : {}),
      });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} busy={busy} icon={<Pencil size={18} aria-hidden />} title={`Edit ${source.title}`} description="Leave a field empty to keep what's saved.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="lab">Title</span>
          <input className="in" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        {(db || source.kind === "flowkite") && (
          <label className="flex flex-col gap-1.5">
            <span className="lab">{db ? "New password" : "New Database API key"}</span>
            <input className="in font-mono" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={db ? "" : "fkg_…"} />
            <span className="lab">Forge reconnects with it before saving, so a wrong one is caught now.</span>
          </label>
        )}
        {source.kind === "sheet" && (
          <label
            htmlFor={fileId}
            className="flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border-2 border-dashed border-line-2 px-6 py-6 text-center transition-colors hover:border-primary hover:bg-primary-weak/40"
          >
            <Upload size={20} className="text-primary" aria-hidden />
            <span className="font-semibold">{file ? file.name : "Replace the spreadsheet (optional)"}</span>
            <span className="lab">The tables are rebuilt from the new file.</span>
            <input id={fileId} type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {error && (
          <p className="rounded-md bg-danger-weak px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="button" className="btn btn-g" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" aria-busy={busy}>
            <BusyLabel busy={busy} busyText="Saving…">
              Save
            </BusyLabel>
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** The page reads the URL (its id), so it renders inside a Suspense boundary (cacheComponents). */
export default function DataSourcePage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6" aria-busy>
          <div className="card">
            <SkeletonRows n={5} />
          </div>
        </main>
      }
    >
      <DataSourcePageInner />
    </Suspense>
  );
}
