import { z } from "zod";

/* ----------------------------- Projects API ----------------------------- */

export const ProjectStatus = z.enum(["created", "running", "stopped", "error"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.string(),
  ownerName: z.string().optional(),
  status: ProjectStatus,
  source: z.enum(["template", "github"]).default("template"),
  repo: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  workBranch: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  /** The signed-in user's role in this project (workspace admins are always "admin"). */
  myRole: z.enum(["admin", "builder", "viewer"]).optional(),
  /** Run the QA agent automatically after each saved version. */
  autoQa: z.boolean().optional(),
  /** Daily spend limit for automatic QA, in US cents. */
  autoQaDailyBudgetCents: z.number().int().optional(),
  /** Autonomous: the agent builds start to finish without stopping for plan approval or questions. */
  autonomous: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** The name was made from the request (deriveProjectName), not typed: Forge may suggest a better one. */
  autoName: z.boolean().optional(),
  description: z.string().trim().max(2000).optional(),
  /** Start from a team template instead of the blank app. */
  templateId: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const ImportProjectInput = z.object({
  /** GitHub repository as owner/name (a full github.com URL is also accepted). */
  repo: z.string().trim().min(3).max(200),
  branch: z.string().trim().max(200).optional(),
  name: z.string().trim().max(80).optional(),
});
export type ImportProjectInput = z.infer<typeof ImportProjectInput>;

export const ProjectSettingsInput = z.object({
  /** Rename the project (builders and admins). */
  name: z.string().trim().min(1, "Give the project a name.").max(80, "Project names can be up to 80 characters.").optional(),
  autoQa: z.boolean().optional(),
  autonomous: z.boolean().optional(),
  /** $0.10 to $50 per day. */
  autoQaDailyBudgetCents: z.number().int().min(10).max(5000).optional(),
});
export type ProjectSettingsInput = z.infer<typeof ProjectSettingsInput>;

/* ------------------------------ Run events ------------------------------ */
/*
 * Append-only per project. Every event has a monotonically increasing `seq`
 * within its project so clients can resume with `after=<seq>`.
 */

export const CheckName = z.enum(["install", "typecheck", "lint", "unit", "e2e"]);
export type CheckName = z.infer<typeof CheckName>;
export const CheckOutcome = z.object({
  ok: z.boolean(),
  skipped: z.boolean().optional(),
  /** Failing, but it already failed when the repo was imported, so it doesn't block saving. */
  advisory: z.boolean().optional(),
  output: z.string(),
});
export type CheckOutcome = z.infer<typeof CheckOutcome>;

export const QaIssue = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  title: z.string(),
  steps: z.string(),
  expected: z.string(),
  actual: z.string(),
});
export type QaIssue = z.infer<typeof QaIssue>;

/* ------------------------------ Saved tests ------------------------------ */
/*
 * A saved test is a list of steps Forge replays in a real browser after every new version, without
 * the AI. The QA agent proposes them from flows that worked; Forge replays each proposal straight
 * away and only offers the ones that pass.
 */

/** How a step finds an element: role (+ name), label or visible text; a CSS selector as a last resort. */
export const TestTarget = z
  .object({
    role: z.string().max(40).optional(),
    name: z.string().max(200).optional(),
    label: z.string().max(200).optional(),
    text: z.string().max(200).optional(),
    selector: z.string().max(300).optional(),
  })
  .refine((t) => t.role || t.label || t.text || t.selector, "A target needs a role, label, text or selector.");
export type TestTarget = z.infer<typeof TestTarget>;

export const TestStep = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), path: z.string().max(500) }),
  z.object({ action: z.literal("click"), target: TestTarget }),
  z.object({ action: z.literal("fill"), target: TestTarget, value: z.string().max(2000) }),
  z.object({ action: z.literal("press"), key: z.string().max(40) }),
  /** visible / hidden: the element is (not) shown. contains: its text includes `value`. */
  z.object({ action: z.literal("expect"), target: TestTarget, state: z.enum(["visible", "hidden", "contains"]), value: z.string().max(500).optional() }),
]);
export type TestStep = z.infer<typeof TestStep>;

export const TestInput = z.object({ title: z.string().trim().min(1).max(200), steps: z.array(TestStep).min(1).max(60) });
export type TestInput = z.infer<typeof TestInput>;

export const TestRunResult = z.object({
  ok: z.boolean(),
  /** 0-based index of the step that failed. */
  failedStep: z.number().int().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});
export type TestRunResult = z.infer<typeof TestRunResult>;

/** Saving a test, optionally as the proof of a spec criterion. */
export const SaveTestInput = TestInput.extend({ criterionId: z.string().max(20).optional() });
export type SaveTestInput = z.infer<typeof SaveTestInput>;

/** A test the QA agent proposed, with the result of Forge replaying it. */
export const ProposedTest = TestInput.extend({
  result: TestRunResult,
  /** The spec criterion it proves, when the agent named one. */
  criterionId: z.string().max(20).optional(),
  /** Forge saved it already (tests written for spec criteria on request). */
  saved: z.boolean().optional(),
});
export type ProposedTest = z.infer<typeof ProposedTest>;

export type SavedTest = TestInput & {
  id: string;
  createdBy: string;
  createdAt: string;
  lastResult: (TestRunResult & { sha: string | null; at: string }) | null;
};

