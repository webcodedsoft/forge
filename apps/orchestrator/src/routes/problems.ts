import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import { clearSettled, fixProblems, listProblems, ProblemError, setProblemStatus } from "../problems.ts";
import { RunConflictError } from "../runs.ts";

/* Fix from logs: the app's recorded problems. Reading needs viewer; the rest needs builder (access.ts). */
export const problemRoutes = new Hono<AppEnv>()
  .get("/:id/problems", async (c) => c.json(await listProblems(c.req.param("id"))))
  .post("/:id/problems/fix", async (c) => {
    const body = z
      .object({ ids: z.union([z.array(z.string().max(40)).min(1).max(50), z.literal("all")]) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Say which problems to fix." }, 400);
    try {
      return c.json(await fixProblems(c.req.param("id"), body.data.ids, c.get("user")));
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: "The agent is busy. Try again when it has finished." }, 409);
      if (err instanceof ProblemError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .post("/:id/problems/:pid/status", async (c) => {
    const body = z.object({ status: z.enum(["open", "ignored"]) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid status." }, 400);
    try {
      await setProblemStatus(c.req.param("id"), c.req.param("pid"), body.data.status);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ProblemError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })
  .delete("/:id/problems/settled", async (c) => {
    await clearSettled(c.req.param("id"));
    return c.json({ ok: true });
  });
