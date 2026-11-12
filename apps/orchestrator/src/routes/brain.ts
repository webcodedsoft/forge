import { BrainDocInput } from "@forge/protocol";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { atLeastProject, atLeastWorkspace, projectRole } from "../access.ts";
import { addStarterDocs, BrainError, createDoc, deleteDoc, listDocs, updateDoc } from "../brain.ts";
import { db, schema } from "../db/index.ts";
import type { AppEnv } from "../index.ts";

/**
 * May the caller change a doc? Team docs (projectId null): workspace admins.
 * A project's own notes: that project's builders and admins.
 */
async function denyEdit(c: Context<AppEnv>, projectId: string | null): Promise<Response | null> {
  if (!projectId) {
    return atLeastWorkspace(c.get("role"), "admin") ? null : c.json({ error: "Only workspace admins can change team docs." }, 403);
  }
  const role = await projectRole(c.get("user").id, projectId, c.get("role"));
  if (!role) return c.json({ error: "not_found" }, 404);
  return atLeastProject(role, "builder") ? null : c.json({ error: "Only the project's builders and admins can change its notes." }, 403);
}

const docProject = async (id: string) =>
  (await db.select({ projectId: schema.brainDoc.projectId }).from(schema.brainDoc).where(eq(schema.brainDoc.id, id)))[0];

/** Team brain docs. GET ?projectId= includes that project's own docs (needs access to it). */
export const brain = new Hono<AppEnv>()
  .get("/", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    if (projectId && !(await projectRole(c.get("user").id, projectId, c.get("role")))) return c.json({ error: "not_found" }, 404);
    return c.json(await listDocs(projectId));
  })
  .post("/", async (c) => {
    const parsed = BrainDocInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    const denied = await denyEdit(c, parsed.data.projectId ?? null);
    if (denied) return denied;
    return c.json(await createDoc(parsed.data, c.get("user").name), 201);
  })
  .post("/starter", async (c) => {
    const denied = await denyEdit(c, null);
    if (denied) return denied;
    return c.json(await addStarterDocs(c.get("user").name));
  })
  .put("/:id", async (c) => {
    const parsed = BrainDocInput.omit({ projectId: true }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    const doc = await docProject(c.req.param("id"));
    if (!doc) return c.json({ error: "not_found" }, 404);
    const denied = await denyEdit(c, doc.projectId);
    if (denied) return denied;
    try {
      return c.json(await updateDoc(c.req.param("id"), parsed.data, c.get("user").name));
    } catch (err) {
      if (err instanceof BrainError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })
  .delete("/:id", async (c) => {
    const doc = await docProject(c.req.param("id"));
    if (!doc) return c.json({ error: "not_found" }, 404);
    const denied = await denyEdit(c, doc.projectId);
    if (denied) return denied;
    await deleteDoc(c.req.param("id"));
    return c.json({ ok: true });
  });
