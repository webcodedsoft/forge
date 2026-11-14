# Forge

Our team's private AI app builder. See `../PLAN.md` for the architecture and phases.

## Run locally

```bash
cp .env.example .env          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
pnpm install
pnpm db:up                    # Postgres in Docker on 127.0.0.1:5433
pnpm db:push                  # apply the schema
pnpm sandbox:build            # build the project sandbox image (first time: several minutes)
pnpm dev                      # orchestrator :8790 + web :4310
```

Open http://localhost:4310 and create an account (email and password).
Set `ALLOWED_EMAIL_DOMAINS=yourcompany.com` in `.env` to limit sign-ups to the team.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js 16 UI. Proxies `/api/*` to the orchestrator so auth cookies stay on one origin |
| `apps/orchestrator` | Hono API: Better Auth (email/password), projects, and later the event stream and sandboxes |
| `packages/protocol` | Shared zod schemas: projects API and the run-event protocol |
| `sandbox/Dockerfile` | Per-project container: Node 24, pnpm, git, ripgrep, Playwright Chromium; runs as a non-root user |

## Ports
Web 4310 · orchestrator 8790 · previews 7777 (phase 1) · Postgres 5433.
These avoid 3000 and 8787, which other projects on this Mac already use.

## How a run works
1. Opening a project starts its container `forge-proj-<id>`. The first start copies the pre-installed
   template into the `forge-ws-<id>` volume and commits it. Then `next dev` runs on :3000.
2. The preview proxy maps `http://<id>.preview.localhost:7777` to that dev server, HMR included.
3. A prompt starts `sandbox/runner/runner.mjs` inside the container (Claude Agent SDK, `claude-opus-5-5`
   by default, set `FORGE_MODEL` to change). Follow-up prompts resume the same agent session.
4. The runner's JSON-lines output becomes stored events, streamed to the browser over `ws://localhost:8790/api/ws`.
5. When the run ends, the changes are committed in the project repo and shown as a version.

## Status
- Phase 0 done: auth, team-shared projects, dashboard, sandbox image.
- Phase 1 done: prompt → agent → live preview, streamed activity feed, per-run cost, commit per run,
  session resume, Stop button.
- Phase 2 done: the agent can pause to ask multiple-choice questions (`ask_user`) or get a plan
  approved, edited or revised (`present_plan`). The Versions tab lists every commit with one-click restore
  (a new commit, history kept), and the agent is told about restores on its next turn. Plans and messages
  render as Markdown.
- Phase 3 done: green-build guarantee. After each agent turn Forge runs `sandbox/checks/checks.mjs`
  (install, typecheck, lint, unit tests if a `test` script exists, and a Chromium smoke test that loads
  every static page and fails on HTTP errors, uncaught errors or console errors). Failures go back to the
  agent (up to 2 fix rounds). A version is saved only when everything passes; otherwise the changes stay
  unsaved and the builder offers "Keep fixing" or "Discard changes".
- Phase 4a done: API connections. Register our in-house APIs once (Settings → API connections: name,
  base URL, OpenAPI 3 spec URL). A project picks connections in the builder header (APIs). Forge then
  commits into the project: the spec and a README for the agent (`.forge/apis/`), generated types and
  openapi-fetch clients (`src/lib/forge-api/<name>.ts` for client code, `<name>.server.ts` for Server
  Components) and a proxy route (`/api/forge/<name>/...`). The upstream base URLs go to the git-ignored
  `.env.development.local`. Refreshing a spec regenerates every project that uses it.
- Phase 5 done: team brain. Markdown docs (Settings → Team brain, with recommended starter docs) plus
  per-project notes (builder → Brain tab) are appended to the agent's system prompt on every turn
  (`apps/orchestrator/src/brain.ts`, capped at 40k characters). Project notes override team docs; the
  user's request overrides both; existing code does not override them.
- Phase 6 built: import from GitHub (dashboard → Import). The clone, push and `gh pr create` run on this Mac
  in `data/repos/<id>` with your `gh` login; the token never enters a container. Work happens on
  `forge/<id>`. Stack detection writes `.forge/project.json` (git-excluded). Preparation installs
  dependencies, starts the repo's own dev server, records checks that already fail (advisory from then
  on), and hides install byproducts locally. "Open/Update pull request" bundles the container's commits
  back to the clone, pushes, and opens or updates one PR. Import, agent change and bundle-back are tested;
  push and PR creation still need a test against a repo we may push to.
- Phase 7 done: QA agent ("Test the app"). A separate agent session in `mode: "qa"` with no write tools
  drives a real Chromium (open/snapshot/click/fill/press/screenshot) against the project's recent requests
  and the team brain, reports issues (`report_issue`), and ends with a QA report card ("Fix these issues"
  hands it to the build agent). While it runs, the builder shows its browser live (CDP screencast about
  6 fps, not stored) with a drawn cursor that glides to each element and ripples on clicks. A label next to the cursor
  says what it is doing ("Clicking “Vote”", in `runner.mjs` `showLabel`), and under the live view a caption shows the
  current step, the last three, and the step and problem counts (`qa-live.tsx`, built from the run's tool calls).
- Phase 8 done: visual edit and usage. The preview proxy injects `/__forge/inspector.js` into HTML pages
  (fetched uncompressed); "Select element" in the preview toolbar highlights elements on hover and posts
  the clicked one (tag, text, section, DOM path, classes, HTML) to the builder via postMessage, restricted
  to the Forge and preview origins. The next prompt carries those details. Settings → Usage shows AI cost
  and runs per project, teammate and day (`GET /api/usage?days=`). Google sign-in was dropped in favour of
  Entra (phase 4b).
- Auto-test done: per project, the builder's "Auto-test" switch runs the QA agent automatically after each
  saved version, told to test that request first and then re-check the main features. A daily budget
  (default $2, $0.10 to $50, counting today's QA spend in UTC) stops automatic tests; the feed then shows a
  `notice` event and "Test the app" still works. Settings: `PATCH /api/projects/:id/settings`.
- Multiplayer done: presence (the websocket knows each viewer's session; `presence` frames list who has a
  project open, one avatar per person however many tabs) and comments pinned to elements
  (`project_comment` table, `/api/projects/:id/comments`). "Comment" in the preview toolbar picks an
  element; the preview inspector draws numbered pins from `forge:pins` messages, follows layout changes
  and posts `forge:pin-click`. Threads support replies (a reply reopens a resolved thread), resolve, and
  delete-your-own. "Ask the agent to fix this" turns a thread into a prompt aimed at its element. Every
  change sends `comments_changed` so teammates see it live. A second test account (`DEV_TEST2_*` in
  `.env`, removed after testing; recreate one for the next multiplayer test) is for multiplayer tests;
  never sign one user into two browsers.
- Secrets done: per-project environment variables (header → Secrets). Values are AES-256-GCM encrypted in
  `project_secret` (key `FORGE_SECRETS_KEY`, or derived from `BETTER_AUTH_SECRET`; set and back up the
  explicit key in production), write-only from the browser, and passed only to the app's dev server process
  (started with `setsid`, restarted on change; no `.env` file, so nothing can be committed). The agent's
  system prompt lists the names only, with rules for using them; values found in run output are masked as
  `••••••` before storing or streaming. Changes are blocked while the agent runs and post a feed notice;
  teammates' previews reload automatically. Limit: the agent shares the container user with the dev
  server, so this protects against leaks into git, chat and prompts, not against a hostile agent.
- Templates and component library done. Templates: Versions tab → "Save as template" stores `git archive
  HEAD` (tracked files only), the project's API connections, its own brain notes and its secret *names*
  (`project_template`). New project → "Starting point" seeds from the archive over the warm base install,
  reinstalls dependencies, commits once, regenerates API files, copies the notes and posts a notice listing
  secrets to add. Library: the build agent's `save_to_library` tool (the runner reads the files from disk)
  stores a self-contained component in `library_component`; "Save to library" on a selected element
  prepares that request. Before each build turn the library is copied to `.forge/library/` (git-excluded)
  and listed in the system prompt, with the rule to reuse a fitting component or say why not.
  Settings → Templates & library lists both, with code view and delete. After rebuilding the sandbox image,
  existing project containers are removed so they come back on the new image (workspaces are volumes).
- Hardening: agent runs get a run-scoped token for the orchestrator's model proxy
  (`model-proxy.ts`, port 8791; `MODEL_PROXY_HOST=172.17.0.1` on Linux servers), so the real Anthropic
  key never enters a project container; a token stops working when its run ends. `FORGE_SECRETS_KEY` is
  explicit (deploy.sh refuses to run without it). A separate OS user for the dev server was tried and
  dropped: Next.js writes `.next` from both the dev server and `next typegen`, and Turbopack must own those
  files. Store test/development keys in project secrets, never production ones. Each build request gets a
  one-line library reminder (agents ignored the system-prompt rule alone).
- Redesign in the Flowkite design language: tokens in `apps/web/src/app/globals.css` (paper/surface/ink/line/
  primary #5B2CE2 plus ok/warn/danger; two greys a step darker than Flowkite's for contrast), old names kept as
  aliases; light/dark via `<html data-theme>` (set before paint, toggle in the header); Hanken Grotesk and
  JetBrains Mono; shared classes `.btn`, `.card`, `.tile`, `.pill`, `.seg`/`.mode`, `.tab`, `.nav`, `.row`, `.dots`.
  Home and settings share `components/app-shell.tsx` (route group `app/(shell)`); the builder has a project
  switcher, Build/Comments/Versions/Brain modes, open-project tabs (`lib/open-projects.ts`), a ⌘K go-to palette
  (also from inside the preview: the inspector forwards it) and a Desktop/Phone preview. `GET /api/activity` feeds
  the home page's activity list and per-project status.
- Roles and invitations (`apps/orchestrator/src/access.ts`, `routes/team.ts`): workspace roles admin > builder >
  member and project roles admin > builder > viewer (`workspace_member`, `project_member`). Workspace admins are
  admin of every project; others see only projects they're members of (others return 404). Every
  `/api/projects/:id/…` call is checked in `index.ts` (reads and comments: viewer; people: admin; other changes:
  builder); workspace-level rules cover project creation, API connections, usage, team brain, templates, library
  and the team page; the websocket checks project access. Sign-up needs a pending invitation (except the first
  account, which becomes admin); invitations are 7-day, single-use links tied to an email (only a SHA-256 of the
  token is stored) because Forge doesn't send email yet. Admin page: Settings → Team. Project sharing: the
  builder's Share button (project admins add teammates or invite by email). Previews are still reachable by
  anyone with the link (unguessable host); signing in to previews comes with Entra. Test accounts:
  `DEV_TEST_VIEWER_*` (member, viewer of Team lunch poll) and `DEV_TEST_BUILDER_*` (builder) in `.env`.
- Builder preview as a browser: Preview | Code views; Chrome-style page tabs (titles from the app, + opens a
  page, right-click menu as in Flowkite: split view, pin, move, groups with 9 colours and collapsing chips,
  close options); back / forward / reload and an address bar (suggests pages found in `app/**/page.tsx` or
  `pages/**`, `lib/routes.ts`); the inspector reports navigation (`forge:location`) and takes `forge:nav`.
  Screen picker: Responsive (drag the right/bottom/corner handles or type W × H) or phone/tablet/desktop
  presets with rotate; larger sizes scale to fit. Code view lists `git ls-files -co --exclude-standard` and
  shows files read-only (`routes/workspace.ts`). More: open in new tab, copy link, download the saved
  version (.zip), reload from home, restart the app server.
- Review toolbar (floating, bottom of the preview): select element, edit text in place (prefills a
  request aimed at the element), draw (server-side Playwright screenshot of the same view + strokes →
  attached PNG), comment; Dock / Minimize / Hide, the previewed app's theme (Auto/Light/Dark, per project:
  the inspector forces `prefers-color-scheme` rules and the `dark` class) and keyboard shortcuts
  (S/T/D/C/Esc, also from inside the preview).
- Prompt box: + menu (search, Project ▸, Help center → `/help`, Add context ▸ inserts @page/@file, Attach
  files → `.forge/uploads/`, git-excluded, read by the agent; pasting a screenshot attaches it); modes
  Build / Chat (read-only turn, no checks or version) / Plan (spec via present_plan first), ⌥P cycles.
  The chat panel resizes (drag its edge, double-click resets) and collapses to a rail. Tooltips app-wide
  (`components/tooltip-layer.tsx`: data-tip, title, or the aria-label of icon-only controls).
- Changes view (builder: Preview | Code | Changes; `versions.ts`, `routes/versions.ts`): any two versions'
  changed files and line diffs, or side by side live (the older version runs from a git worktree on the
  sandbox's :3001 with webpack, at `<id>--compare.<preview host>`; stops after 20 idle minutes). Ideas:
  branches started from an older version ("Try an idea"), switch lines, "Use in the main line" (one new
  version on main, history kept), delete. Containers on an older image or without :3001 are replaced on the
  next ensureSandbox (never mid-run); volumes keep the files.
- Health tab (builder): Problems (Fix from logs, `problems.ts`): the preview's reporter script
  (`/__forge/report.js`, also in standalone tabs) sends browser errors and failed requests to
  `/__forge/problems`; server errors come from `/tmp/dev.log` every 15 s; grouped by fingerprint; "Fix this"
  / "Fix all" start a build run, fixed when it saves, reopened if it happens again. Saved tests (`tests.ts`):
  the QA agent proposes tests (`propose_test`), Forge replays them at once and offers passing ones; saved
  tests replay after every version without AI (Playwright in the sandbox, fresh context per test); "Describe
  a test" asks the QA agent to create one. Security (`security.ts`): pnpm audit, keys/tokens/.env files in
  tracked files, server routes/actions without a sign-in check, unchecked input, raw HTML, eval, SQL or shell
  built from strings; after every version and before pushing; each finding has "Fix".
- GitHub (`github.ts`, `integrations.ts`): no deploys; the code goes to the company GitHub. Settings ›
  Integrations › Connect GitHub (manifest flow): one click creates a Forge GitHub App on the admin's account,
  installable elsewhere, and GitHub's install screen lets them pick the organization (transfer the app to
  the org later and make it private). Advanced: name the org to create a private, org-owned app directly.
  Forge mints installation tokens (git credential helper / GH_TOKEN, never on the command line).
  "Push to GitHub": made-in-Forge projects get a private repo in the org, then pushes to its main (refused if
  GitHub's main has other changes); imported repos get pull requests. Failing saved tests or critical/high
  security findings block the push; project admins may push anyway (recorded). Without a connection, imports
  and PRs fall back to the gh login on this machine.
- Design mode + Figma (`figma.ts`): paste a Figma frame link in the prompt box: Forge imports the frame (PNG)
  and a spec (layout, gaps, padding, colours, fonts, texts) as attachments and switches to Design, which
  rebuilds it with the library and brain rules. Figma token: Settings › Integrations (or FIGMA_TOKEN).
- Data sources (`datasources.ts`, Settings › Data sources): PostgreSQL, SQL Server, MySQL (encrypted
  passwords, structure read on save) and Excel/CSV uploads (a read-only SQLite file per source in
  data/datasets/). Projects pick sources under "APIs & data"; Forge commits `src/lib/forge-data.ts` and tells
  the agent the tables. Apps query through the data proxy (DATA_PROXY_PORT 8792) with a per-project token
  (FORGE_DATA_URL/TOKEN in the dev server): one SELECT/WITH statement, read-only transaction or read-only
  intent, 15 s, 2,000 rows. SharePoint lists wait for Entra.
- Loading (`components/loading.tsx`, globals.css "Loading"): Spinner, BusyLabel + `.btn[aria-busy]`,
  Skeleton/SkeletonRows/SkeletonCards, ForgeLoader (opening a project, starting the sandbox), RouteBar
  (route loading.tsx); reduced motion respected. Pagination on every list (`components/pagination.tsx`).
- Icons: generated apps use `lucide-react` (template dependency, rule in the template's AGENTS.md and the
  team brain's Design system doc).
- Phase 9 prepared: server deployment in `deploy/` (see `deploy/README.md`). One Docker Compose stack for
  the Azure production VM and the on-premises staging server: Postgres, orchestrator, web, Caddy (HTTPS
  and wildcard preview routing; TLS via Let's Encrypt + Azure DNS, company CA, or Caddy's internal CA).
  Preview addresses come from `PREVIEW_URL_TEMPLATE`; the builder's websocket uses the same host when
  deployed. Images build and the Compose and Caddy configs validate; not yet run on the real servers.
- Guest feedback on share links (`routes/comments.ts` `publicFeedback`, `preview/[projectId]/[token]/shared-preview.tsx`): a
  preview share link (with "Let visitors leave feedback", `preview_share.allow_feedback`) lets someone without an account
  pick an element on the shared page and leave a note under a name they type. Public endpoints under
  `/api/public/preview-shares/:projectId/:token/comments` (the token is the access; 20 notes per 10 minutes and 300 in
  total per link). Notes are `project_comment` rows with `user_id` null, `guest_name` and `share_id`; they show in Comments
  marked Guest and builders may delete them. A visitor sees only the threads started through their own link, plus the
  team's replies (polled every 20 s). Guest text reaches the agent only when a builder presses "Ask the agent to fix this"
  and sends the prefilled request.
- Share links can be copied again: each new link's token is kept AES-256-GCM encrypted (`preview_share.token_enc`, same
  key as project secrets, bound to the project and link id) next to its SHA-256 hash, which is still what access is checked
  against. The Share preview dialog lists active links with Copy (builders only). Links made before this have only the hash
  and show "Can't be shown"; they keep working. Changing `FORGE_SECRETS_KEY` makes existing links uncopyable, not broken.
- Version reviews: visual diffs and accessibility (`review.ts`, `routes/review.ts`, `version_review`). The smoke test in
  `sandbox/checks/checks.mjs` also takes a screenshot of every static page at 1280 and 390 px (reduced motion, animations
  off, up to 3,000 px tall) and runs axe-core (WCAG 2.1 A/AA) into `/tmp/forge-review`. On commit Forge copies that to
  `data/reviews/<project>/<sha>/`, compares each picture with the nearest earlier reviewed version (pixelmatch; under 30
  differing pixels counts as the same) and stores which pages changed, are new or are gone. Versions tab: "N pages look
  different" and Look (before/after and a differences picture, desktop/phone). Health › Accessibility lists the latest
  findings with Fix / Fix all / Check now; they never block saving or pushing. Versions saved without the checks (restore,
  idea used, see below) are reviewed by `reviewVersion()` (`FORGE_ONLY=review`). The latest 40 reviews per project are kept.
- Living spec (`spec.ts`, `routes/spec.ts`, `project_spec`, `spec_criterion`, builder Spec tab): a summary plus acceptance
  criteria grouped by area. The build agent sees the spec in its system prompt, must keep criteria true, and records
  changes with its `update_spec` tool; they are staged in memory and applied when the version is saved (dropped on
  discard; applied straight away when the turn changed no files). Projects made in Forge get `docs/SPEC.md` written into
  every saved version. The QA agent gets the criteria, may pass `criterionId` to `propose_test`, and saving such a test
  links it (`spec_criterion.test_id`), so the criterion shows passing/failing from the test's last replay. Spec › "Write
  tests" starts a QA run for up to 10 untested criteria and saves the passing tests itself; "Write the spec from the app"
  starts a build run that only calls `update_spec`. The spec is not versioned: restoring an old version keeps today's spec.
- GitHub round trip (`github-sync.ts`, `routes/github.ts` `githubSyncRoutes`, GitHub menu › `github-roundtrip.tsx`).
  Changes on GitHub: `GET …/github/incoming` fetches the base branch into the host clone and lists the commits the
  project's main line lacks; `POST …/github/pull` sends them into the sandbox as a git bundle, runs
  `git merge --no-ff --no-commit`, and starts a run (`RunOptions` in `runs.ts`): no agent turn when the merge is clean,
  a conflict-resolution turn otherwise; then the usual checks, and the merge is committed only when they pass (Discard
  resets it). A `github.sync` event follows, which also tells the agent on its next turn that files changed. Review
  feedback: `GET …/github/feedback` reads the pull request's unresolved review threads, review summaries, conversation and
  checks over GraphQL (projects without a PR: checks on the pushed branch); `POST …/github/feedback/address` turns the
  picked items (plus failing checks with the end of their Actions logs) into one build request and remembers what was
  sent (`project.pr_feedback_sent`). Reviewer text is quoted and marked as untrusted in that request.
- Test status of the four features above (2026-11-14): guest feedback, version reviews, the spec API and tab, a clean
  merge from a local bare remote (merged, checked, saved, reviewed, `docs/SPEC.md` written) and reading feedback from a
  public pull request all pass. Not yet run with a model, because the workspace's only AI key had no credits: the agent
  calling `update_spec`, QA writing tests per criterion, the agent resolving merge conflicts (detection, cancel and
  discard were tested), and addressing review feedback.
- AI cost controls (2026-11-14; measured before: one never-ending conversation per project, 52k-87k tokens resent at
  every step, and whole histories billed again after a pause).
  - Fresh conversations (`runs.ts` `freshSessionSeed`): a project's agent conversation starts over, with a summary of the
    last six requests and their outcomes, when it holds more than `FORGE_SESSION_MAX_TOKENS` (90k), or has been idle for
    `FORGE_SESSION_IDLE_MIN` (5) minutes and holds more than `FORGE_SESSION_IDLE_TOKENS` (40k). Size and last use are kept
    on `project.agent_context_tokens` / `agent_session_at` (Claude: reported by the runner; ChatGPT: by the model proxy).
  - Context outside the system prompt (`contextBlock`): the system prompt is now only Forge's rules (plus an imported repo's
    facts) and the runner sets `excludeDynamicSections`, so it is identical for every project and conversation. Brain, spec,
    library, secrets and data sources travel in a `<forge-context>` block at the start of a message, and only sections
    whose hash changed since they were sent in this conversation (`project.agent_context_sent`).
  - ChatGPT (`openai-bridge.ts`): `prompt_cache_key` per project; reasoning items are kept in memory and put back before
    the tool call they led to (`include: reasoning.encrypted_content`), so the model doesn't re-think every step; side tasks
    use low effort and, with no fast model set, the cheapest allowed OpenAI model; `FORGE_OPENAI_EFFORT` sets the building
    effort (default medium). A 400 that names one of these optional fields is retried once without them. GPT-5.5 has a
    list price, so its runs are no longer recorded as $0.
  - Auto (`ai.ts` `pickAuto`, model picker): per request, without AI: small edits start on the cheapest allowed model,
    plans, designs, long requests, attachments and anything that reads like a feature or a fix use the default. When the
    cheap model's own fix attempt also fails the checks, the default takes over and gets one extra round.
  - Testing: click/fill/press return only the lines of the page that changed (the whole page on open and snapshot),
    screenshots are JPEG, and QA runs on the cheapest allowed model that is cheaper than the default (`qaModelKey`;
    `FORGE_QA_MODEL` picks another, or `default`). Its cursor is a magenta arrow with a halo so it stands out.
  - Spending cap: `FORGE_RUN_BUDGET_USD` (default 5, 0 = off) per request. Claude: the agent SDK's `maxBudgetUsd`;
    ChatGPT: the model proxy refuses further calls. The run ends with a clear message and the changes stay unsaved.
  - Test scope and speed (`test-button.tsx`, `StartQaInput`, `runs.ts` `qaPrompt`): "Test the app" opens a small form: what
    to test, what to leave alone, Quick or Full. Quick (the default, also used by Auto-test) checks only what was named or
    the latest request, skips the spec walk, and is capped at 25 model calls; Full at 70. The test agent has a `steps` tool
    (up to 10 actions per model call), waits for the page to stop changing (`settle`, 150 ms quiet, max 0.8 s) instead of
    fixed pauses, and a test that hits its call limit still reports what it found.
    Browser tools run one at a time (`inTurn`; ChatGPT test runs also get `parallel_tool_calls: false`), because actions
    asked for together raced on the single page. `find` fails within about 1.5 s with the names that are on the page,
    tries the same name as label, placeholder, other roles, title and text first, and reports disabled controls at once.
    Text is typed out visibly. `screen` switches to phone/tablet/desktop size and says whether the page overflows.
  Tested end to end against a mock OpenAI server (system prompt identical between requests, context sent once, fresh
  conversation 37.7k -> 18.5k tokens, reasoning returned on the next step, cap stops the run). Not yet run against real
  OpenAI or Claude: no key had credits.
- Next: phase 4b, Entra SSO (Forge sign-in, and the preview proxy injecting the teammate's API token as
  `x-forge-access-token`, which the generated proxy forwards as `Authorization: Bearer`). Waiting on
  tenant ID, the API scope and a Forge app registration.

## Pauses
The runner's `ask_user` / `present_plan` tools print a `pause` line and wait for
`/tmp/forge-answers/<pauseId>.json`. `POST /api/projects/:id/pauses/:pauseId` writes that file
(atomically) and records a `resume` event. Waiting tools time out after 2 hours.
