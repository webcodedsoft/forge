"use client";

import type { BrainDoc } from "@forge/protocol";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BrainDocCard, NewBrainDoc } from "@/components/brain-editor";
import { SkeletonCards } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { api } from "@/lib/api";

/** Builder tab: this project's notes (editable) and the team docs that also apply. */
export function BrainPanel({ projectId, onError }: { projectId: string; onError: (m: string) => void }) {
  const [docs, setDocs] = useState<BrainDoc[] | null>(null);
  const load = useCallback(
    () => api.brain(projectId).then(setDocs, (e) => onError(e instanceof Error ? e.message : String(e))),
    [projectId, onError],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const mine = (docs ?? []).filter((d) => d.projectId === projectId);
  const team = (docs ?? []).filter((d) => d.projectId === null);
  const minePager = usePagination(mine, 5);
  const teamPager = usePagination(team, 10);
  if (!docs)
    return (
      <div className="p-4">
        <SkeletonCards n={3} />
      </div>
    );

  return (
    <div className="space-y-4 p-4 text-sm">
      <p className="lab">
        The agent follows these on every prompt. Project notes win over team docs when they disagree.
      </p>
      <section className="space-y-2">
        <h3 className="h2">Notes for this project</h3>
        {minePager.items.map((d) => (
          <BrainDocCard key={d.id + d.updatedAt} doc={d} onChange={load} onError={onError} />
        ))}
        <Pagination pager={minePager} noun="notes" compact />
        <NewBrainDoc projectId={projectId} onCreated={load} onError={onError} />
      </section>
      <section className="space-y-1">
        <h3 className="h2">Team docs</h3>
        {team.length === 0 ? (
          <p className="card px-3 py-4 text-center text-xs text-ink-2">None yet.</p>
        ) : (
          <ul className="card overflow-hidden text-xs">
            {teamPager.items.map((d) => (
              <li key={d.id} className={`border-t border-line px-3 py-2 first:border-t-0 ${d.enabled ? "" : "text-ink-3 line-through"}`}>
                {d.title}
              </li>
            ))}
          </ul>
        )}
        <Pagination pager={teamPager} noun="docs" compact />
        <Link href="/settings/brain" className="btn btn-sm mt-1">
          Edit team docs
        </Link>
      </section>
    </div>
  );
}
