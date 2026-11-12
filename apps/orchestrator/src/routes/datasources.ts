import { CreateDataSourceInput, UpdateDataSourceInput } from "@forge/protocol";
import { Hono } from "hono";
import { z } from "zod";
import {
  createDataSource,
  DataSourceError,
  deleteDataSource,
  getDataSource,
  updateDataSource,
  listDataSources,
  previewOperation,
  previewQuery,
  projectDataSourceIds,
  refreshDataSource,
  setProjectDataSources,
} from "../datasources.ts";
import type { AppEnv } from "../index.ts";
import { RunConflictError } from "../runs.ts";

const fail = (err: unknown) => {
  if (err instanceof DataSourceError) return { error: err.message, status: 400 as const };
  if (err instanceof RunConflictError) return { error: err.message, status: 409 as const };
  throw err;
};

/* Settings › Data sources. Everyone can see them; changing them needs a workspace admin (index.ts). */
export const dataSources = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await listDataSources()))
  .post("/", async (c) => {
    const body = CreateDataSourceInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Check the form." }, 400);
    try {
      return c.json(await createDataSource(body.data, c.get("user").name), 201);
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status);
    }
  })
  .get("/:sid", async (c) => {
    try {
      return c.json(await getDataSource(c.req.param("sid")));
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status === 400 ? 404 : f.status);
    }
  })
  .patch("/:sid", async (c) => {
    const body = UpdateDataSourceInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Check the form." }, 400);
    try {
      return c.json(await updateDataSource(c.req.param("sid"), body.data));
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status);
    }
  })
  .post("/:sid/refresh", async (c) => {
    try {
      return c.json(await refreshDataSource(c.req.param("sid")));
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status);
    }
  })
  .post("/:sid/query", async (c) => {
    const body = z.object({ sql: z.string().min(1).max(20_000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Write a SELECT query." }, 400);
    try {
      return c.json(await previewQuery(c.req.param("sid"), body.data.sql));
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status);
    }
  })
  .post("/:sid/operation", async (c) => {
    const body = z.object({ operation: z.string().min(1).max(200), body: z.unknown().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Pick an operation." }, 400);
    try {
      return c.json(await previewOperation(c.req.param("sid"), body.data.operation, body.data.body ?? {}));
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status);
    }
  })
  .delete("/:sid", async (c) => {
    await deleteDataSource(c.req.param("sid"));
    return c.json({ ok: true });
  });

/* A project's chosen sources. Reading needs viewer; changing needs builder (access.ts). */
export const projectDataSources = new Hono<AppEnv>()
  .get("/:id/data-sources", async (c) => c.json({ sourceIds: await projectDataSourceIds(c.req.param("id")) }))
  .put("/:id/data-sources", async (c) => {
    const body = z.object({ sourceIds: z.array(z.string().max(40)).max(30) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid request." }, 400);
    try {
      await setProjectDataSources(c.req.param("id"), body.data.sourceIds);
      return c.json({ ok: true });
    } catch (err) {
      const f = fail(err);
      return c.json({ error: f.error }, f.status);
    }
  });
