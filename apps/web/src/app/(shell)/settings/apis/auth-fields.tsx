"use client";

import type { ApiAuthInput, ApiAuthKind, ApiAuthSummary } from "@forge/protocol";

/** Sign-in choices for an API, with plain descriptions. */
export const AUTH_KINDS: { id: ApiAuthKind; label: string; help: string }[] = [
  { id: "none", label: "No sign-in", help: "The API is open on the company network." },
  { id: "api_key", label: "API key", help: "A key sent in a header (like X-API-Key) or the query string." },
  { id: "bearer", label: "Access token", help: "A fixed token sent as “Authorization: Bearer …”." },
  { id: "basic", label: "Username and password", help: "Sent with every call as HTTP Basic authentication." },
  { id: "login", label: "Log in for a token", help: "Forge posts a username and password to the login URL and sends the token it gets back on every call (Bearer)." },
  { id: "oauth2_client", label: "OAuth 2 (client credentials)", help: "Forge gets a token from your token URL and renews it." },
  { id: "entra_user", label: "Signed-in user (Entra)", help: "Calls run as the person using the app (company sign-in)." },
];

/** Form state for every kind at once, so switching kinds doesn't lose what was typed. */
export type AuthDraft = {
  kind: ApiAuthKind;
  location: "header" | "query";
  keyName: string;
  value: string;
  token: string;
  username: string;
  password: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  clientAuth: "basic" | "body";
  entraScope: string;
  loginUrl: string;
  usernameField: string;
  passwordField: string;
  bodyFormat: "json" | "form";
  tokenPath: string;
  headerName: string;
  prefix: string;
};

export const emptyAuth = (kind: ApiAuthKind = "none"): AuthDraft => ({
  kind,
  location: "header",
  keyName: "X-API-Key",
  value: "",
  token: "",
  username: "",
  password: "",
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "",
  clientAuth: "basic",
  entraScope: "",
  loginUrl: "/auth/login",
  usernameField: "username",
  passwordField: "password",
  bodyFormat: "json",
  tokenPath: "",
  headerName: "Authorization",
  prefix: "Bearer",
});

/** Start from what's saved (secrets are never sent back, so those fields start empty). */
export function draftFrom(s: ApiAuthSummary): AuthDraft {
  const d = emptyAuth(s.kind);
  if (s.kind === "api_key") Object.assign(d, { location: s.location, keyName: s.name });
  if (s.kind === "basic") d.username = s.username;
  if (s.kind === "oauth2_client") Object.assign(d, { tokenUrl: s.tokenUrl, clientId: s.clientId, scope: s.scope ?? "", clientAuth: s.clientAuth });
  if (s.kind === "entra_user") d.entraScope = s.scope ?? "";
  if (s.kind === "login") {
    Object.assign(d, {
      loginUrl: s.loginUrl,
      username: s.username,
      usernameField: s.usernameField,
      passwordField: s.passwordField,
      bodyFormat: s.bodyFormat,
      tokenPath: s.tokenPath,
      headerName: s.headerName,
      prefix: s.prefix,
    });
  }
  return d;
}

export function toAuthInput(d: AuthDraft): ApiAuthInput {
  switch (d.kind) {
    case "api_key":
      return { kind: "api_key", location: d.location, name: d.keyName.trim(), value: d.value };
    case "bearer":
      return { kind: "bearer", token: d.token.trim() };
    case "basic":
      return { kind: "basic", username: d.username.trim(), password: d.password };
    case "oauth2_client":
      return { kind: "oauth2_client", tokenUrl: d.tokenUrl.trim(), clientId: d.clientId.trim(), clientSecret: d.clientSecret, scope: d.scope.trim() || undefined, clientAuth: d.clientAuth };
    case "entra_user":
      return { kind: "entra_user", scope: d.entraScope.trim() || undefined };
    case "login":
      return {
        kind: "login",
        loginUrl: d.loginUrl.trim(),
        username: d.username.trim(),
        password: d.password,
        usernameField: d.usernameField.trim() || "username",
        passwordField: d.passwordField.trim() || "password",
        bodyFormat: d.bodyFormat,
        tokenPath: d.tokenPath.trim(),
        headerName: d.headerName.trim() || "Authorization",
        prefix: d.prefix.trim(),
      };
    default:
      return { kind: "none" };
  }
}

/** What's missing before it can be saved (null = ready). */
export function authProblem(d: AuthDraft): string | null {
  if (d.kind === "api_key" && (!d.keyName.trim() || !d.value)) return "Enter the key's name and value.";
  if (d.kind === "bearer" && !d.token.trim()) return "Enter the access token.";
  if (d.kind === "basic" && !d.username.trim()) return "Enter the username.";
  if (d.kind === "oauth2_client" && (!d.tokenUrl.trim() || !d.clientId.trim() || !d.clientSecret)) return "Enter the token URL, client id and client secret.";
  if (d.kind === "login" && (!d.loginUrl.trim() || !d.username.trim() || !d.password)) return "Enter the login URL, username and password.";
  return null;
}

/**
 * Guess the sign-in from an OpenAPI document's securitySchemes (components.securitySchemes).
 * Returns null when the spec doesn't say.
 */
export function detectAuth(spec: unknown): Partial<AuthDraft> | null {
  const schemes = (spec as { components?: { securitySchemes?: Record<string, Record<string, unknown>> } })?.components?.securitySchemes;
  if (!schemes) return null;
  for (const s of Object.values(schemes)) {
    const type = String(s.type ?? "").toLowerCase();
    if (type === "apikey" && (s.in === "header" || s.in === "query")) return { kind: "api_key", location: s.in, keyName: String(s.name ?? "X-API-Key") };
    if (type === "http" && String(s.scheme).toLowerCase() === "bearer") return { kind: "bearer" };
    if (type === "http" && String(s.scheme).toLowerCase() === "basic") return { kind: "basic" };
    if (type === "oauth2") {
      const cc = (s.flows as Record<string, { tokenUrl?: string; scopes?: Record<string, string> }> | undefined)?.clientCredentials;
      if (cc) return { kind: "oauth2_client", tokenUrl: cc.tokenUrl ?? "", scope: Object.keys(cc.scopes ?? {}).join(" ") };
    }
    if (type === "openidconnect" || type === "oauth2") return { kind: "entra_user" };
  }
  return null;
}

