import type { ActivityItem } from "@forge/protocol";
import { Hono } from "hono";
import { accessibleProjectIds } from "../access.ts";
import { sql } from "../db/index.ts";
import type { AppEnv } from "../index.ts";

/*
 * GET /api/activity: the team's recent activity across projects for the home page,
 * plus a per-project summary (latest version, open comments, whether a run is going).
 * Built from the event log and comments; nothing new is stored.
 */
export const activity = new Hono<AppEnv>().get("/", async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 12) || 12));

  const events = await sql<{ kind: string; project_id: string; project_name: string; who: string | null; text: string; at: Date }[]>`
    (
      select e.type as kind, e.project_id, p.name as project_name,
             coalesce(e.payload->>'userName', s.payload->>'userName') as who,
             case
               when e.type = 'commit' and e.payload ? 'restoredFrom' then 'Restored an earlier version'
               when e.type = 'commit' then 'Saved a version: ' || left(split_part(e.payload->>'message', E'\n', 1), 80)
               when e.type = 'qa.report' then 'Tested the app: ' || jsonb_array_length(e.payload->'issues') || ' issue(s) found'
               when e.type = 'pull_request' then 'Opened or updated a pull request'
               else left(e.payload->>'text', 120)
             end as text,
             e.at
      from project_event e
      join project p on p.id = e.project_id
      left join project_event s on s.project_id = e.project_id and s.run_id = e.run_id and s.type = 'run.started'
      where e.type in ('commit', 'qa.report', 'pull_request')
         or (e.type = 'notice' and (e.run_id like 'secrets-%' or e.run_id like 'template-%' or e.payload->>'text' like 'Saved %library%'))
    )
    union all
    (
      select 'comment', c.project_id, p.name, u.name,
             case when c.parent_id is null then 'Commented: ' else 'Replied: ' end || left(c.body, 80),
             c.created_at
      from project_comment c
      join project p on p.id = c.project_id
      join "user" u on u.id = c.user_id
    )
    order by at desc
    limit ${limit * 5}
  `;

  const projects = await sql<{ id: string; sha: string | null; at: Date | null; open_comments: number; running: boolean }[]>`
    select p.id,
           (select e.payload->>'sha' from project_event e where e.project_id = p.id and e.type = 'commit' order by e.seq desc limit 1) as sha,
           (select max(e.at) from project_event e where e.project_id = p.id) as at,
           (select count(*)::int from project_comment c where c.project_id = p.id and c.parent_id is null and not c.resolved) as open_comments,
           coalesce((select count(*) filter (where e.type = 'run.started') > count(*) filter (where e.type = 'run.finished')
                     from project_event e where e.project_id = p.id), false) as running
    from project p
  `;

  const allowed = await accessibleProjectIds(c.get("user").id, c.get("role"));
  const visible = (id: string) => !allowed || allowed.has(id);
  const items: ActivityItem[] = events.filter((e) => visible(e.project_id)).slice(0, limit).map((e) => ({
    kind: e.kind,
    projectId: e.project_id,
    projectName: e.project_name,
    who: e.who ?? "Forge",
    text: e.text,
    at: new Date(e.at).toISOString(),
  }));
  return c.json({
    items,
    projects: Object.fromEntries(
      projects.filter((p) => visible(p.id)).map((p) => [
        p.id,
        { latestVersion: p.sha, lastActivityAt: p.at ? new Date(p.at).toISOString() : null, openComments: p.open_comments, running: p.running },
      ]),
    ),
  });
});
