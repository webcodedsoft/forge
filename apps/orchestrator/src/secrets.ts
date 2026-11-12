import type { ProjectSecret } from "@forge/protocol";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";

/*
 * Project secrets: environment variables for a project's app (API keys, settings).
 *
 * - Stored encrypted (AES-256-GCM) in Postgres; values are never returned to the browser.
 * - Delivered only to the app's dev server process as environment variables
 *   (sandbox.ts ensureDevServer). No .env file is written, so nothing can be committed.
 * - The agent is told the names, never the values (secretsPrompt).
 * - Any value that shows up in stored run output is masked (redactor).
 *
 * Limit: the agent writes the app's code, and app code can read its own environment, so no
 * setup can hide values from a determined agent. (A separate OS user for the dev server was
 * tried and dropped: Next.js writes .next from both the server and `next typegen`, and
 * Turbopack needs to own those files.) This keeps secrets out of git, prompts, chat history
 * and teammates' screens. Teams should store test/development keys, not production ones.
 */

/** Names Forge or the platform control; a project can't override them. */
const RESERVED = /^(NODE_ENV|PORT|HOSTNAME|PATH|HOME|USER|SHELL|PWD|ANTHROPIC_.*|FORGE_.*|NEXT_RUNTIME|__NEXT_.*)$/;
export const isReservedName = (name: string) => RESERVED.test(name);

const KEY: Buffer = env.FORGE_SECRETS_KEY
  ? Buffer.from(env.FORGE_SECRETS_KEY, "base64")
  : Buffer.from(hkdfSync("sha256", env.BETTER_AUTH_SECRET, "forge", "project-secrets-v1", 32));
if (KEY.length !== 32) throw new Error("FORGE_SECRETS_KEY must be 32 bytes, base64-encoded");

export function encrypt(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(stored: string, aad: string): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unknown secret format");
  const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

/** Binds a ciphertext to its project and name, so rows can't be swapped between projects. */
const aadFor = (projectId: string, name: string) => `${projectId}/${name}`;

export async function listSecrets(projectId: string): Promise<ProjectSecret[]> {
  const rows = await db
    .select({ name: schema.projectSecret.name, updatedBy: schema.projectSecret.updatedBy, updatedAt: schema.projectSecret.updatedAt })
    .from(schema.projectSecret)
    .where(eq(schema.projectSecret.projectId, projectId))
    .orderBy(asc(schema.projectSecret.name));
  return rows.map((r) => ({
    name: r.name,
    public: r.name.startsWith("NEXT_PUBLIC_"),
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function setSecret(projectId: string, name: string, value: string, userName: string) {
  const enc = encrypt(value, aadFor(projectId, name));
  await db
    .insert(schema.projectSecret)
    .values({ projectId, name, value: enc, updatedBy: userName })
    .onConflictDoUpdate({
      target: [schema.projectSecret.projectId, schema.projectSecret.name],
      set: { value: enc, updatedBy: userName, updatedAt: new Date() },
    });
  redactors.delete(projectId);
}

export async function deleteSecret(projectId: string, name: string): Promise<boolean> {
  const rows = await db
    .delete(schema.projectSecret)
    .where(and(eq(schema.projectSecret.projectId, projectId), eq(schema.projectSecret.name, name)))
    .returning({ name: schema.projectSecret.name });
  redactors.delete(projectId);
  return rows.length > 0;
}

async function decrypted(projectId: string): Promise<{ name: string; value: string }[]> {
  const rows = await db
    .select({ name: schema.projectSecret.name, value: schema.projectSecret.value })
    .from(schema.projectSecret)
    .where(eq(schema.projectSecret.projectId, projectId));
  const out: { name: string; value: string }[] = [];
  for (const r of rows) {
    try {
      out.push({ name: r.name, value: decrypt(r.value, aadFor(projectId, r.name)) });
    } catch {
      console.error(`secret ${r.name} in ${projectId} could not be decrypted (key changed?)`);
    }
  }
  return out;
}

/** ["NAME=value", …] for the app's dev server. */
export async function secretEnv(projectId: string): Promise<string[]> {
  return (await decrypted(projectId)).map((s) => `${s.name}=${s.value}`);
}

/** Tells the agent which variables exist (names only) and how to treat them. */
export async function secretsPrompt(projectId: string): Promise<string> {
  const names = await listSecrets(projectId);
  const list = names.length
    ? names.map((s) => `- \`${s.name}\`${s.public ? " (public: also available in browser code)" : " (server only)"}`).join("\n")
    : "- (none yet)";
  return `## Secrets and settings

These environment variables are set for this app's server at runtime. You can't see their values.
${list}

- Read them with \`process.env.NAME\` in server code (Server Components, route handlers, server actions). Only \`NEXT_PUBLIC_*\` names work in client components.
- Never hardcode, print, log, return to the browser or commit a secret value, and never create \`.env\` files with values.
- If the app needs a key or setting that isn't listed, write the code to read it from \`process.env\`, handle it being missing with a clear message, and tell the user to add it in Forge (the Secrets button in the project header). Never ask for the value in chat.`;
}

/* ------------------------------ Redaction ------------------------------ */

const redactors = new Map<string, { at: number; values: string[] }>();

/** Masks secret values in text before it is stored or streamed (values shorter than 6 chars are skipped). */
export async function redactor(projectId: string): Promise<(text: string) => string> {
  let entry = redactors.get(projectId);
  if (!entry || Date.now() - entry.at > 60_000) {
    const values = (await decrypted(projectId))
      .map((s) => s.value)
      .filter((v) => v.length >= 6)
      .sort((a, b) => b.length - a.length);
    redactors.set(projectId, (entry = { at: Date.now(), values }));
  }
  const values = entry.values;
  if (values.length === 0) return (t) => t;
  return (text) => values.reduce((t, v) => (t.includes(v) ? t.split(v).join("••••••") : t), text);
}
