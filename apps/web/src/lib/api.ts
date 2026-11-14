import type { AiModel, AiProvider, CreateConnectionRequest, PreviewShare, PreviewShareDuration, ProjectModels, QueuedMessage, StartRunResponse, UpdateAiSettingsInput, UpdateConnectionInput } from "@forge/protocol";
import type {
  AnswerPauseInput,
  ApiConnectionDetails,
  AppProblem,
  ApiOperation,
  BranchesResponse,
  CreateDataSourceInput,
  DataSource,
  DataSourceDetails,
  UpdateDataSourceInput,
  IntegrationsStatus,
  GitHubReposResponse,
  GitHubStatus,
  GitHubIncoming,
  PrFeedback,
  SecurityReport,
  VersionReview,
  VersionReviewSummary,
  ProjectSpec,
  SaveTestInput,
  SavedTest,
  TestRunResult,
  VersionCompare,
  ActivityResponse,
  CreateInvitationInput,
  Invitation,
  InvitationPreview,
  Me,
  ProjectMemberInfo,
  ProjectRole,
  RunMode,
  TeamMember,
  WorkspaceRole,
  ApiConnection,
  BrainDoc,
  BrainDocInput,
  CreateCommentInput,
  CreateProjectInput,
  ImportProjectInput,
  LibraryComponent,
  Project,
  ProjectComment,
  ProjectSecret,
  ProjectTemplate,
  ProjectSettingsInput,
  SandboxStatus,
  Version,
} from "@forge/protocol";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The parsed JSON error body, for errors that carry details (e.g. a blocked push). */
    public body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    let body: unknown;
    try {
      body = JSON.parse(text);
      if (typeof (body as { error?: unknown }).error === "string") message = (body as { error: string }).error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<Project[]>("/projects"),
  getProject: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),
  createProject: (input: CreateProjectInput) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),
  importProject: (input: ImportProjectInput) =>
    request<Project>("/projects/import", { method: "POST", body: JSON.stringify(input) }),
  pullRequest: (id: string) =>
    request<{ url: string; number: number; action: "opened" | "updated"; commits: number }>(
      `/projects/${encodeURIComponent(id)}/pull-request`,
      { method: "POST" },
    ),
  sandbox: (id: string) => request<SandboxStatus>(`/projects/${encodeURIComponent(id)}/sandbox`),
  startSandbox: (id: string) =>
    request<SandboxStatus>(`/projects/${encodeURIComponent(id)}/sandbox/start`, { method: "POST" }),
  queue: (id: string) => request<{ queue: QueuedMessage[] }>(`/projects/${encodeURIComponent(id)}/queue`).then((r) => r.queue),
  removeQueued: (id: string, qid: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/queue/${encodeURIComponent(qid)}`, { method: "DELETE" }),
  runNextQueued: (id: string) => request<{ runId: string }>(`/projects/${encodeURIComponent(id)}/queue/next`, { method: "POST" }),
  previewAccess: (id: string, opts: { compare?: boolean; next?: string } = {}) =>
    request<{ url: string }>(
      `/projects/${encodeURIComponent(id)}/preview-access?${new URLSearchParams({ ...(opts.compare ? { compare: "1" } : {}), next: opts.next ?? "/" })}`,
    ),
  previewShares: (id: string) => request<{ shares: PreviewShare[] }>(`/projects/${encodeURIComponent(id)}/preview-shares`).then((r) => r.shares),
  createPreviewShare: (id: string, input: { duration: PreviewShareDuration; label?: string; allowFeedback?: boolean }) =>
    request<PreviewShare>(`/projects/${encodeURIComponent(id)}/preview-shares`, { method: "POST", body: JSON.stringify(input) }),
  revokePreviewShare: (id: string, sid: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/preview-shares/${encodeURIComponent(sid)}`, { method: "DELETE" }),
  projectModels: (id: string) => request<ProjectModels>(`/projects/${encodeURIComponent(id)}/models`),
  startRun: (id: string, prompt: string, mode: RunMode = "build", model?: string) =>
    request<StartRunResponse>(`/projects/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify(model ? { prompt, mode, model } : { prompt, mode }),
    }),
  files: (id: string) => request<{ files: string[] }>(`/projects/${encodeURIComponent(id)}/files`),
  fileContent: (id: string, path: string) =>
    request<{ path: string; size: number; content: string | null; binary?: boolean; tooLarge?: boolean }>(
      `/projects/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`,
    ),
  upload: (id: string, file: { name: string; type: string; dataBase64: string }) =>
    request<{ path: string; name: string; size: number; type: string }>(`/projects/${encodeURIComponent(id)}/uploads`, {
      method: "POST",
      body: JSON.stringify(file),
    }),
  downloadUrl: (id: string, name: string) => `/api/projects/${encodeURIComponent(id)}/download?name=${encodeURIComponent(name)}`,
  screenshot: (
    id: string,
    view: { path: string; width: number; height: number; scrollX: number; scrollY: number; colorScheme: "light" | "dark"; forced: boolean },
  ) =>
    request<{ png: string }>(`/projects/${encodeURIComponent(id)}/screenshot`, { method: "POST", body: JSON.stringify(view) }),
  restartApp: (id: string) => request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/sandbox/restart`, { method: "POST" }),
  me: () => request<Me>("/me"),
  apiOperations: (connectionId: string) => request<ApiOperation[]>(`/connections/${encodeURIComponent(connectionId)}/operations`),
  dataSources: () => request<DataSource[]>("/data-sources"),
  dataSource: (sid: string) => request<DataSourceDetails>(`/data-sources/${encodeURIComponent(sid)}`),
  updateDataSource: (sid: string, input: UpdateDataSourceInput) =>
    request<DataSourceDetails>(`/data-sources/${encodeURIComponent(sid)}`, { method: "PATCH", body: JSON.stringify(input) }),
  previewDataOperation: (sid: string, operation: string, body: unknown) =>
    request<{ rows: Record<string, unknown>[]; nextPage?: string | null; truncated?: boolean }>(`/data-sources/${encodeURIComponent(sid)}/operation`, {
      method: "POST",
      body: JSON.stringify({ operation, body }),
    }),
  createDataSource: (input: CreateDataSourceInput) => request<DataSource>("/data-sources", { method: "POST", body: JSON.stringify(input) }),
  refreshDataSource: (sid: string) => request<DataSource>(`/data-sources/${encodeURIComponent(sid)}/refresh`, { method: "POST" }),
  deleteDataSource: (sid: string) => request<{ ok: true }>(`/data-sources/${encodeURIComponent(sid)}`, { method: "DELETE" }),
  previewDataQuery: (sid: string, sql: string) =>
    request<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }>(`/data-sources/${encodeURIComponent(sid)}/query`, {
      method: "POST",
      body: JSON.stringify({ sql }),
    }),
  projectDataSources: (id: string) => request<{ sourceIds: string[] }>(`/projects/${encodeURIComponent(id)}/data-sources`),
  setProjectDataSources: (id: string, sourceIds: string[]) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/data-sources`, { method: "PUT", body: JSON.stringify({ sourceIds }) }),
  githubRepos: () => request<GitHubReposResponse>("/github/repos"),
  githubBranches: (repo: string) => request<{ branches: string[] }>(`/github/branches?${new URLSearchParams({ repo })}`),
  integrations: () => request<IntegrationsStatus>("/integrations"),
  /** Without an organization, GitHub lets the admin pick one when installing the app. */
  connectGitHub: (org?: string) =>
    request<{ action: string; manifest: string; state: string }>("/integrations/github/connect", { method: "POST", body: JSON.stringify(org ? { org } : {}) }),
  /** Keeps Forge's GitHub app unless forgetApp (then connecting again creates a new app). */
  disconnectGitHub: (forgetApp = false) => request<{ ok: true }>(`/integrations/github${forgetApp ? "?forget=app" : ""}`, { method: "DELETE" }),
  setFigmaToken: (token: string) => request<{ ok: true }>("/integrations/figma", { method: "PUT", body: JSON.stringify({ token }) }),
  removeFigmaToken: () => request<{ ok: true }>("/integrations/figma", { method: "DELETE" }),
  aiModels: (provider: AiProvider, apiKey?: string) =>
    request<{ models: AiModel[]; source: "api" | "builtin" }>("/integrations/ai/models", {
      method: "POST",
      body: JSON.stringify(apiKey ? { provider, apiKey } : { provider }),
    }),
  updateAi: (input: UpdateAiSettingsInput) => request<{ ok: true }>("/integrations/ai", { method: "PUT", body: JSON.stringify(input) }),
  removeAiKey: (provider: AiProvider) => request<{ ok: true }>(`/integrations/ai/keys/${provider}`, { method: "DELETE" }),
  team: () => request<{ members: TeamMember[]; invitations: Invitation[] }>("/team"),
  invite: (input: Partial<CreateInvitationInput> & { email: string }) =>
    request<Invitation>("/team/invitations", { method: "POST", body: JSON.stringify(input) }),
  revokeInvitation: (id: string) => request<{ ok: true }>(`/team/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setMemberRole: (userId: string, role: WorkspaceRole) =>
    request<{ ok: true }>(`/team/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeMember: (userId: string) => request<{ ok: true }>(`/team/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  invitation: (token: string) => request<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string) =>
    request<{ ok: true; projectId: string | null }>(`/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" }),
  projectMembers: (id: string) =>
    request<{
      members: ProjectMemberInfo[];
      others: { userId: string; name: string; email: string }[];
      invitations: Invitation[];
      myRole: ProjectRole;
    }>(`/projects/${encodeURIComponent(id)}/members`),
  setProjectMember: (id: string, userId: string, role: ProjectRole) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeProjectMember: (id: string, userId: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  inviteToProject: (id: string, email: string, role: ProjectRole) =>
    request<Invitation | { added: true }>(`/projects/${encodeURIComponent(id)}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  usage: (days = 30) =>
    request<{ totals: { costUsd: number; runs: number; qaRuns: number } }>(`/usage?days=${days}`),
  activity: (limit = 12) => request<ActivityResponse>(`/activity?limit=${limit}`),
  listTemplates: () => request<ProjectTemplate[]>("/templates"),
  createTemplate: (input: { projectId: string; name: string; description?: string }) =>
    request<ProjectTemplate>("/templates", { method: "POST", body: JSON.stringify(input) }),
  deleteTemplate: (id: string) => request<{ ok: true }>(`/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listLibrary: () => request<LibraryComponent[]>("/library"),
  deleteComponent: (id: string) => request<{ ok: true }>(`/library/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listSecrets: (id: string) => request<ProjectSecret[]>(`/projects/${encodeURIComponent(id)}/secrets`),
  setSecret: (id: string, name: string, value: string) =>
    request<ProjectSecret[]>(`/projects/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteSecret: (id: string, name: string) =>
    request<ProjectSecret[]>(`/projects/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  listComments: (id: string) => request<ProjectComment[]>(`/projects/${encodeURIComponent(id)}/comments`),
  createComment: (id: string, input: CreateCommentInput) =>
    request<{ id: string }>(`/projects/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify(input) }),
  updateComment: (id: string, commentId: string, input: { resolved?: boolean; body?: string; selector?: string }) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteComment: (id: string, commentId: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    }),
  updateSettings: (id: string, input: ProjectSettingsInput) =>
    request<Project>(`/projects/${encodeURIComponent(id)}/settings`, { method: "PATCH", body: JSON.stringify(input) }),
  startQa: (id: string, scope: { only?: string; skip?: string; depth?: "quick" | "full" } = {}) =>
    request<{ runId: string }>(`/projects/${encodeURIComponent(id)}/qa`, { method: "POST", body: JSON.stringify(scope) }),
  cancelRun: (id: string) =>
    request<{ cancelled: boolean }>(`/projects/${encodeURIComponent(id)}/runs/cancel`, { method: "POST" }),
  answerPause: (id: string, pauseId: string, answer: AnswerPauseInput) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/pauses/${encodeURIComponent(pauseId)}`, {
      method: "POST",
      body: JSON.stringify(answer),
    }),
  discardChanges: (id: string) =>
    request<{ discarded: number }>(`/projects/${encodeURIComponent(id)}/changes/discard`, { method: "POST" }),
  connections: () => request<ApiConnection[]>("/connections"),
  connection: (id: string) => request<ApiConnectionDetails>(`/connections/${encodeURIComponent(id)}`),
  createConnection: (input: CreateConnectionRequest) =>
    request<ApiConnection>("/connections", { method: "POST", body: JSON.stringify(input) }),
  refreshConnection: (id: string) =>
    request<ApiConnection>(`/connections/${encodeURIComponent(id)}/refresh`, { method: "POST" }),
  deleteConnection: (id: string) =>
    request<{ ok: true }>(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updateConnection: (id: string, input: UpdateConnectionInput) =>
    request<ApiConnection>(`/connections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  testConnection: (id: string) =>
    request<{ ok: boolean; status: number | null; message: string; at: string }>(`/connections/${encodeURIComponent(id)}/test`, { method: "POST" }),
  projectConnections: (id: string) =>
    request<{ connectionIds: string[] }>(`/projects/${encodeURIComponent(id)}/connections`),
  setProjectConnections: (id: string, connectionIds: string[]) =>
    request<{ connectionIds: string[] }>(`/projects/${encodeURIComponent(id)}/connections`, {
      method: "PUT",
      body: JSON.stringify({ connectionIds }),
    }),
  brain: (projectId?: string) =>
    request<BrainDoc[]>(`/brain${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createBrainDoc: (input: BrainDocInput) => request<BrainDoc>("/brain", { method: "POST", body: JSON.stringify(input) }),
  updateBrainDoc: (id: string, input: Omit<BrainDocInput, "projectId">) =>
    request<BrainDoc>(`/brain/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteBrainDoc: (id: string) => request<{ ok: true }>(`/brain/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addStarterBrain: () => request<BrainDoc[]>("/brain/starter", { method: "POST" }),
  versions: (id: string) => request<Version[]>(`/projects/${encodeURIComponent(id)}/versions`),
  restoreVersion: (id: string, sha: string) =>
    request<{ sha: string; changed: boolean }>(
      `/projects/${encodeURIComponent(id)}/versions/${encodeURIComponent(sha)}/restore`,
      { method: "POST" },
    ),
  /** `from` may be "<sha>^": the version before it. */
  compareVersions: (id: string, from: string, to: string) =>
    request<VersionCompare>(`/projects/${encodeURIComponent(id)}/versions/compare?${new URLSearchParams({ from, to })}`),
  fileDiff: (id: string, from: string, to: string, path: string) =>
    request<{ diff: string; truncated: boolean }>(`/projects/${encodeURIComponent(id)}/versions/diff?${new URLSearchParams({ from, to, path })}`),
  startComparePreview: (id: string, sha: string) =>
    request<{ sha: string; url: string }>(`/projects/${encodeURIComponent(id)}/compare/preview`, { method: "POST", body: JSON.stringify({ sha }) }),
  stopComparePreview: (id: string) => request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/compare/preview`, { method: "DELETE" }),
  branches: (id: string) => request<BranchesResponse>(`/projects/${encodeURIComponent(id)}/branches`),
  createBranch: (id: string, name: string, from: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/branches`, { method: "POST", body: JSON.stringify({ name, from }) }),
  switchBranch: (id: string, name: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}/switch`, { method: "POST" }),
  useBranch: (id: string, name: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}/use`, { method: "POST" }),
  problems: (id: string) => request<AppProblem[]>(`/projects/${encodeURIComponent(id)}/problems`),
  fixProblems: (id: string, ids: string[] | "all") =>
    request<{ runId: string; count: number }>(`/projects/${encodeURIComponent(id)}/problems/fix`, { method: "POST", body: JSON.stringify({ ids }) }),
  setProblemStatus: (id: string, problemId: string, status: "open" | "ignored") =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/problems/${encodeURIComponent(problemId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  clearSettledProblems: (id: string) => request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/problems/settled`, { method: "DELETE" }),
  tests: (id: string) => request<SavedTest[]>(`/projects/${encodeURIComponent(id)}/tests`),
  saveTest: (id: string, input: SaveTestInput) =>
    request<SavedTest>(`/projects/${encodeURIComponent(id)}/tests`, { method: "POST", body: JSON.stringify(input) }),
  deleteTest: (id: string, testId: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/tests/${encodeURIComponent(testId)}`, { method: "DELETE" }),
  runTests: (id: string, ids?: string[]) =>
    request<{ results: (TestRunResult & { testId: string; title: string })[] }>(`/projects/${encodeURIComponent(id)}/tests/run`, {
      method: "POST",
      body: JSON.stringify(ids ? { ids } : {}),
    }),
  draftTest: (id: string, description: string) =>
    request<{ runId: string }>(`/projects/${encodeURIComponent(id)}/tests/draft`, { method: "POST", body: JSON.stringify({ description }) }),
  security: (id: string) => request<SecurityReport | null>(`/projects/${encodeURIComponent(id)}/security`),
  scanSecurity: (id: string) => request<SecurityReport>(`/projects/${encodeURIComponent(id)}/security/scan`, { method: "POST" }),
  fixSecurity: (id: string, ids: string[] | "all") =>
    request<{ runId: string }>(`/projects/${encodeURIComponent(id)}/security/fix`, { method: "POST", body: JSON.stringify({ ids }) }),
  spec: (id: string) => request<ProjectSpec>(`/projects/${encodeURIComponent(id)}/spec`),
  setSpecSummary: (id: string, summary: string) =>
    request<ProjectSpec>(`/projects/${encodeURIComponent(id)}/spec`, { method: "PATCH", body: JSON.stringify({ summary }) }),
  addCriterion: (id: string, input: { area: string; text: string }) =>
    request<ProjectSpec>(`/projects/${encodeURIComponent(id)}/spec/criteria`, { method: "POST", body: JSON.stringify(input) }),
  updateCriterion: (id: string, cid: string, input: { area?: string; text?: string; testId?: string | null }) =>
    request<ProjectSpec>(`/projects/${encodeURIComponent(id)}/spec/criteria/${encodeURIComponent(cid)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteCriterion: (id: string, cid: string) =>
    request<ProjectSpec>(`/projects/${encodeURIComponent(id)}/spec/criteria/${encodeURIComponent(cid)}`, { method: "DELETE" }),
  /** The QA agent writes tests for criteria without one (all, or the given ids). */
  coverSpec: (id: string, ids?: string[]) =>
    request<{ runId: string; count: number }>(`/projects/${encodeURIComponent(id)}/spec/cover`, { method: "POST", body: JSON.stringify(ids ? { ids } : {}) }),
  draftSpec: (id: string) => request<{ runId: string }>(`/projects/${encodeURIComponent(id)}/spec/draft`, { method: "POST" }),
  reviews: (id: string) => request<VersionReviewSummary[]>(`/projects/${encodeURIComponent(id)}/reviews`),
  review: (id: string, sha: string) => request<VersionReview>(`/projects/${encodeURIComponent(id)}/reviews/${encodeURIComponent(sha)}`),
  latestReview: (id: string) => request<VersionReview | null>(`/projects/${encodeURIComponent(id)}/reviews/latest`),
  checkReview: (id: string) => request<VersionReview>(`/projects/${encodeURIComponent(id)}/reviews/check`, { method: "POST" }),
  reviewImageUrl: (id: string, sha: string, name: string) =>
    `/api/projects/${encodeURIComponent(id)}/reviews/${encodeURIComponent(sha)}/image/${encodeURIComponent(name)}`,
  fixA11y: (id: string, ids: string[] | "all") =>
    request<{ runId: string }>(`/projects/${encodeURIComponent(id)}/a11y/fix`, { method: "POST", body: JSON.stringify({ ids }) }),
  gitHub: (id: string) => request<GitHubStatus>(`/projects/${encodeURIComponent(id)}/github`),
  pushToGitHub: (id: string, input: { name?: string; override?: boolean }) =>
    request<{ url: string; repo: string; created: boolean; commits: number; pullRequest?: boolean }>(
      `/projects/${encodeURIComponent(id)}/github/push`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  gitHubIncoming: (id: string) => request<GitHubIncoming>(`/projects/${encodeURIComponent(id)}/github/incoming`),
  pullFromGitHub: (id: string) =>
    request<{ runId: string; commits: number; conflicts: string[] }>(`/projects/${encodeURIComponent(id)}/github/pull`, { method: "POST" }),
  gitHubFeedback: (id: string) => request<PrFeedback>(`/projects/${encodeURIComponent(id)}/github/feedback`),
  addressGitHubFeedback: (id: string, input: { ids: string[]; checks?: boolean }) =>
    request<{ runId: string; points: number }>(`/projects/${encodeURIComponent(id)}/github/feedback/address`, { method: "POST", body: JSON.stringify(input) }),
  importFigma: (id: string, url: string) =>
    request<{ attachments: { path: string; name: string; type: string }[] }>(`/projects/${encodeURIComponent(id)}/figma`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  deleteBranch: (id: string, name: string) =>
    request<{ ok: true }>(`/projects/${encodeURIComponent(id)}/branches/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