const base = {
  seq: z.number().int().nonnegative(),
  projectId: z.string(),
  runId: z.string(),
  at: z.string(),
};

export const RunEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("run.started"),
    prompt: z.string(),
    model: z.string(),
    /** The model's display name and provider (Settings › Integrations › AI model), when known. */
    modelLabel: z.string().optional(),
    provider: z.enum(["anthropic", "openai"]).optional(),
    userId: z.string(),
    userName: z.string(),
    /** "qa" runs test the app in a browser and report issues; they never change code. */
    mode: z.enum(["build", "qa", "chat", "plan", "design"]).optional(),
  }),
  z.object({ ...base, type: z.literal("assistant.message"), text: z.string() }),
  /** Informational message from Forge itself (e.g. an automatic test was skipped). */
  z.object({ ...base, type: z.literal("notice"), text: z.string() }),
  z.object({
    ...base,
    type: z.literal("tool.call"),
    toolUseId: z.string(),
    tool: z.string(),
    summary: z.string().optional(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.result"),
    toolUseId: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("pause"),
    kind: z.enum(["question", "plan", "budget"]),
    pauseId: z.string(),
    payload: z.unknown(),
  }),
  z.object({ ...base, type: z.literal("resume"), pauseId: z.string(), answer: z.unknown() }),
  z.object({ ...base, type: z.literal("check.started"), attempt: z.number().int() }),
  z.object({
    ...base,
    type: z.literal("check.result"),
    attempt: z.number().int(),
    ok: z.boolean(),
    checks: z.partialRecord(CheckName, CheckOutcome),
  }),
  z.object({
    ...base,
    type: z.literal("pull_request"),
    action: z.enum(["opened", "updated"]),
    url: z.string(),
    number: z.number().int(),
    commits: z.number().int(),
    userName: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("changes.discarded"),
    files: z.array(z.string()),
    userName: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("commit"),
    sha: z.string(),
    message: z.string(),
    /** Set when this commit restores an earlier version. */
    restoredFrom: z.string().optional(),
    userName: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("qa.report"),
    summary: z.string(),
    issues: z.array(QaIssue),
    /** Repeatable tests the QA agent proposed, already replayed once by Forge. */
    tests: z.array(ProposedTest).optional(),
  }),
  /** Versions pushed to GitHub (a repo Forge created for a project made in Forge). */
  z.object({
    ...base,
    type: z.literal("github.push"),
    repo: z.string(),
    url: z.string(),
    commits: z.number().int(),
    created: z.boolean(),
    /** A project admin pushed although checks failed. */
    overridden: z.boolean().optional(),
    userName: z.string(),
  }),
  /** Changes made on GitHub were merged into the project and saved as a version. */
  z.object({
    ...base,
    type: z.literal("github.sync"),
    repo: z.string(),
    branch: z.string(),
    commits: z.number().int(),
    /** Files git could not merge by itself (the agent resolved them). */
    conflicts: z.number().int(),
    userName: z.string(),
  }),
  /** Saved tests were replayed (after a new version, or on request). */
  z.object({
    ...base,
    type: z.literal("tests.result"),
    trigger: z.enum(["version", "manual", "push"]),
    sha: z.string().nullable(),
    results: z.array(TestRunResult.extend({ testId: z.string(), title: z.string() })),
  }),
  /** Ideas (branches): started from an older version, switched to, brought into main, deleted. */
  z.object({
    ...base,
    type: z.literal("branch"),
    action: z.enum(["created", "switched", "used", "deleted"]),
    branch: z.string(),
    sha: z.string().optional(),
    userName: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    /** Cost of this run. */
    costUsd: z.number(),
    /** True when part of the cost had no known price (an OpenAI model without one): it's an estimate. */
    costEstimated: z.boolean().optional(),
    /** "forge": priced by Forge's model proxy per request (ChatGPT runs). Missing: the agent's own figure. */
    pricedBy: z.literal("forge").optional(),
    /** Cumulative cost of the agent session (the SDK's total_cost_usd), used to derive per-run cost. */
    sessionCostUsd: z.number().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("run.finished"),
    status: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().optional(),
    /** True when the workspace still has changes that were not saved as a version. */
    unsaved: z.boolean().optional(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];

/** A RunEvent before the store assigns `seq` and `at`. */
export type NewRunEvent = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "seq" | "at"> : never) : never;

/* ------------------------------- Sandbox API ------------------------------- */

export const SandboxState = z.enum(["missing", "starting", "running", "stopped", "error"]);
export type SandboxState = z.infer<typeof SandboxState>;

export type SandboxStatus = {
  state: SandboxState;
  previewUrl: string | null;
  activeRunId: string | null;
  /** What the sandbox is doing while state is "starting" (e.g. "Installing dependencies"). */
  stage?: string;
  error?: string;
};

/** build: change the app. chat: answer and explore, no changes. plan: write a spec, build after approval. */
/** design: rebuild an attached design (screenshot or Figma frame) as working UI. */
export const RunMode = z.enum(["build", "chat", "plan", "design"]);
export type RunMode = z.infer<typeof RunMode>;
export const StartRunInput = z.object({
  prompt: z.string().trim().min(1).max(20000),
  mode: RunMode.default("build"),
  /** "provider:model", one of the models the admin allows. Omitted: the project's last choice or the default. */
  model: z.string().max(160).optional(),
});
export type StartRunInput = z.infer<typeof StartRunInput>;

/** A request waiting for the agent to finish its current run. */
export type QueuedMessage = { id: string; prompt: string; mode: RunMode; model: string | null; userId: string; userName: string; createdAt: string };

/** POST /runs: started now, or queued because the agent is busy. */
export type StartRunResponse = { runId: string; queued?: false } | { queued: true; queuedId: string; position: number };

/* -------------------------------- Pauses -------------------------------- */

export type QuestionPayload = { questions: { id: string; question: string; options: string[] }[] };
/** One step of a plan: what gets done, optionally how. */
export type PlanStep = { id: string; title: string; detail?: string; /** The agent suggests it but it isn't required. */ optional?: boolean };
/**
 * A plan to approve. New plans have a summary and steps (shown in the Plan panel, where people
 * keep, edit, remove and add steps); older ones only have Markdown in `plan`.
 */
export type PlanPayload = { title: string; plan: string; summary?: string; steps?: PlanStep[] };

export const QuestionAnswer = z.object({ answers: z.record(z.string(), z.string().max(2000)) });
export const PlanAnswer = z.object({
  decision: z.enum(["approve", "revise"]),
  feedback: z.string().max(5000).optional(),
  plan: z.string().max(50000).optional(),
  /** The steps as the person left them, in order: the agent's (maybe edited) and their own. */
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(500),
        detail: z.string().max(2000).optional(),
        origin: z.enum(["agent", "user"]),
        edited: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  /** Titles of the agent's steps the person unticked. */
  removed: z.array(z.string().max(500)).max(100).optional(),
});
export const AnswerPauseInput = z.union([QuestionAnswer, PlanAnswer]);
export type AnswerPauseInput = z.infer<typeof AnswerPauseInput>;

/* ---------------------------- API connections ---------------------------- */

/**
 * How Forge signs calls to an API. Credentials are stored encrypted and added by Forge's API gateway;
 * apps and the agent never see them.
 *   none          no sign-in
 *   entra_user    the signed-in user's company (Entra) token
 *   api_key       a key in a header (e.g. X-API-Key) or the query string (e.g. ?api_key=)
 *   bearer        a fixed token: Authorization: Bearer <token>
 *   basic         username + password: Authorization: Basic …
 *   oauth2_client OAuth 2 client credentials: Forge gets (and renews) a token from the token URL
 *   login         username + password sent to the API's login endpoint; the token it returns is sent
 *                 on every call (Authorization: Bearer …), renewed before it expires and after a 401
 */
export const ApiAuthKind = z.enum(["none", "entra_user", "api_key", "bearer", "basic", "oauth2_client", "login"]);
export type ApiAuthKind = z.infer<typeof ApiAuthKind>;
export const ApiAuthInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("entra_user"), scope: z.string().max(300).optional() }),
  z.object({
    kind: z.literal("api_key"),
    location: z.enum(["header", "query"]),
    name: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, "Letters, numbers, dots, dashes and underscores"),
    value: z.string().min(1).max(4000),
  }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal("basic"), username: z.string().min(1).max(300), password: z.string().max(1000) }),
  z.object({
    kind: z.literal("oauth2_client"),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    scope: z.string().max(1000).optional(),
    /** Send the client id/secret as Basic auth (default) or in the form body. */
    clientAuth: z.enum(["basic", "body"]).default("basic"),
  }),
  z.object({
    kind: z.literal("login"),
    /** The login endpoint: a full URL, or a path on the API's base URL (e.g. /auth/login). */
    loginUrl: z.string().trim().min(1).max(1000),
    username: z.string().min(1).max(300),
    password: z.string().max(1000),
    usernameField: z.string().trim().min(1).max(100).default("username"),
    passwordField: z.string().trim().min(1).max(100).default("password"),
    bodyFormat: z.enum(["json", "form"]).default("json"),
    /** Where the token is in the answer, e.g. "token" or "data.accessToken". Empty: Forge looks in the usual places. */
    tokenPath: z.string().trim().max(200).default(""),
    headerName: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9-]+$/).default("Authorization"),
    /** Text before the token in that header ("Bearer"); empty sends the token alone. */
    prefix: z.string().max(40).default("Bearer"),
  }),
]);
export type ApiAuthInput = z.infer<typeof ApiAuthInput>;
/** What can be shown about an API's sign-in (never the secret itself). */
export type ApiAuthSummary =
  | { kind: "none" }
  | { kind: "entra_user"; scope: string | null }
  | { kind: "api_key"; location: "header" | "query"; name: string; hint: string }
  | { kind: "bearer"; hint: string }
  | { kind: "basic"; username: string }
  | { kind: "oauth2_client"; tokenUrl: string; clientId: string; scope: string | null; clientAuth: "basic" | "body" }
  | {
      kind: "login";
      loginUrl: string;
      username: string;
      usernameField: string;
      passwordField: string;
      bodyFormat: "json" | "form";
      tokenPath: string;
      headerName: string;
      prefix: string;
    };

