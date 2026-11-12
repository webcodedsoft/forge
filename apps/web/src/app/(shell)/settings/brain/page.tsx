"use client";

import type { BrainDoc } from "@forge/protocol";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BrainDocCard, NewBrainDoc } from "@/components/brain-editor";
import { Pagination, usePagination } from "@/components/pagination";
import { BusyLabel, SkeletonCards } from "@/components/loading";
import { BookOpen, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";

/** Team-wide instructions the agent follows in every project. */
export default function TeamBrainPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<BrainDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const pager = usePagination(docs, 6);
  const admin = isAdmin(useMe());

  const load = useCallback(
    () =>
      api.brain().then(setDocs, (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setError(e.message);
      }),
    [router],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="h1">Team brain</h1>
      <p className="mt-1 max-w-2xl text-ink-2">
        Standing instructions the agent follows in every project: engineering rules, our design system, writing style. Changes apply from the next prompt.
        Projects can add their own notes in the builder&apos;s Brain tab.
      </p>
      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <section className="mt-6 flex flex-col gap-3">
        {docs === null ? (
          <SkeletonCards n={3} />
        ) : (
          <>
            {docs.length === 0 && admin && (
              <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
                <div className="grid size-12 place-items-center rounded-xl bg-primary-weak text-primary">
                  <BookOpen size={22} aria-hidden />
                </div>
                <p className="font-semibold">No team docs yet</p>
                <p className="max-w-md text-ink-2">Start with Forge&apos;s recommended docs and adjust them, or write your own below.</p>
                <button
                  aria-busy={seeding}
                  onClick={async () => {
                    setSeeding(true);
                    try {
                      setDocs(await api.addStarterBrain());
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setSeeding(false);
                    }
                  }}
                  className="btn btn-p mt-2"
                >
                  <BusyLabel busy={seeding} busyText="Adding…">
                    Start with recommended docs
                  </BusyLabel>
                </button>
              </div>
            )}
            {pager.items.map((d) => (
              <BrainDocCard key={d.id + d.updatedAt} doc={d} onChange={load} onError={setError} readOnly={!admin} />
            ))}
            <Pagination pager={pager} noun="docs" />
            {admin ? <NewBrainDoc onCreated={load} onError={setError} /> : <p className="text-sm text-ink-2">Only workspace admins can change team docs.</p>}
          </>
        )}
      </section>
    </main>
  );
}
