import { accessibleProjectIds, atLeastProject, grantProject } from "../access.ts";
import { applyTemplateToNewProject } from "../templates.ts";
import {
  AnswerPauseInput,
  CreateProjectInput,
  ImportProjectInput,
  ProjectSettingsInput,
  SetProjectConnectionsInput,
  StartRunInput,
  type Project,
  type SandboxStatus,
  type StartRunResponse,
  CreatePreviewShareInput,
} from "@forge/protocol";
import { ConnectionError, projectConnectionIds, setProjectConnections } from "../connections.ts";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import { db, schema } from "../db/index.ts";
import type { AppEnv } from "../index.ts";
import {
  activeRunId,
  answerPause,
  cancelRun,
  discardChanges,
  isRunning,
  listChanges,
  PauseError,
  RunConflictError,
  startQa,
  startRun,
} from "../runs.ts";
import { ensureSandbox, prepareStatus, previewUrl, sandboxState, stopSandbox } from "../sandbox.ts";
import { GitHubError, importProject, openOrUpdatePullRequest } from "../github.ts";
import { listVersions, restoreVersion, VersionError } from "../versions.ts";
import { enqueue, hasQueued, listQueue, QueueError, removeQueued, runNext } from "../queue.ts";
import { chatOnlyModel, projectModels } from "../ai.ts";
import { suggestProjectName } from "../naming.ts";
import { createShare, listShares, memberEnterUrl, revokeShare } from "../preview-access.ts";

// Lowercase alphanumerics: project ids are used in preview hostnames.
const newProjectId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

async function projectExists(id: string) {
  const [r] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.id, id));
  return Boolean(r);
}

async function sandboxStatus(id: string, error?: string): Promise<SandboxStatus> {
  const prep = prepareStatus(id);
  if (prep) {
    return {
      state: prep.error ? "error" : "starting",
      stage: prep.stage,
      previewUrl: null,
      activeRunId: activeRunId(id),
      error: prep.error,
    };
  }
  const state = error ? "error" : await sandboxState(id);
  return { state, previewUrl: state === "running" ? previewUrl(id) : null, activeRunId: activeRunId(id), error };
}

