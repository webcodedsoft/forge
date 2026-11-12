import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createProxyServer } from "http-proxy-3";
import { env } from "./env.ts";

/*
 * Model proxy: project containers never see the real Anthropic API key.
 *
 * Each agent run gets a random token, valid only while that run is active (and at most
 * 3 hours). The runner uses it as its API key with ANTHROPIC_BASE_URL pointing here; this
 * proxy swaps it for the real key and forwards /v1/* to the Anthropic API (streaming
 * included). A token that leaks from a sandbox stops working when the run ends.
 */

const UPSTREAM = "https://api.anthropic.com";
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
const tokens = new Map<string, { projectId: string; runId: string; expires: number }>();

/** A token for one run. Call the returned revoke() when the run ends. */
export function issueModelToken(projectId: string, runId: string): { token: string; revoke: () => void } {
  const token = `forge-run-${randomBytes(24).toString("base64url")}`;
  tokens.set(token, { projectId, runId, expires: Date.now() + MAX_AGE_MS });
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

export function startModelProxy() {
  if (!env.ANTHROPIC_API_KEY) return;
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/v1/")) return deny(res, 404, "Not found");
    const token = tokenFrom(req);
    const entry = token ? tokens.get(token) : undefined;
    if (!entry || entry.expires < Date.now()) {
      if (token) tokens.delete(token);
      return deny(res, 401, "This run's model access has ended.");
    }
    delete req.headers.authorization;
    req.headers["x-api-key"] = env.ANTHROPIC_API_KEY;
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
