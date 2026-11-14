import { AddressFeedbackInput, type PushBlocked } from "@forge/protocol";
import { addressFeedback, bringInChanges, incomingChanges, prFeedback } from "../github-sync.ts";
import { Hono } from "hono";
import { z } from "zod";
import { GitHubError, gitHubStatus, PushBlockedError, pushToGitHub } from "../github.ts";
import type { AppEnv } from "../index.ts";
import { RunConflictError } from "../runs.ts";
import { IntegrationError, listInstallationRepos, listRepoBranches } from "../integrations.ts";

/* Push to the company's GitHub. Reading needs viewer; pushing needs builder (access.ts). */
export const githubRoutes = new Hono<AppEnv>()
  .get("/:id/github", async (c) => c.json(await gitHubStatus(c.req.param("id"))))
  .post("/:id/github/push", async (c) => {
    const body = z
      .object({ name: z.string().max(100).optional(), override: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Invalid request." }, 400);
    const admin = c.get("projectRole") === "admin";
    try {
      // Only project admins may push past failing checks.
      return c.json(await pushToGitHub(c.req.param("id"), c.get("user"), { name: body.data.name, override: admin && body.data.override }));
    } catch (err) {
      if (err instanceof PushBlockedError) {
        return c.json(
          { error: err.message, failingTests: err.failingTests, securityBlocking: err.securityBlocking, canOverride: admin } satisfies PushBlocked,
          409,
        );
      }
      if (err instanceof RunConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof GitHubError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

/** GitHub round trip (github-sync.ts): 400 for things the person can fix, 409 while the agent works, 502 when GitHub fails. */
const guarded = async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; status: 400 | 409 | 502 }> => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof RunConflictError) return { ok: false, error: err.message, status: 409 };
    if (err instanceof GitHubError) return { ok: false, error: err.message, status: 400 };
    console.error("github round trip:", err);
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "GitHub could not be reached.", status: 502 };
  }
};

export const githubSyncRoutes = new Hono<AppEnv>()
  // Commits on GitHub's branch that the project doesn't have yet.
  .get("/:id/github/incoming", async (c) => {
    const r = await guarded(() => incomingChanges(c.req.param("id")));
    return r.ok ? c.json(r.value) : c.json({ error: r.error }, r.status);
  })
  // Merge them into the workspace and start the run that checks (and resolves) them.
  .post("/:id/github/pull", async (c) => {
    const user = c.get("user");
    const r = await guarded(() => bringInChanges(c.req.param("id"), { id: user.id, name: user.name }));
    return r.ok ? c.json(r.value, 202) : c.json({ error: r.error }, r.status);
  })
  // Review comments and CI results of the project's pull request (or its pushed branch).
  .get("/:id/github/feedback", async (c) => {
    const r = await guarded(() => prFeedback(c.req.param("id")));
    return r.ok ? c.json(r.value) : c.json({ error: r.error }, r.status);
  })
  .post("/:id/github/feedback/address", async (c) => {
    const body = AddressFeedbackInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success || (!body.data.ids.length && !body.data.checks)) return c.json({ error: "Pick the feedback to send to the agent." }, 400);
    const user = c.get("user");
    const r = await guarded(() => addressFeedback(c.req.param("id"), { id: user.id, name: user.name }, body.data));
    return r.ok ? c.json(r.value, 202) : c.json({ error: r.error }, r.status);
  });

/* The import picker: repositories of the connected GitHub app (any workspace member who may create projects). */
export const githubRepos = new Hono<AppEnv>()
  .get("/repos", async (c) => {
    try {
      return c.json(await listInstallationRepos());
    } catch (err) {
      if (err instanceof IntegrationError) return c.json({ error: err.message }, 502);
      throw err;
    }
  })
  .get("/branches", async (c) => {
    try {
      return c.json({ branches: await listRepoBranches(c.req.query("repo") ?? "") });
    } catch (err) {
      if (err instanceof IntegrationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
