import { type CommentAnchor, CreateCommentInput, GuestCommentInput, type ProjectComment, UpdateCommentInput } from "@forge/protocol";
import { and, asc, count, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, schema } from "../db/index.ts";
import { publish } from "../events.ts";
import type { AppEnv } from "../index.ts";
import { atLeastProject } from "../access.ts";
import { shareForToken } from "../preview-access.ts";

/*
 * Comments pinned to elements in a project's preview. Mounted at
 * /api/projects/:id/comments. Every change notifies the project's viewers
 * (a `comments_changed` frame) so their pins and lists refresh.
 */

const changed = (projectId: string) => publish(projectId, { type: "comments_changed", projectId });

async function list(projectId: string): Promise<ProjectComment[]> {
  const rows = await db
    .select({ c: schema.projectComment, userName: schema.user.name, shareLabel: schema.previewShare.label })
    .from(schema.projectComment)
    .leftJoin(schema.user, eq(schema.user.id, schema.projectComment.userId))
    .leftJoin(schema.previewShare, eq(schema.previewShare.id, schema.projectComment.shareId))
    .where(eq(schema.projectComment.projectId, projectId))
    .orderBy(asc(schema.projectComment.createdAt));
  return rows.map(({ c, userName, shareLabel }) => ({
    id: c.id,
    parentId: c.parentId,
    userId: c.userId ?? "",
    userName: c.userId ? (userName ?? "Someone") : (c.guestName ?? "Guest"),
    ...(c.userId ? {} : { guest: true, via: shareLabel ?? null }),
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
    // Your own comments; builders may also remove feedback left by guests.
    const guestByBuilder = row.userId === null && atLeastProject(c.get("projectRole"), "builder");
    if (row.userId !== c.get("user").id && !guestByBuilder) return c.json({ error: "You can only delete your own comments." }, 403);
    // Deleting a thread root removes its replies too.
    await db
      .delete(schema.projectComment)
      .where(and(eq(schema.projectComment.projectId, projectId), or(eq(schema.projectComment.id, commentId), eq(schema.projectComment.parentId, commentId))));
    changed(projectId);
    return c.json({ ok: true });
  });

/*
 * Feedback through a preview share link (no Forge account): mounted at
 * /api/public/preview-shares, before the sign-in check. The link's token is the access. A visitor
 * sees and adds to the threads started through that same link, never the team's own comments.
 */

const MAX_PER_SHARE = 300;
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
const recent = new Map<string, number[]>();

/** At most 20 comments per link in 10 minutes. */
function throttled(shareId: string): boolean {
  const now = Date.now();
  const times = (recent.get(shareId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= MAX_PER_WINDOW) {
    recent.set(shareId, times);
    return true;
  }
  times.push(now);
  recent.set(shareId, times);
  return false;
}

const VALID = (projectId: string, token: string) => /^[a-z0-9]{6,32}$/.test(projectId) && /^[A-Za-z0-9_-]{20,64}$/.test(token);

async function guestThreads(projectId: string, shareId: string): Promise<ProjectComment[]> {
  const all = await list(projectId);
  const roots = new Set<string>();
  const rows = await db
    .select({ id: schema.projectComment.id })
    .from(schema.projectComment)
    .where(and(eq(schema.projectComment.projectId, projectId), eq(schema.projectComment.shareId, shareId)));
  const mine = new Set(rows.map((r) => r.id));
  for (const c of all) if (!c.parentId && mine.has(c.id)) roots.add(c.id);
  // Team members' ids stay private; visitors only need names.
  return all.filter((c) => roots.has(c.id) || (c.parentId && roots.has(c.parentId))).map((c) => ({ ...c, userId: "", via: undefined }));
}

export const publicFeedback = new Hono()
  .get("/:projectId/:token/comments", async (c) => {
    const { projectId, token } = c.req.param();
    c.header("cache-control", "no-store");
    const share = VALID(projectId, token) ? await shareForToken(projectId, token) : null;
    if (!share) return c.json({ error: "expired" }, 404);
    if (!share.allowFeedback) return c.json([]);
    return c.json(await guestThreads(projectId, share.id));
  })
  .post("/:projectId/:token/comments", async (c) => {
    const { projectId, token } = c.req.param();
    const share = VALID(projectId, token) ? await shareForToken(projectId, token) : null;
    if (!share) return c.json({ error: "This link doesn't work any more." }, 404);
    if (!share.allowFeedback) return c.json({ error: "Feedback is turned off for this link." }, 403);
    const parsed = GuestCommentInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Add your name and a comment." }, 400);
    const [total] = await db.select({ n: count() }).from(schema.projectComment).where(eq(schema.projectComment.shareId, share.id));
    if ((total?.n ?? 0) >= MAX_PER_SHARE) return c.json({ error: "This link has reached its feedback limit. Ask for a new link." }, 429);
    if (throttled(share.id)) return c.json({ error: "That's a lot of comments in a short time. Try again in a few minutes." }, 429);

    let parentId: string | null = null;
    if ("parentId" in parsed.data) {
      // Replies only in threads started through this link.
      const [root] = await db
        .select({ id: schema.projectComment.id })
        .from(schema.projectComment)
        .where(
          and(
            eq(schema.projectComment.id, parsed.data.parentId),
            eq(schema.projectComment.projectId, projectId),
            eq(schema.projectComment.shareId, share.id),
          ),
        );
      if (!root) return c.json({ error: "That comment no longer exists." }, 404);
      parentId = root.id;
    }
    const id = nanoid(12);
    await db.insert(schema.projectComment).values({
      id,
      projectId,
      parentId,
      userId: null,
      guestName: parsed.data.name,
      shareId: share.id,
      body: parsed.data.body,
      anchor: "anchor" in parsed.data ? parsed.data.anchor : null,
    });
    if (parentId) await db.update(schema.projectComment).set({ resolved: false, resolvedBy: null }).where(eq(schema.projectComment.id, parentId));
    changed(projectId);
    return c.json({ id }, 201);
  });
