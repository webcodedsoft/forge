"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

/*
 * Pagination for lists, done in the browser: the list is loaded in full, one page is shown.
 *
 *   const pager = usePagination(projects, 12);
 *   pager.items.map(...)
 *   <Pagination pager={pager} noun="projects" />
 *
 * The control hides itself when everything fits on one page. If the list shrinks (an item is
 * deleted on the last page) the page number is clamped; a changed `resetKey` (a filter, a tab)
 * goes back to page 1.
 */

export type Pager<T> = {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  from: number;
  to: number;
  pageSize: number;
  setPage: (page: number) => void;
};

export function usePagination<T>(all: readonly T[] | null | undefined, pageSize: number, resetKey: unknown = null): Pager<T> {
  const [state, setState] = useState<{ key: unknown; page: number }>({ key: resetKey, page: 1 });
  const list = all ?? [];
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const wanted = Object.is(state.key, resetKey) ? state.page : 1;
  const page = Math.min(Math.max(1, wanted), pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: list.slice(start, start + pageSize),
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, total),
    pageSize,
    setPage: (p) => setState({ key: resetKey, page: Math.min(Math.max(1, p), pageCount) }),
  };
}

/** Page numbers to show: first, last, and the neighbours of the current page; gaps as "…". */
function pageList(page: number, count: number): (number | "gap")[] {
  const keep = new Set([1, count, page - 1, page, page + 1].filter((n) => n >= 1 && n <= count));
  const out: (number | "gap")[] = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - last === 2) out.push(n - 1); // a single hidden page: show it instead of "…"
    else if (n - last > 2) out.push("gap");
    out.push(n);
    last = n;
  }
  return out;
}

export function Pagination<T>({
  pager,
  noun = "items",
  compact = false,
  className = "",
}: {
  pager: Pager<T>;
  /** Plural name for the count, e.g. "projects". */
  noun?: string;
  /** Narrow places (side panels): no page numbers. */
  compact?: boolean;
  className?: string;
}) {
  if (pager.total <= pager.pageSize) return null;
  const { page, pageCount, setPage } = pager;
  return (
    <nav aria-label={`Pages of ${noun}`} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-[13px] ${className}`}>
      <span className="text-ink-3">
        {pager.from}–{pager.to} of {pager.total} {noun}
      </span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          className="btn btn-g btn-sm btn-icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={15} aria-hidden />
        </button>
        {compact ? (
          <span className="px-1 text-ink-2">
            {page} / {pageCount}
          </span>
        ) : (
          pageList(page, pageCount).map((n, i) =>
            n === "gap" ? (
              <span key={`gap-${i}`} className="px-1 text-ink-3" aria-hidden>
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                aria-label={`Page ${n}`}
                aria-current={n === page ? "page" : undefined}
                onClick={() => setPage(n)}
                className={`h-[30px] min-w-[30px] rounded-md px-2 font-medium ${
                  n === page ? "bg-primary-weak text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {n}
              </button>
            ),
          )
        )}
        <button
          type="button"
          className="btn btn-g btn-sm btn-icon"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={15} aria-hidden />
        </button>
      </span>
    </nav>
  );
}