export const CreateConnectionInput = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9]{1,30}$/, "2-31 lowercase letters or digits, starting with a letter"),
    baseUrl: z.string().url(),
    /** Either a URL Forge downloads (and can refresh), or the spec itself (an uploaded JSON or YAML file). */
    specUrl: z.string().url().optional(),
    specText: z.string().max(10 * 1024 * 1024).optional(),
    specFileName: z.string().max(200).optional(),
    auth: ApiAuthInput.default({ kind: "none" }),
  })
  .refine((v) => Boolean(v.specUrl) !== Boolean(v.specText), "Give either the spec's URL or the spec file.");
export type CreateConnectionInput = z.infer<typeof CreateConnectionInput>;
/** What a client sends (defaults not yet applied). */
export type CreateConnectionRequest = z.input<typeof CreateConnectionInput>;

export const UpdateConnectionInput = z.object({
  baseUrl: z.string().url().optional(),
  auth: ApiAuthInput.optional(),
  /** Replace the spec with an uploaded file (for APIs whose spec isn't at a URL). */
  specText: z.string().max(10 * 1024 * 1024).optional(),
  specFileName: z.string().max(200).optional(),
});
export type UpdateConnectionInput = z.infer<typeof UpdateConnectionInput>;

export type ApiConnection = {
  id: string;
  name: string;
  title: string | null;
  version: string | null;
  baseUrl: string;
  /** null when the spec was uploaded as a file. */
  specUrl: string | null;
  specFileName: string | null;
  operations: number;
  specFetchedAt: string | null;
  specError: string | null;
  auth: ApiAuthSummary;
  /** Result of the last "Test the connection". */
  lastTest: { ok: boolean; status: number | null; message: string; at: string } | null;
};

