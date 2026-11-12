"use client";

import type { ApiOperation } from "@forge/protocol";
import { ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { api } from "@/lib/api";

/** Colour per HTTP method (text on a tinted background, readable in both themes). */
const METHOD: Record<ApiOperation["method"], string> = {
  get: "bg-ok-weak text-ok",
  post: "bg-primary-weak text-primary",
  put: "bg-warn-weak text-warn",
  patch: "bg-warn-weak text-warn",
  delete: "bg-danger-weak text-danger",
};

export function MethodBadge({ method }: { method: ApiOperation["method"] }) {
  return <span className={`inline-flex w-14 shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase ${METHOD[method]}`}>{method}</span>;
}

/** An API's endpoints: search, grouped by tag, each expandable to its details. */
export function Endpoints({ connectionId, name }: { connectionId: string; name: string }) {
  const [ops, setOps] = useState<ApiOperation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.apiOperations(connectionId).then(
      (o) => !cancelled && setOps(o),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!ops) return null;
    if (!t) return ops;
    return ops.filter((o) => [o.method, o.path, o.summary ?? "", o.operationId ?? "", ...o.tags].join(" ").toLowerCase().includes(t));
  }, [ops, q]);
  const pager = usePagination(filtered, 15, q);

  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  if (!ops) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading endpoints">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2.5">
            <Skeleton className="h-5 w-14 rounded" />
            <Skeleton className="skel-line" style={{ width: `${35 + ((i * 17) % 40)}%` }} />
          </div>
        ))}
      </div>
    );
  }
  if (ops.length === 0) return <p className="text-[13px] text-ink-2">The spec doesn&apos;t list any endpoints. Refresh the spec, or check the spec URL.</p>;

  // Group the page's endpoints under their first tag, keeping the spec's order.
  const groups: { tag: string; items: ApiOperation[] }[] = [];
  for (const o of pager.items) {
    const tag = o.tags[0] ?? "Other";
    const g = groups.find((x) => x.tag === tag);
    if (g) g.items.push(o);
    else groups.push({ tag, items: [o] });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <label className="relative flex items-center">
        <Search size={14} className="pointer-events-none absolute left-3 text-ink-3" aria-hidden />
        <input
          className="in h-9 w-full pl-8 text-[13px]"
          placeholder={`Search ${ops.length} endpoints of ${name}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={`Search the endpoints of ${name}`}
        />
      </label>
      {filtered && filtered.length === 0 ? (
        <p className="py-3 text-center text-[13px] text-ink-2">No endpoint matches &ldquo;{q}&rdquo;.</p>
      ) : (
        groups.map((g) => (
          <section key={g.tag} aria-label={g.tag}>
            {(groups.length > 1 || g.tag !== "Other") && <p className="lab mb-1 mt-1 uppercase tracking-wide">{g.tag}</p>}
            <ul className="overflow-hidden rounded-md border border-line">
              {g.items.map((o) => (
                <li key={`${o.method} ${o.path}`} className="border-t border-line first:border-0">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 hover:bg-surface-2">
                      <MethodBadge method={o.method} />
                      <code className={`min-w-0 truncate font-mono text-[12.5px] ${o.deprecated ? "text-ink-3 line-through" : ""}`}>{o.path}</code>
                      <span className="hidden min-w-0 flex-1 truncate text-[13px] text-ink-2 sm:block">{o.summary}</span>
                      {o.deprecated && <span className="pill pill-warn text-[11px]">deprecated</span>}
                      <ChevronRight size={14} className="ml-auto shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
                    </summary>
                    <div className="flex flex-col gap-2 border-t border-line bg-surface-2/60 px-3 py-2.5 text-[13px]">
                      {o.summary && <p className="font-semibold sm:hidden">{o.summary}</p>}
                      {o.description && <p className="whitespace-pre-line text-ink-2">{o.description}</p>}
                      {o.parameters.length > 0 ? (
                        <div>
                          <p className="lab mb-1">Parameters</p>
                          <ul className="flex flex-wrap gap-1.5">
                            {o.parameters.map((p) => (
                              <li key={`${p.in}:${p.name}`} className="pill font-mono text-[11.5px]">
                                {p.name}
                                <span className="font-sans text-ink-3">
                                  {p.in}
                                  {p.required ? " · required" : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="lab">No parameters.</p>
                      )}
                      <p className="lab">
                        {o.hasBody ? "Takes a request body." : "No request body."}
                        {o.operationId && (
                          <>
                            {" "}
                            In code: <code className="font-mono text-ink">{o.operationId}</code>
                          </>
                        )}
                      </p>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <Pagination pager={pager} noun="endpoints" />
    </div>
  );
}
