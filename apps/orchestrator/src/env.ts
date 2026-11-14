import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:4310"),
  ORCHESTRATOR_PORT: z.coerce.number().int().default(8790),
  /**
   * Key for project secrets (32 bytes, base64). Optional: derived from BETTER_AUTH_SECRET when unset.
   * Set it explicitly in production so rotating the auth secret doesn't lose secrets.
   */
  FORGE_SECRETS_KEY: z.string().optional(),
  /** Model proxy (model-proxy.ts): holds the Anthropic key; sandboxes get run-scoped tokens. */
  MODEL_PROXY_PORT: z.coerce.number().int().default(8791),
  /** Docker Desktop: 127.0.0.1. Linux servers: the docker bridge address, e.g. 172.17.0.1. */
  MODEL_PROXY_HOST: z.string().default("127.0.0.1"),
  MODEL_PROXY_URL_FOR_SANDBOX: z.string().url().default("http://host.docker.internal:8791"),
  /** Data proxy (company data sources): apps' read-only queries. Same host as the model proxy. */
  DATA_PROXY_PORT: z.coerce.number().int().default(8792),
  DATA_PROXY_URL_FOR_SANDBOX: z.string().url().default("http://host.docker.internal:8792"),
  PREVIEW_PORT: z.coerce.number().int().default(7777),
  /**
   * Public address of a project's preview; "{id}" is replaced by the project id.
   * Dev: http://{id}.preview.localhost:7777. Deployed: https://{id}.preview.forge.example.com
   */
  PREVIEW_URL_TEMPLATE: z
    .string()
    .default("http://{id}.preview.localhost:7777")
    .refine((v) => v.includes("{id}"), "PREVIEW_URL_TEMPLATE must contain {id}"),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** ChatGPT (Settings › Integrations › AI model). A key added in Settings wins over this one. */
  OPENAI_API_KEY: z.string().optional(),
  /** OpenAI-compatible API base (tests point this at a local mock). */
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  /** Model the build agent uses. */
  FORGE_MODEL: z.string().default("claude-opus-5-5"),
  /**
   * AI cost controls (runs.ts).
   * FORGE_RUN_BUDGET_USD: the most one request may spend before it is stopped (0: no limit).
   * A project's conversation with the agent starts fresh (carrying a summary) when it has been
   * idle for FORGE_SESSION_IDLE_MIN minutes and holds more than FORGE_SESSION_IDLE_TOKENS tokens
   * (the provider's cache has expired, so resuming would pay for all of it again), or as soon as
   * it holds more than FORGE_SESSION_MAX_TOKENS.
   */
  FORGE_RUN_BUDGET_USD: z.coerce.number().min(0).default(5),
  FORGE_SESSION_IDLE_MIN: z.coerce.number().min(0).default(5),
  FORGE_SESSION_IDLE_TOKENS: z.coerce.number().int().min(0).default(40_000),
  FORGE_SESSION_MAX_TOKENS: z.coerce.number().int().min(0).default(90_000),
  /** Comma-separated email domains allowed to sign up. Empty = anyone who can reach the app. */
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  /** Figma access token, if not set in Settings › Integrations (that one wins). */
  FIGMA_TOKEN: z
    .string()
    .optional()
    .transform((v) => v || undefined),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment. Copy .env.example to .env and fill it in.");
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
