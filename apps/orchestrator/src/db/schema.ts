import { relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/* ---------------- Better Auth tables (default singular names) ---------------- */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(() => new Date()).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/* ------------------------------- Forge tables ------------------------------- */

export const projectStatus = pgEnum("project_status", ["created", "running", "stopped", "error"]);

export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: projectStatus("status").default("created").notNull(),
    /** Claude Agent SDK session, resumed on each follow-up prompt. */
    agentSessionId: text("agent_session_id"),
    /** "template" (new app) or "github" (imported repo). */
    source: text("source").default("template").notNull(),
    /** owner/name for imported repos. */
    repo: text("repo"),
    baseBranch: text("base_branch"),
    workBranch: text("work_branch"),
    prUrl: text("pr_url"),
    prNumber: integer("pr_number"),
    /** Team template this project started from, if any. */
    templateId: text("template_id"),
    /** Run the QA agent automatically after each saved version. */
    autoQa: boolean("auto_qa").default(false).notNull(),
    /** Daily spend limit for automatic QA runs in this project, in US cents. */
    autoQaDailyBudgetCents: integer("auto_qa_daily_budget_cents").default(200).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("project_owner_idx").on(t.ownerId)],
);

/** Append-only run event log; `payload` holds the protocol RunEvent minus base fields. */
export const projectEvent = pgTable(
  "project_event",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("project_event_pk").on(t.projectId, t.seq)],
);

/* ---------------------------- API connections ---------------------------- */

export const apiAuthMode = pgEnum("api_auth_mode", ["none", "entra_user", "api_key", "bearer", "basic", "oauth2_client", "login"]);

/** One of our in-house APIs, registered once for the whole team. */
export const apiConnection = pgTable("api_connection", {
  id: text("id").primaryKey(),
  /** Short identifier used in code and URLs, e.g. "hr" → hrApi, /api/forge/hr. */
  name: text("name").notNull().unique(),
  title: text("title"),
  baseUrl: text("base_url").notNull(),
  /** Where Forge downloads the spec; null when it was uploaded as a file (specFileName). */
  specUrl: text("spec_url"),
  specFileName: text("spec_file_name"),
  /** The OpenAPI document, normalized to JSON. */
  spec: jsonb("spec"),
  specFetchedAt: timestamp("spec_fetched_at"),
  specError: text("spec_error"),
  authMode: apiAuthMode("auth_mode").default("entra_user").notNull(),
  /** Entra scope the user's token is exchanged for, e.g. api://<app-id>/access_as_user. */
  entraScope: text("entra_scope"),
  /** Non-secret sign-in settings (header name, token URL, client id, username…). */
  authConfig: jsonb("auth_config"),
  /** Encrypted secret (key, token, password, client secret). See api-gateway.ts. */
  authSecret: text("auth_secret"),
  lastTest: jsonb("last_test"),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const projectApiConnection = pgTable(
  "project_api_connection",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => apiConnection.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("project_api_connection_pk").on(t.projectId, t.connectionId)],
);

/* ------------------------------- Team brain ------------------------------- */

/** Markdown guidance for the agent. projectId null = applies to every project. */
export const brainDoc = pgTable(
  "brain_doc",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    position: integer("position").default(0).notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("brain_doc_project_idx").on(t.projectId)],
);

/* ------------------------- Templates and component library ------------------------- */

