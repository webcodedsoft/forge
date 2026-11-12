import { Hono } from "hono";
import { sql } from "../db/index.ts";
import type { AppEnv } from "../index.ts";

/** Team usage for the last N days: AI cost and runs per project, per teammate and per day. */
export const usage = new Hono<AppEnv>().get("/", async (c) => {
  const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
  const rows = await sql<
    { project_id: string; name: string; user_name: string; mode: string; day: Date; cost: string | null; at: Date }[]
  >`
    with runs as (
      select project_id, run_id, payload->>'userName' as user_name,
             coalesce(payload->>'mode', 'build') as mode, at
      from project_event
      where type = 'run.started' and at > now() - make_interval(days => ${days})
    ), costs as (
      select project_id, run_id, sum((payload->>'costUsd')::numeric) as cost
      from project_event where type = 'usage' group by 1, 2
    )
    select r.project_id, p.name, r.user_name, r.mode, date_trunc('day', r.at) as day, c.cost, r.at
    from runs r
    join project p on p.id = r.project_id
    left join costs c on c.project_id = r.project_id and c.run_id = r.run_id
    order by r.at
  `;

  const totals = { costUsd: 0, runs: 0, qaRuns: 0 };
  const byProject = new Map<string, { projectId: string; name: string; runs: number; qaRuns: number; costUsd: number; lastRunAt: string }>();
  const byUser = new Map<string, { userName: string; runs: number; costUsd: number }>();
  const byDay = new Map<string, number>();

  for (const r of rows) {
    const cost = Number(r.cost ?? 0);
    const qa = r.mode === "qa";
    totals.costUsd += cost;
    if (qa) totals.qaRuns += 1;
    else totals.runs += 1;

    const p = byProject.get(r.project_id) ?? { projectId: r.project_id, name: r.name, runs: 0, qaRuns: 0, costUsd: 0, lastRunAt: "" };
    if (qa) p.qaRuns += 1;
    else p.runs += 1;
    p.costUsd += cost;
    p.lastRunAt = new Date(r.at).toISOString();
    byProject.set(r.project_id, p);

    const u = byUser.get(r.user_name) ?? { userName: r.user_name, runs: 0, costUsd: 0 };
    u.runs += 1;
    u.costUsd += cost;
    byUser.set(r.user_name, u);

    const d = new Date(r.day).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + cost);
  }

  return c.json({
    days,
    totals,
    byProject: [...byProject.values()].sort((a, b) => b.costUsd - a.costUsd),
    byUser: [...byUser.values()].sort((a, b) => b.costUsd - a.costUsd),
    byDay: [...byDay.entries()].map(([day, costUsd]) => ({ day, costUsd })),
  });
});