/** One API with what its details page shows. */
export type ApiConnectionDetails = ApiConnection & {
  description: string | null;
  createdBy: string;
  createdAt: string;
  usedBy: { id: string; name: string }[];
};

/** One endpoint of a registered API, from its OpenAPI spec. */
export type ApiOperation = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string | null;
  description: string | null;
  operationId: string | null;
  tags: string[];
  deprecated: boolean;
  parameters: { name: string; in: string; required: boolean }[];
  hasBody: boolean;
};

export const SetProjectConnectionsInput = z.object({ connectionIds: z.array(z.string()).max(20) });

/* ------------------------------- Team brain ------------------------------- */

export const BrainDocInput = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().max(20000),
  enabled: z.boolean().default(true),
  /** Omit for a team doc (applies to every project). */
  projectId: z.string().optional(),
});
export type BrainDocInput = z.infer<typeof BrainDocInput>;

export type BrainDoc = {
  id: string;
  projectId: string | null;
  title: string;
  content: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
};

/* ------------------------------- Versions ------------------------------- */

export type Version = { sha: string; message: string; at: string; author: string; current: boolean };

/** Files that differ between two versions. Line counts are null for binary files. */
export type VersionDiffFile = { path: string; status: "added" | "modified" | "deleted"; added: number | null; deleted: number | null };
export type VersionCompare = { from: string; to: string; files: VersionDiffFile[] };
/** A line of work: the main line, or an idea started from an older version. */
export type Branch = { name: string; sha: string; at: string; current: boolean; main: boolean };
export type BranchesResponse = { current: string; main: string; branches: Branch[] };

/* --------------------------- Security (before push) -------------------------- */

export type SecurityFinding = {
  id: string;
  category: "dependencies" | "secrets" | "access" | "input";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string | null;
  line: number | null;
  detail: string;
  fix: string;
};
/** Settings › Integrations. */
export type IntegrationsStatus = {
  github:
    | { state: "not_connected" }
    | {
        state: "connected" | "needs_install";
        account: string | null;
        appSlug: string | null;
        repositorySelection: string | null;
        installUrl: string | null;
        manageUrl: string | null;
        /** "Organization" or "User": Forge can only create repositories in an organization. */
        accountType: string | null;
        /** The GitHub account that owns the Forge app (the admin who connected, or the organization). */
        appOwner: string | null;
        connectedBy: string;
        connectedAt: string;
      };
  figma: { configured: false } | { configured: true; user: string | null; updatedBy: string; updatedAt: string };
  ai: AiSettings;
};

/** Which AI builds the apps (Settings › Integrations › AI model). */
export type AiProvider = "anthropic" | "openai";

export type AiSettings = {
  provider: AiProvider;
  /** The model the agent uses, e.g. "claude-opus-5-5" or an OpenAI model id. */
  model: string;
  /** A cheaper model for small background steps (titles, command checks). null: same as `model`. */
  fastModel: string | null;
  /** Whether each provider has an API key, and where it comes from. */
  keys: Record<AiProvider, { source: "settings" | "env" | null; last4: string | null; updatedBy: string | null }>;
  /** Models people may pick per message (always includes the default). */
  allowed: AllowedModel[];
  updatedBy: string | null;
  updatedAt: string | null;
};

/** USD per million tokens. */
export type ModelPrice = { input: number; cachedInput: number; output: number };

export type AiModel = { id: string; label: string; hint?: string; /** OpenAI list price, when Forge knows it. */ price?: ModelPrice | null };

/** How expensive a model is, roughly: 1 €, 2 €€, 3 €€€. */
export type CostTier = 1 | 2 | 3;

/**
 * Whether a model can build (it needs tool use: editing files, running commands) or only chat.
 * Claude models all can; OpenAI's chat-only families (ChatGPT snapshots, o1-mini/preview, search
 * and audio models) can't. Used by the server (runs) and the UI (pickers) alike.
 */
