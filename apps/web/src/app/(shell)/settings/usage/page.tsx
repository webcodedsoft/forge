"use client";

import { Coins, FlaskConical, Hammer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, ProjectBadge } from "@/components/project-badge";
import { Skeleton, SkeletonRows } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { ApiError } from "@/lib/api";

type Usage = {
  days: number;
  totals: { costUsd: number; runs: number; qaRuns: number };
  byProject: { projectId: string; name: string; runs: number; qaRuns: number; costUsd: number; lastRunAt: string }[];
  byUser: { userName: string; runs: number; costUsd: number }[];
  byDay: { day: string; costUsd: number }[];
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const RANGES = [7, 30, 90];

/** AI usage across the team: what we spend, on which projects, by whom. */
export default function UsagePage() {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Usage | null>(null);
  const [loadedDays, setLoadedDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/usage?days=${days}`, { credentials: "include" })
      .then(async (r) => {
        if (r.status === 401) throw new ApiError(401, "unauthorized");
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<Usage>;
      })
      .then(
        (d) => {
          if (cancelled) return;
          setData(d);
          setLoadedDays(days);
        },
        (e) => {
          if (e instanceof ApiError) router.replace("/login");
          else if (!cancelled) setError(String(e.message ?? e));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [days, router]);

  // Changing the range goes back to page 1.
  const projectPager = usePagination(data?.byProject, 10, days);
  const userPager = usePagination(data?.byUser, 8, days);
  const switching = loadedDays !== null && loadedDays !== days;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">Usage</h1>
          <p className="mt-1 text-ink-2">AI cost of building and testing apps in Forge.</p>
        </div>
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d} className="mode">
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          {error}
        </p>
      )}

      {!data ? (
        <UsageSkeleton />
      ) : (
        <div className={`transition-opacity ${switching ? "opacity-60" : ""}`} aria-busy={switching}>
          <section className="mt-6 grid gap-3 sm:grid-cols-3" aria-label="Totals">
            {(
              [
                ["Total cost", usd(data.totals.costUsd), Coins],
                ["Build runs", String(data.totals.runs), Hammer],
                ["Test runs", String(data.totals.qaRuns), FlaskConical],
              ] as const
            ).map(([label, value, Icon]) => (
              <div key={label} className="tile flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-lg bg-primary-weak text-primary">
                  <Icon size={18} aria-hidden />
                </div>
                <div>
                  <p className="lab">{label}</p>
                  <p className="big">{value}</p>
                </div>
              </div>
            ))}
          </section>

          <DailyChart byDay={data.byDay} days={data.days} />

          <section className="card mt-6 overflow-hidden" aria-label="By project">
            <h2 className="h2 px-4 pt-3.5">By project</h2>
            {data.byProject.length === 0 ? (
              <p className="px-4 py-6 text-ink-2">No runs in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[560px]">
                  <div className="th mt-2">
                    <span className="flex-[2]">Project</span>
                    <span className="w-20 text-right">Builds</span>
                    <span className="w-16 text-right">Tests</span>
                    <span className="flex-1">Share of cost</span>
                    <span className="w-20 text-right">Cost</span>
                    <span className="w-24">Last run</span>
                  </div>
                  {projectPager.items.map((p) => (
                    <Link key={p.projectId} href={`/projects/${p.projectId}`} className="row">
                      <span className="flex min-w-0 flex-[2] items-center gap-2.5">
                        <ProjectBadge id={p.projectId} name={p.name} />
                        <span className="truncate font-semibold">{p.name}</span>
                      </span>
                      <span className="w-20 text-right tabular-nums">{p.runs}</span>
                      <span className="w-16 text-right tabular-nums">{p.qaRuns}</span>
                      <span className="flex-1">
                        <span className="block h-1.5 overflow-hidden rounded-full bg-surface-2">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${data.totals.costUsd ? Math.max(2, (p.costUsd / data.totals.costUsd) * 100) : 0}%` }}
                          />
                        </span>
                      </span>
                      <span className="w-20 text-right font-semibold tabular-nums">{usd(p.costUsd)}</span>
                      <span className="lab w-24">{new Date(p.lastRunAt).toLocaleDateString()}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            <Pagination pager={projectPager} noun="projects" className="border-t border-line px-4" />
          </section>

          <section className="card mt-6 overflow-hidden" aria-label="By teammate">
            <h2 className="h2 px-4 pt-3.5">By teammate</h2>
            {data.byUser.length === 0 ? (
              <p className="px-4 py-6 text-ink-2">No runs in this period.</p>
            ) : (
              <>
                <div className="th mt-2">
                  <span className="flex-1">Name</span>
                  <span className="w-20 text-right">Runs</span>
                  <span className="w-24 text-right">Cost</span>
                </div>
                {userPager.items.map((u) => (
                  <div key={u.userName} className="row">
                    <span className="flex min-w-0 flex-1 items-center gap-2.5">
                      <Avatar name={u.userName} size={26} ring={false} />
                      <span className="truncate">{u.userName}</span>
                    </span>
                    <span className="w-20 text-right tabular-nums">{u.runs}</span>
                    <span className="w-24 text-right font-semibold tabular-nums">{usd(u.costUsd)}</span>
                  </div>
                ))}
              </>
            )}
            <Pagination pager={userPager} noun="people" className="border-t border-line px-4" />
          </section>
        </div>
      )}
    </main>
  );
}

