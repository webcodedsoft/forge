import { accessibleProjectIds, grantProject } from "../access.ts";
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
  listChanges,
  PauseError,
  RunConflictError,
  startQa,
  startRun,
} from "../runs.ts";
import { ensureSandbox, prepareStatus, previewUrl, sandboxState, stopSandbox } from "../sandbox.ts";
import { GitHubError, importProject, openOrUpdatePullRequest } from "../github.ts";
import { listVersions, restoreVersion, VersionError } from "../versions.ts";

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
        description: parsed.data.description ?? null,
        ownerId: c.get("user").id,
        templateId: templateId ?? null,
      })
      .returning();
    // The creator manages the project.
    await grantProject(row!.id, c.get("user").id, "admin", c.get("user").id);
    if (templateId) await applyTemplateToNewProject(row!.id, templateId, { name: c.get("user").name });
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
    if (!parsed.success) return c.json({ error: "Daily budget must be between $0.10 and $50." }, 400);
    const [row] = await db
      .update(schema.project)
      .set(parsed.data)
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
    try {
      const user = c.get("user");
      const runId = await startRun(id, parsed.data.prompt, { id: user.id, name: user.name }, parsed.data.mode);
      return c.json({ runId }, 202);
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      throw err;
    }
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
