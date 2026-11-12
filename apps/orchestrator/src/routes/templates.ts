import { CreateTemplateInput } from "@forge/protocol";
import { Hono } from "hono";
import { atLeastProject, projectRole } from "../access.ts";
import type { AppEnv } from "../index.ts";
import { deleteComponent, listComponents } from "../library.ts";
import { createTemplate, deleteTemplate, listTemplates, TemplateError } from "../templates.ts";

/** /api/templates and /api/library: team-wide starting points and reusable components. */
export const templates = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await listTemplates()))
  .post("/", async (c) => {
    const parsed = CreateTemplateInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Give the template a name." }, 400);
    if (!atLeastProject(await projectRole(c.get("user").id, parsed.data.projectId, c.get("role")), "builder")) {
      return c.json({ error: "Only the project's builders and admins can save it as a template." }, 403);
    }
    try {
      return c.json(await createTemplate(parsed.data, { name: c.get("user").name }), 201);
    } catch (err) {
      if (err instanceof TemplateError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .delete("/:id", async (c) => ((await deleteTemplate(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)));

export const library = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await listComponents()))
  .delete("/:id", async (c) => ((await deleteComponent(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)));