export function modelCanCode(provider: AiProvider, id: string): boolean {
  if (provider === "anthropic") return true;
  return !/^chatgpt-|^o1-(mini|preview)|search|audio|realtime|transcribe|tts|instruct|^gpt-3\.5-turbo-instruct/.test(id);
}

/** A model people may pick in the prompt box (chosen by an admin). */
export type AllowedModel = {
  provider: AiProvider;
  id: string;
  label: string;
  hint: string;
  cost: CostTier;
  /** OpenAI models: what Forge charges on the Usage page. null/missing: Forge's list price, if it knows one. */
  price?: ModelPrice | null;
};

/** GET /projects/:id/models: what the prompt box's model picker offers. */
export type ProjectModels = {
  models: (AllowedModel & { key: string; available: boolean; canCode: boolean })[];
  /** "provider:model" of the workspace default. */
  defaultKey: string;
  /** "provider:model" the project used last (if still allowed), else the default. */
  currentKey: string;
};

export type UpdateAiSettingsInput = {
  provider: AiProvider;
  model: string;
  fastModel?: string | null;
  /** A new API key for `provider` (checked before it's saved). */
  apiKey?: string;
  /** Models people may pick per message. Omitted: unchanged. */
  allowed?: AllowedModel[];
};

/** Where the project's code lives on GitHub, and whether Forge can create a repo for it. */
export type GitHubStatus = {
  /** "github": imported (changes go out as a pull request). "template": made in Forge. */
  source: "template" | "github";
  repo: string | null;
  url: string | null;
  /** The company organization new repos are created in (null: not configured). */
  org: string | null;
};
/** Changes on GitHub's branch that the project doesn't have yet. */
export type GitHubIncoming = {
  branch: string;
  /** How many commits the project is missing (of the newest 50 looked at). */
  behind: number;
  /** True when all 50 looked at are missing: there may be more. */
  more: boolean;
  commits: { sha: string; message: string; author: string; at: string }[];
};

export type PrComment = { author: string; body: string; at: string; url: string };
/** What reviewers and CI said about the project's pull request (or, without one, CI on the pushed branch). */
export type PrFeedback = {
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED"; title: string; reviewDecision: string | null } | null;
  /** Unresolved review conversations on lines of code. */
  threads: { id: string; path: string; line: number | null; outdated: boolean; comments: PrComment[]; sent: boolean }[];
  /** Review summaries with text ("Changes requested: …"). */
  reviews: (PrComment & { id: string; state: string; sent: boolean })[];
  /** The pull request's general conversation. */
  comments: (PrComment & { id: string; sent: boolean })[];
  checks: { name: string; state: "failing" | "pending" | "passing"; url: string | null; summary: string | null }[];
  /** False when GitHub wouldn't show the checks (the Forge app lacks permission). */
  checksAvailable: boolean;
};

export const AddressFeedbackInput = z.object({
  /** Ids of threads, reviews and comments to hand to the agent. */
  ids: z.array(z.string().max(120)).max(60),
  /** Also hand over the failing checks (with the end of their logs). */
  checks: z.boolean().optional(),
});

/** A repository the connected GitHub app can see (the import picker). */
export type GitHubRepo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  updatedAt: string;
};
export type GitHubReposResponse = { connected: false } | { connected: true; account: string; repos: GitHubRepo[]; truncated: boolean };

/** Why a push was refused. */
export type PushBlocked = { error: string; failingTests: string[]; securityBlocking: number; canOverride: boolean };

export type SecurityReport = {
  sha: string | null;
  at: string;
  findings: SecurityFinding[];
  /** False when pnpm audit couldn't run (no registry access or no lockfile). */
  dependenciesChecked: boolean;
  /** Critical + high findings: these block pushing to GitHub. */
  blocking: number;
};

/* ------------------------------ Data sources ------------------------------ */

/** flowkite: a Flowkite Database API key; its read operations become this source's "tables". */
export const DataSourceKind = z.enum(["postgres", "mssql", "mysql", "sheet", "flowkite"]);
export type DataSourceKind = z.infer<typeof DataSourceKind>;
/** Identifier used in code: lowercase letters, numbers, underscores. */
export const DATA_SOURCE_NAME = /^[a-z][a-z0-9_]{1,39}$/;

const DataSourceBase = { name: z.string().regex(DATA_SOURCE_NAME, "Use lowercase letters, numbers and underscores, e.g. hr_db"), title: z.string().trim().min(1).max(100) };
export const DatabaseConnection = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(128),
  user: z.string().trim().min(1).max(128),
  password: z.string().max(500),
  ssl: z.boolean().default(true),
});
export const CreateDataSourceInput = z.discriminatedUnion("kind", [
  z.object({ ...DataSourceBase, kind: z.literal("postgres"), connection: DatabaseConnection }),
  z.object({ ...DataSourceBase, kind: z.literal("mssql"), connection: DatabaseConnection }),
  z.object({ ...DataSourceBase, kind: z.literal("mysql"), connection: DatabaseConnection }),
  z.object({ ...DataSourceBase, kind: z.literal("sheet"), fileName: z.string().min(1).max(200), dataBase64: z.string().max(28_000_000) }),
  z.object({
    ...DataSourceBase,
    kind: z.literal("flowkite"),
    /** The Data Gateway's address, e.g. https://gateway.flowkite.app */
    gatewayUrl: z.string().url(),
    /** The database's key (or id) in Flowkite. */
    database: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
    /** A Database API key (fkg_…). */
    apiKey: z.string().trim().min(10).max(200),
  }),
]);
export type CreateDataSourceInput = z.infer<typeof CreateDataSourceInput>;

