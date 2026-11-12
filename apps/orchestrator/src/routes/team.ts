import {
  CreateInvitationInput,
  type Invitation,
  type InvitationPreview,
  ProjectRole,
  type ProjectMemberInfo,
  type TeamMember,
  WorkspaceRole,
} from "@forge/protocol";
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import { atLeastProject, grantProject, projectRole } from "../access.ts";
import { db, schema } from "../db/index.ts";
import { env } from "../env.ts";
import type { AppEnv } from "../index.ts";

/*
 * Team management (workspace admins), invitations, and project membership.
 *
 * Forge has no email delivery yet: creating an invitation returns a link to send.
 * The link is tied to the invited email address and expires after 7 days; only a
 * SHA-256 of its token is stored.
 */

const INVITE_DAYS = 7;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const RANK_WS = { member: 1, builder: 2, admin: 3 } as const;
const RANK_PROJECT = { viewer: 1, builder: 2, admin: 3 } as const;

type InvitationRow = typeof schema.invitation.$inferSelect;

async function pendingByToken(token: string): Promise<InvitationRow | null> {
  const [row] = await db
    .select()
    .from(schema.invitation)
    .where(and(eq(schema.invitation.tokenHash, hashToken(token)), isNull(schema.invitation.acceptedAt), gt(schema.invitation.expiresAt, new Date())));
  return row ?? null;
}

/** Applies an invitation to a user: workspace role (never lowered) and project role (never lowered). */
export async function applyInvitation(inv: InvitationRow, userId: string) {
  const [ws] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.userId, userId));
  const role = inv.role as WorkspaceRole;
  if (!ws) await db.insert(schema.workspaceMember).values({ userId, role });
  else if (RANK_WS[role] > RANK_WS[ws.role as WorkspaceRole]) {
    await db.update(schema.workspaceMember).set({ role }).where(eq(schema.workspaceMember.userId, userId));
  }
  if (inv.projectId && inv.projectRole) {
    const [pm] = await db
      .select()
      .from(schema.projectMember)
      .where(and(eq(schema.projectMember.projectId, inv.projectId), eq(schema.projectMember.userId, userId)));
    const pr = inv.projectRole as ProjectRole;
    if (!pm || RANK_PROJECT[pr] > RANK_PROJECT[pm.role as ProjectRole]) await grantProject(inv.projectId, userId, pr, inv.invitedBy);
  }
  await db.update(schema.invitation).set({ acceptedAt: new Date(), acceptedBy: userId }).where(eq(schema.invitation.id, inv.id));
}

/** Called by the auth hook after sign-up: the first account becomes admin; others get their invitations. */
export async function onUserCreated(user: { id: string; email: string }) {
  const n = (await db.select({ n: count() }).from(schema.workspaceMember))[0]?.n ?? 0;
  if (n === 0) {
    await db.insert(schema.workspaceMember).values({ userId: user.id, role: "admin" });
    return;
  }
  const invites = await db
    .select()
    .from(schema.invitation)
    .where(and(eq(schema.invitation.email, user.email.toLowerCase()), isNull(schema.invitation.acceptedAt), gt(schema.invitation.expiresAt, new Date())));
  for (const inv of invites) await applyInvitation(inv, user.id);
}

/** Sign-up is allowed for the first account and for emails with a pending invitation. */
export async function canSignUp(email: string): Promise<boolean> {
  const n = (await db.select({ n: count() }).from(schema.workspaceMember))[0]?.n ?? 0;
  if (n === 0) return true;
  const [inv] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(and(eq(schema.invitation.email, email.toLowerCase()), isNull(schema.invitation.acceptedAt), gt(schema.invitation.expiresAt, new Date())));
  return Boolean(inv);
}

async function createInvitation(input: CreateInvitationInput, invitedBy: string): Promise<Invitation> {
  const token = randomBytes(24).toString("base64url");
  const id = nanoid(12);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await db.insert(schema.invitation).values({
    id,
    tokenHash: hashToken(token),
    email: input.email,
    role: input.role,
    projectId: input.projectId ?? null,
    projectRole: input.projectRole ?? null,
    invitedBy,
    expiresAt,
  });
  const [inv] = await listInvitations(id);
  return { ...inv!, link: `${env.BETTER_AUTH_URL}/invite/${token}` };
}

