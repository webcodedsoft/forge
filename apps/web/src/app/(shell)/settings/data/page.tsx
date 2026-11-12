"use client";

import type { DataSource, DataSourceKind } from "@forge/protocol";
import { ChevronRight, Database, Lock, Plus, TriangleAlert, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { BusyLabel, SkeletonCards } from "@/components/loading";
import { Modal, ModalActions } from "@/components/modal";
import { OptionCard } from "@/components/option-card";
import { Pagination, usePagination } from "@/components/pagination";
import { ApiError, api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";
import { KIND_LABEL, KINDS, kindIcon, toBase64 } from "./kinds";

/** Settings › Data sources: read-only company data that apps can build on. */
export default function DataSourcesPage() {
  const router = useRouter();
  const admin = isAdmin(useMe());
  const [sources, setSources] = useState<DataSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pager = usePagination(sources, 10);

  const load = useCallback(
    () =>
      api.dataSources().then(setSources, (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setError(e instanceof Error ? e.message : String(e));
      }),
    [router],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="h1">Data sources</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Company data apps can read: databases, spreadsheets and Flowkite. Apps only ever read, and they never see passwords or keys. Each project picks
            the sources it uses under <span className="font-semibold text-ink">APIs & data</span>.
          </p>
        </div>
        {admin && (
          <button type="button" className="btn btn-p" onClick={() => setAdding(true)}>
            <Plus size={15} aria-hidden />
            Add data source
          </button>
        )}
      </div>

      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <X size={14} aria-hidden />
          </button>
        </p>
      )}

      <section className="mt-6 flex flex-col gap-3" aria-label="Data sources">
        {sources === null ? (
          <SkeletonCards n={3} />
        ) : sources.length === 0 ? (
          <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="grid size-12 place-items-center rounded-xl bg-primary-weak text-primary">
              <Database size={22} aria-hidden />
            </div>
            <p className="font-semibold">No data sources yet</p>
            <p className="max-w-md text-ink-2">
              {admin ? "Connect a database with a read-only login, upload a spreadsheet, or add a Flowkite Database API key." : "A workspace admin can connect company data here."}
            </p>
            {admin && (
              <button type="button" className="btn btn-p mt-2" onClick={() => setAdding(true)}>
                <Plus size={15} aria-hidden />
                Add data source
              </button>
            )}
          </div>
        ) : (
          pager.items.map((s) => (
            <Link key={s.id} href={`/settings/data/${s.id}`} className="card fade-in group flex items-center gap-3 p-4 transition-colors hover:border-line-2 hover:bg-surface-2/40">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-weak text-primary">{kindIcon(s.kind)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="h2">{s.title}</h2>
                  <code className="pill pill-pri font-mono">{s.name}</code>
                  <span className="pill">{KIND_LABEL[s.kind]}</span>
                  {s.error && <span className="pill pill-bad">Can&apos;t connect</span>}
                </div>
                <p className="lab mt-1">
                  {s.where} · {s.tables.length} {s.kind === "flowkite" ? "operation" : "table"}
                  {s.tables.length === 1 ? "" : "s"} · used by {s.projects} project{s.projects === 1 ? "" : "s"}
                </p>
              </div>
              <ChevronRight size={18} className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))
        )}
        <Pagination pager={pager} noun="data sources" />
      </section>

      <AddSourceModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(id) => {
          setAdding(false);
          router.push(`/settings/data/${id}`);
        }}
      />
    </main>
  );
}

function AddSourceModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const [kind, setKind] = useState<DataSourceKind>("postgres");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [conn, setConn] = useState({ host: "", port: "", database: "", user: "", password: "", ssl: true });
  const [fk, setFk] = useState({ gatewayUrl: "", database: "", apiKey: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileId = useId();
  const port = KINDS.find((k) => k.id === kind)?.port;
  const set = (k: keyof typeof conn, v: string | boolean) => setConn((c) => ({ ...c, [k]: v }));

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setTitle("");
      setConn({ host: "", port: "", database: "", user: "", password: "", ssl: true });
      setFk({ gatewayUrl: "", database: "", apiKey: "" });
      setFile(null);
      setError(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const base = { name: name.trim(), title: title.trim() || name.trim() };
      let created;
      if (kind === "sheet") {
        if (!file) throw new Error("Choose an Excel (.xlsx) or CSV file.");
        if (file.size > 20 * 1024 * 1024) throw new Error("Spreadsheets can be up to 20 MB.");
        created = await api.createDataSource({ ...base, kind, fileName: file.name, dataBase64: await toBase64(file) });
      } else if (kind === "flowkite") {
        created = await api.createDataSource({ ...base, kind, gatewayUrl: fk.gatewayUrl.trim(), database: fk.database.trim(), apiKey: fk.apiKey.trim() });
      } else {
        created = await api.createDataSource({
          ...base,
          kind,
          connection: { host: conn.host.trim(), port: Number(conn.port) || port, database: conn.database.trim(), user: conn.user.trim(), password: conn.password, ssl: conn.ssl },
        });
      }
      onAdded(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    Boolean(name) && (kind === "sheet" ? Boolean(file) : kind === "flowkite" ? Boolean(fk.gatewayUrl && fk.database && fk.apiKey) : Boolean(conn.host && conn.database && conn.user));

  return (
    <Modal open={open} onClose={onClose} busy={busy} size="lg" icon={<Database size={19} aria-hidden />} title="Add a data source" description="Apps can only read it. Credentials stay in Forge, encrypted.">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend className="lab mb-2">Type</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Type of data source">
            {KINDS.map((k) => (
              <OptionCard
                key={k.id}
                selected={kind === k.id}
                onSelect={() => !k.soon && setKind(k.id as DataSourceKind)}
                disabled={Boolean(k.soon)}
                title={k.label}
                text={k.text}
                icon={k.icon(16)}
                badge={k.soon ? <span className="pill text-[10px]">soon</span> : undefined}
              />
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="lab">Name in code</span>
            <input
              className="in font-mono"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="hr"
              required
              pattern="[a-z][a-z0-9_]{1,39}"
              title="Lowercase letters, numbers and underscores; starts with a letter"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Title</span>
            <input className="in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="HR database" />
          </label>
        </div>

        {kind === "sheet" ? (
          <label
            htmlFor={fileId}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border-2 border-dashed border-line-2 px-6 py-8 text-center transition-colors hover:border-primary hover:bg-primary-weak/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) setFile(f);
            }}
          >
            <Upload size={22} className="text-primary" aria-hidden />
            <span className="font-semibold">{file ? file.name : "Drop an Excel or CSV file here, or choose one"}</span>
            <span className="lab">Each sheet becomes a table; the first row holds the column names. Up to 20 MB.</span>
            <input id={fileId} type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        ) : kind === "flowkite" ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <label className="flex flex-col gap-1.5">
                <span className="lab">Flowkite Data Gateway address</span>
                <input className="in" type="url" value={fk.gatewayUrl} onChange={(e) => setFk({ ...fk, gatewayUrl: e.target.value })} placeholder="https://gateway.flowkite.app" required />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Database key</span>
                <input className="in font-mono" value={fk.database} onChange={(e) => setFk({ ...fk, database: e.target.value })} placeholder="core_db" required />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="lab">Database API key</span>
              <input className="in font-mono" type="password" autoComplete="off" value={fk.apiKey} onChange={(e) => setFk({ ...fk, apiKey: e.target.value })} placeholder="fkg_…" required />
            </label>
            <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
              <Lock size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden />
              In Flowkite: Databases › the database › API › API keys. Forge uses only the key&apos;s read operations; operations that change data are left out.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem_1fr]">
              <label className="flex flex-col gap-1.5">
                <span className="lab">Server</span>
                <input className="in" value={conn.host} onChange={(e) => set("host", e.target.value)} placeholder="db.internal.company.com" required />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Port</span>
                <input className="in" value={conn.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} placeholder={String(port ?? "")} inputMode="numeric" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Database</span>
                <input className="in" value={conn.database} onChange={(e) => set("database", e.target.value)} required />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="lab">Login</span>
                <input className="in" value={conn.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" required />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Password</span>
                <input className="in" type="password" value={conn.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" className="accent-[var(--primary)]" checked={conn.ssl} onChange={(e) => set("ssl", e.target.checked)} />
              Encrypted connection (SSL)
            </label>
            <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
              <Lock size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden />
              Use a login that can only read. Forge also runs every query read-only, but a read-only login is the real safeguard.
            </p>
          </div>
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
          <button type="submit" className="btn btn-p" aria-busy={busy} disabled={!ready}>
            <BusyLabel busy={busy} busyText={kind === "sheet" ? "Reading the file…" : "Connecting…"}>
              {kind === "sheet" ? "Upload" : "Connect"}
            </BusyLabel>
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}