/** A table, or (Flowkite) a read operation: its result columns, what it does and the inputs it takes. */
export type DataSourceTable = {
  schema: string | null;
  name: string;
  columns: { name: string; type: string }[];
  rows?: number;
  summary?: string;
  inputs?: string[];
};
/** Change a data source: its title, its password / API key, or (spreadsheets) the file. */
export const UpdateDataSourceInput = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  password: z.string().max(500).optional(),
  apiKey: z.string().trim().min(10).max(200).optional(),
  fileName: z.string().min(1).max(200).optional(),
  dataBase64: z.string().max(28_000_000).optional(),
});
export type UpdateDataSourceInput = z.infer<typeof UpdateDataSourceInput>;

/** One data source with the projects that use it (its details page). */
export type DataSourceDetails = DataSource & { usedBy: { id: string; name: string }[] };

export type DataSource = {
  id: string;
  name: string;
  title: string;
  kind: DataSourceKind;
  /** "db.example.com / hr" or "staff.xlsx". Never the password. */
  where: string;
  tables: DataSourceTable[];
  error: string | null;
  refreshedAt: string;
  createdBy: string;
  /** Projects using it. */
  projects: number;
};

/* ------------------------------ App problems ------------------------------ */

/** An error the running app produced, grouped with its repeats. See orchestrator problems.ts. */
export type AppProblem = {
  id: string;
  source: "browser" | "network" | "server";
  message: string;
  detail: string;
  page: string | null;
  count: number;
  status: "open" | "fixing" | "fixed" | "ignored";
  fixedSha: string | null;
  firstSeen: string;
  lastSeen: string;
};

/* -------------------------------- Living spec -------------------------------- */

/** One acceptance criterion: something a user can do or see, checkable in the browser. */
export type SpecCriterion = {
  id: string;
  /** A short feature name the criteria are grouped by, e.g. "Voting". */
  area: string;
  text: string;
  /** The saved test that proves it, if any. */
  testId: string | null;
  testTitle: string | null;
  /** untested: no test. not_run: its test hasn't been replayed yet. */
  status: "untested" | "not_run" | "passing" | "failing";
  /** failing: why the test failed. */
  error: string | null;
  createdBy: string;
  updatedAt: string;
};

export type ProjectSpec = {
  /** Markdown: what the app is for and its main features. */
  summary: string;
  updatedAt: string | null;
  updatedBy: string | null;
  criteria: SpecCriterion[];
  tested: number;
  passing: number;
  failing: number;
};

const SpecArea = z.string().trim().min(1).max(60);
const SpecText = z.string().trim().min(3).max(400);
export const SpecCriterionInput = z.object({ area: SpecArea, text: SpecText });
/** Changes to the spec: from the build agent's update_spec tool, or the Spec tab. */
export const SpecUpdate = z.object({
  summary: z.string().trim().max(6000).optional(),
  add: z.array(SpecCriterionInput).max(60).optional(),
  change: z.array(z.object({ id: z.string().max(20), text: SpecText.optional(), area: SpecArea.optional() })).max(60).optional(),
  remove: z.array(z.string().max(20)).max(60).optional(),
});
export type SpecUpdate = z.infer<typeof SpecUpdate>;

/* ------------------------------ Version reviews ------------------------------ */

/** One screenshot of a page in a version, compared with the earlier version's. */
export type ReviewShot = {
  route: string;
  slug: string;
  viewport: "desktop" | "phone";
  /** The picture's file name; for a removed page it belongs to the earlier version. */
  file: string;
  width: number;
  height: number;
  /** new: the page didn't exist before. removed: it no longer exists. */
  status: "new" | "same" | "changed" | "removed";
  /** changed: the share of pixels that differ (0 to 1), and the picture that marks them. */
  ratio?: number;
  diffFile?: string;
};

/** An accessibility problem (axe rule) on one page. */
export type A11yFinding = {
  id: string;
  route: string;
  rule: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  help: string;
  helpUrl: string;
  /** How many elements have it; `nodes` lists up to three. */
  count: number;
  nodes: { target: string; html: string; summary: string }[];
};

export type VersionReview = {
  sha: string;
  /** The earlier version it was compared with (null: the first reviewed version). */
  baseSha: string | null;
  at: string;
  shots: ReviewShot[];
  a11y: A11yFinding[];
  /** False when the accessibility scan could not run. */
  a11yChecked: boolean;
};

/** Per version: the pages (routes) that look different, are new, or are gone. */
export type VersionReviewSummary = { sha: string; baseSha: string | null; changed: string[]; added: string[]; removed: string[]; a11y: number };

/* ------------------------- Templates and component library ------------------------- */

export const CreateTemplateInput = z.object({
  projectId: z.string(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
});

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string | null;
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  sourceSha: string;
  sizeBytes: number;
  apis: string[];
  notes: number;
  secretNames: string[];
  createdBy: string;
  createdAt: string;
};

export type LibraryComponent = {
  id: string;
  name: string;
  title: string;
  description: string;
  usage: string;
  files: { path: string; content: string }[];
  dependencies: string[];
  sourceProjectId: string | null;
  sourceProjectName: string | null;
  createdBy: string;
  updatedAt: string;
};

