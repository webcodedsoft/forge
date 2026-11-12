import { TestInput } from "@forge/protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import { RunConflictError, startQa } from "../runs.ts";
import { deleteTest, listTests, runSavedTests, saveTest } from "../tests.ts";

/* Saved tests. Reading needs viewer; saving, running, deleting and drafting need builder (access.ts). */
export const testRoutes = new Hono<AppEnv>()
  .get("/:id/tests", async (c) => c.json(await listTests(c.req.param("id"))))
  .post("/:id/tests", async (c) => {
    const body = TestInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "That test isn't valid." }, 400);
    return c.json(await saveTest(c.req.param("id"), body.data, c.get("user")), 201);
  })
  .delete("/:id/tests/:tid", async (c) => {
    await deleteTest(c.req.param("id"), c.req.param("tid"));
    return c.json({ ok: true });
  })
  .post("/:id/tests/run", async (c) => {
    const body = z.object({ ids: z.array(z.string().max(40)).max(100).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Invalid request." }, 400);
    const results = await runSavedTests(c.req.param("id"), "manual", body.data.ids);
    return c.json({ results: results ?? [] });
  })
  // Describe a test in words; the QA agent walks through it and proposes the steps.
  .post("/:id/tests/draft", async (c) => {
    const body = z.object({ description: z.string().trim().min(5).max(2000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Describe the test in a sentence or two." }, 400);
    const user = c.get("user");
    try {
      return c.json({ runId: await startQa(c.req.param("id"), { id: user.id, name: user.name }, undefined, body.data.description) }, 202);
    } catch (err) {
      if (err instanceof RunConflictError) return c.json({ error: "The agent is busy. Try again when it has finished." }, 409);
      throw err;
    }
  });
