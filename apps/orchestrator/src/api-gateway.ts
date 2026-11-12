import type { ApiAuthInput, ApiAuthSummary } from "@forge/protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { decrypt, encrypt } from "./secrets.ts";

/*
 * API gateway: apps call our in-house APIs through Forge, which adds the sign-in.
 *
 *   app (browser) → /api/forge/<name>/<path>  (the app's generated route)
 *                 → Forge gateway  POST/GET … /api/<name>/<path>  (with the project's token)
 *                 → the API, signed with the connection's credentials
 *
 * Credentials never enter a sandbox: they're stored encrypted here and added per request:
 *   api_key        header or query parameter
 *   bearer         Authorization: Bearer <token>
 *   basic          Authorization: Basic base64(user:password)
 *   oauth2_client  a token from the token URL (client credentials), cached until shortly before expiry
 *   login          username + password posted to the API's login endpoint; the token it answers with is
 *                  sent on every call, renewed before it expires, and after a 401 (one retry)
 *   entra_user     the signed-in user's token, passed through from the preview (x-forge-user-token)
 * The gateway checks the project may use that connection, and runs on the data proxy's port.
 */

type Row = typeof schema.apiConnection.$inferSelect;
type Config = {
  location?: "header" | "query";
  name?: string;
  username?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  clientAuth?: "basic" | "body";
  hint?: string;
  loginUrl?: string;
  usernameField?: string;
  passwordField?: string;
  bodyFormat?: "json" | "form";
  tokenPath?: string;
  headerName?: string;
  prefix?: string;
};
type Secret = { value?: string; token?: string; password?: string; clientSecret?: string };

const AAD = (id: string) => `api-connection/${id}`;
const hintOf = (s: string) => (s.length <= 8 ? "••••" : `••••${s.slice(-4)}`);

/** Columns for a connection's sign-in (secret encrypted). */
export function authColumns(id: string, auth: ApiAuthInput): Pick<Row, "authMode" | "authConfig" | "authSecret" | "entraScope"> {
  switch (auth.kind) {
    case "none":
      return { authMode: "none", authConfig: null, authSecret: null, entraScope: null };
    case "entra_user":
      return { authMode: "entra_user", authConfig: null, authSecret: null, entraScope: auth.scope?.trim() || null };
    case "api_key":
      return {
        authMode: "api_key",
        authConfig: { location: auth.location, name: auth.name, hint: hintOf(auth.value) } satisfies Config,
        authSecret: encrypt(JSON.stringify({ value: auth.value } satisfies Secret), AAD(id)),
        entraScope: null,
      };
    case "bearer":
      return {
        authMode: "bearer",
        authConfig: { hint: hintOf(auth.token) } satisfies Config,
        authSecret: encrypt(JSON.stringify({ token: auth.token } satisfies Secret), AAD(id)),
        entraScope: null,
      };
    case "basic":
      return {
        authMode: "basic",
        authConfig: { username: auth.username } satisfies Config,
        authSecret: encrypt(JSON.stringify({ password: auth.password } satisfies Secret), AAD(id)),
        entraScope: null,
      };
    case "login":
      return {
        authMode: "login",
        authConfig: {
          loginUrl: auth.loginUrl,
          username: auth.username,
          usernameField: auth.usernameField,
          passwordField: auth.passwordField,
          bodyFormat: auth.bodyFormat,
          tokenPath: auth.tokenPath,
          headerName: auth.headerName,
          prefix: auth.prefix,
        } satisfies Config,
        authSecret: encrypt(JSON.stringify({ password: auth.password } satisfies Secret), AAD(id)),
        entraScope: null,
      };
    case "oauth2_client":
      return {
        authMode: "oauth2_client",
        authConfig: { tokenUrl: auth.tokenUrl, clientId: auth.clientId, scope: auth.scope?.trim() || undefined, clientAuth: auth.clientAuth } satisfies Config,
        authSecret: encrypt(JSON.stringify({ clientSecret: auth.clientSecret } satisfies Secret), AAD(id)),
        entraScope: null,
      };
  }
}

export function authSummary(row: Row): ApiAuthSummary {
  const c = (row.authConfig ?? {}) as Config;
  switch (row.authMode) {
    case "entra_user":
      return { kind: "entra_user", scope: row.entraScope };
    case "api_key":
      return { kind: "api_key", location: c.location ?? "header", name: c.name ?? "", hint: c.hint ?? "••••" };
    case "bearer":
      return { kind: "bearer", hint: c.hint ?? "••••" };
    case "basic":
      return { kind: "basic", username: c.username ?? "" };
    case "oauth2_client":
      return { kind: "oauth2_client", tokenUrl: c.tokenUrl ?? "", clientId: c.clientId ?? "", scope: c.scope ?? null, clientAuth: c.clientAuth ?? "basic" };
    case "login":
      return {
        kind: "login",
        loginUrl: c.loginUrl ?? "",
        username: c.username ?? "",
        usernameField: c.usernameField ?? "username",
        passwordField: c.passwordField ?? "password",
        bodyFormat: c.bodyFormat ?? "json",
        tokenPath: c.tokenPath ?? "",
        headerName: c.headerName ?? "Authorization",
        prefix: c.prefix ?? "Bearer",
      };
    default:
      return { kind: "none" };
  }
}