/* -------------------------------- Secrets -------------------------------- */

/** Environment variable names the app may use. NEXT_PUBLIC_* values are visible in the browser. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const SetSecretInput = z.object({ value: z.string().min(1).max(10000) });

/** Metadata only: values never leave the orchestrator once saved. */
export type ProjectSecret = { name: string; public: boolean; updatedBy: string; updatedAt: string };

/* ------------------------------- Comments ------------------------------- */

/** Where a comment is pinned in the preview. */
export const CommentAnchor = z.object({
  /** Page path in the app, e.g. "/about". */
  page: z.string().max(500),
  /** CSS path of the element (from the preview inspector). */
  selector: z.string().max(1000),
  /** Short human label, e.g. `<button> "Vote" in Sushi Bar`. */
  label: z.string().max(300),
  tag: z.string().max(40),
  text: z.string().max(200).optional(),
  section: z.string().max(120).optional(),
  html: z.string().max(1200).optional(),
});
export type CommentAnchor = z.infer<typeof CommentAnchor>;

export const CreateCommentInput = z.union([
  z.object({ body: z.string().trim().min(1).max(4000), anchor: CommentAnchor }),
  z.object({ body: z.string().trim().min(1).max(4000), parentId: z.string() }),
]);
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

export const UpdateCommentInput = z.object({
  resolved: z.boolean().optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  /** Re-anchor: the preview found the pinned element again after the page changed; its new CSS path. */
  selector: z.string().min(1).max(1000).optional(),
});

export type ProjectComment = {
  id: string;
  parentId: string | null;
  /** Empty for guest feedback. */
  userId: string;
  userName: string;
  /** Left through a preview share link by someone without a Forge account. */
  guest?: boolean;
  /** Guest feedback: the share link's label, when it has one. */
  via?: string | null;
  body: string;
  /** Thread roots only. */
  anchor: CommentAnchor | null;
  resolved: boolean;
  resolvedBy: string | null;
  createdAt: string;
};

/* ---------------------------- Roles and invitations ---------------------------- */

export const WorkspaceRole = z.enum(["admin", "builder", "member"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;
export const ProjectRole = z.enum(["admin", "builder", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const CreateInvitationInput = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: WorkspaceRole.default("member"),
    projectId: z.string().optional(),
    projectRole: ProjectRole.optional(),
  })
  .refine((v) => !v.projectId === !v.projectRole, "Pick a project role together with the project.");
export type CreateInvitationInput = z.infer<typeof CreateInvitationInput>;

export type Me = { id: string; name: string; email: string; role: WorkspaceRole };

export type TeamMember = { id: string; name: string; email: string; role: WorkspaceRole; joinedAt: string; projects: number };

export type Invitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  projectId: string | null;
  projectName: string | null;
  projectRole: ProjectRole | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  /** Only returned right after creating it: the link to send. */
  link?: string;
};

export type InvitationPreview = {
  email: string;
  role: WorkspaceRole;
  invitedBy: string;
  projectName: string | null;
  projectRole: ProjectRole | null;
  hasAccount: boolean;
};

export type ProjectMemberInfo = { userId: string; name: string; email: string; role: ProjectRole; viaWorkspaceAdmin: boolean };

/* ------------------------------- Activity ------------------------------- */

export type ActivityItem = {
  kind: string;
  projectId: string;
  projectName: string;
  who: string;
  text: string;
  at: string;
};

export type ProjectSummary = {
  latestVersion: string | null;
  lastActivityAt: string | null;
  openComments: number;
  running: boolean;
};

export type ActivityResponse = { items: ActivityItem[]; projects: Record<string, ProjectSummary> };

/* ------------------------------- Presence ------------------------------- */

/** A teammate with the project open (one entry per person, however many tabs). */
export type PresenceUser = { id: string; name: string; since: string };

/* ---------------------------- WebSocket frames ---------------------------- */

export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), projectId: z.string(), after: z.number().int().default(0) }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export type ServerFrame =
  | { type: "event"; event: RunEvent }
  /** Streamed assistant text. Live only, not stored; the final text arrives as assistant.message. */
  | { type: "delta"; projectId: string; runId: string; text: string }
  /** Live JPEG frame (base64) of the QA agent's browser. Live only, not stored. */
  | { type: "qa_frame"; projectId: string; runId: string; data: string }
  | { type: "caught_up"; projectId: string; seq: number }
  /** Who has this project open right now. */
  | { type: "presence"; projectId: string; users: PresenceUser[] }
  /** Comments changed; clients refetch them. */
  | { type: "comments_changed"; projectId: string }
  /** The app's recorded problems changed; clients refetch them. */
  | { type: "problems_changed"; projectId: string }
  /** A new security report is available. */
  | { type: "security_changed"; projectId: string }
  /** A version's review (screenshots, accessibility) is ready. */
  | { type: "review_changed"; projectId: string }
  /** The living spec changed. */
  | { type: "spec_changed"; projectId: string }
  /** The message queue changed (queued, removed or started); clients refetch it. */
  | { type: "queue_changed"; projectId: string }
  /** The project's details changed (e.g. Forge named it); clients refetch the project. */
  | { type: "project_changed"; projectId: string }
  | { type: "pong" }
  | { type: "error"; message: string };