/** The fields for the chosen kind. `editing`: secrets are already saved, so empty means "keep". */
export function AuthFields({ draft, onChange, editing = false }: { draft: AuthDraft; onChange: (d: AuthDraft) => void; editing?: boolean }) {
  const set = (patch: Partial<AuthDraft>) => onChange({ ...draft, ...patch });
  const secretHint = editing ? "Enter it again to change it; it isn't shown once saved." : "Stored encrypted. Apps and the agent never see it.";
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="lab">Sign-in</span>
        <select className="in" value={draft.kind} onChange={(e) => set({ kind: e.target.value as ApiAuthKind })}>
          {AUTH_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="lab">{AUTH_KINDS.find((k) => k.id === draft.kind)?.help}</span>
      </label>

      {draft.kind === "api_key" && (
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
          <label className="flex flex-col gap-1.5">
            <span className="lab">Sent in</span>
            <select className="in" value={draft.location} onChange={(e) => set({ location: e.target.value as "header" | "query" })}>
              <option value="header">A header</option>
              <option value="query">The query string</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">{draft.location === "header" ? "Header name" : "Parameter name"}</span>
            <input className="in font-mono" value={draft.keyName} onChange={(e) => set({ keyName: e.target.value })} placeholder={draft.location === "header" ? "X-API-Key" : "api_key"} />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="lab">Key</span>
            <input className="in font-mono" type="password" autoComplete="off" value={draft.value} onChange={(e) => set({ value: e.target.value })} />
            <span className="lab">{secretHint}</span>
          </label>
        </div>
      )}

      {draft.kind === "bearer" && (
        <label className="flex flex-col gap-1.5">
          <span className="lab">Access token</span>
          <input className="in font-mono" type="password" autoComplete="off" value={draft.token} onChange={(e) => set({ token: e.target.value })} />
          <span className="lab">{secretHint}</span>
        </label>
      )}

      {draft.kind === "basic" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="lab">Username</span>
            <input className="in" autoComplete="off" value={draft.username} onChange={(e) => set({ username: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Password</span>
            <input className="in" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => set({ password: e.target.value })} />
          </label>
          <span className="lab sm:col-span-2">{secretHint}</span>
        </div>
      )}

      {draft.kind === "oauth2_client" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="lab">Token URL</span>
            <input className="in" type="url" value={draft.tokenUrl} onChange={(e) => set({ tokenUrl: e.target.value })} placeholder="https://login.company.com/oauth2/token" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Client id</span>
            <input className="in font-mono" autoComplete="off" value={draft.clientId} onChange={(e) => set({ clientId: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Client secret</span>
            <input className="in font-mono" type="password" autoComplete="off" value={draft.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Scope (optional)</span>
            <input className="in font-mono" value={draft.scope} onChange={(e) => set({ scope: e.target.value })} placeholder="api://hr/.default" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="lab">Send the client credentials</span>
            <select className="in" value={draft.clientAuth} onChange={(e) => set({ clientAuth: e.target.value as "basic" | "body" })}>
              <option value="basic">As Basic auth (most servers)</option>
              <option value="body">In the form body</option>
            </select>
          </label>
          <span className="lab sm:col-span-2">{secretHint}</span>
        </div>
      )}

      {draft.kind === "login" && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="lab">Login URL</span>
            <input className="in font-mono" value={draft.loginUrl} onChange={(e) => set({ loginUrl: e.target.value })} placeholder="/auth/login or https://api.company.com/auth/login" />
            <span className="lab">A path is added to the base URL. Forge sends a POST with the username and password.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="lab">Username</span>
              <input className="in" autoComplete="off" value={draft.username} onChange={(e) => set({ username: e.target.value })} placeholder="service.account@company.com" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="lab">Password</span>
              <input className="in" type="password" autoComplete="new-password" value={draft.password} onChange={(e) => set({ password: e.target.value })} />
            </label>
          </div>
          <span className="lab">{secretHint} Use a service account, not a person&apos;s login.</span>
          <details className="group rounded-md border border-line">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[13px] text-ink-2 hover:text-ink">
              <span>
                Advanced: request and token{" "}
                <span className="lab">
                  ({draft.bodyFormat === "json" ? "JSON" : "form"} {draft.usernameField}/{draft.passwordField} → {draft.headerName}: {draft.prefix ? `${draft.prefix} ` : ""}token)
                </span>
              </span>
              <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="lab">Username field</span>
                <input className="in font-mono" value={draft.usernameField} onChange={(e) => set({ usernameField: e.target.value })} placeholder="username or email" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Password field</span>
                <input className="in font-mono" value={draft.passwordField} onChange={(e) => set({ passwordField: e.target.value })} placeholder="password" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Send as</span>
                <select className="in" value={draft.bodyFormat} onChange={(e) => set({ bodyFormat: e.target.value as "json" | "form" })}>
                  <option value="json">JSON body</option>
                  <option value="form">Form fields</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Token in the answer</span>
                <input className="in font-mono" value={draft.tokenPath} onChange={(e) => set({ tokenPath: e.target.value })} placeholder="auto, e.g. data.token" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Send the token in header</span>
                <input className="in font-mono" value={draft.headerName} onChange={(e) => set({ headerName: e.target.value })} placeholder="Authorization" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Before the token</span>
                <input className="in font-mono" value={draft.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="Bearer (empty: the token alone)" />
              </label>
              <p className="lab sm:col-span-2">
                Forge keeps the token until it expires (from expires_in or the token itself; otherwise 30 minutes), logs in again before then, and once more if the API answers 401.
              </p>
            </div>
          </details>
        </div>
      )}

      {draft.kind === "entra_user" && (
        <label className="flex flex-col gap-1.5">
          <span className="lab">Entra scope (optional for now)</span>
          <input className="in font-mono" value={draft.entraScope} onChange={(e) => set({ entraScope: e.target.value })} placeholder="api://<app-id>/access_as_user" />
          <span className="lab">Works once company sign-in (Entra) is set up for Forge.</span>
        </label>
      )}
    </div>
  );
}

/** One line describing the saved sign-in. */
export function authLine(a: ApiAuthSummary): string {
  switch (a.kind) {
    case "api_key":
      return `API key in ${a.location === "header" ? `header ${a.name}` : `?${a.name}=`} (${a.hint})`;
    case "bearer":
      return `Access token (${a.hint})`;
    case "basic":
      return `Username and password (${a.username})`;
    case "oauth2_client":
      return `OAuth 2 client credentials (${a.clientId})`;
    case "entra_user":
      return "Signed-in user (Entra)";
    case "login":
      return `Logs in as ${a.username}, sends the token`;
    default:
      return "No sign-in";
  }
}
