import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import { RunConflictError } from "../runs.ts";
import {
  compareVersions,
  createBranch,
  deleteBranch,
  fileDiff,
  listBranches,
  startComparePreview,
  stopComparePreview,
  switchBranch,
  useBranch,
  VersionError,
} from "../versions.ts";

/*
 * Comparing versions (changed files, code differences, an older version's live preview)
 * and ideas: branches started from an older version. Access is checked by the project guard.
 */

const fail = (err: unknown) => {
  if (err instanceof RunConflictError) return { error: err.message, status: 409 as const };
  if (err instanceof VersionError) return { error: err.message, status: 400 as const };
  throw err;
};
const handle = async <T,>(fn: () => Promise<T>) => {
  try {
    return { ok: true as const, value: await fn() };
  } catch (err) {
    return { ok: false as const, ...fail(err) };
  }
};

export const versionRoutes = new Hono<AppEnv>()
  .get("/:id/versions/compare", async (c) => {
    const { from = "", to = "" } = c.req.query();
    const r = await handle(() => compareVersions(c.req.param("id"), from, to));
    return r.ok ? c.json(r.value) : c.json({ error: r.error }, r.status);
  })
  .get("/:id/versions/diff", async (c) => {
    const { from = "", to = "", path = "" } = c.req.query();
    const r = await handle(() => fileDiff(c.req.param("id"), from, to, path));
    return r.ok ? c.json(r.value) : c.json({ error: r.error }, r.status);
  })
  // Viewers may open an older version's preview (a read), see access.ts.
  .post("/:id/compare/preview", async (c) => {
    const body = z.object({ sha: z.string().min(7).max(41) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid version." }, 400);
    const r = await handle(() => startComparePreview(c.req.param("id"), body.data.sha));
    return r.ok ? c.json(r.value) : c.json({ error: r.error }, r.status);
  })
  .delete("/:id/compare/preview", async (c) => {
    await stopComparePreview(c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/:id/branches", async (c) => c.json(await listBranches(c.req.param("id"))))
  .post("/:id/branches", async (c) => {
    const body = z.object({ name: z.string().max(40), from: z.string().min(7).max(40) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Give the idea a name and a version to start from." }, 400);
    const r = await handle(() => createBranch(c.req.param("id"), body.data.name, body.data.from, c.get("user")));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  })
  .post("/:id/branches/:name/switch", async (c) => {
    const r = await handle(() => switchBranch(c.req.param("id"), c.req.param("name"), c.get("user")));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  })
  .post("/:id/branches/:name/use", async (c) => {
    const r = await handle(() => useBranch(c.req.param("id"), c.req.param("name"), c.get("user")));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  })
  .delete("/:id/branches/:name", async (c) => {
    const r = await handle(() => deleteBranch(c.req.param("id"), c.req.param("name"), c.get("user")));
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