const secretOf = (row: Row): Secret => (row.authSecret ? (JSON.parse(decrypt(row.authSecret, AAD(row.id))) as Secret) : {});

/* OAuth 2 client credentials: one cached token per connection. */
const oauthTokens = new Map<string, { token: string; expires: number; key: string }>();

async function oauthToken(row: Row): Promise<string> {
  const c = (row.authConfig ?? {}) as Config;
  const key = `${c.tokenUrl}|${c.clientId}|${c.scope ?? ""}|${row.authSecret}`;
  const cached = oauthTokens.get(row.id);
  if (cached && cached.key === key && cached.expires - Date.now() > 60_000) return cached.token;
  const secret = secretOf(row).clientSecret ?? "";
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (c.scope) body.set("scope", c.scope);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if ((c.clientAuth ?? "basic") === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId ?? "")}:${encodeURIComponent(secret)}`).toString("base64")}`;
  } else {
    body.set("client_id", c.clientId ?? "");
    body.set("client_secret", secret);
  }
  const res = await fetch(c.tokenUrl!, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
    throw new Error(`Couldn't reach the token URL: ${e.message}`);
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`The token URL refused the client credentials (${res.status}${json.error ? `: ${json.error_description ?? json.error}` : ""}).`);
  }
  const t = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000, key };
  oauthTokens.set(row.id, t);
  return t.token;
}

/* Login for a token: one cached session token per connection. */
const sessions = new Map<string, { token: string; expires: number; issued: number; key: string }>();
const TOKEN_KEYS = ["token", "access_token", "accessToken", "jwt", "id_token", "data.token", "data.access_token", "data.accessToken", "result.token", "auth.token"];

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** When the token runs out: expires_in/expiresIn (seconds) in the answer, the JWT's exp, else 30 minutes. */
function expiryOf(answer: unknown, token: string): number {
  const secs = [pick(answer, "expires_in"), pick(answer, "expiresIn"), pick(answer, "data.expires_in"), pick(answer, "data.expiresIn")].find((v) => typeof v === "number") as number | undefined;
  if (secs) return Date.now() + secs * 1000;
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      const exp = (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number }).exp;
      if (typeof exp === "number") return exp * 1000;
    } catch {
      /* not a JWT */
    }
  }
  return Date.now() + 30 * 60_000;
}

