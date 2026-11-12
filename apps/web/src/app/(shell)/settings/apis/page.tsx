"use client";

import type { ApiConnection } from "@forge/protocol";
import { ChevronRight, FileUp, KeyRound, Link2, Plug, Plus, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SkeletonCards } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { isAdmin, useMe } from "@/lib/me";
import { api, ApiError } from "@/lib/api";
import { AddApiModal } from "./api-modals";
import { authLine } from "./auth-fields";

/** Settings › API connections: our in-house APIs that generated apps can use. Each opens its details page. */
export default function ApiConnectionsPage() {
  const admin = isAdmin(useMe());
  const router = useRouter();
  const [list, setList] = useState<ApiConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pager = usePagination(list, 10);

  useEffect(() => {
    api.connections().then(setList, (e) => {
      if (e instanceof ApiError && e.status === 401) router.replace("/login");
      else setError(e.message);
    });
  }, [router]);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="h1">API connections</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Our in-house APIs that apps built in Forge can use. Register each one once with its OpenAPI spec and how it signs in; projects pick the ones they
            use. Forge adds the sign-in to every call, so apps never hold keys or passwords.
          </p>
        </div>
        {admin && (
          <button type="button" className="btn btn-p" onClick={() => setAdding(true)}>
            <Plus size={15} aria-hidden />
            Add API
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

      <section className="mt-6 flex flex-col gap-3" aria-label="APIs">
        {list === null ? (
          <SkeletonCards n={3} />
        ) : list.length === 0 ? (
          <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="grid size-12 place-items-center rounded-xl bg-primary-weak text-primary">
              <Plug size={22} aria-hidden />
            </div>
            <p className="font-semibold">No APIs registered yet</p>
            <p className="max-w-md text-ink-2">
              {admin ? "Add one from its OpenAPI spec (a URL or a JSON/YAML file), and projects can start using it." : "A workspace admin can register the company's APIs here."}
            </p>
            {admin && (
              <button type="button" className="btn btn-p mt-2" onClick={() => setAdding(true)}>
                <Plus size={15} aria-hidden />
                Add API
              </button>
            )}
          </div>
        ) : (
          pager.items.map((c) => (
            <Link key={c.id} href={`/settings/apis/${c.id}`} className="card fade-in group flex items-center gap-3 p-4 transition-colors hover:border-line-2 hover:bg-surface-2/40">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-weak text-primary">
                <Plug size={19} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="h2">{c.title || c.name}</h2>
                  <code className="pill pill-pri font-mono">{c.name}</code>
                  {c.version && <span className="pill">v{c.version}</span>}
                  {c.lastTest && <span className={c.lastTest.ok ? "pill pill-ok" : "pill pill-bad"}>{c.lastTest.ok ? "Connected" : "Sign-in failed"}</span>}
                  {c.specError && <span className="pill pill-bad">Spec refresh failed</span>}
                </div>
                <p className="mt-1 truncate font-mono text-xs text-ink-2">{c.baseUrl}</p>
                <p className="lab mt-1 flex flex-wrap items-center gap-x-2">
                  <span>{c.operations} endpoints</span>
                  <span className="flex items-center gap-1">
                    <KeyRound size={12} aria-hidden />
                    {authLine(c.auth)}
                  </span>
                  <span className="flex items-center gap-1">
                    {c.specUrl ? <Link2 size={12} aria-hidden /> : <FileUp size={12} aria-hidden />}
                    {c.specUrl ? "spec from URL" : "spec uploaded"}
                  </span>
                </p>
              </div>
              <ChevronRight size={18} className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))
        )}
        <Pagination pager={pager} noun="APIs" />
      </section>

      <AddApiModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          void api.connections().then(setList);
        }}
      />
    </main>
  );
}
