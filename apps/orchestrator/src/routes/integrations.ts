import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../index.ts";
import {
  githubConnectForm,
  githubInstalled,
  githubManifestCallback,
  IntegrationError,
  integrationsStatus,
  disconnectGitHubInstallation,
  removeIntegration,
  setFigmaToken,
} from "../integrations.ts";
import { listModels, removeAiKey, updateAiSettings } from "../ai.ts";

const Provider = z.enum(["anthropic", "openai"]);

/* Settings › Integrations. Workspace admins only (index.ts). GitHub's redirects come back here too. */
const back = (q: string) => `/settings/integrations?${q}`;

export const integrations = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await integrationsStatus()))
  .post("/github/connect", async (c) => {
    // org is optional: without it GitHub lets the admin pick the organization when installing.
    const body = z.object({ org: z.string().trim().max(39).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Invalid organization name." }, 400);
    try {
      return c.json(githubConnectForm(body.data.org || undefined));
    } catch (err) {
      if (err instanceof IntegrationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // GitHub created the app (manifest flow): exchange the code, then send the admin to install it.
  .get("/github/callback", async (c) => {
    const { code = "", state = "" } = c.req.query();
    try {
      return c.redirect(await githubManifestCallback(code, state, c.get("user").name));
    } catch (err) {
      return c.redirect(back(`error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`));
    }
  })
  // The app was installed (or its installation changed).
  .get("/github/installed", async (c) => {
    const id = Number(c.req.query("installation_id"));
    if (!Number.isInteger(id) || id <= 0) return c.redirect(back("error=GitHub+didn't+say+which+installation+to+use."));
    try {
      await githubInstalled(id, c.get("user").name);
      return c.redirect(back("github=connected"));
    } catch (err) {
      return c.redirect(back(`error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`));
    }
  })
  // ?forget=app also forgets Forge's GitHub app (connecting again creates a new one).
  .delete("/github", async (c) => {
    if (c.req.query("forget") === "app") await removeIntegration("github");
    else await disconnectGitHubInstallation(c.get("user").name);
    return c.json({ ok: true });
  })
  .put("/figma", async (c) => {
    const body = z.object({ token: z.string().trim().min(10).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Paste a Figma access token." }, 400);
    try {
      await setFigmaToken(body.data.token, c.get("user").name);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof IntegrationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  // AI model: which AI builds the apps (ai.ts).
  // POST, so a key being added (to list its models before saving) stays out of the URL and logs.
  .post("/ai/models", async (c) => {
    const body = z
      .object({ provider: Provider, apiKey: z.string().trim().max(400).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose Claude or ChatGPT." }, 400);
    try {
      return c.json(await listModels(body.data.provider, body.data.apiKey || undefined));
    } catch (err) {
      if (err instanceof IntegrationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .put("/ai", async (c) => {
    const body = z
      .object({
        provider: Provider,
        model: z.string().trim().min(1).max(120),
        fastModel: z.string().trim().max(120).nullable().optional(),
        apiKey: z.string().trim().min(20).max(400).optional(),
        allowed: z
          .array(
            z.object({
              provider: Provider,
              id: z.string().trim().min(1).max(120),
              label: z.string().max(60),
              hint: z.string().max(80),
              cost: z.union([z.literal(1), z.literal(2), z.literal(3)]),
              price: z
                .object({ input: z.number().min(0).max(10000), cachedInput: z.number().min(0).max(10000), output: z.number().min(0).max(10000) })
                .nullable()
                .optional(),
            }),
          )
          .max(24)
          .optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose an AI and a model." }, 400);
    try {
      await updateAiSettings(body.data, c.get("user").name);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof IntegrationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .delete("/ai/keys/:provider", async (c) => {
    const p = Provider.safeParse(c.req.param("provider"));
    if (!p.success) return c.json({ error: "Unknown provider." }, 400);
    await removeAiKey(p.data, c.get("user").name);
    return c.json({ ok: true });
  })
  .delete("/figma", async (c) => {
    await removeIntegration("figma");
    return c.json({ ok: true });
  });
