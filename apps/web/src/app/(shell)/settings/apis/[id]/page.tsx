"use client";

import type { ApiConnectionDetails } from "@forge/protocol";
import { ArrowLeft, KeyRound, Plug, RefreshCw, Trash2, TriangleAlert, Upload, X, Zap } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { BusyLabel, Skeleton, SkeletonRows } from "@/components/loading";
import { Markdown } from "@/components/markdown";
import { Modal, ModalActions } from "@/components/modal";
import { ProjectBadge } from "@/components/project-badge";
import { ApiError, api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";
import { ReplaceSpecModal, SignInModal } from "../api-modals";
import { authLine } from "../auth-fields";
import { Endpoints } from "../endpoints";

/** Settings › API connections › one API: its endpoints, sign-in, spec and the projects using it. */
function ApiConnectionPageInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const admin = isAdmin(useMe());
  const [c, setC] = useState<ApiConnectionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<"signin" | "spec" | "remove" | null>(null);

  const load = useCallback(
    () =>
      api.connection(id).then(setC, (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      }),
    [id, router],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <BackLink />
        <p className="mt-6 text-ink-2">That API doesn&apos;t exist any more.</p>
      </main>
    );
  }
  if (!c) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6" aria-busy>
        <BackLink />
        <div className="mt-4 flex items-center gap-3">
          <Skeleton className="size-12 rounded-xl" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="skel-line w-80 opacity-70" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-[10px]" />
          ))}
        </div>
        <div className="card mt-6">
          <SkeletonRows n={6} />
        </div>
        {error && <p className="mt-4 text-danger">{error}</p>}
      </main>
    );
  }

  return (
    <main className="fade-in mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <BackLink />

      <header className="mt-4 flex flex-wrap items-start gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary-weak text-primary">
          <Plug size={22} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="h1">{c.title || c.name}</h1>
            <code className="pill pill-pri font-mono">{c.name}</code>
            {c.version && <span className="pill">v{c.version}</span>}
            {c.lastTest && <span className={c.lastTest.ok ? "pill pill-ok" : "pill pill-bad"}>{c.lastTest.ok ? "Connected" : "Sign-in failed"}</span>}
          </div>
          <p className="mt-1.5 truncate font-mono text-xs text-ink-2">{c.baseUrl}</p>
        </div>
        {admin && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-sm" aria-busy={busy === "test"} onClick={() => void act("test", () => api.testConnection(c.id))} data-tip="Sign in and make one simple call">
              {busy === "test" ? (
                <BusyLabel busy>Testing</BusyLabel>
              ) : (
                <>
                  <Zap size={13} aria-hidden /> Test connection
                </>
              )}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setModal("signin")}>
              <KeyRound size={13} aria-hidden />
              Sign-in
            </button>
            {c.specUrl ? (
              <button type="button" className="btn btn-sm" aria-busy={busy === "refresh"} onClick={() => void act("refresh", () => api.refreshConnection(c.id))} data-tip="Download the spec again">
                {busy === "refresh" ? (
                  <BusyLabel busy>Refreshing</BusyLabel>
                ) : (
                  <>
                    <RefreshCw size={13} aria-hidden /> Refresh spec
                  </>
                )}
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => setModal("spec")}>
                <Upload size={13} aria-hidden />
                Replace spec
              </button>
            )}
            <button type="button" className="btn btn-g btn-sm btn-icon" aria-label={`Remove ${c.name}`} onClick={() => setModal("remove")}>
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        )}
      </header>

      {(error || c.specError) && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{error ?? `The last spec refresh failed: ${c.specError}`}</span>
          {error && (
            <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Dismiss" onClick={() => setError(null)}>
              <X size={14} aria-hidden />
            </button>
          )}
        </p>
      )}
      {c.lastTest && (
        <p className={`mt-4 rounded-[10px] px-3.5 py-2.5 text-[13px] ${c.lastTest.ok ? "bg-ok-weak text-ok" : "bg-danger-weak text-danger"}`} role="status">
          {c.lastTest.message} <span className="opacity-70">({new Date(c.lastTest.at).toLocaleString()})</span>
        </p>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="At a glance">
        <div className="tile">
          <p className="lab">Endpoints</p>
          <p className="big">{c.operations}</p>
        </div>
        <div className="tile">
          <p className="lab">Sign-in</p>
          <p className="mt-1 text-[13.5px] font-semibold leading-snug">{authLine(c.auth)}</p>
        </div>
        <div className="tile">
          <p className="lab">Spec</p>
          <p className="mt-1 truncate text-[13.5px] font-semibold leading-snug" title={c.specUrl ?? c.specFileName ?? ""}>
            {c.specUrl ? "From a URL" : `Uploaded (${c.specFileName ?? "file"})`}
          </p>
          {c.specFetchedAt && <p className="lab mt-0.5">updated {new Date(c.specFetchedAt).toLocaleDateString()}</p>}
        </div>
        <div className="tile">
          <p className="lab">Used by</p>
          <p className="big">{c.usedBy.length}</p>
        </div>
      </section>

      <section className="card mt-6 p-4" aria-label="Endpoints">
        <h2 className="h2 mb-3">Endpoints</h2>
        <Endpoints connectionId={c.id} name={c.title || c.name} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card p-4" aria-label="About">
          <h2 className="h2">About</h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-ink-2">Base URL</dt>
            <dd className="truncate font-mono text-xs">{c.baseUrl}</dd>
            {c.specUrl && (
              <>
                <dt className="text-ink-2">Spec URL</dt>
                <dd className="truncate font-mono text-xs">
                  <a href={c.specUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                    {c.specUrl}
                  </a>
                </dd>
              </>
            )}
            <dt className="text-ink-2">In code</dt>
            <dd className="font-mono text-xs">
              {c.name}Api, {c.name}ServerApi
            </dd>
            <dt className="text-ink-2">Added by</dt>
            <dd>
              {c.createdBy}, {new Date(c.createdAt).toLocaleDateString()}
            </dd>
          </dl>
          {c.description && <Markdown className="mt-3 border-t border-line pt-3 text-[13px] text-ink-2">{c.description}</Markdown>}
        </section>
        <section className="card p-4" aria-label="Projects using it">
          <h2 className="h2">Projects using it</h2>
          {c.usedBy.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-ink-2">No project uses it yet. In a project, open APIs & data and tick it.</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {c.usedBy.map((p) => (
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
      </div>

      {modal === "signin" && (
        <SignInModal
          connection={c}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void load();
          }}
        />
      )}
      {modal === "spec" && (
        <ReplaceSpecModal
          connection={c}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void load();
          }}
        />
      )}
      <Modal open={modal === "remove"} onClose={() => setModal(null)} busy={busy === "remove"} size="sm" icon={<Trash2 size={18} aria-hidden />} title={`Remove ${c.title || c.name}?`}>
        <p className="text-[13.5px] text-ink-2">
          {c.usedBy.length
            ? `${c.usedBy.length} project${c.usedBy.length === 1 ? " uses" : "s use"} it. Remove it from them first (APIs & data in each project).`
            : "No project uses it. Its saved sign-in is deleted too."}
        </p>
        <ModalActions>
          <button type="button" className="btn btn-g" onClick={() => setModal(null)} disabled={busy === "remove"}>
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-p bg-danger"
            disabled={c.usedBy.length > 0}
            aria-busy={busy === "remove"}
            onClick={async () => {
              setBusy("remove");
              try {
                await api.deleteConnection(c.id);
                router.push("/settings/apis");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(null);
                setModal(null);
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
    <Link href="/settings/apis" className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
      <ArrowLeft size={14} aria-hidden />
      API connections
    </Link>
  );
}

/** The page reads the URL (its id), so it renders inside a Suspense boundary (cacheComponents). */
export default function ApiConnectionPage() {
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
      <ApiConnectionPageInner />
    </Suspense>
  );
}
