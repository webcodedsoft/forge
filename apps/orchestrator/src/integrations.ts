import type { GitHubRepo, GitHubReposResponse, IntegrationsStatus } from "@forge/protocol";
import { createSign, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { decrypt, encrypt } from "./secrets.ts";
import { aiSettings } from "./ai.ts";

/*
 * Settings › Integrations (workspace admins).
 *
 * GitHub: "Connect GitHub" registers a private GitHub App for Forge in the company organization
 * using GitHub's manifest flow, then installs it on the organization. Nobody copies keys:
 *   1. Forge builds a manifest; the admin's browser posts it to GitHub (they pick the org there).
 *   2. GitHub creates the app and redirects back with a one-time code; Forge exchanges it for the
 *      app's id and private key (stored encrypted).
 *   3. Forge sends the admin to install the app; GitHub redirects back with the installation id.
 * Forge then mints short-lived installation tokens to create repos, push, and open pull requests.
 * The app needs: Administration (create repos), Contents, Pull requests, Workflows: write.
 *
 * Figma: an access token, checked against Figma before it's saved.
 */

export class IntegrationError extends Error {}

type GitHubConfig = {
  appId?: number;
  slug?: string;
  owner?: string;
  installationId?: number;
  account?: string;
  accountType?: string;
  repositorySelection?: string;
  htmlUrl?: string;
};
type GitHubSecret = { pem: string; clientSecret?: string; webhookSecret?: string };

const AAD = (key: string) => `integration/${key}`;

export async function load<C, S>(key: string): Promise<{ config: C; secret: S | null; updatedBy: string; updatedAt: Date } | null> {
  const [row] = await db.select().from(schema.integration).where(eq(schema.integration.key, key));
  if (!row) return null;
  return {
    config: row.config as C,
    secret: row.secret ? (JSON.parse(decrypt(row.secret, AAD(key))) as S) : null,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export async function save(key: string, config: object, secret: object | null, by: string) {
  const enc = secret ? encrypt(JSON.stringify(secret), AAD(key)) : null;
  await db
    .insert(schema.integration)
    .values({ key, config, secret: enc, updatedBy: by })
    .onConflictDoUpdate({ target: schema.integration.key, set: { config, secret: enc, updatedBy: by, updatedAt: new Date() } });
  if (key === "github") cachedToken = null;
}

/**
 * Disconnect GitHub but keep Forge's GitHub app, so connecting again goes straight to GitHub's
 * "pick an organization" screen (no new app). `removeIntegration("github")` forgets the app too.
 */
export async function disconnectGitHubInstallation(by: string) {
  const cur = await load<GitHubConfig, GitHubSecret>("github");
  if (!cur) return;
  const { installationId: _i, account: _a, accountType: _t, repositorySelection: _r, ...app } = cur.config;
  await save("github", app, cur.secret, by);
}

export async function removeIntegration(key: "github" | "figma") {
  await db.delete(schema.integration).where(eq(schema.integration.key, key));
  if (key === "github") cachedToken = null;
}

/* --------------------------------- status -------------------------------- */

export async function integrationsStatus(): Promise<IntegrationsStatus> {
  const [gh, fig, ai] = await Promise.all([
    load<GitHubConfig, GitHubSecret>("github"),
    load<{ user?: string }, { token: string }>("figma"),
    aiSettings(),
  ]);
  return {
    github: gh
      ? {
          state: gh.config.installationId ? "connected" : "needs_install",
          account: gh.config.account ?? gh.config.owner ?? null,
          appSlug: gh.config.slug ?? null,
          repositorySelection: gh.config.repositorySelection ?? null,
          installUrl: gh.config.slug ? `https://github.com/apps/${gh.config.slug}/installations/select_target` : null,
          accountType: gh.config.accountType ?? null,
          appOwner: gh.config.owner ?? null,
          manageUrl: gh.config.htmlUrl ?? null,
          connectedBy: gh.updatedBy,
          connectedAt: gh.updatedAt.toISOString(),
        }
      : { state: "not_connected" },
    figma: fig ? { configured: true, user: fig.config.user ?? null, updatedBy: fig.updatedBy, updatedAt: fig.updatedAt.toISOString() } : { configured: false },
    ai,
  };
}

/* ------------------------------ GitHub connect ----------------------------- */

const pendingStates = new Map<string, { org: string; at: number }>();
const forgeUrl = () => new URL(env.BETTER_AUTH_URL).origin;

/**
 * Step 1: the manifest and where the admin's browser should post it.
 *
 * Without `org` (the default, one click): the app is created under the admin's own GitHub account and
 * is installable on other accounts, so GitHub's install screen lets them pick the organization. It can
 * be transferred to the organization later (app settings › Advanced) and then made private.
 * With `org`: the app is created inside that organization, private, and installed there.
 */
export function githubConnectForm(org?: string) {
  if (org !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new IntegrationError("Enter the organization's name as it appears on GitHub, e.g. my-company.");
  for (const [k, v] of pendingStates) if (Date.now() - v.at > 30 * 60_000) pendingStates.delete(k);
  const state = randomBytes(18).toString("base64url");
  pendingStates.set(state, { org: org ?? "", at: Date.now() });
  const base = forgeUrl();
  // App names are unique across all of GitHub.
  const suffix = randomBytes(3).toString("hex");
  const manifest = {
    name: (org ? `Forge ${org} ${suffix}` : `Forge ${suffix}`).slice(0, 34),
    url: base,
    description: "Forge, our internal app builder: creates repositories, pushes saved versions and opens pull requests.",
    redirect_url: `${base}/api/integrations/github/callback`,
    setup_url: `${base}/api/integrations/github/installed`,
    setup_on_update: true,
    public: !org,
    // No webhook: Forge doesn't need GitHub events, and GitHub refuses addresses it can't reach
    // (like localhost), even for an inactive hook.
    default_permissions: { administration: "write", contents: "write", pull_requests: "write", workflows: "write", metadata: "read" },
    default_events: [],
  };
  return {
    action: org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
    manifest: JSON.stringify(manifest),
    state,
  };
}

async function gh<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "forge-app-builder",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg;
    } catch {
      /* not JSON */
    }
    throw new IntegrationError(`GitHub answered ${res.status}: ${msg}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Step 2: GitHub created the app; exchange the code for its credentials. Returns where to install it. */
export async function githubManifestCallback(code: string, state: string, by: string): Promise<string> {
  const pending = pendingStates.get(state);
  if (!pending) throw new IntegrationError("This connection attempt expired. Start again from Settings › Integrations.");
  pendingStates.delete(state);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(code)) throw new IntegrationError("GitHub sent an invalid code.");
  const app = await gh<{ id: number; slug: string; owner: { login: string }; html_url: string; pem: string; client_secret: string; webhook_secret: string | null }>(
    `/app-manifests/${code}/conversions`,
    { method: "POST" },
  );
  await save(
    "github",
    { appId: app.id, slug: app.slug, owner: app.owner.login, htmlUrl: app.html_url } satisfies GitHubConfig,
    { pem: app.pem, clientSecret: app.client_secret, webhookSecret: app.webhook_secret ?? undefined } satisfies GitHubSecret,
    by,
  );
  // select_target: GitHub asks which account or organization to install it on.
  return `https://github.com/apps/${app.slug}/installations/select_target`;
}

/** A JWT that identifies the app itself (10 minutes). */
function appJwt(appId: number, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem).toString("base64url")}`;
}

/** Step 3: the app was installed on the organization. */
export async function githubInstalled(installationId: number, by: string) {
  const cur = await load<GitHubConfig, GitHubSecret>("github");
  if (!cur?.secret || !cur.config.appId) throw new IntegrationError("Connect GitHub first.");
  const inst = await gh<{ id: number; account: { login: string; type: string }; repository_selection: string }>(`/app/installations/${installationId}`, {
    token: appJwt(cur.config.appId, cur.secret.pem),
  });
  await save(
    "github",
    { ...cur.config, installationId: inst.id, account: inst.account.login, accountType: inst.account.type, repositorySelection: inst.repository_selection },
    cur.secret,
    by,
  );
}

let cachedToken: { token: string; expires: number } | null = null;

/** A short-lived token for the installation, or null when GitHub isn't connected. */
export async function githubInstallationToken(): Promise<{ token: string; account: string; accountType: string } | null> {
  const cur = await load<GitHubConfig, GitHubSecret>("github");
  if (!cur?.secret || !cur.config.appId || !cur.config.installationId) return null;
  if (!cachedToken || cachedToken.expires - Date.now() < 5 * 60_000) {
    const t = await gh<{ token: string; expires_at: string }>(`/app/installations/${cur.config.installationId}/access_tokens`, {
      method: "POST",
      token: appJwt(cur.config.appId, cur.secret.pem),
    });
    cachedToken = { token: t.token, expires: new Date(t.expires_at).getTime() };
  }
  return { token: cachedToken.token, account: cur.config.account!, accountType: cur.config.accountType ?? "Organization" };
}

/** Repositories the installation can see (newest first), for the import picker. Up to 1000. */
export async function listInstallationRepos(): Promise<GitHubReposResponse> {
  const conn = await githubInstallationToken();
  if (!conn) return { connected: false };
  type R = { full_name: string; private: boolean; default_branch: string; description: string | null; language: string | null; pushed_at: string | null; updated_at: string };
  const repos: GitHubRepo[] = [];
  let truncated = false;
  for (let page = 1; page <= 10; page++) {
    const r = await gh<{ total_count: number; repositories: R[] }>(`/installation/repositories?per_page=100&page=${page}`, { token: conn.token });
    for (const x of r.repositories) {
      repos.push({
        fullName: x.full_name,
        private: x.private,
        defaultBranch: x.default_branch,
        description: x.description,
        language: x.language,
        updatedAt: x.pushed_at ?? x.updated_at,
      });
    }
    if (repos.length >= r.total_count || r.repositories.length < 100) break;
    if (page === 10) truncated = true;
  }
  repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { connected: true, account: conn.account, repos, truncated };
}

/** Branches of one repository the installation can see. */
export async function listRepoBranches(fullName: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName)) throw new IntegrationError("Invalid repository.");
  const conn = await githubInstallationToken();
  if (!conn) throw new IntegrationError("GitHub isn't connected.");
  const r = await gh<{ name: string }[]>(`/repos/${fullName}/branches?per_page=100`, { token: conn.token });
  return r.map((b) => b.name);
}

/** Create a private repository in the connected organization. */
export async function createOrgRepo(name: string, description: string): Promise<string> {
  const conn = await githubInstallationToken();
  if (!conn) throw new IntegrationError("GitHub isn't connected. An admin connects it in Settings › Integrations.");
  if (conn.accountType !== "Organization") throw new IntegrationError("Forge can only create repositories in an organization. Connect the company organization.");
  const repo = await gh<{ full_name: string }>(`/orgs/${encodeURIComponent(conn.account)}/repos`, {
    method: "POST",
    token: conn.token,
    body: JSON.stringify({ name, description, private: true, auto_init: false }),
  }).catch((e: Error) => {
    if (/422/.test(e.message) && /already exists/i.test(e.message)) throw new IntegrationError(`${conn.account}/${name} already exists on GitHub. Pick another name.`);
    if (/403/.test(e.message)) throw new IntegrationError("GitHub refused: the Forge app needs permission to create repositories. Reinstall it on the organization with access to all repositories.");
    throw e;
  });
  return repo.full_name;
}

/* ---------------------------------- Figma --------------------------------- */

export async function setFigmaToken(token: string, by: string) {
  const res = await fetch("https://api.figma.com/v1/me", { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new IntegrationError("Figma didn't accept that token. Create a new one in Figma (Settings › Security › Personal access tokens).");
  const me = (await res.json()) as { handle?: string; email?: string };
  await save("figma", { user: me.handle ?? null }, { token }, by);
}

/** The Figma token: from Settings › Integrations, else FIGMA_TOKEN in .env. */
export async function figmaToken(): Promise<string | null> {
  const f = await load<object, { token: string }>("figma");
  return f?.secret?.token ?? env.FIGMA_TOKEN ?? null;
}
