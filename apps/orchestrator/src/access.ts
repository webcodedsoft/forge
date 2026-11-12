import type { ProjectRole, WorkspaceRole } from "@forge/protocol";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";

/*
 * Who may do what.
 *
 * Workspace roles: admin > builder > member.
 *   admin    everything, including people, API connections, the team brain, usage and every project
 *   builder  creates projects; works in projects shared with them
 *   member   only the projects shared with them; can't create projects
 *
 * Project roles: admin > builder > viewer.
 *   admin    manages the project's people
 *   builder  prompts the agent, restores versions, changes secrets/APIs/settings, tests, opens PRs
 *   viewer   sees the app, chat and versions, and comments
 *
 * A workspace admin is an admin of every project.
 */

const WORKSPACE_RANK: Record<WorkspaceRole, number> = { member: 1, builder: 2, admin: 3 };
const PROJECT_RANK: Record<ProjectRole, number> = { viewer: 1, builder: 2, admin: 3 };

export const atLeastWorkspace = (role: WorkspaceRole | null, min: WorkspaceRole) =>
  role !== null && WORKSPACE_RANK[role] >= WORKSPACE_RANK[min];
export const atLeastProject = (role: ProjectRole | null, min: ProjectRole) =>
  role !== null && PROJECT_RANK[role] >= PROJECT_RANK[min];

export async function workspaceRole(userId: string): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: schema.workspaceMember.role })
    .from(schema.workspaceMember)
    .where(eq(schema.workspaceMember.userId, userId));
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

/** The user's effective role in a project, or null when they have no access. */
export async function projectRole(userId: string, projectId: string, wsRole?: WorkspaceRole | null): Promise<ProjectRole | null> {
  const ws = wsRole === undefined ? await workspaceRole(userId) : wsRole;
  if (ws === "admin") return "admin";
  if (!ws) return null;
  const [row] = await db
    .select({ role: schema.projectMember.role })
    .from(schema.projectMember)
    .where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, userId)));
  return (row?.role as ProjectRole | undefined) ?? null;
}

/** Project ids the user can open (null = all, for workspace admins). */
export async function accessibleProjectIds(userId: string, wsRole: WorkspaceRole | null): Promise<Set<string> | null> {
  if (wsRole === "admin") return null;
  const rows = await db
    .select({ projectId: schema.projectMember.projectId })
    .from(schema.projectMember)
    .where(eq(schema.projectMember.userId, userId));
  return new Set(rows.map((r) => r.projectId));
}

/** Adds or updates a project membership. */
export async function grantProject(projectId: string, userId: string, role: ProjectRole, addedBy: string) {
  await db
    .insert(schema.projectMember)
    .values({ projectId, userId, role, addedBy })
    .onConflictDoUpdate({ target: [schema.projectMember.projectId, schema.projectMember.userId], set: { role } });
}

/**
 * The minimum project role for an API call under /api/projects/:id/…
 * Reading and commenting need viewer; managing people needs admin; everything else that
 * changes the project needs builder. Starting the sandbox is a read (it shows the preview).
 */
export function requiredProjectRole(method: string, subpath: string): ProjectRole {
  if (method === "GET" || method === "HEAD") return "viewer";
  if (/^\/(comments)(\/|$)/.test(subpath)) return "viewer";
  if (subpath === "/sandbox/start" || subpath === "/compare/preview") return "viewer"; // showing a preview is a read
  if (/^\/members(\/|$)/.test(subpath)) return "admin";
  return "builder";
}