/**
 * A run's error as people should read it: the provider's message, without the agent's wrapper
 * ("Claude Code returned an error result", "API Error: 400", "Request rejected (429)"), stack
 * traces or telemetry. Used when a run's error is stored and when older errors are shown.
 */
export function cleanRunError(raw: string | undefined | null): string {
  if (!raw) return "The agent stopped unexpectedly.";
  let s = raw;
  // Stack traces ("at fS.readMessages (file:///…)") and the telemetry object after them.
  s = s.replace(/\s+at\s+[\w$.<>[\]]+\s+\((?:file|node):[\s\S]*$/, "");
  s = s.replace(/\s*\{\s*telemetryMessage[\s\S]*$/, "");
  s = s.replace(/^\s*(?:Error:\s*)?Claude Code returned an error result:\s*/i, "");
  s = s.replace(/^API Error:\s*/i, "");
  s = s.replace(/^Request rejected \(\d{3}\)\s*·\s*/i, "");
  s = s.replace(/^\d{3}\s+(?=[A-Z{])/, "");
  // A JSON error body: keep its message.
  const json = /^\{[\s\S]*"message"\s*:\s*"((?:[^"\\]|\\.)*)"[\s\S]*\}$/.exec(s.trim());
  if (json) s = json[1]!.replace(/\\"/g, '"');
  if (/ANTHROPIC_API_KEY is not set/.test(s)) s = "No API key for the AI model. An admin can add one in Settings › Integrations › AI model.";
  s = s.trim();
  return s || "The agent stopped unexpectedly.";
}

/* ----------------------------- preview sharing ----------------------------- */

export const PREVIEW_SHARE_DURATIONS = ["1h", "24h", "7d", "30d"] as const;
export type PreviewShareDuration = (typeof PREVIEW_SHARE_DURATIONS)[number];

/** A link that lets anyone view a project's preview until it expires or is revoked. */
export type PreviewShare = {
  id: string;
  label: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
  /** Visitors may pin feedback to the app. */
  allowFeedback: boolean;
  /** The link to send. Missing for links made before Forge kept them (only a hash was stored). */
  url?: string;
};

export const CreatePreviewShareInput = z.object({
  duration: z.enum(PREVIEW_SHARE_DURATIONS),
  label: z.string().trim().max(80).optional(),
  allowFeedback: z.boolean().optional(),
});

/** Feedback from a visitor of a shared preview: a new pinned note, or a reply in one of that link's threads. */
export const GuestCommentInput = z.union([
  z.object({ name: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(4000), anchor: CommentAnchor }),
  z.object({ name: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(4000), parentId: z.string().max(40) }),
]);
export type GuestCommentInput = z.infer<typeof GuestCommentInput>;

/** What the public share page learns about a link. */
export type SharedPreviewInfo = { projectName: string; expiresAt: string; frameUrl: string; feedback: boolean };

/* ------------------------------ project names ------------------------------ */

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);
const titleCase = (words: string[]) =>
  words.map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : /^[A-Z0-9]{2,}$/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join(" ");

/**
 * A project name from someone's request, without AI: drop the lead-in ("I want you to build me a…",
 * "Can you create…"), cut at the first clause ("…where people vote", "…that shows…"), and keep the
 * core in title case, up to 4 words. "I want you to build a team lunch poll where people vote" →
 * "Team Lunch Poll".
 */
export function deriveProjectName(text: string): string {
  let s = text.replace(/\s+/g, " ").trim().split(/[.!?\n]/)[0] ?? "";
  // Lead-ins, repeated: "Hi, can you please build me a simple…"
  const lead =
    /^(hi|hello|hey|ok|okay|so|please|pls|kindly|i (?:want|would like|need|wanna)(?: you)?(?: to)?|we (?:want|need)(?: you)?(?: to)?|(?:can|could|would) you(?: please)?|let'?s|help me(?: to)?|i'?d like(?: you)?(?: to)?|build|create|make|design|develop|generate|write|set up|setup|start|add|me|us|an?|the|new|simple|small|basic|quick|nice|modern|beautiful|full|complete|internal|web|app for|application for|tool for)\b[ ,:-]*/i;
  for (let i = 0; i < 12 && lead.test(s); i++) s = s.replace(lead, "");
  // Cut at the first clause or list.
  s = s.split(/\s(?:where|that|which|who|so|to help|to let|to manage|with|using|including|for (?:our|my|the|people|users|teams?|employees|staff)|in which|like)\s|[,;:(–—-]\s?/i)[0] ?? s;
  const words = s.replace(/[^\p{L}\p{N}&+'\s-]/gu, " ").trim().split(/\s+/).filter(Boolean).slice(0, 4);
  while (words.length > 1 && SMALL_WORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
  const name = titleCase(words);
  // Too vague to be a name ("this page", "it", "an app"): a placeholder until Forge suggests one.
  if (name.length < 2 || /^(this|that|it|something|stuff|things?|page|pages|this page|that page|this one|this design|this app|app|apps|website|site|ui|screen)$/i.test(name)) return "New app";
  return name.slice(0, 60);
}

/** A readable name from a repository name: "doctorflix-web" → "Doctorflix Web". */
export function prettyRepoName(repo: string): string {
  const words = repo.replace(/\.git$/, "").split(/[-_.\s]+/).filter(Boolean);
  return words.length ? titleCase(words).slice(0, 80) : repo;
}
