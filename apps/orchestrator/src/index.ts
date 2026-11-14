import { serve } from "@hono/node-server";
import type { Me, ProjectRole, WorkspaceRole } from "@forge/protocol";
import { type Context, Hono, type Next } from "hono";
import { logger } from "hono/logger";
import { atLeastProject, atLeastWorkspace, projectRole, requiredProjectRole, workspaceRole } from "./access.ts";
import { auth, type AuthSession } from "./auth.ts";
import { sql } from "./db/index.ts";
import { env } from "./env.ts";
import type { Server } from "node:http";
import { seedFromClone } from "./github.ts";
import { startPreviewProxy } from "./preview.ts";
import { startModelProxy } from "./model-proxy.ts";
import { aiReady } from "./ai.ts";
import { recoverInterruptedRuns } from "./runs.ts";
import { describeShare } from "./preview-access.ts";
import { setImportSeeder } from "./sandbox.ts";
import { brain } from "./routes/brain.ts";
import { connections } from "./routes/connections.ts";
import { comments, publicFeedback } from "./routes/comments.ts";
import { secrets } from "./routes/secrets.ts";
import { activity } from "./routes/activity.ts";
import { library, templates } from "./routes/templates.ts";
import "./templates.ts"; // registers the template seeder
import { projects } from "./routes/projects.ts";
import { usage } from "./routes/usage.ts";
import { workspace } from "./routes/workspace.ts";
import { versionRoutes } from "./routes/versions.ts";
import { problemRoutes } from "./routes/problems.ts";
import { testRoutes } from "./routes/tests.ts";
import { securityRoutes } from "./routes/security.ts";
import { reviewRoutes } from "./routes/review.ts";
import { specRoutes } from "./routes/spec.ts";
import { githubRepos, githubRoutes, githubSyncRoutes } from "./routes/github.ts";
import { integrations } from "./routes/integrations.ts";
import { dataSources, projectDataSources } from "./routes/datasources.ts";
import { startDataProxy } from "./datasources.ts";
import { startServerLogWatcher } from "./problems.ts";
import { invitations, projectMembers, publicInvitations, setup, team } from "./routes/team.ts";
import { attachWebSocket } from "./ws.ts";

export type AppEnv = {
  Variables: {
    user: AuthSession["user"];
    session: AuthSession["session"];
    /** The caller's workspace role (checked on every request). */
    role: WorkspaceRole;
    /** The caller's role in the project of a /api/projects/:id/… request. */
    projectRole: ProjectRole;
  };
};

const app = new Hono<AppEnv>();
app.use(logger());

app.get("/api/health", async (c) => {
  await sql`select 1`;
  return c.json({ ok: true });
});

// Better Auth: sign-up, sign-in, sign-out, session.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Public: whether the first (admin) account still needs to be created, and invitation previews.
// Preview share links (preview-access.ts): the public page /preview/<projectId>/<token> in the web
// app asks what a link opens. Public: the token is the access.
app.get("/api/public/preview-shares/:projectId/:token", async (c) => {
  const { projectId, token } = c.req.param();
  c.header("cache-control", "no-store");
  if (!/^[a-z0-9]{6,32}$/.test(projectId) || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return c.json({ error: "invalid" }, 404);
  const share = await describeShare(projectId, token);
  return share ? c.json(share) : c.json({ error: "expired" }, 404);
});
app.route("/api/public/preview-shares", publicFeedback);
app.route("/api/setup", setup);
app.route("/api/invitations", publicInvitations);

// Everything else under /api requires a signed-in member of the workspace.
app.use("/api/*", async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) return c.json({ error: "unauthorized" }, 401);
  c.set("user", result.user);
  c.set("session", result.session);
  const role = await workspaceRole(result.user.id);
  // Accepting an invitation is how an existing account joins (or gains a project), so it is allowed without a role.
  const accepting = /^\/api\/invitations\/[^/]+\/accept$/.test(c.req.path);
  if (!role && !accepting) return c.json({ error: "Your account isn't part of this workspace. Ask an admin for an invitation." }, 403);
  if (role) c.set("role", role);
  await next();
});