/** Daily cost as columns; each day's exact amount shows on hover/focus and in the screen-reader table. */
function DailyChart({ byDay, days }: { byDay: Usage["byDay"]; days: number }) {
  // Fill in days without runs, so the axis is continuous.
  const map = new Map(byDay.map((d) => [d.day, d.costUsd]));
  const series: { day: string; cost: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, cost: map.get(key) ?? 0 });
  }
  const max = Math.max(...series.map((s) => s.cost), 0.01);
  const fmt = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <section className="card mt-6 p-4" aria-label="Cost per day">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="h2">Cost per day</h2>
        <span className="lab">highest {usd(max)}</span>
      </div>
      <div className="mt-4 flex h-36 items-end gap-[3px]" aria-hidden>
        {series.map((s) => (
          <span key={s.day} className="group relative flex h-full flex-1 items-end" data-tip={`${fmt(s.day)}: ${usd(s.cost)}`}>
            <span
              className={`block w-full rounded-t-[3px] transition-colors ${s.cost ? "bg-primary/80 group-hover:bg-primary" : "bg-surface-2"}`}
              style={{ height: s.cost ? `${Math.max(4, (s.cost / max) * 100)}%` : "3px" }}
            />
          </span>
        ))}
      </div>
      <div className="lab mt-2 flex justify-between" aria-hidden>
        <span>{fmt(series[0]!.day)}</span>
        <span>{fmt(series[series.length - 1]!.day)}</span>
      </div>
      <table className="sr-only">
        <caption>Cost per day</caption>
        <tbody>
          {series
            .filter((s) => s.cost)
            .map((s) => (
              <tr key={s.day}>
                <td>{fmt(s.day)}</td>
                <td>{usd(s.cost)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

function UsageSkeleton() {
  return (
    <div role="status" aria-label="Loading usage">
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="tile flex items-center gap-3">
            <Skeleton className="size-10 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="skel-line w-20" />
              <Skeleton className="h-6 w-24" />
            </div>
          </div>
        ))}
      </div>
      <div className="card mt-6 p-4">
        <Skeleton className="skel-line w-32" />
        <div className="mt-4 flex h-36 items-end gap-[3px]">
          {Array.from({ length: 30 }, (_, i) => (
            <Skeleton key={i} className="flex-1 rounded-b-none" style={{ height: `${20 + ((i * 37) % 70)}%` }} />
          ))}
        </div>
      </div>
      <div className="card mt-6 overflow-hidden">
        <SkeletonRows n={4} />
      </div>
    </div>
  );
}
