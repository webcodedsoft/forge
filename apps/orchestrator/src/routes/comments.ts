import { type CommentAnchor, CreateCommentInput, type ProjectComment, UpdateCommentInput } from "@forge/protocol";
import { and, asc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import type { AppEnv } from "../index.ts";

/*
 * Comments pinned to elements in a project's preview. Mounted at
 * /api/projects/:id/comments. Every change notifies the project's viewers
 * (a `comments_changed` frame) so their pins and lists refresh.
 */

const changed = (projectId: string) => publish(projectId, { type: "comments_changed", projectId });

async function list(projectId: string): Promise<ProjectComment[]> {
  const rows = await db
    .select({ c: schema.projectComment, userName: schema.user.name })
    .from(schema.projectComment)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectComment.userId))
    .where(eq(schema.projectComment.projectId, projectId))
    .orderBy(asc(schema.projectComment.createdAt));
  return rows.map(({ c, userName }) => ({
    id: c.id,
    parentId: c.parentId,
    userId: c.userId,
    userName,
    body: c.body,
    anchor: (c.anchor as CommentAnchor | null) ?? null,
    resolved: c.resolved,
    resolvedBy: c.resolvedBy,
    createdAt: c.createdAt.toISOString(),
  }));
}

export const comments = new Hono<AppEnv>()
  .get("/:id/comments", async (c) => c.json(await list(c.req.param("id"))))
  .post("/:id/comments", async (c) => {
    const projectId = c.req.param("id");
    const parsed = CreateCommentInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Write a comment first." }, 400);
    const [project] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.id, projectId));
    if (!project) return c.json({ error: "not_found" }, 404);

    let parentId: string | null = null;
    if ("parentId" in parsed.data) {
      const [root] = await db
        .select({ id: schema.projectComment.id, parentId: schema.projectComment.parentId })
        .from(schema.projectComment)
        .where(and(eq(schema.projectComment.id, parsed.data.parentId), eq(schema.projectComment.projectId, projectId)));
      if (!root) return c.json({ error: "That comment no longer exists." }, 404);
      parentId = root.parentId ?? root.id; // replies always hang off the thread root
    }
    const id = nanoid(12);
    await db.insert(schema.projectComment).values({
      id,
      projectId,
      parentId,
      userId: c.get("user").id,
      body: parsed.data.body,
      anchor: "anchor" in parsed.data ? parsed.data.anchor : null,
    });
    // A reply reopens a resolved thread.
    if (parentId) {
      await db.update(schema.projectComment).set({ resolved: false, resolvedBy: null }).where(eq(schema.projectComment.id, parentId));
    }
    changed(projectId);
    return c.json({ id }, 201);
  })
  .patch("/:id/comments/:commentId", async (c) => {
    const { id: projectId, commentId } = c.req.param();
    const parsed = UpdateCommentInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid change." }, 400);
    const user = c.get("user");
    const [row] = await db
      .select()
      .from(schema.projectComment)
      .where(and(eq(schema.projectComment.id, commentId), eq(schema.projectComment.projectId, projectId)));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (parsed.data.body !== undefined && row.userId !== user.id) {
      return c.json({ error: "You can only edit your own comments." }, 403);
    }
    if (parsed.data.resolved !== undefined && row.parentId) {
      return c.json({ error: "Resolve the thread, not a reply." }, 400);
    }
    // Re-anchoring keeps everything else about where the comment points (page, label, html).
    const anchor = row.anchor as CommentAnchor | null;
    const reanchor = parsed.data.selector !== undefined && anchor && anchor.selector !== parsed.data.selector;
    if (parsed.data.selector !== undefined && !reanchor && parsed.data.body === undefined && parsed.data.resolved === undefined) {
      return c.json({ ok: true });
    }
    await db
      .update(schema.projectComment)
      .set({
        ...(reanchor ? { anchor: { ...anchor, selector: parsed.data.selector! } } : {}),
        ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
        ...(parsed.data.resolved !== undefined
          ? { resolved: parsed.data.resolved, resolvedBy: parsed.data.resolved ? user.name : null }
          : {}),
      })
      .where(eq(schema.projectComment.id, commentId));
    changed(projectId);
    return c.json({ ok: true });
  })
  .delete("/:id/comments/:commentId", async (c) => {
    const { id: projectId, commentId } = c.req.param();
    const [row] = await db
      .select({ userId: schema.projectComment.userId })
      .from(schema.projectComment)
      .where(and(eq(schema.projectComment.id, commentId), eq(schema.projectComment.projectId, projectId)));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.userId !== c.get("user").id) return c.json({ error: "You can only delete your own comments." }, 403);
    // Deleting a thread root removes its replies too.
    await db
      .delete(schema.projectComment)
      .where(and(eq(schema.projectComment.projectId, projectId), or(eq(schema.projectComment.id, commentId), eq(schema.projectComment.parentId, commentId))));
    changed(projectId);
    return c.json({ ok: true });
  });