// Project access: every /api/projects/:id/… call needs a role in that project.
const projectGuard = async (c: Context<AppEnv>, next: Next) => {
  const id = c.req.param("id");
  if (!id || id === "import") return next();
  const role = await projectRole(c.get("user").id, id, c.get("role"));
  if (!role) return c.json({ error: "not_found" }, 404); // don't reveal projects you can't see
  const subpath = c.req.path.slice(`/api/projects/${id}`.length) || "/";
  const needed = requiredProjectRole(c.req.method, subpath);
  if (!atLeastProject(role, needed)) {
    return c.json({ error: needed === "admin" ? "Only project admins can do that." : "You have view access to this project. Ask a project admin for builder access." }, 403);
  }
  c.set("projectRole", role);
  await next();
};
app.use("/api/projects/:id", projectGuard);
app.use("/api/projects/:id/*", projectGuard);

// Workspace-level rules.
const needWorkspace = (min: WorkspaceRole, message: string) => async (c: Context<AppEnv>, next: Next) =>
  atLeastWorkspace(c.get("role"), min) ? next() : c.json({ error: message }, 403);
app.post("/api/projects", needWorkspace("builder", "Only builders and admins can create projects."));
app.post("/api/projects/import", needWorkspace("builder", "Only builders and admins can import repositories."));
app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/connections/*", needWorkspace("admin", "Only workspace admins can change API connections."));
app.post("/api/connections", needWorkspace("admin", "Only workspace admins can change API connections."));
app.use("/api/usage/*", needWorkspace("admin", "Only workspace admins can see usage."));
app.get("/api/usage", needWorkspace("admin", "Only workspace admins can see usage."));
app.delete("/api/templates/*", needWorkspace("admin", "Only workspace admins can delete templates."));
app.delete("/api/library/*", needWorkspace("admin", "Only workspace admins can delete library components."));
app.use("/api/team/*", needWorkspace("admin", "Only workspace admins can manage the team."));
app.use("/api/team", needWorkspace("admin", "Only workspace admins can manage the team."));
app.use("/api/integrations/*", needWorkspace("admin", "Only workspace admins can manage integrations."));
app.use("/api/integrations", needWorkspace("admin", "Only workspace admins can manage integrations."));
app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/data-sources/*", needWorkspace("admin", "Only workspace admins can change data sources."));
app.post("/api/data-sources", needWorkspace("admin", "Only workspace admins can change data sources."));

app.route("/api/projects", projects);
app.route("/api/projects", comments);
app.route("/api/projects", secrets);
app.route("/api/projects", projectMembers);
app.route("/api/projects", workspace);
app.route("/api/projects", versionRoutes);
app.route("/api/projects", problemRoutes);
app.route("/api/projects", testRoutes);
app.route("/api/projects", securityRoutes);
app.route("/api/projects", reviewRoutes);
app.route("/api/projects", specRoutes);
app.route("/api/projects", githubRoutes);
app.route("/api/projects", githubSyncRoutes);
app.route("/api/connections", connections);
app.route("/api/brain", brain);
app.route("/api/usage", usage);
app.route("/api/activity", activity);
app.route("/api/templates", templates);
app.route("/api/library", library);
app.route("/api/team", team);
app.route("/api/integrations", integrations);
app.use("/api/github/*", needWorkspace("builder", "Only builders and admins can import repositories."));
app.route("/api/github", githubRepos);
app.route("/api/data-sources", dataSources);
app.route("/api/projects", projectDataSources);
app.route("/api/invitations", invitations);
app.get("/api/me", (c) => {
  const u = c.get("user");
  return c.json({ id: u.id, name: u.name, email: u.email, role: c.get("role") } satisfies Me);
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: env.ORCHESTRATOR_PORT }, (info) => {
  console.log(`orchestrator listening on http://127.0.0.1:${info.port}`);
  void aiReady().then((ok) => {
    if (!ok) console.warn("The chosen AI has no API key: add one in Settings › Integrations › AI model (or ANTHROPIC_API_KEY / OPENAI_API_KEY in .env).");
  });
});
attachWebSocket(server as Server);
setImportSeeder(seedFromClone);
startPreviewProxy();
startModelProxy();
void recoverInterruptedRuns().catch((e) => console.error("could not close interrupted runs", e));
startServerLogWatcher();
startDataProxy();
