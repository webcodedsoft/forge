import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createProxyServer } from "http-proxy-3";
import type { AiProvider, ModelPrice } from "@forge/protocol";
import { listPrice, priceTokens } from "./openai-pricing.ts";
import { env } from "./env.ts";
import { anthropicError, type AnthropicRequest, bridgeMessages, estimateTokens } from "./openai-bridge.ts";

/*
 * Model proxy: project containers never see the real Anthropic API key.
 *
 * Each agent run gets a random token, valid only while that run is active (and at most
 * 3 hours). The runner uses it as its API key with ANTHROPIC_BASE_URL pointing here; this
 * proxy swaps it for the real key and forwards /v1/* to the Anthropic API (streaming
 * included). A token that leaks from a sandbox stops working when the run ends.
 *
 * When the workspace uses ChatGPT (ai.ts), the run's token says so and /v1/messages goes to
 * OpenAI through openai-bridge.ts instead; the agent in the container doesn't know the difference.
 */

const UPSTREAM = "https://api.anthropic.com";
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
export type RunAi = {
  provider: AiProvider;
  model: string;
  fastModel: string | null;
  apiKey: string;
  /** Admin-set prices of OpenAI models (by id); others use Forge's list price. */
  prices?: Record<string, ModelPrice>;
  /** ChatGPT runs: stop answering once the run has spent this much (USD). Claude runs are capped by the agent itself. */
  budgetUsd?: number;
};

/**
 * What each ChatGPT run has cost so far, priced per request with the model's own price. The run
 * takes it when the agent reports usage (takeRunCost), replacing the agent's Claude-priced guess.
 */
const runCost = new Map<string, { usd: number; unpriced: boolean }>();
/** Everything a ChatGPT run has spent, for its spending limit. */
const runTotal = new Map<string, number>();

/** The cost added since the last call, and whether any of it had no known price. */
export function takeRunCost(runId: string): { usd: number; unpriced: boolean } | null {
  const c = runCost.get(runId);
  if (!c) return null;
  runCost.set(runId, { usd: 0, unpriced: false });
  return c;
}
/**
 * ChatGPT runs: how many tokens the conversation held at the latest building step (what it read
 * plus what it wrote). The agent can't report this itself: OpenAI's usage arrives at the end of
 * a streamed answer, after the agent has noted the message.
 */
const runContext = new Map<string, number>();
export const runContextTokens = (runId: string) => runContext.get(runId) ?? 0;
export const forgetRunCost = (runId: string) => {
  runCost.delete(runId);
  runTotal.delete(runId);
  runContext.delete(runId);
};
export const BUDGET_ERROR = "reached its spending limit";
const tokens = new Map<string, { projectId: string; runId: string; expires: number; ai: RunAi }>();

/** A token for one run, using the AI chosen when the run started. Call revoke() when the run ends. */
export function issueModelToken(projectId: string, runId: string, ai: RunAi): { token: string; revoke: () => void } {
  const token = `forge-run-${randomBytes(24).toString("base64url")}`;
  tokens.set(token, { projectId, runId, expires: Date.now() + MAX_AGE_MS, ai });
  return { token, revoke: () => void tokens.delete(token) };
}

function tokenFrom(req: IncomingMessage): string | null {
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key) return key;
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

const proxy = createProxyServer({ target: UPSTREAM, changeOrigin: true, secure: true });
proxy.on("error", (err, _req, res) => {
  const r = res as ServerResponse;
  if (!r.headersSent) r.writeHead(502, { "content-type": "application/json" });
  r.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Forge model proxy: ${err.message}` } }));
});

const deny = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message } }));
};

const MAX_BODY = 64 * 1024 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** ChatGPT runs: answer the Messages API with OpenAI. */
async function viaOpenAI(req: IncomingMessage, res: ServerResponse, ai: RunAi, runId: string, projectId: string) {
  const path = req.url!.split("?")[0]!;
  if (req.method !== "POST" || !path.startsWith("/v1/messages")) return anthropicError(res, 404, `Not available with ChatGPT: ${path}`);
  let body: AnthropicRequest;
  try {
    body = (await readJson(req)) as AnthropicRequest;
  } catch {
    return anthropicError(res, 400, "Invalid request body.");
  }
  if (path === "/v1/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
  }
  if (path !== "/v1/messages") return anthropicError(res, 404, `Not available with ChatGPT: ${path}`);
  if (ai.budgetUsd && (runTotal.get(runId) ?? 0) >= ai.budgetUsd) {
    return anthropicError(res, 400, `This request ${BUDGET_ERROR} ($${ai.budgetUsd.toFixed(2)}).`);
  }
  // The agent asks for Claude ids for small side tasks; those use the fast model.
  const sideTask = !body.model || body.model.startsWith("claude");
  const model = sideTask ? (ai.fastModel ?? ai.model) : body.model;
  const used = await bridgeMessages(body, res, ai.apiKey, model, { cacheKey: `forge-${projectId}`, sideTask });
  if (used) {
    const price = ai.prices?.[model] ?? listPrice(model);
    const usd = price ? priceTokens(price, used) : 0;
    const c = runCost.get(runId) ?? { usd: 0, unpriced: false };
    runCost.set(runId, price ? { usd: c.usd + usd, unpriced: c.unpriced } : { usd: c.usd, unpriced: true });
    runTotal.set(runId, (runTotal.get(runId) ?? 0) + usd);
    if (!sideTask) runContext.set(runId, used.input + used.cached + used.output);
  }
}

export function startModelProxy() {
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/v1/")) return deny(res, 404, "Not found");
    const token = tokenFrom(req);
    const entry = token ? tokens.get(token) : undefined;
    if (!entry || entry.expires < Date.now()) {
      if (token) tokens.delete(token);
      return deny(res, 401, "This run's model access has ended.");
    }
    if (entry.ai.provider === "openai") {
      viaOpenAI(req, res, entry.ai, entry.runId, entry.projectId).catch((err) => anthropicError(res, 502, `Forge model proxy: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    delete req.headers.authorization;
    req.headers["x-api-key"] = entry.ai.apiKey;
    proxy.web(req, res);
  });
  server.listen(env.MODEL_PROXY_PORT, env.MODEL_PROXY_HOST, () => {
    console.log(`model proxy on ${env.MODEL_PROXY_HOST}:${env.MODEL_PROXY_PORT}`);
  });
  // Forget expired tokens of runs that never revoked (e.g. a crash).
  setInterval(() => {
    const now = Date.now();
    for (const [t, e] of tokens) if (e.expires < now) tokens.delete(t);
  }, 10 * 60 * 1000).unref();
}
