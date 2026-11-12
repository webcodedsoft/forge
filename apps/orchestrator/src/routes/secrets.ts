import { SECRET_NAME, SetSecretInput } from "@forge/protocol";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db, schema } from "../db/index.ts";
import { appendEvent } from "../events.ts";
import type { AppEnv } from "../index.ts";
import { activeRunId } from "../runs.ts";
import { restartDevServer } from "../sandbox.ts";
import { deleteSecret, isReservedName, listSecrets, setSecret } from "../secrets.ts";

/*
 * /api/projects/:id/secrets — names and metadata only; values are write-only.
 * A change restarts the app's dev server so the new value takes effect, and adds
 * a notice to the project's feed (name only) so teammates know.
 */

async function projectExists(id: string) {
  const [p] = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.id, id));
  return Boolean(p);
}

async function applied(projectId: string, text: string) {
  await appendEvent({ type: "notice", projectId, runId: `secrets-${nanoid(8)}`, text });
  // The server restarts in the background; the preview reconnects on its own.
  void restartDevServer(projectId).catch((e) => console.error("dev server restart failed", e));
}

export const secrets = new Hono<AppEnv>()
  .get("/:id/secrets", async (c) => {
    if (!(await projectExists(c.req.param("id")))) return c.json({ error: "not_found" }, 404);
    return c.json(await listSecrets(c.req.param("id")));
  })
  .put("/:id/secrets/:name", async (c) => {
    const { id: projectId, name } = c.req.param();
    if (!SECRET_NAME.test(name)) {
      return c.json({ error: "Use capital letters, digits and underscores, starting with a letter (e.g. STRIPE_API_KEY)." }, 400);
    }
    if (isReservedName(name)) return c.json({ error: `${name} is set by Forge and can't be changed.` }, 400);
    const parsed = SetSecretInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a value (up to 10,000 characters)." }, 400);
    if (!(await projectExists(projectId))) return c.json({ error: "not_found" }, 404);
    if (activeRunId(projectId)) return c.json({ error: "Wait for the agent to finish; changing a secret restarts the app." }, 409);

    const existed = (await listSecrets(projectId)).some((s) => s.name === name);
    const user = c.get("user");
    await setSecret(projectId, name, parsed.data.value, user.name);
    await applied(projectId, `${user.name} ${existed ? "updated" : "added"} the secret ${name}. The app restarted to use it.`);
    return c.json(await listSecrets(projectId));
  })
  .delete("/:id/secrets/:name", async (c) => {
    const { id: projectId, name } = c.req.param();
    if (activeRunId(projectId)) return c.json({ error: "Wait for the agent to finish; changing a secret restarts the app." }, 409);
    if (!(await deleteSecret(projectId, name))) return c.json({ error: "not_found" }, 404);
    await applied(projectId, `${c.get("user").name} removed the secret ${name}. The app restarted without it.`);
    return c.json(await listSecrets(projectId));
  });