async function listInvitations(onlyId?: string): Promise<Invitation[]> {
  const rows = await db
    .select({ i: schema.invitation, by: schema.user.name, projectName: schema.project.name })
    .from(schema.invitation)
    .innerJoin(schema.user, eq(schema.user.id, schema.invitation.invitedBy))
    .leftJoin(schema.project, eq(schema.project.id, schema.invitation.projectId))
    .where(
      onlyId
        ? eq(schema.invitation.id, onlyId)
        : and(isNull(schema.invitation.acceptedAt), gt(schema.invitation.expiresAt, new Date())),
    )
    .orderBy(desc(schema.invitation.createdAt));
  return rows.map(({ i, by, projectName }) => ({
    id: i.id,
    email: i.email,
    role: i.role as WorkspaceRole,
    projectId: i.projectId,
    projectName: projectName ?? null,
    projectRole: (i.projectRole as ProjectRole | null) ?? null,
    invitedBy: by,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
  }));
}

const adminCount = async () =>
  (await db.select({ n: count() }).from(schema.workspaceMember).where(eq(schema.workspaceMember.role, "admin")))[0]!.n;

/* ------------------------------ public routes ------------------------------ */

export const setup = new Hono<AppEnv>().get("/", async (c) => {
  const n = (await db.select({ n: count() }).from(schema.workspaceMember))[0]?.n ?? 0;
  return c.json({ needsFirstUser: n === 0 });
});

export const publicInvitations = new Hono<AppEnv>().get("/:token", async (c) => {
  const inv = await pendingByToken(c.req.param("token"));
  if (!inv) return c.json({ error: "This invitation link has expired or was already used. Ask for a new one." }, 404);
  const [by] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, inv.invitedBy));
  const [proj] = inv.projectId
    ? await db.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, inv.projectId))
    : [];
  const [existing] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, inv.email));
  return c.json({
    email: inv.email,
    role: inv.role as WorkspaceRole,
    invitedBy: by?.name ?? "A teammate",
    projectName: proj?.name ?? null,
    projectRole: (inv.projectRole as ProjectRole | null) ?? null,
    hasAccount: Boolean(existing),
  } satisfies InvitationPreview);
});

/* --------------------------- signed-in routes --------------------------- */

/** POST /api/invitations/:token/accept: an existing account accepts (must be signed in as the invited email). */
export const invitations = new Hono<AppEnv>().post("/:token/accept", async (c) => {
  const inv = await pendingByToken(c.req.param("token"));
  if (!inv) return c.json({ error: "This invitation link has expired or was already used. Ask for a new one." }, 404);
  const user = c.get("user");
  if (user.email.toLowerCase() !== inv.email) {
    return c.json({ error: `This invitation is for ${inv.email}. Sign in with that address to accept it.` }, 403);
  }
  await applyInvitation(inv, user.id);
  return c.json({ ok: true, projectId: inv.projectId });
});

/** /api/team: workspace admins only (enforced in index.ts). */
export const team = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.workspaceMember.role,
        joinedAt: schema.workspaceMember.createdAt,
        projects: dsql<number>`(select count(*)::int from project_member pm where pm.user_id = ${schema.user.id})`,
      })
      .from(schema.workspaceMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
      .orderBy(schema.workspaceMember.createdAt);
    const members: TeamMember[] = rows.map((r) => ({ ...r, role: r.role as WorkspaceRole, joinedAt: r.joinedAt.toISOString() }));
    return c.json({ members, invitations: await listInvitations() });
  })
  .post("/invitations", async (c) => {
    const parsed = CreateInvitationInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Check the email and roles." }, 400);
    const [member] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .innerJoin(schema.workspaceMember, eq(schema.workspaceMember.userId, schema.user.id))
      .where(eq(schema.user.email, parsed.data.email));
    if (member && !parsed.data.projectId) return c.json({ error: "That person is already on the team. Change their role in the list instead." }, 400);
    return c.json(await createInvitation(parsed.data, c.get("user").id), 201);
  })
  .delete("/invitations/:id", async (c) => {
    const rows = await db.delete(schema.invitation).where(eq(schema.invitation.id, c.req.param("id"))).returning({ id: schema.invitation.id });
    return rows.length ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  })
  .patch("/members/:userId", async (c) => {
    const parsed = z.object({ role: WorkspaceRole }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Pick a role." }, 400);
    const userId = c.req.param("userId");
    const [current] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.userId, userId));
    if (!current) return c.json({ error: "not_found" }, 404);
    if (current.role === "admin" && parsed.data.role !== "admin" && (await adminCount()) <= 1) {
      return c.json({ error: "The workspace needs at least one admin. Make someone else an admin first." }, 400);
    }
    await db.update(schema.workspaceMember).set({ role: parsed.data.role }).where(eq(schema.workspaceMember.userId, userId));
    return c.json({ ok: true });
  })
  .delete("/members/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (userId === c.get("user").id) return c.json({ error: "You can't remove yourself." }, 400);
    const [current] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.userId, userId));
    if (!current) return c.json({ error: "not_found" }, 404);
    if (current.role === "admin" && (await adminCount()) <= 1) return c.json({ error: "The workspace needs at least one admin." }, 400);
    // Keeps their projects, versions and comments; removes access and signs them out everywhere.
    await db.delete(schema.projectMember).where(eq(schema.projectMember.userId, userId));
    await db.delete(schema.workspaceMember).where(eq(schema.workspaceMember.userId, userId));
    await db.delete(schema.session).where(eq(schema.session.userId, userId));
    return c.json({ ok: true });
  });

