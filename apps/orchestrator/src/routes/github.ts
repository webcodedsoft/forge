import type { PushBlocked } from "@forge/protocol";
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
