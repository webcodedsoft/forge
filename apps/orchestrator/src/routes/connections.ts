import { CreateConnectionInput, UpdateConnectionInput } from "@forge/protocol";
import { Hono } from "hono";
import {
  ConnectionError,
  createConnection,
  deleteConnection,
  listConnections,
  getConnection,
  listOperations,
  refreshConnection,
  testConnectionById,
  updateConnection,
} from "../connections.ts";
import type { AppEnv } from "../index.ts";

/** Team-wide API connections (our in-house APIs). */
export const connections = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await listConnections()))
  .get("/:id", async (c) => {
    try {
      return c.json(await getConnection(c.req.param("id")));
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })
  // The API's endpoints, for browsing (any workspace member).
  .get("/:id/operations", async (c) => {
    try {
      return c.json(await listOperations(c.req.param("id")));
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })
  .post("/", async (c) => {
    const parsed = CreateConnectionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") }, 400);
    try {
      return c.json(await createConnection(parsed.data, c.get("user").id), 201);
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // Change the base URL or sign-in, or replace an uploaded spec (admins, see index.ts).
  .patch("/:id", async (c) => {
    const parsed = UpdateConnectionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Check the form." }, 400);
    try {
      return c.json(await updateConnection(c.req.param("id"), parsed.data));
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // Sign in and make one simple call.
  .post("/:id/test", async (c) => {
    try {
      return c.json(await testConnectionById(c.req.param("id")));
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 404);
      throw err;
    }
  })
  .post("/:id/refresh", async (c) => {
    try {
      return c.json(await refreshConnection(c.req.param("id")));
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .delete("/:id", async (c) => {
    try {
      await deleteConnection(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ConnectionError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });
