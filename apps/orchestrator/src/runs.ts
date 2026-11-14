import type { CheckName, CheckOutcome, QaIssue, RunMode } from "@forge/protocol";
import { cleanRunError, TestInput } from "@forge/protocol";
import { replayTests, runSavedTests } from "./tests.ts";
import { scanProject } from "./security.ts";
import { dataSourcesPrompt } from "./datasources.ts";
import { settleFixRun } from "./problems.ts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { brainPrompt } from "./brain.ts";
import { redactor, secretsPrompt } from "./secrets.ts";
import { forgetRunCost, issueModelToken, takeRunCost } from "./model-proxy.ts";
import { aiForRun, chatOnlyModel } from "./ai.ts";
import { hasQueued, runNext } from "./queue.ts";
import { structureIssues, structurePrompt } from "./structure.ts";
import { checkComponent, type ComponentInput, libraryPrompt, libraryReminder, saveComponent, syncLibrary } from "./library.ts";
import { db, schema } from "./db/index.ts";
import { env } from "./env.ts";
import { appendEvent, publish } from "./events.ts";
import { ensureDevServer, ensureSandbox, exec, execLines, waitPrepared } from "./sandbox.ts";

/*
 * One agent run at a time per project. A run is a loop:
 *   agent turn → Forge's checks → (fix turn → checks)… → commit only when green.
 * The agent runner and the checks both execute inside the project's sandbox.
 */

const APPEND_SYSTEM_PROMPT = `You are the build agent in Forge, our team's internal app builder.
The user watches a live preview of this Next.js app while you work, and sees your tool calls as a progress feed.
Follow the rules in AGENTS.md. The dev server is already running; never start it yourself.
Data comes from our in-house APIs: if .forge/apis/README.md exists, read it before building anything that shows or changes data, and use only the endpoints it lists.
Files the user attaches are in .forge/uploads/ (outside git). Open each one with the Read tool before acting on it; for Word, Excel and PowerPoint files read the .md text copy next to the original. Treat them as the user's material: requirements, content, data, designs. When an attached image or document should appear in the app (a logo, photo, downloadable PDF), copy the original into public/ with a short clean name and reference it from there; app code must never point at .forge/uploads.

Talking to the user:
- If a request is ambiguous in ways that change what you build, call mcp__forge__ask_user once with up to 4 multiple-choice questions before building. Do not ask about things you can reasonably decide yourself.
- Before building a new app or making a large change (new pages, data model, auth), call mcp__forge__present_plan and wait for approval. Skip it for small edits.
- Never write a plan or checklist as a chat message and ask "let me know if you want me to proceed": put it in mcp__forge__present_plan (a short summary and concrete steps, nice-to-haves marked optional) so the user can tick, edit and approve it.
- Once the user approves a plan, implement every approved step in this same turn, one after another, until all are done. Don't stop between steps or phases to ask "shall I continue?" or for permission: approval covers the whole plan. Only ask (mcp__forge__ask_user) if you're truly blocked on information only the user has.

Building exactly what was asked:
1. Before writing code, turn the request into a checklist with TodoWrite: every page, section, component, field, text, colour, behaviour and state the user mentioned or attached. That checklist is the definition of done.
2. Follow the request literally where it is specific: use the user's exact wording for texts and labels, their colours, fonts, order and layout, and the content of attached files. Where it is open, make the choice an experienced product designer would and keep it consistent.
3. Don't add what wasn't asked for (extra sections, features, pages, fake testimonials, marketing copy). Don't remove or restyle things the user didn't mention. A change request changes only what it names.
4. When a missing detail would change the result in a way the user would care about, ask (mcp__forge__ask_user) instead of guessing; otherwise decide, and mention the decision at the end.

Design quality (every screen):
- A clear hierarchy: one main heading, obvious primary action, related things grouped, consistent spacing on a 4/8px scale, aligned edges.
- Readable: body text 14-16px, enough contrast (WCAG AA), no walls of text, realistic sample content instead of lorem ipsum.
- Complete: empty, loading and error states for anything that loads or saves; hover, focus and disabled states for controls.
- Responsive: it must work at phone width (390px) without horizontal scrolling, and use the space well on desktop.
- Consistent: reuse the project's existing components, tokens and the team library before creating new ones; use lucide-react icons.

Code structure (write it like a senior engineer on this team would):
- Follow the project's existing structure, naming and patterns first. When there is none, use: src/app for routes (pages and layouts compose; they don't hold big chunks of UI or logic), src/components for reusable UI (src/components/ui for small primitives like Button, Card, Badge), src/lib for data access, API calls, formatting and business logic, src/hooks for client hooks, src/types (or a types.ts next to the code) for shared types.
- Make a reusable component when the same UI appears twice or more (cards, list rows, badges, empty states, form fields), when a piece of a file has its own clear job, or when a file grows past ~200 lines. Give it typed props and a name that says what it is (CourseCard, not Card2); don't copy-paste markup with small variations: parameterise it.
- Separation of concerns: components render and handle UI state; fetching, mapping API data, validation and calculations live in src/lib (or a hook), never inline in JSX. Server Components fetch data; client components stay small and only where interactivity needs them. Constants and sample data go in their own module, not inside components.
- Don't over-abstract: no wrapper components or helpers used once, no generic "utils" dumping ground, no premature configuration. One component per file for anything reused; small private helpers may stay in the file that uses them.
- Before finishing, re-read what you changed: extract anything repeated, split anything doing too much, and remove dead code. Forge also reviews the changed files for long files, repeated blocks and pages that load data inline, and will ask you to tidy them.

Check your work like the user will:
- After building or changing anything visible, call mcp__forge__look_at_page for each page you touched (desktop and phone). Compare the screenshots with the checklist and any attached design: layout, spacing, texts, colours, sizes, states. Fix every mismatch and look again; at most two rounds.
- Also fix browser errors that look_at_page reports.
- Run \`pnpm typecheck\` and \`pnpm lint\` and fix what they report.

After you finish, Forge runs its own checks (install, typecheck, lint, tests, and loading every page in a browser) and saves a version only if they pass.
End with a short message for a non-technical teammate: what changed and what to try in the preview, then the checklist with each item marked done, and plainly anything you could not do or decided yourself.`;

/** Fix rounds after the first check failure before giving up and leaving changes unsaved. */
const MAX_FIX_ROUNDS = 2;
const PAUSE_ID = /^[a-z0-9]{8,32}$/;

type Active = {
  runId: string;
  cancelled: boolean;
  cancel: () => Promise<void>;
  pendingPause?: { id: string; kind: string };
  /** The user approved a plan in this run: the agent should build all of it without asking again. */
  planApproved?: boolean;
  /** Autonomous run: no plan approval or questions; Forge says "continue" whenever the agent stops to ask. */
  autonomous?: boolean;
};

/** How many times Forge says "continue" for the agent when it stops mid-plan to ask permission. */
const MAX_PLAN_CONTINUES = 6;
const CONTINUE_PLAN_PROMPT =
  "Yes, continue. The user already approved the whole plan: implement every remaining approved step now, one after another, " +
  "without asking for permission between steps or phases. Only stop to ask if you are truly blocked (missing information only the user has). " +
  "When everything is done, give a short summary of what you built.";

/**
 * Whether the agent ended its turn asking to go on ("Shall I continue with phase 2?", "Let me
 * know if you want me to proceed"), judged from the end of its final message.
 */
export function asksToContinue(text: string | undefined): boolean {
  if (!text) return false;
  const tail = text.slice(-600);
  return (
    /\b(shall|should|would you like|do you want|want me to|ready (?:for|to)|let me know|ok(?:ay)? (?:to|if)|go ahead|confirm)\b[^.!]{0,160}\b(continue|proceed|next|phase|step|move on|start|implement|build|carry on)\b/i.test(tail) ||
    /\b(continue|proceed|next phase|next step|move on)\b[^.!?]{0,80}\?\s*$/i.test(tail.trim())
  );
}
const active = new Map<string, Active>();

/** Whether the agent is working on this project (a build, chat or QA run). */
export const isRunning = (projectId: string) => active.has(projectId);

export const activeRunId = (projectId: string) => active.get(projectId)?.runId ?? null;

export class RunConflictError extends Error {}
export class PauseError extends Error {}

type RunnerLine =
  | { kind: "session"; sessionId: string }
  | { kind: "delta"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; toolUseId: string; tool: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; ok: boolean; output: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }
  | { kind: "pause"; pauseId: string; pauseKind: "question" | "plan"; payload: unknown }
  | { kind: "qa_issue"; issue: QaIssue }
  | { kind: "qa_test"; test: unknown }
  | { kind: "qa_frame"; data: string }
  | { kind: "library_save"; component: ComponentInput }
  | { kind: "done"; status: "completed" | "failed" | "cancelled"; result?: string; error?: string };

type TurnStatus = "completed" | "failed" | "cancelled";

/** Design mode: turn an attached design (screenshot or Figma frame + spec) into working UI. */
const DESIGN_MODE_PROMPT = `Design mode: the user attached a design (a screenshot, or a Figma frame with a .md spec). Build it as working UI in this app.
- Open every attached file with the Read tool first. A Figma spec gives exact sizes, gaps, padding, colours, fonts and texts: use those values instead of guessing from the image.
- Match the design closely: layout, spacing, sizes, colours, typography, corner radii, and the exact texts.
- Use the team's component library and design rules (see the team brain) wherever a component fits, instead of new one-off markup. Map the design's colours and fonts to the existing theme tokens when they're close; add new tokens only when nothing matches.
- Icons: lucide-react, picking the closest match to the design's icon.
- Make it responsive (it must work on a phone too) and accessible (real buttons and links, labels, alt text, contrast).
- Wire up the obvious interactions (navigation, buttons, forms) with sensible behaviour; don't leave dead controls.
- Then call mcp__forge__look_at_page (desktop and phone) and compare the result with the attached image side by side: layout, spacing, sizes, colours, fonts and texts. Fix differences and look again (at most two rounds).
- At the end, list anything you couldn't match exactly and why.`;

/** Autonomous projects: build the whole request without stopping for approval or questions. */
const AUTONOMOUS_PROMPT = `## Autonomous mode
The user turned on Autonomous for this project: build the whole request from start to finish in this turn. Don't present a plan for approval and don't ask questions or permission (those tools are off); when something is unclear, choose the most sensible option and keep going. Work through every part of the request without stopping between phases. At the end, list the assumptions you made so the user can adjust them.`;

/** Chat mode: the same agent session, but this turn only reads and answers. */
const CHAT_MODE_PROMPT = `## Chat mode (this message only)
The user is asking or exploring, not requesting a change. Answer from the project's files (Read, Glob, Grep) and the web if useful. You cannot edit files or run commands in this mode. If they'd like a change, describe it briefly and tell them to switch to Build mode to make it.`;

/** Short human-readable label for a tool call. */
function summarize(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tool) {
    case "Bash":
      return str(i.description) || str(i.command).slice(0, 120);
    case "Read":
    case "Write":
    case "Edit": {
      const path = str(i.file_path).replace(/^\/workspace\//, "");
      // Attachments: the name the user gave the file, not where Forge keeps it.
      const upload = /^\.forge\/uploads\/[a-z0-9]+-(.+)$/.exec(path);
      return upload ? `attachment · ${upload[1]}` : path;
    }
    case "Glob":
    case "Grep":
      return str(i.pattern);
    case "WebFetch":
      return str(i.url);
    case "WebSearch":
      return str(i.query);
    case "mcp__browser__open":
      return `Open ${str(i.path)}`;
    case "mcp__browser__click":
    case "mcp__browser__fill": {
      const what = str(i.name) || str(i.label) || str(i.text) || str(i.selector) || str(i.role);
      return tool.endsWith("click") ? `Click “${what}”` : `Type “${str(i.value).slice(0, 40)}” into “${what}”`;
    }
    case "mcp__browser__press":
      return `Press ${str(i.key)}`;
    case "mcp__browser__report_issue":
      return `${str(i.severity)}: ${str(i.title)}`;
    case "mcp__forge__look_at_page":
      return `${str(i.path) || "/"}${Array.isArray(i.viewports) ? ` · ${(i.viewports as string[]).join(" and ")}` : " · desktop and phone"}`;
    case "mcp__browser__propose_test":
      return `Test: ${str(i.title)}`;
    default:
      return "";
  }
}

/** The model picked for each running run ("provider:model"), read by every turn of it. */
const runModel = new Map<string, string | null>();

export async function startRun(
  projectId: string,
  prompt: string,
  user: { id: string; name: string },
  mode: RunMode = "build",
  /** "provider:model" from the prompt box; undefined: the project's last choice. */
  model?: string | null,
) {
  if (active.has(projectId)) throw new RunConflictError("A run is already in progress for this project.");
  const runId = nanoid(10);
  const entry: Active = { runId, cancelled: false, cancel: async () => {} };
  // Reserve the slot before any await so concurrent requests cannot both start.
  active.set(projectId, entry);
  entry.cancel = async () => {
    entry.cancelled = true;
    await exec(projectId, [
      "sh",
      "-c",
      'pkill -TERM -f "[/]opt/forge/runner/runner.mjs"; pkill -TERM -f "[/]opt/forge/checks/checks.mjs"; true',
    ]).catch(() => undefined);
  };

  try {
    // A pick in the prompt box becomes the project's choice; otherwise use its last one.
    if (model !== undefined) await db.update(schema.project).set({ lastModel: model }).where(eq(schema.project.id, projectId));
    const [proj] = model === undefined ? await db.select({ lastModel: schema.project.lastModel }).from(schema.project).where(eq(schema.project.id, projectId)) : [];
    let choice = model !== undefined ? model : (proj?.lastModel ?? null);
    // A chat-only model can't build: anything but Chat uses the default then.
    if (mode !== "chat" && (await chatOnlyModel(choice))) choice = null;
    runModel.set(runId, choice);
    // Autonomous projects build without stopping to ask (Plan mode still asks; Chat doesn't build).
    const [flags] = await db.select({ autonomous: schema.project.autonomous }).from(schema.project).where(eq(schema.project.id, projectId));
    entry.autonomous = Boolean(flags?.autonomous) && mode !== "plan" && mode !== "chat";
    const ai = await aiForRun(choice).catch(() => null);
    await appendEvent({
      type: "run.started",
      projectId,
      runId,
      prompt,
      model: ai?.model ?? choice ?? "",
      ...(ai ? { modelLabel: ai.label, provider: ai.provider } : {}),
      userId: user.id,
      userName: user.name,
      ...(mode !== "build" ? { mode } : {}),
    });
    await db.update(schema.project).set({ status: "running" }).where(eq(schema.project.id, projectId));
  } catch (err) {
    active.delete(projectId);
    runModel.delete(runId);
    throw err;
  }

  void execute(projectId, runId, prompt, entry, mode)
    .catch(() => false)
    .then(async (committed) => {
      active.delete(projectId);
      runModel.delete(runId);
      forgetRunCost(runId);
      void settleFixRun(projectId, runId, committed).catch((e) => console.error("could not settle fixed problems", e));
      // Messages sent while it worked come next (not after Stop: people may want to rethink).
      const queued = !entry.cancelled && (await hasQueued(projectId).catch(() => false));
      if (queued) void runNext(projectId).catch((e) => console.error("queued message did not start", e));
      // A new version: security scan and saved tests (no AI), then the optional AI auto-test
      // (skipped when a queued message is up next; the next version will be tested).
      if (committed) {
        void scanProject(projectId).catch((e) => console.error("security scan did not run", e));
        void runSavedTests(projectId, "version")
          .catch((e) => console.error("saved tests did not run", e))
          .then(() => (queued ? undefined : maybeAutoQa(projectId, prompt)))
          .catch((e) => console.error("auto QA did not start", e));
      }
    });
  return runId;
}