const resolveUrl = (row: Row, u: string) => (/^https?:\/\//i.test(u) ? u : `${row.baseUrl.replace(/\/+$/, "")}/${u.replace(/^\/+/, "")}`);

async function loginToken(row: Row): Promise<string> {
  const c = (row.authConfig ?? {}) as Config;
  const key = `${c.loginUrl}|${c.username}|${row.authSecret}`;
  const cached = sessions.get(row.id);
  // Renew a little early: 30 s before expiry, or a quarter of the lifetime for short-lived tokens.
  if (cached && cached.key === key && cached.expires - Date.now() > Math.min(30_000, (cached.expires - cached.issued) / 4)) return cached.token;
  const password = secretOf(row).password ?? "";
  const uField = c.usernameField || "username";
  const pField = c.passwordField || "password";
  const json = (c.bodyFormat ?? "json") === "json";
  const res = await fetch(resolveUrl(row, c.loginUrl ?? "/login"), {
    method: "POST",
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
    body: json ? JSON.stringify({ [uField]: c.username, [pField]: password }) : new URLSearchParams({ [uField]: c.username ?? "", [pField]: password }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => {
    throw new Error(`Couldn't reach the login URL: ${e.message}`);
  });
  const answer = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(`The login URL refused the username and password (${res.status}).`);
  const raw = c.tokenPath ? pick(answer, c.tokenPath) : TOKEN_KEYS.map((k) => pick(answer, k)).find((v) => typeof v === "string" && v);
  if (typeof raw !== "string" || !raw) {
    throw new Error(c.tokenPath ? `The login answer has no token at "${c.tokenPath}".` : "Logged in, but couldn't find the token in the answer. Set where it is (Advanced › Token in the answer).");
  }
  const t = { token: raw, expires: expiryOf(answer, raw), issued: Date.now(), key };
  sessions.set(row.id, t);
  return t.token;
}

/** Apply the connection's sign-in to an outgoing request. */
export async function signRequest(row: Row, url: URL, headers: Headers, userToken: string | null) {
  const c = (row.authConfig ?? {}) as Config;
  switch (row.authMode) {
    case "entra_user":
      if (userToken) headers.set("authorization", `Bearer ${userToken}`);
      return;
    case "api_key": {
      const v = secretOf(row).value ?? "";
      if (c.location === "query") url.searchParams.set(c.name!, v);
      else headers.set(c.name!, v);
      return;
    }
    case "bearer":
      headers.set("authorization", `Bearer ${secretOf(row).token ?? ""}`);
      return;
    case "basic":
      headers.set("authorization", `Basic ${Buffer.from(`${c.username ?? ""}:${secretOf(row).password ?? ""}`).toString("base64")}`);
      return;
    case "oauth2_client":
      headers.set("authorization", `Bearer ${await oauthToken(row)}`);
      return;
    case "login": {
      const token = await loginToken(row);
      headers.set(c.headerName || "authorization", c.prefix ? `${c.prefix} ${token}` : token);
      return;
    }
  }
}

/** Forget a cached OAuth token (credentials changed or the connection was removed). */
export const forgetToken = (id: string) => {
  oauthTokens.delete(id);
  sessions.delete(id);
};

const FORWARD_REQUEST = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since"];
const FORWARD_RESPONSE = ["cache-control", "content-type", "etag", "last-modified", "location", "content-disposition"];

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** /api/<name>/<path…>?query for a project (already authenticated by its token). */
export async function handleGateway(req: IncomingMessage, res: ServerResponse, projectId: string) {
  const u = new URL(req.url ?? "/", "http://gateway");
  const m = /^\/api\/([a-z][a-z0-9]{1,30})(\/.*)?$/.exec(u.pathname);
  if (!m) return reply(res, 404, { error: "Not found" });
  const [row] = await db
    .select({ c: schema.apiConnection })
    .from(schema.projectApiConnection)
    .innerJoin(schema.apiConnection, eq(schema.apiConnection.id, schema.projectApiConnection.connectionId))
    .where(and(eq(schema.projectApiConnection.projectId, projectId), eq(schema.apiConnection.name, m[1]!)));
  if (!row) return reply(res, 403, { error: `This project can't use the API "${m[1]}". Add it in the project's APIs & data.` });
  const conn = row.c;

  const target = new URL(conn.baseUrl.replace(/\/+$/, "") + (m[2] ?? "/"));
  target.search = u.search;
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers[h];
    if (typeof v === "string") headers.set(h, v);
  }
  const userToken = typeof req.headers["x-forge-user-token"] === "string" ? req.headers["x-forge-user-token"] : null;
  try {
    await signRequest(conn, target, headers, userToken);
  } catch (err) {
    return reply(res, 502, { error: `Forge couldn't sign in to "${conn.name}": ${(err as Error).message}` });
  }

  const method = req.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) {
      size += (ch as Buffer).length;
      if (size > 20 * 1024 * 1024) return reply(res, 413, { error: "The request body is too large (20 MB)." });
      chunks.push(ch as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  const send = () => fetch(target, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  let upstream: Response;
  try {
    upstream = await send();
    // A token Forge got (login or OAuth) may have been revoked or expired early: get a new one and retry once.
    if (upstream.status === 401 && (conn.authMode === "login" || conn.authMode === "oauth2_client")) {
      forgetToken(conn.id);
      await signRequest(conn, target, headers, userToken);
      upstream = await send();
    }
  } catch (err) {
    return reply(res, 502, { error: `Couldn't reach the "${conn.name}" API: ${(err as Error).message}` });
  }
  const out: Record<string, string> = {};
  for (const h of FORWARD_RESPONSE) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

/**
 * "Test the connection": one signed GET to a simple endpoint (the first GET without path
 * parameters, else the base URL). Any answer other than 401/403 or a network error means the
 * sign-in is accepted.
 */
export async function testConnection(row: Row): Promise<{ ok: boolean; status: number | null; message: string; at: string }> {
  const spec = row.spec as { paths?: Record<string, Record<string, unknown>> } | null;
  const path = Object.entries(spec?.paths ?? {}).find(([p, item]) => item?.get && !p.includes("{"))?.[0] ?? "/";
  const url = new URL(row.baseUrl.replace(/\/+$/, "") + path);
  const headers = new Headers({ accept: "application/json" });
  const at = new Date().toISOString();
  if (row.authMode === "entra_user") {
    return { ok: true, status: null, message: "Signed-in user tokens can only be tested from an app, once company sign-in (Entra) is set up.", at };
  }
  try {
    forgetToken(row.id); // a test always signs in afresh
    await signRequest(row, url, headers, null);
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: "manual" });
    const ok = r.status !== 401 && r.status !== 403 && r.status < 500;
    return {
      ok,
      status: r.status,
      message: ok
        ? `GET ${path} answered ${r.status}: the API accepted the sign-in.`
        : r.status >= 500
          ? `GET ${path} answered ${r.status}: the API had an error.`
          : `GET ${path} answered ${r.status}: the API refused the sign-in. Check the credentials.`,
      at,
    };
  } catch (err) {
    const m = (err as Error).message;
    const own = /^(The token URL|Couldn't reach the token|The login URL|Couldn't reach the login|Logged in, but|The login answer)/.test(m);
    return { ok: false, status: null, message: own ? m : `Couldn't reach the API: ${m}`, at };
  }
}
