import { and, eq } from "drizzle-orm";
import { aiForRun } from "./ai.ts";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { publish } from "./events.ts";
import { isReasoning } from "./openai-bridge.ts";

/*
 * Project names. New projects get an instant name from the request (deriveProjectName in the
 * protocol). When nobody typed a name, Forge then asks the workspace's AI (its cheaper small-steps
 * model) for a short product name and uses it, unless someone renamed the project meanwhile
 * (project.nameAuto). Without a key or credits the instant name simply stays.
 */

const SYSTEM =
  "You name internal business apps. Reply with only the name: 1 to 4 words, Title Case, no quotes, no emoji, " +
  'no trailing punctuation, no words like "App" or "Tool" unless they are part of a natural name. Use the ' +
  "product or domain the request is about (e.g. Team Lunch Poll, Expense Tracker, Doctorflix Course Hub).";

const clean = (raw: string) =>
  raw
    .split("\n")[0]!
    .replace(/^(name|app name|project name)\s*:\s*/i, "")
    .replace(/["'“”‘’`*_#]/g, "")
    .replace(/[.!?:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

export async function askModel(request: string): Promise<string | null> {
  const ai = await aiForRun().catch(() => null);
  if (!ai) return null;
  const model = ai.fastModel ?? (ai.provider === "anthropic" ? "claude-haiku-5-5" : ai.model);
  const user = `Request:\n${request.slice(0, 1500)}`;
  const signal = AbortSignal.timeout(20_000);

  if (ai.provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ai.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 24, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    return j.content?.find((c) => c.type === "text")?.text ?? null;
  }

  if (isReasoning(model)) {
    const r = await fetch(`${env.OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({ model, instructions: SYSTEM, input: user, reasoning: { effort: "low" }, max_output_tokens: 400, store: false }),
      signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
    return j.output?.find((o) => o.type === "message")?.content?.map((c) => c.text ?? "").join("") ?? null;
  }

  const r = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({ model, max_completion_tokens: 24, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
    signal,
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? null;
}

/** In the background: suggest a name and use it if the project still has its automatic one. */
export async function suggestProjectName(projectId: string, request: string): Promise<void> {
  const raw = await askModel(request).catch(() => null);
  const name = raw ? clean(raw) : "";
  if (name.length < 2 || name.split(" ").length > 6) return;
  const updated = await db
    .update(schema.project)
    .set({ name })
    .where(and(eq(schema.project.id, projectId), eq(schema.project.nameAuto, true)))
    .returning({ id: schema.project.id });
  if (updated.length) publish(projectId, { type: "project_changed", projectId });
}