const toProject = (row: typeof schema.project.$inferSelect, ownerName?: string): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  ownerId: row.ownerId,
  ownerName,
  status: row.status,
  source: row.source === "github" ? "github" : "template",
  repo: row.repo,
  baseBranch: row.baseBranch,
  workBranch: row.workBranch,
  prUrl: row.prUrl,
  autoQa: row.autoQa,
  autoQaDailyBudgetCents: row.autoQaDailyBudgetCents,
  autonomous: row.autonomous,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const projects = new Hono<AppEnv>()
  // Workspace admins see every project; everyone else, the projects shared with them.
  .get("/", async (c) => {
    const user = c.get("user");
    const allowed = await accessibleProjectIds(user.id, c.get("role"));
    const roles = new Map(
      (await db.select().from(schema.projectMember).where(eq(schema.projectMember.userId, user.id))).map((m) => [m.projectId, m.role]),
    );
    const rows = await db
      .select({ p: schema.project, ownerName: schema.user.name })
      .from(schema.project)
      .innerJoin(schema.user, eq(schema.user.id, schema.project.ownerId))
      .orderBy(desc(schema.project.updatedAt));
    return c.json(
      rows
        .filter((r) => !allowed || allowed.has(r.p.id))
        .map((r) => ({
          ...toProject(r.p, r.ownerName),
          myRole: (c.get("role") === "admin" ? "admin" : roles.get(r.p.id)) as Project["myRole"],
        })),
    );
  })
  .post("/", async (c) => {
    const parsed = CreateProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { templateId } = parsed.data;
    if (templateId) {
      const [t] = await db.select({ id: schema.projectTemplate.id }).from(schema.projectTemplate).where(eq(schema.projectTemplate.id, templateId));
      if (!t) return c.json({ error: "That template no longer exists." }, 400);
    }
    const [row] = await db
      .insert(schema.project)
      .values({
        id: newProjectId(),
        name: parsed.data.name,
        nameAuto: Boolean(parsed.data.autoName),
        description: parsed.data.description ?? null,
        ownerId: c.get("user").id,
        templateId: templateId ?? null,
      })
      .returning();
    // The creator manages the project.
    await grantProject(row!.id, c.get("user").id, "admin", c.get("user").id);
    if (templateId) await applyTemplateToNewProject(row!.id, templateId, { name: c.get("user").name });
    // Named from the request: ask the AI for a better name in the background (naming.ts).
    if (parsed.data.autoName && parsed.data.description) void suggestProjectName(row!.id, parsed.data.description).catch(() => undefined);
    return c.json({ ...toProject(row!, c.get("user").name), myRole: "admin" }, 201);
  })
  .post("/import", async (c) => {
    const parsed = ImportProjectInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a repository as owner/name." }, 400);
    try {
      const user = c.get("user");
      const project = await importProject(parsed.data, { id: user.id, name: user.name });
      await grantProject(project.id, user.id, "admin", user.id);
      return c.json({ ...project, myRole: "admin" }, 201);
    } catch (err) {
      if (err instanceof GitHubError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .patch("/:id/settings", async (c) => {
    const parsed = ProjectSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: issue?.path[0] === "name" ? issue.message : "Daily budget must be between $0.10 and $50." }, 400);
    }
    const [row] = await db
      .update(schema.project)
      // A name someone typed is final: Forge won't replace it with a suggestion.
      .set({ ...parsed.data, ...(parsed.data.name !== undefined ? { nameAuto: false } : {}) })
      .where(eq(schema.project.id, c.req.param("id")))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(toProject(row));
  })
  .post("/:id/pull-request", async (c) => {
    try {
      return c.json(await openOrUpdatePullRequest(c.req.param("id"), { name: c.get("user").name }));
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof GitHubError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .get("/:id", async (c) => {
    const [r] = await db
      .select({ p: schema.project, ownerName: schema.user.name })
      .from(schema.project)
      .innerJoin(schema.user, eq(schema.user.id, schema.project.ownerId))
      .where(eq(schema.project.id, c.req.param("id")));
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ ...toProject(r.p, r.ownerName), myRole: c.get("projectRole") });
  })

  /* ------------------------------- sandbox ------------------------------- */
  .get("/:id/sandbox", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json(await sandboxStatus(id));
  })
  .post("/:id/sandbox/start", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    try {
      await ensureSandbox(id);
      return c.json(await sandboxStatus(id));
    } catch (err) {
      console.error("sandbox start failed", err);
      return c.json(await sandboxStatus(id, err instanceof Error ? err.message : String(err)), 500);
    }
  })
  .post("/:id/sandbox/stop", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    if (activeRunId(id)) return c.json({ error: "A run is in progress." }, 409);
    await stopSandbox(id);
    return c.json(await sandboxStatus(id));
  })

  /* --------------------------------- runs -------------------------------- */
  .post("/:id/runs", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    const parsed = StartRunInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const user = c.get("user");
    const who = { id: user.id, name: user.name };
    // Chat-only models can't build: say so instead of failing halfway through the run.
    if (parsed.data.mode !== "chat") {
      const chatOnly = await chatOnlyModel(parsed.data.model);
      if (chatOnly) return c.json({ error: `${chatOnly} can only chat. Switch to Chat mode, or pick a model that can code.` }, 400);
    }
    try {
      // Busy, or others are already waiting: join the queue (queue.ts) so order is kept.
      if (isRunning(id) || (await hasQueued(id))) {
        return c.json({ queued: true, ...(await enqueue(id, parsed.data.prompt, parsed.data.mode, who, parsed.data.model)) } satisfies StartRunResponse, 202);
      }
      return c.json({ runId: await startRun(id, parsed.data.prompt, who, parsed.data.mode, parsed.data.model) } satisfies StartRunResponse, 202);
    } catch (err) {
      if (err instanceof RunConflictError) {
        return c.json({ queued: true, ...(await enqueue(id, parsed.data.prompt, parsed.data.mode, who, parsed.data.model)) } satisfies StartRunResponse, 202);
      }
      if (err instanceof QueueError) return c.json({ error: err.message }, 429);
      throw err;
    }
  })
  // The prompt box's model picker: the models admins allow, and this project's current pick.
  .get("/:id/models", async (c) => {
    const [p] = await db.select({ lastModel: schema.project.lastModel }).from(schema.project).where(eq(schema.project.id, c.req.param("id")));
    if (!p) return c.json({ error: "not_found" }, 404);
    return c.json(await projectModels(p.lastModel));
  })
  // Preview access (preview-access.ts): an entry link for the builder's preview frame.
  .get("/:id/preview-access", (c) => {
    const compare = c.req.query("compare") === "1";
    const next = c.req.query("next") ?? "/";
    return c.json({ url: memberEnterUrl(c.req.param("id"), c.get("user").id, compare, next) });
  })
  // Share links: anyone with one can view the preview until it expires (builders manage them).
  .get("/:id/preview-shares", async (c) => {
    if (!atLeastProject(c.get("projectRole"), "builder")) return c.json({ error: "Only builders can see share links." }, 403);
    return c.json({ shares: await listShares(c.req.param("id")) });
  })
  .post("/:id/preview-shares", async (c) => {
    const parsed = CreatePreviewShareInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose how long the link should work." }, 400);
    return c.json(await createShare(c.req.param("id"), parsed.data.duration, parsed.data.label, c.get("user").name), 201);
  })
  .delete("/:id/preview-shares/:sid", async (c) => {
    const ok = await revokeShare(c.req.param("id"), c.req.param("sid"));
    return ok ? c.json({ ok: true }) : c.json({ error: "That link was already turned off." }, 404);
  })
  // Messages waiting for the agent (queue.ts).
  .get("/:id/queue", async (c) => c.json({ queue: await listQueue(c.req.param("id")) }))
  .delete("/:id/queue/:qid", async (c) => {
    const ok = await removeQueued(c.req.param("id"), c.req.param("qid"));
    return ok ? c.json({ ok: true }) : c.json({ error: "That message already started or was removed." }, 404);
  })
  // After Stop the queue waits; this starts the next message.
  .post("/:id/queue/next", async (c) => {
    const runId = await runNext(c.req.param("id"));
    return runId ? c.json({ runId }, 202) : c.json({ error: "The agent is busy or nothing is queued." }, 409);
  })
  .post("/:id/qa", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    try {
      const user = c.get("user");
      return c.json({ runId: await startQa(id, { id: user.id, name: user.name }) }, 202);
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      throw err;
    }
  })
  .post("/:id/runs/cancel", async (c) => {
    const cancelled = await cancelRun(c.req.param("id"));
    return c.json({ cancelled });
  })

  /* -------------------------------- pauses ------------------------------- */
  .post("/:id/pauses/:pauseId", async (c) => {
    const id = c.req.param("id");
    const parsed = AnswerPauseInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      await answerPause(id, c.req.param("pauseId"), parsed.data, { name: c.get("user").name });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof PauseError) return c.json({ error: err.message }, 409);
      throw err;
    }
  })

  /* ---------------------------- API connections -------------------------- */
  .get("/:id/connections", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json({ connectionIds: await projectConnectionIds(id) });
  })
  .put("/:id/connections", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    const parsed = SetProjectConnectionsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid input" }, 400);
    try {
      return c.json({ connectionIds: await setProjectConnections(id, parsed.data.connectionIds) });
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })

  /* --------------------------- unsaved changes --------------------------- */
  .get("/:id/changes", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json({ files: await listChanges(id) });
  })
  .post("/:id/changes/discard", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    try {
      return c.json(await discardChanges(id, { name: c.get("user").name }));
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      throw err;
    }
  })

  /* ------------------------------- versions ------------------------------ */
  .get("/:id/versions", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    return c.json(await listVersions(id));
  })
  .post("/:id/versions/:sha/restore", async (c) => {
    const id = c.req.param("id");
    if (!(await projectExists(id))) return c.json({ error: "not_found" }, 404);
    try {
      return c.json(await restoreVersion(id, c.req.param("sha"), { name: c.get("user").name }));
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof VersionError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