/** A saved project version that new projects can start from. */
export const projectTemplate = pgTable("project_template", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  sourceProjectId: text("source_project_id").references(() => project.id, { onDelete: "set null" }),
  sourceSha: text("source_sha").notNull(),
  /** `git archive HEAD` as .tar.gz, base64. Tracked files only (no node_modules, no secrets). */
  archive: text("archive").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /** API connection ids the source project used. */
  connectionIds: jsonb("connection_ids").$type<string[]>().default([]).notNull(),
  /** The source project's own brain notes: { title, content }[]. */
  notes: jsonb("notes").$type<{ title: string; content: string }[]>().default([]).notNull(),
  /** Secret names the app expects (values are never copied). */
  secretNames: jsonb("secret_names").$type<string[]>().default([]).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** A reusable component saved by the agent from a project; every project's agent can reuse it. */
export const libraryComponent = pgTable("library_component", {
  id: text("id").primaryKey(),
  /** kebab-case, unique; also its folder name under .forge/library/. */
  name: text("name").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  /** How to use it (props, example). */
  usage: text("usage").notNull(),
  files: jsonb("files").$type<{ path: string; content: string }[]>().notNull(),
  dependencies: jsonb("dependencies").$type<string[]>().default([]).notNull(),
  sourceProjectId: text("source_project_id").references(() => project.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

/* --------------------------------- Secrets --------------------------------- */

/** Per-project environment variables for the app, encrypted at rest (see secrets.ts). */
export const projectSecret = pgTable(
  "project_secret",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** AES-256-GCM: "v1:<iv>:<tag>:<ciphertext>", base64 parts. */
    value: text("value").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [uniqueIndex("project_secret_pk").on(t.projectId, t.name)],
);

/* ---------------------------- Roles and invitations ---------------------------- */

/** Workspace role: admin (everything), builder (creates projects), member (only projects shared with them). */
export const workspaceMember = pgTable("workspace_member", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Project role: admin (manages people), builder (changes the app), viewer (looks and comments). */
export const projectMember = pgTable(
  "project_member",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    addedBy: text("added_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("project_member_pk").on(t.projectId, t.userId), index("project_member_user_idx").on(t.userId)],
);

/** An invitation link. Only a SHA-256 of the token is stored. */
export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    projectRole: text("project_role"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedBy: text("accepted_by"),
  },
  (t) => [index("invitation_email_idx").on(t.email)],
);

/* -------------------------------- Comments -------------------------------- */

/** Comments pinned to elements in a project's preview; replies point at their root via parentId. */
export const projectComment = pgTable(
  "project_comment",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /** CommentAnchor, thread roots only. */
    anchor: jsonb("anchor"),
    resolved: boolean("resolved").default(false).notNull(),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("project_comment_project_idx").on(t.projectId)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  projects: many(project),
}));
export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));
export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
export const projectRelations = relations(project, ({ one }) => ({
  owner: one(user, { fields: [project.ownerId], references: [user.id] }),
}));

/* ------------------------------- app problems ------------------------------ */

/**
 * Errors the running app produced: browser errors and failed requests (reported by the preview's
 * inspector script) and server errors (read from the dev server's log). One row per distinct
 * problem (`fingerprint`), counted when it happens again.
 * status: open → fixing (a "Fix this" run is working on it) → fixed (that run saved a version);
 * a fixed problem that happens again reopens. ignored: hidden until it happens again.
 */
export const appProblem = pgTable(
  "app_problem",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    /** browser (uncaught error, console.error), network (failed request), server (dev server log). */
    source: text("source").notNull(),
    message: text("message").notNull(),
    /** Stack trace, request details or the log excerpt. */
    detail: text("detail").default("").notNull(),
    /** App path where it happened (browser/network), if known. */
    page: text("page"),
    count: integer("count").default(1).notNull(),
    status: text("status").default("open").notNull(),
    fixRunId: text("fix_run_id"),
    fixedSha: text("fixed_sha"),
    firstSeen: timestamp("first_seen").defaultNow().notNull(),
    lastSeen: timestamp("last_seen").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("app_problem_fp_idx").on(t.projectId, t.fingerprint), index("app_problem_project_idx").on(t.projectId, t.lastSeen)],
);

/* ------------------------------- saved tests ------------------------------- */

/** Repeatable browser tests (TestStep[]), replayed after every new version. See tests.ts. */
export const savedTest = pgTable(
  "saved_test",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    steps: jsonb("steps").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** TestRunResult + sha + at of the latest replay. */
    lastResult: jsonb("last_result"),
  },
  (t) => [index("saved_test_project_idx").on(t.projectId)],
);

/** The latest security report per project (SecurityReport). See security.ts. */
export const securityScan = pgTable("security_scan", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  report: jsonb("report").notNull(),
  at: timestamp("at").defaultNow().notNull(),
});

/* ------------------------------- integrations ------------------------------ */

/**
 * Workspace-wide connections, set up by an admin in Settings › Integrations.
 *   github  the Forge GitHub App (created via GitHub's manifest flow) and its installation
 *   figma   a Figma access token
 * `secret` is encrypted (secrets.ts); `config` holds what's safe to show.
 */
export const integration = pgTable("integration", {
  key: text("key").primaryKey(),
  config: jsonb("config").notNull(),
  secret: text("secret"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

/* ------------------------------- data sources ------------------------------ */

/**
 * Read-only company data apps can build on (datasources.ts): a database (postgres, mssql, mysql)
 * or an uploaded spreadsheet (sheet, kept as a read-only SQLite file in data/datasets/).
 * `secret` holds the encrypted password; `tables` the structure the agent sees.
 */
export const dataSource = pgTable("data_source", {
  id: text("id").primaryKey(),
  /** Identifier used in code, e.g. "hr" (unique). */
  name: text("name").notNull().unique(),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  /** host, port, database, user, ssl (databases); fileName, sheets (spreadsheets). */
  config: jsonb("config").notNull(),
  secret: text("secret"),
  /** [{ schema, name, columns: [{ name, type }], rows? }] */
  tables: jsonb("tables").notNull(),
  error: text("error"),
  refreshedAt: timestamp("refreshed_at").defaultNow().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projectDataSource = pgTable(
  "project_data_source",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => dataSource.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("project_data_source_pk").on(t.projectId, t.sourceId)],
);