/** Runs the build loop. Resolves true when a new version was saved. */
async function execute(projectId: string, runId: string, prompt: string, entry: Active, mode: RunMode = "build"): Promise<boolean> {
  let committed = false;
  let status: TurnStatus = "failed";
  let error: string | undefined;
  let unsaved = false;

  try {
    await ensureSandbox(projectId);
    await waitPrepared(projectId); // imported repos: dependencies installed, baseline recorded

    // If the files changed under the agent since its last turn (restore or
    // discard), tell it so it re-reads instead of trusting its memory.
    const note = await staleFilesNote(projectId, runId);
    const modePrefix =
      mode === "plan"
        ? "Plan mode: before changing anything, work out a detailed spec for this request (what the user gets, pages and components, data and API calls, edge cases, how you'll check it) and call mcp__forge__present_plan with it as a summary and concrete steps (one change per step, nice-to-haves marked optional). Build only after the user approves it.\n\n"
        : mode === "design"
          ? DESIGN_MODE_PROMPT + "\n\n"
          : "";
    let turnPrompt = (note ? `${note}\n\n` : "") + modePrefix + prompt;

    // Chat mode: one read-only turn; nothing to check or save.
    if (mode === "chat") {
      const turn = await agentTurn(projectId, runId, turnPrompt, undefined, { readOnly: true });
      status = turn.status;
      error = turn.error;
    }

    let continues = 0;
    let structureReviewed = false;
    for (let round = 0; mode !== "chat"; round++) {
      const turn = await agentTurn(projectId, runId, turnPrompt, undefined, { autonomous: entry.autonomous });
      status = turn.status;
      error = turn.error;
      if (status !== "completed" || entry.cancelled) break;
      // After an approved plan the agent should build all of it. If it stops to ask permission for
      // the next phase, answer for the user and keep going (this isn't a fix round).
      if ((entry.planApproved || entry.autonomous) && continues < MAX_PLAN_CONTINUES && asksToContinue(turn.result)) {
        continues++;
        await appendEvent({ type: "notice", projectId, runId, text: entry.autonomous ? "Autonomous: continuing without asking…" : "Continuing with the approved plan…" });
        turnPrompt = CONTINUE_PLAN_PROMPT;
        round--;
        continue;
      }
      if (!(await hasChanges(projectId))) break; // nothing to check or save

      // Once per run: review the changed files' structure (long files, repeated blocks, pages that
      // load data inline) and give the agent one round to tidy them before the checks.
      if (!structureReviewed) {
        structureReviewed = true;
        const issues = await structureIssues(projectId).catch(() => []);
        if (issues.length && !entry.cancelled) {
          await appendEvent({ type: "notice", projectId, runId, text: `Tidying the code structure (${issues.length} thing${issues.length === 1 ? "" : "s"} to improve)…` });
          turnPrompt = structurePrompt(issues);
          round--;
          continue;
        }
      }

      const result = await runChecks(projectId, runId, round + 1);
      if (entry.cancelled) {
        status = "cancelled";
        break;
      }
      if (result.ok) {
        committed = await commitChanges(projectId, runId, prompt);
        break;
      }
      if (round >= MAX_FIX_ROUNDS) {
        status = "failed";
        error = `Forge's checks still fail after ${MAX_FIX_ROUNDS} fix attempts, so this version was not saved.`;
        break;
      }
      turnPrompt = fixPrompt(result.checks);
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }

  if (status === "cancelled" && entry.cancelled) error = undefined;
  unsaved = await hasChanges(projectId).catch(() => false);

  if (error) console.error(`run ${runId} failed:`, error);
  await appendEvent({ type: "run.finished", projectId, runId, status, error: error ? cleanRunError(error) : undefined, unsaved }).catch((e) =>
    console.error("could not record run.finished", e),
  );
  await db
    .update(schema.project)
    .set({ status: status === "failed" ? "error" : "created" })
    .where(eq(schema.project.id, projectId))
    .catch(() => undefined);
  return committed && status === "completed";
}

/** One invocation of the agent runner. Build mode resumes the project's agent session; QA mode starts fresh. */
async function agentTurn(
  projectId: string,
  runId: string,
  prompt: string,
  qa?: { systemPrompt: string; onIssue: (issue: QaIssue) => void; onTest?: (test: unknown) => void },
  opts: { readOnly?: boolean; autonomous?: boolean } = {},
): Promise<{ status: TurnStatus; error?: string; result?: string }> {
  // The AI chosen in Settings › Integrations › AI model, read at the start of every turn.
  let ai: Awaited<ReturnType<typeof aiForRun>>;
  try {
    ai = await aiForRun(runModel.get(runId));
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  let status = "failed" as TurnStatus;
  let error: string | undefined;
  let result: string | undefined;
  let stderrTail = "";

  const [proj] = await db
    .select({ sessionId: schema.project.agentSessionId })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));

  // total_cost_usd from a resumed session includes the session's earlier
  // spend, so subtract the last recorded session total to get this turn's cost.
  // QA turns run in a fresh session, so their total is their own cost; they don't
  // record sessionCostUsd, which keeps them out of the build session's running total.
  let priorSessionCost = 0;
  if (proj?.sessionId && !qa) {
    const [last] = await db
      .select({ payload: schema.projectEvent.payload })
      .from(schema.projectEvent)
      .where(
        and(
          eq(schema.projectEvent.projectId, projectId),
          eq(schema.projectEvent.type, "usage"),
          sql`${schema.projectEvent.payload} ? 'sessionCostUsd'`,
        ),
      )
      .orderBy(desc(schema.projectEvent.seq))
      .limit(1);
    const p = last?.payload as { sessionCostUsd?: number; costUsd?: number } | undefined;
    priorSessionCost = p?.sessionCostUsd ?? p?.costUsd ?? 0;
  }

  // Team brain docs are read fresh every turn, so edits apply to the next turn.
  const brainText = await brainPrompt(projectId);
  const importedText = await importedProjectPrompt(projectId);
  const secretsText = qa ? "" : await secretsPrompt(projectId);
  const dataText = qa ? "" : await dataSourcesPrompt(projectId);
  // The team library is copied into the workspace and listed for the build agent.
  if (!qa) await syncLibrary(projectId).catch((e) => console.error("library sync failed", e));
  const libraryText = qa ? "" : await libraryPrompt();
  const libraryNote = qa ? "" : await libraryReminder();
  const redact = await redactor(projectId);
  const input = qa
    ? { prompt, mode: "qa", model: ai.model, appendSystemPrompt: [qa.systemPrompt, brainText].filter(Boolean).join("\n\n") }
    : {
        prompt: opts.readOnly ? prompt : prompt + libraryNote,
        readOnly: opts.readOnly || undefined,
        autonomous: opts.autonomous || undefined,
        sessionId: proj?.sessionId ?? undefined,
        model: ai.model,
        appendSystemPrompt: [
          APPEND_SYSTEM_PROMPT,
          opts.readOnly ? CHAT_MODE_PROMPT : "",
          opts.autonomous ? AUTONOMOUS_PROMPT : "",
          importedText,
          secretsText,
          dataText,
          libraryText,
          brainText,
        ]
          .filter(Boolean)
          .join("\n\n"),
      };

  // Events from one turn are appended in order; keep the chain so we can await it.
  let chain: Promise<unknown> = Promise.resolve();
  const queue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch((e) => console.error("event append failed", e)));

  const modelAccess = issueModelToken(projectId, runId, ai);
  const exitCode = await execLines(
    projectId,
    ["node", "/opt/forge/runner/runner.mjs"],
    {
      env: [
        `FORGE_INPUT_B64=${Buffer.from(JSON.stringify(input)).toString("base64")}`,
        // A run-scoped token for the model proxy; the real API key never enters the container.
        `ANTHROPIC_API_KEY=${modelAccess.token}`,
        `ANTHROPIC_BASE_URL=${env.MODEL_PROXY_URL_FOR_SANDBOX}`,
        // Small background steps (titles, command checks) use the fast model, when one is set.
        ...(ai.fastModel ? [`ANTHROPIC_SMALL_FAST_MODEL=${ai.fastModel}`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=${ai.fastModel}`] : []),
      ],
    },
    (raw) => {
      let line: RunnerLine;
      try {
        line = JSON.parse(raw);
      } catch {
        return; // ignore non-JSON output
      }
      switch (line.kind) {
        case "session":
          // QA sessions are throwaway; only the build agent's session is resumed later.
          if (qa) break;
          queue(() =>
            db.update(schema.project).set({ agentSessionId: line.sessionId }).where(eq(schema.project.id, projectId)),
          );
          break;
        case "qa_issue":
          qa?.onIssue(line.issue);
          break;
        case "qa_test":
          qa?.onTest?.(line.test);
          break;
        case "library_save": {
          if (qa) break;
          const component = line.component;
          queue(async () => {
            const problem = checkComponent(component);
            if (problem) {
              await appendEvent({ type: "notice", projectId, runId, text: `The component could not be saved to the library: ${problem}.` });
              return;
            }
            const [starter] = await db
              .select({ userName: sql<string>`${schema.projectEvent.payload}->>'userName'` })
              .from(schema.projectEvent)
              .where(and(eq(schema.projectEvent.projectId, projectId), eq(schema.projectEvent.runId, runId), eq(schema.projectEvent.type, "run.started")));
            await saveComponent(component, projectId, starter?.userName ?? "Forge");
            await appendEvent({
              type: "notice",
              projectId,
              runId,
              text: `Saved "${component.title}" to the team component library (${component.files.length} file${component.files.length === 1 ? "" : "s"}). Every project can now reuse it.`,
            });
          });
          break;
        }
        case "qa_frame":
          publish(projectId, { type: "qa_frame", projectId, runId, data: line.data });
          break;
        case "delta":
          publish(projectId, { type: "delta", projectId, runId, text: redact(line.text) });
          break;
        case "assistant":
          // Provider errors the agent echoes as a message are shown on the failure line instead.
          if (/^\s*API Error:/i.test(line.text)) break;
          queue(() => appendEvent({ type: "assistant.message", projectId, runId, text: redact(line.text) }));
          break;
        case "tool_call":
          queue(() =>
            appendEvent({
              type: "tool.call",
              projectId,
              runId,
              toolUseId: line.toolUseId,
              tool: line.tool,
              summary: redact(summarize(line.tool, line.input)),
              input: JSON.parse(redact(JSON.stringify(line.input ?? null))),
            }),
          );
          break;
        case "tool_result":
          queue(() =>
            appendEvent({ type: "tool.result", projectId, runId, toolUseId: line.toolUseId, ok: line.ok, output: redact(line.output) }),
          );
          break;
        case "usage":
          queue(() =>
            appendEvent({
              type: "usage",
              projectId,
              runId,
              inputTokens: line.inputTokens,
              outputTokens: line.outputTokens,
              cacheReadTokens: line.cacheReadTokens,
              // ChatGPT runs: the real cost Forge's model proxy priced per request. The agent's own
              // figure assumes Claude prices (it's still kept as sessionCostUsd for later Claude turns).
              ...(() => {
                if (ai.provider !== "openai") return { costUsd: Math.max(0, line.costUsd - priorSessionCost) };
                const c = takeRunCost(runId);
                return { costUsd: c?.usd ?? 0, pricedBy: "forge" as const, ...(c?.unpriced ? { costEstimated: true } : {}) };
              })(),
              ...(qa ? {} : { sessionCostUsd: line.costUsd }),
            }),
          );
          break;
        case "pause":
          if (!PAUSE_ID.test(line.pauseId)) break;
          {
            const a = active.get(projectId);
            if (a) a.pendingPause = { id: line.pauseId, kind: line.pauseKind };
          }
          queue(() =>
            appendEvent({ type: "pause", projectId, runId, kind: line.pauseKind, pauseId: line.pauseId, payload: line.payload }),
          );
          break;
        case "done":
          status = line.status;
          error = line.error;
          result = line.result;
          break;
      }
    },
    (text) => {
      stderrTail = (stderrTail + text).slice(-2000);
    },
  ).finally(() => modelAccess.revoke());
  await chain;
  if (exitCode !== 0 && status === "completed") status = "failed";
  if (status === "failed" && !error) error = stderrTail.trim() || `Runner exited with code ${exitCode}`;
  return { status, error, result };
}

/* ----------------------------------- QA ---------------------------------- */

const QA_SYSTEM_PROMPT = `You are the QA tester in Forge, our team's internal app builder.
You test the running app like a careful teammate would, using the browser tools (mcp__browser__*). You cannot change code.
- Start with mcp__browser__open on "/". Use the accessibility tree to find elements; use screenshots to judge layout and visuals.
- Verify each requested feature end to end, then try realistic edge cases: empty and invalid input, double clicks, reloading, keyboard use, and navigating back and forth.
- Watch the console errors each tool reports.
- Report every real problem with mcp__browser__report_issue (one call per issue, with exact steps). Severity: blocker = a requested feature doesn't work; major = wrong behaviour or confusing UX; minor = cosmetic. Don't report pure style preferences.
- You may read the code (Read, Grep, Glob) to understand intent, but judge the app by what a user sees.
- For each important flow that works, call mcp__browser__propose_test with the exact steps you used and expect steps that check the result (for example: vote twice, then expect the card to contain "Leading"). Forge replays them after every new version, so use stable targets (role + name, labels) and check outcomes, not exact styling. Propose at most 5, and none for flows that are broken.
- Finish with a short plain-language summary for a non-technical teammate: what you tested, what works, and the most important problems.`;

/**
 * Start a QA run. `focus`: the request a new version was saved for (auto-test).
 * `testRequest`: the user described a test to create; the run walks through just that and proposes it.
 */
export async function startQa(projectId: string, user: { id: string; name: string }, focus?: string, testRequest?: string) {
  if (active.has(projectId)) throw new RunConflictError("A run is already in progress for this project.");
  const runId = nanoid(10);
  const entry: Active = { runId, cancelled: false, cancel: async () => {} };
  active.set(projectId, entry);
  entry.cancel = async () => {
    entry.cancelled = true;
    await exec(projectId, ["sh", "-c", 'pkill -TERM -f "[/]opt/forge/runner/runner.mjs"; true']).catch(() => undefined);
  };
  try {
    await appendEvent({
      type: "run.started",
      projectId,
      runId,
      prompt: testRequest
        ? `Create a test: ${testRequest.slice(0, 300)}`
        : focus
          ? `Automatic test after: ${focus.split("\n")[0]!.slice(0, 200)}`
          : "Test the app in a browser and report problems",
      ...(await aiForRun().then(
        (ai) => ({ model: ai.model, modelLabel: ai.label, provider: ai.provider }),
        () => ({ model: "" }),
      )),
      userId: user.id,
      userName: user.name,
      mode: "qa",
    });
  } catch (err) {
    active.delete(projectId);
    throw err;
  }
  void executeQa(projectId, runId, entry, focus, testRequest).finally(() => {
    active.delete(projectId);
    forgetRunCost(runId);
    if (!entry.cancelled) void runNext(projectId).catch((e) => console.error("queued message did not start", e));
  });
  return runId;
}

async function executeQa(projectId: string, runId: string, entry: Active, focus?: string, testRequest?: string) {
  const issues: QaIssue[] = [];
  const proposals: unknown[] = [];
  let status: TurnStatus = "failed";
  let error: string | undefined;
  try {
    await ensureSandbox(projectId);
    await waitPrepared(projectId);
    await ensureDevServer(projectId);

    // The project's recent requests are the acceptance criteria.
    const rows = await db
      .select({ payload: schema.projectEvent.payload })
      .from(schema.projectEvent)
      .where(and(eq(schema.projectEvent.projectId, projectId), eq(schema.projectEvent.type, "run.started")))
      .orderBy(desc(schema.projectEvent.seq))
      .limit(30);
    const requests = rows
      .map((r) => r.payload as { prompt: string; mode?: string })
      .filter((p) => p.mode !== "qa")
      .slice(0, 8)
      .reverse()
      .map((p, i) => `${i + 1}. ${p.prompt.slice(0, 1500)}`);
    const prompt = testRequest
      ? [
          `Create a repeatable test for this, as the team described it:\n${testRequest.slice(0, 2000)}`,
          "Walk through it in the browser first. If it works, call propose_test once with the steps and expect checks. If it doesn't work, report it with report_issue instead. Don't test anything else.",
        ].join("\n\n")
      : [
      "Test this app in the browser.",
      ...(focus
        ? [`A new version was just saved for this request. Test it first and thoroughly, then briefly re-check the main features:\n${focus.slice(0, 2000)}`]
        : []),
      requests.length ? `It was built from these requests (oldest first); check that each works:\n${requests.join("\n")}` : "Explore its main features.",
      "Report each problem with report_issue, then summarize.",
    ].join("\n\n");

    const turn = await agentTurn(projectId, runId, prompt, {
      systemPrompt: QA_SYSTEM_PROMPT,
      onIssue: (i) => issues.push(i),
      onTest: (t) => proposals.length < 8 && proposals.push(t),
    });
    status = entry.cancelled ? "cancelled" : turn.status;
    error = turn.error;
    if (status === "completed") {
      // Replay each proposed test once, so the team only gets offered ones that pass.
      const valid = proposals.flatMap((p) => {
        const r = TestInput.safeParse(p);
        return r.success ? [r.data] : [];
      });
      const results = valid.length ? await replayTests(projectId, valid) : [];
      const tests = valid.map((t, i) => ({ ...t, result: results[i]! }));
      await appendEvent({ type: "qa.report", projectId, runId, summary: turn.result ?? "", issues, ...(tests.length ? { tests } : {}) });
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? err.message : String(err);
  }
  if (error && status !== "cancelled") console.error(`test run ${runId} failed:`, error);
  await appendEvent({ type: "run.finished", projectId, runId, status, error: status === "cancelled" || !error ? undefined : cleanRunError(error), unsaved: false }).catch(
    (e) => console.error("could not record run.finished", e),
  );
}

/** Extra context for repos imported from GitHub (from .forge/project.json). */
async function importedProjectPrompt(projectId: string): Promise<string> {
  const r = await exec(projectId, ["cat", ".forge/project.json"]);
  if (r.exitCode !== 0) return "";
  try {
    const c = JSON.parse(r.stdout) as {
      repo: string;
      branch: string;
      packageManager: string;
      framework: string;
      dev: string;
      baselineFailing: string[];
    };
    return [
      "## This project is an existing GitHub repository",
      `Imported from ${c.repo} (branch ${c.branch}). Your saved versions become a pull request, so keep changes focused and reviewable.`,
      "- The template rules above about Next.js and AGENTS.md only apply if this repo uses them; follow the repo's own README, conventions and any CLAUDE.md/AGENTS.md.",
      `- Package manager: ${c.packageManager}. Framework: ${c.framework}. The dev server is already running (\`${c.dev}\`); never start it yourself.`,
      c.baselineFailing.length
        ? `- These checks already failed before your changes: ${c.baselineFailing.join(", ")}. Don't fix unrelated pre-existing failures unless asked, and don't make them worse.`
        : "- All checks passed when the repo was imported; keep it that way.",
      "- Never commit or push yourself, never change git remotes, and leave the .forge/ folder alone.",
    ].join("\n");
  } catch {
    return "";
  }
}

/* --------------------------------- checks -------------------------------- */

type CheckResult = { ok: boolean; checks: Partial<Record<CheckName, CheckOutcome>> };

async function runChecks(projectId: string, runId: string, attempt: number): Promise<CheckResult> {
  await appendEvent({ type: "check.started", projectId, runId, attempt });
  await ensureDevServer(projectId); // the smoke test needs it
  let result: CheckResult = { ok: false, checks: {} };
  let lastLine = "";
  let stderr = "";
  const exitCode = await execLines(
    projectId,
    ["node", "/opt/forge/checks/checks.mjs"],
    {},
    (line) => {
      if (line.trim().startsWith("{")) lastLine = line;
    },
    (t) => (stderr = (stderr + t).slice(-2000)),
  );
  try {
    result = JSON.parse(lastLine) as CheckResult;
  } catch {
    result = {
      ok: false,
      checks: { e2e: { ok: false, output: `The check runner failed (exit ${exitCode}). ${stderr.trim()}`.trim() } },
    };
  }
  await appendEvent({ type: "check.result", projectId, runId, attempt, ok: result.ok, checks: result.checks });
  return result;
}

function fixPrompt(checks: CheckResult["checks"]): string {
  const failed = Object.entries(checks).filter(([, c]) => c && !c.ok);
  return [
    "Forge ran its checks on your changes and some failed, so nothing has been saved yet.",
    "Fix the causes, then finish with a short summary. Do not disable, skip or delete checks, lint rules or tests to make them pass.",
    "",
    ...failed.map(([name, c]) => `## ${name}\n\`\`\`\n${c!.output}\n\`\`\``),
  ].join("\n");
}

/* ------------------------------- git helpers ------------------------------ */

async function hasChanges(projectId: string): Promise<boolean> {
  const r = await exec(projectId, ["git", "status", "--porcelain"]);
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

export async function listChanges(projectId: string): Promise<string[]> {
  await ensureSandbox(projectId);
  const r = await exec(projectId, ["git", "status", "--porcelain"]);
  return r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** Commit what the agent changed (only called when the checks pass). */
async function commitChanges(projectId: string, runId: string, prompt: string) {
  const message = prompt.split("\n")[0]!.slice(0, 72) || "Agent changes";
  const r = await exec(projectId, [
    "sh",
    "-c",
    'git add -A && if git diff --cached --quiet; then echo NOCHANGE; else git commit -q -m "$1" && git rev-parse HEAD; fi',
    "sh",
    message,
  ]);
  const out = r.stdout.trim();
  if (r.exitCode === 0 && out && out !== "NOCHANGE") {
    await appendEvent({ type: "commit", projectId, runId, sha: out.split("\n").pop()!, message });
    return true;
  }
  return false;
}

/** Throw away uncommitted changes (e.g. after checks kept failing). Ignored files such as node_modules stay. */
export async function discardChanges(projectId: string, user: { name: string }) {
  if (active.has(projectId)) throw new RunConflictError("Wait for the agent to finish before discarding changes.");
  await ensureSandbox(projectId);
  const files = await listChanges(projectId);
  if (files.length === 0) return { discarded: 0 };
  const r = await exec(projectId, [
    "sh",
    "-c",
    "git reset -q --hard HEAD && git clean -fdq && pnpm install --frozen-lockfile --prefer-offline >/tmp/discard-install.log 2>&1",
  ]);
  if (r.exitCode !== 0) throw new Error(`Discard failed: ${r.stderr || r.stdout}`);
  await appendEvent({ type: "changes.discarded", projectId, runId: `discard-${nanoid(8)}`, files, userName: user.name });
  return { discarded: files.length };
}

/* --------------------------------- pauses -------------------------------- */

/** Deliver the user's answer to a waiting ask_user / present_plan tool call. */
export async function answerPause(projectId: string, pauseId: string, answer: unknown, user: { name: string }) {
  const a = active.get(projectId);
  if (!a?.pendingPause || a.pendingPause.id !== pauseId) throw new PauseError("This question is no longer waiting for an answer.");
  if (!PAUSE_ID.test(pauseId)) throw new PauseError("Invalid pause id.");
  const b64 = Buffer.from(JSON.stringify(answer)).toString("base64");
  // Write atomically: the runner polls for the final file name.
  const r = await exec(projectId, [
    "sh",
    "-c",
    'mkdir -p /tmp/forge-answers && printf %s "$1" | base64 -d > "/tmp/forge-answers/$2.json.tmp" && mv "/tmp/forge-answers/$2.json.tmp" "/tmp/forge-answers/$2.json"',
    "sh",
    b64,
    pauseId,
  ]);
  if (r.exitCode !== 0) throw new Error(`Could not deliver the answer: ${r.stderr || r.stdout}`);
  if (a.pendingPause.kind === "plan" && (answer as { decision?: string }).decision === "approve") a.planApproved = true;
  a.pendingPause = undefined;
  await appendEvent({ type: "resume", projectId, runId: a.runId, pauseId, answer: { ...(answer as object), by: user.name } });
}

/** A note for the agent when files changed under it since its last run (restore or discard). */
async function staleFilesNote(projectId: string, currentRunId: string): Promise<string | null> {
  const rows = await db
    .select({ payload: schema.projectEvent.payload })
    .from(schema.projectEvent)
    .where(
      and(
        eq(schema.projectEvent.projectId, projectId),
        inArray(schema.projectEvent.type, ["run.finished", "commit", "changes.discarded", "branch"]),
      ),
    )
    .orderBy(desc(schema.projectEvent.seq))
    .limit(50);
  for (const { payload } of rows) {
    const e = payload as { type: string; runId: string; restoredFrom?: string; action?: string; branch?: string };
    if (e.runId === currentRunId) continue;
    if (e.type === "run.finished") return null; // nothing changed since the last run
    if (e.type === "commit" && e.restoredFrom) {
      return `(Note from Forge: since your last turn the user restored the app to an earlier version, ${e.restoredFrom.slice(0, 7)}. Files may differ from what you remember; re-read them before editing.)`;
    }
    if (e.type === "branch" && (e.action === "created" || e.action === "switched" || e.action === "used")) {
      return e.action === "used"
        ? `(Note from Forge: since your last turn the user brought the idea "${e.branch}" into the main line and switched to it. Files may differ from what you remember; re-read them before editing.)`
        : `(Note from Forge: since your last turn the user switched the workspace to the line "${e.branch}"${e.action === "created" ? ", a new idea started from an older version" : ""}. Files may differ from what you remember; re-read them before editing.)`;
    }
    if (e.type === "changes.discarded") {
      return "(Note from Forge: since your last turn the user discarded your unsaved changes, so the app is back to the last saved version. Re-read files before editing.)";
    }
  }
  return null;
}

export async function cancelRun(projectId: string) {
  const a = active.get(projectId);
  if (!a) return false;
  await a.cancel();
  return true;
}

/* -------------------------------- auto QA -------------------------------- */

/** After a saved version: start an automatic QA run if the project wants one and today's budget allows. */
async function maybeAutoQa(projectId: string, latestPrompt: string) {
  const [p] = await db
    .select({ autoQa: schema.project.autoQa, budget: schema.project.autoQaDailyBudgetCents })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  if (!p?.autoQa || active.has(projectId)) return;

  const [spent] = await qaCentsToday<{ cents: number }>(projectId);
  if ((spent?.cents ?? 0) >= p.budget) {
    await appendEvent({
      type: "notice",
      projectId,
      runId: `autoqa-${nanoid(8)}`,
      text: `Automatic test skipped: today's QA budget for this project ($${(p.budget / 100).toFixed(2)}) is used up. Use "Test the app" to run one anyway.`,
    });
    return;
  }
  await startQa(projectId, { id: "forge", name: "Forge (auto-test)" }, latestPrompt);
}

/** Cents spent today (UTC) on QA runs in a project. */
async function qaCentsToday<T>(projectId: string): Promise<T[]> {
  const rows = await db.execute(sql`
    select coalesce(round(sum((u.payload->>'costUsd')::numeric) * 100), 0)::int as cents
    from project_event u
    join project_event r on r.project_id = u.project_id and r.run_id = u.run_id and r.type = 'run.started'
    where u.project_id = ${projectId} and u.type = 'usage'
      and r.payload->>'mode' = 'qa' and r.at >= date_trunc('day', now())`);
  return rows as unknown as T[];
}

/**
 * Runs cut off by an orchestrator restart never got a run.finished event, so the builder would
 * show them as running forever. On startup: stop any agent process left in their sandbox, close
 * them as failed (with a clear reason), and reset the project's status. Their file changes stay
 * in the workspace as unsaved changes.
 */
export async function recoverInterruptedRuns(): Promise<void> {
  const open = await db.execute<{ project_id: string; run_id: string }>(sql`
    select s.project_id, s.run_id from project_event s
    where s.type = 'run.started'
      and not exists (select 1 from project_event f where f.run_id = s.run_id and f.type = 'run.finished')`);
  for (const { project_id: projectId, run_id: runId } of open) {
    if (active.has(projectId)) continue;
    await exec(projectId, ["sh", "-c", 'pkill -TERM -f "[/]opt/forge/runner/runner.mjs"; pkill -TERM -f "[/]opt/forge/checks/checks.mjs"; true'], {
      user: "root",
    }).catch(() => undefined);
    const unsaved = await hasChanges(projectId).catch(() => false);
    await appendEvent({
      type: "run.finished",
      projectId,
      runId,
      status: "failed",
      error: "Interrupted: Forge restarted while the agent was working. Changes it made so far are kept; send a message to continue.",
      ...(unsaved ? { unsaved: true } : {}),
    });
    await db.update(schema.project).set({ status: "error" }).where(eq(schema.project.id, projectId));
    console.log(`closed interrupted run ${runId} (${projectId})`);
  }
}
