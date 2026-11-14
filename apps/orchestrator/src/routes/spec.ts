import { SpecCriterionInput } from "@forge/protocol";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import type { AppEnv } from "../index.ts";
import { RunConflictError, startQa, startRun } from "../runs.ts";
import { applySpecUpdate, getSpec, linkTest } from "../spec.ts";

/* The living spec. Reading needs viewer; everything else builder (access.ts). */

const DRAFT_PROMPT =
  "Write this app's living spec from what it does today. Read the pages, components and data code (and look at the main pages with look_at_page if that helps), " +
  "then call mcp__forge__update_spec once with a summary (a short paragraph, then a bullet per main feature) and acceptance criteria for every feature a user can use. " +
  "Don't change any files. Finish with a two-sentence note on what you covered.";

const busy = (err: unknown) => {
  if (err instanceof RunConflictError) return "The agent is busy. Try again when it has finished.";
  throw err;
};

export const specRoutes = new Hono<AppEnv>()
  .get("/:id/spec", async (c) => c.json(await getSpec(c.req.param("id"))))
  .patch("/:id/spec", async (c) => {
    const body = z.object({ summary: z.string().trim().max(6000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "The summary can be up to 6,000 characters." }, 400);
    await applySpecUpdate(c.req.param("id"), { summary: body.data.summary }, c.get("user").name);
    return c.json(await getSpec(c.req.param("id")));
  })
  .post("/:id/spec/criteria", async (c) => {
    const body = SpecCriterionInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Give the criterion an area and a sentence." }, 400);
    const r = await applySpecUpdate(c.req.param("id"), { add: [body.data] }, c.get("user").name);
    if (!r.added) return c.json({ error: "The spec already has that criterion (or is full: 150 criteria)." }, 409);
    return c.json(await getSpec(c.req.param("id")), 201);
  })
  .patch("/:id/spec/criteria/:cid", async (c) => {
    const { id, cid } = c.req.param();
    const body = z
      .object({ area: SpecCriterionInput.shape.area.optional(), text: SpecCriterionInput.shape.text.optional(), testId: z.string().max(40).nullable().optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid change." }, 400);
    if (body.data.testId !== undefined) {
      if (body.data.testId) {
        const [test] = await db
          .select({ id: schema.savedTest.id })
          .from(schema.savedTest)
          .where(and(eq(schema.savedTest.projectId, id), eq(schema.savedTest.id, body.data.testId)));
        if (!test) return c.json({ error: "That test no longer exists." }, 404);
      }
      if (!(await linkTest(id, cid, body.data.testId))) return c.json({ error: "That criterion no longer exists." }, 404);
    }
    if (body.data.area !== undefined || body.data.text !== undefined) {
      const r = await applySpecUpdate(id, { change: [{ id: cid, area: body.data.area, text: body.data.text }] }, c.get("user").name);
      if (!r.edited) return c.json({ error: "That criterion no longer exists." }, 404);
    }
    return c.json(await getSpec(id));
  })
  .delete("/:id/spec/criteria/:cid", async (c) => {
    const { id, cid } = c.req.param();
    await applySpecUpdate(id, { remove: [cid] }, c.get("user").name);
    return c.json(await getSpec(id));
  })
  // The QA agent walks through criteria without a test and writes one for each; passing ones are saved.
  .post("/:id/spec/cover", async (c) => {
    const id = c.req.param("id");
    const body = z.object({ ids: z.array(z.string().max(20)).min(1).max(50).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Invalid request." }, 400);
    const spec = await getSpec(id);
    const wanted = spec.criteria.filter((x) => (body.data.ids ? body.data.ids.includes(x.id) : x.status === "untested")).slice(0, 10);
    if (!wanted.length) return c.json({ error: "Every criterion already has a test." }, 400);
    const user = c.get("user");
    try {
      const runId = await startQa(id, { id: user.id, name: user.name }, undefined, undefined, wanted.map((x) => x.id));
      return c.json({ runId, count: wanted.length }, 202);
    } catch (err) {
      return c.json({ error: busy(err) }, 409);
    }
  })
  // The build agent reads the app and writes the spec (no file changes).
  .post("/:id/spec/draft", async (c) => {
    const user = c.get("user");
    try {
      const runId = await startRun(c.req.param("id"), "Write the spec from the app", { id: user.id, name: user.name }, "build", undefined, {
        agentPrompt: DRAFT_PROMPT,
        skipStructure: true,
      });
      return c.json({ runId }, 202);
    } catch (err) {
      return c.json({ error: busy(err) }, 409);
    }
  });
