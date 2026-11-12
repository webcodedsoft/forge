import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import { RunConflictError, startRun } from "../runs.ts";
import { latestScan, scanProject, securityFixPrompt } from "../security.ts";

/* Security checks before pushing. Reading needs viewer; scanning and fixing need builder (access.ts). */
export const securityRoutes = new Hono<AppEnv>()
  .get("/:id/security", async (c) => c.json(await latestScan(c.req.param("id"))))
  .post("/:id/security/scan", async (c) => c.json(await scanProject(c.req.param("id"))))
  .post("/:id/security/fix", async (c) => {
    const body = z.object({ ids: z.union([z.array(z.string().max(10)).min(1).max(50), z.literal("all")]) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Say which findings to fix." }, 400);
    const report = await latestScan(c.req.param("id"));
    const picked = (report?.findings ?? []).filter((f) => body.data.ids === "all" || body.data.ids.includes(f.id)).slice(0, 12);
    if (!picked.length) return c.json({ error: "Those findings are no longer in the latest report. Scan again." }, 400);
    try {
      const user = c.get("user");
      return c.json({ runId: await startRun(c.req.param("id"), securityFixPrompt(picked), { id: user.id, name: user.name }) });
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: "The agent is busy. Try again when it has finished." }, 409);
      throw err;
    }
  });