/* --------------------------- project membership --------------------------- */

/** /api/projects/:id/members (viewer can list; project admins change; checked in index.ts). */
export const projectMembers = new Hono<AppEnv>()
  .get("/:id/members", async (c) => {
    const projectId = c.req.param("id");
    const rows = await db
      .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email, pRole: schema.projectMember.role, wsRole: schema.workspaceMember.role })
      .from(schema.workspaceMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMember.userId))
      .leftJoin(schema.projectMember, and(eq(schema.projectMember.userId, schema.user.id), eq(schema.projectMember.projectId, projectId)))
      .orderBy(schema.user.name);
    const members: ProjectMemberInfo[] = rows
      .filter((r) => r.pRole || r.wsRole === "admin")
      .map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        role: r.wsRole === "admin" ? "admin" : (r.pRole as ProjectRole),
        viaWorkspaceAdmin: r.wsRole === "admin",
      }));
    // Teammates who could be added (for the picker).
    const others = rows.filter((r) => !r.pRole && r.wsRole !== "admin").map((r) => ({ userId: r.userId, name: r.name, email: r.email }));
    const invites = (await listInvitations()).filter((i) => i.projectId === projectId);
    return c.json({ members, others, invitations: invites, myRole: c.get("projectRole") });
  })
  .put("/:id/members/:userId", async (c) => {
    const parsed = z.object({ role: ProjectRole }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Pick a role." }, 400);
    const { id: projectId, userId } = c.req.param();
    const [ws] = await db.select().from(schema.workspaceMember).where(eq(schema.workspaceMember.userId, userId));
    if (!ws) return c.json({ error: "That person isn't on the team." }, 400);
    if (ws.role === "admin") return c.json({ error: "Workspace admins already have admin access to every project." }, 400);
    await grantProject(projectId, userId, parsed.data.role, c.get("user").id);
    return c.json({ ok: true });
  })
  .delete("/:id/members/:userId", async (c) => {
    const { id: projectId, userId } = c.req.param();
    const remainingAdmins = await db
      .select({ userId: schema.projectMember.userId })
      .from(schema.projectMember)
      .where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.role, "admin")));
    if (remainingAdmins.length === 1 && remainingAdmins[0]!.userId === userId) {
      return c.json({ error: "The project needs at least one admin. Make someone else an admin first." }, 400);
    }
    await db.delete(schema.projectMember).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, userId)));
    return c.json({ ok: true });
  })
  // A project admin invites someone new by email: they join the workspace as a member with this project role.
  .post("/:id/members/invite", async (c) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email(), role: ProjectRole }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter an email address and a role." }, 400);
    const projectId = c.req.param("id");
    const [existing] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .innerJoin(schema.workspaceMember, eq(schema.workspaceMember.userId, schema.user.id))
      .where(eq(schema.user.email, parsed.data.email));
    if (existing) {
      if (atLeastProject(await projectRole(existing.id, projectId), parsed.data.role)) {
        return c.json({ error: "They already have that access." }, 400);
      }
      await grantProject(projectId, existing.id, parsed.data.role, c.get("user").id);
      return c.json({ added: true }, 201);
    }
    const inv = await createInvitation(
      { email: parsed.data.email, role: "member", projectId, projectRole: parsed.data.role },
      c.get("user").id,
    );
    return c.json(inv, 201);
  });
