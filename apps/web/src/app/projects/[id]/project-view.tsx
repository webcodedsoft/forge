"use client";

import { cleanRunError } from "@forge/protocol";
import type { AppProblem, CommentAnchor, Project, ProjectComment, ProposedTest, ProjectModels, QueuedMessage, RunEvent, RunMode, SandboxStatus, SaveTestInput } from "@forge/protocol";
import { failedTestPrompt, StepList } from "./test-steps";
import { HealthPanel } from "./health-panel";
import { AgentWorking, currentActivity } from "./agent-working";
import { QaLiveView } from "./qa-live";
import { QueueList } from "./queue-list";
import { PreviewOffline, usePreviewReachable } from "./preview-health";
import { PlanPanel, PlanSummaryCard } from "./plan-panel";
import { onPreviewAccessRequest, usePreviewEntry } from "./preview-entry";
import { SharePreviewModal } from "./share-preview";
import { splitAttachments, splitElementContext } from "@/lib/prompt-parts";
import { ForgeLoader, Spinner } from "@/components/loading";
import { AttachmentIcon, attachmentProblem, AttachmentPreview, attachmentSuffix, AttachmentThumb, isImagePath, uploadFiles } from "@/lib/uploads";
import { GitHubButton } from "./github-button";
import { useSession } from "@/lib/auth-client";
import { SecretsButton } from "./secrets-button";
import { ShareButton } from "./share-button";
import { BrowserBar, type BrowserBarHandle } from "./browser-bar";
import { PreviewTabs, type PreviewTab, type TabGroup } from "./preview-tabs";
import { setViewport, useViewport, viewportSize, ViewportPicker } from "./viewport";
import { DrawLayer, ReviewToolbar, type ReviewTool, setPreviewTheme, setToolbarPrefs, usePreviewTheme, useToolbarPrefs } from "./review-toolbar";
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, setPanelPrefs, usePanelPrefs } from "@/lib/panel-prefs";
import { CodeView } from "./code-view";
import { type ComparePair, CompareView } from "./compare-view";
import { AutoToggle, ComposerMenu, ModelPicker, ModeSelect } from "./composer-menu";
import { routesFromFiles } from "@/lib/routes";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Code2,
  Columns2,
  Download,
  ExternalLink,
  FlaskConical,
  GitBranch,
  GitCompare,
  GitPullRequest,
  Globe,
  Hammer,
  HeartPulse,
  History,
  ScrollText,
  Info,
  Layers,
  Link2,
  ListChecks,
  MessageCircleQuestion,
  ListPlus,
  MessagesSquare,
  Pencil,
  Sparkles,
  Square,
  Minus,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  Power,
  RotateCw,
  SendHorizontal,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { CommandPalette } from "@/components/command-palette";
import { ProjectBadge } from "@/components/project-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { useMe } from "@/lib/me";
import { closeProject, openProject, useOpenProjects } from "@/lib/open-projects";
import { CommentsPanel, PresenceStack, type Thread, toThreads } from "./comments-panel";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { api, ApiError } from "@/lib/api";
import { useProjectEvents } from "@/lib/use-project-events";
import { ApisPicker } from "./apis-picker";
import { BrainPanel } from "./brain-panel";
import { SpecPanel } from "./spec-panel";
import { PauseCard } from "./pause-card";
import { VersionsPanel } from "./versions-panel";

type ToolRow = { call: Extract<RunEvent, { type: "tool.call" }>; result?: Extract<RunEvent, { type: "tool.result" }> };
type Item =
  | { kind: "prompt"; e: Extract<RunEvent, { type: "run.started" }> }
  | { kind: "text"; e: Extract<RunEvent, { type: "assistant.message" }> }
  | { kind: "tool"; row: ToolRow }
  | { kind: "commit"; e: Extract<RunEvent, { type: "commit" }> }
  | { kind: "usage"; e: Extract<RunEvent, { type: "usage" }>; model?: string }
  | { kind: "finished"; e: Extract<RunEvent, { type: "run.finished" }> }
  | { kind: "answered"; pause: Extract<RunEvent, { type: "pause" }>; answer: Extract<RunEvent, { type: "resume" }> }
  | { kind: "checking"; e: Extract<RunEvent, { type: "check.started" }> }
  | { kind: "checks"; e: Extract<RunEvent, { type: "check.result" }> }
  | { kind: "discarded"; e: Extract<RunEvent, { type: "changes.discarded" }> }
  | { kind: "pr"; e: Extract<RunEvent, { type: "pull_request" }> }
  | { kind: "notice"; e: Extract<RunEvent, { type: "notice" }> }
  | { kind: "qa"; e: Extract<RunEvent, { type: "qa.report" }> }
  | { kind: "branch"; e: Extract<RunEvent, { type: "branch" }> }
  | { kind: "tests"; e: Extract<RunEvent, { type: "tests.result" }> }
  | { kind: "push"; e: Extract<RunEvent, { type: "github.push" }> };

/** Fold the flat event log into chat items, pairing tool calls with their results. */
function toItems(events: RunEvent[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolRow>();
  const pauses = new Map<string, Extract<RunEvent, { type: "pause" }>>();
  // Which model answered each run (shown on its cost line).
  const models = new Map<string, string>();
  for (const e of events) {
    switch (e.type) {
      case "pause":
        pauses.set(e.pauseId, e);
        break;
      case "resume": {
        const pause = pauses.get(e.pauseId);
        if (pause) items.push({ kind: "answered", pause, answer: e });
        break;
      }
      case "run.started":
        if (e.model) models.set(e.runId, e.modelLabel ?? e.model);
        items.push({ kind: "prompt", e });
        break;
      case "assistant.message":
        // The agent echoes provider errors as a message ("API Error: 429 …"); the run's failure
        // line already shows them, cleaned up.
        if (/^\s*API Error:/i.test(e.text)) break;
        items.push({ kind: "text", e });
        break;
      case "tool.call": {
        const row: ToolRow = { call: e };
        tools.set(e.toolUseId, row);
        items.push({ kind: "tool", row });
        break;
      }
      case "tool.result": {
        const row = tools.get(e.toolUseId);
        if (row) row.result = e;
        break;
      }
      case "commit":
        items.push({ kind: "commit", e });
        break;
      case "check.started":
        items.push({ kind: "checking", e });
        break;
      case "check.result": {
        // Replace the "running checks" line of the same attempt with its result.
        const i = items.findLastIndex((it) => it.kind === "checking" && it.e.runId === e.runId && it.e.attempt === e.attempt);
        if (i >= 0) items.splice(i, 1);
        items.push({ kind: "checks", e });
        break;
      }
      case "changes.discarded":
        items.push({ kind: "discarded", e });
        break;
      case "pull_request":
        items.push({ kind: "pr", e });
        break;
      case "notice":
        items.push({ kind: "notice", e });
        break;
      case "qa.report":
        items.push({ kind: "qa", e });
        break;
      case "branch":
        items.push({ kind: "branch", e });
        break;
      case "tests.result":
        items.push({ kind: "tests", e });
        break;
      case "github.push":
        items.push({ kind: "push", e });
        break;
      case "usage":
        items.push({ kind: "usage", e, model: models.get(e.runId) });
        break;
      case "run.finished":
        items.push({ kind: "finished", e });
        break;
    }
  }
  return items;
}

export function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const { events, streaming, connected, caughtUp, qaFrame, presence, commentsVersion, problemsVersion, securityVersion, reviewVersion, specVersion, queueVersion, projectVersion, resync } =
    useProjectEvents(id);
  // The project's details changed on the server (e.g. Forge gave it a better name): refresh them.
  useEffect(() => {
    if (!projectVersion) return;
    let live = true;
    api.getProject(id).then(
      (p) => live && setProject((cur) => (cur ? { ...cur, name: p.name } : cur)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, projectVersion]);
  const { data: session } = useSession();
  const meId = session?.user.id;
  const feedEnd = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<"chat" | "comments" | "versions" | "spec" | "brain" | "health">("chat");
  // Screen size: Responsive (fill, or a size set by dragging / typing) or a device preset.
  const viewport = useViewport();
  const [stage, setStage] = useState({ w: 1000, h: 700 });
  const stageObserver = useRef<ResizeObserver | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    stageObserver.current?.disconnect();
    if (!el) return;
    const measure = () => setStage({ w: Math.max(240, el.clientWidth), h: Math.max(240, el.clientHeight) });
    measure();
    stageObserver.current = new ResizeObserver(measure);
    stageObserver.current.observe(el);
  }, []);
  const [frameResizing, setFrameResizing] = useState(false);
  const [view, setView] = useState<"preview" | "code" | "changes">("preview");
  // Changes view: which two versions (null = the latest against the one before it).
  const [comparePair, setComparePair] = useState<ComparePair | null>(null);
  const panel = usePanelPrefs();
  const [resizing, setResizing] = useState(false);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.width;
    setResizing(true);
    const move = (ev: PointerEvent) => setPanelPrefs({ width: startW + ev.clientX - startX }, false);
    const up = (ev: PointerEvent) => {
      setPanelPrefs({ width: startW + ev.clientX - startX });
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [mode, setMode] = useState<RunMode>("build");
  const [attachments, setAttachments] = useState<{ path: string; name: string; type: string }[]>([]);
  const [importingFigma, setImportingFigma] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [menu, setMenu] = useState<{ open: boolean; startIn: "root" | "context"; query: string }>({ open: false, startIn: "root", query: "" });
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Browser bar: where the app is, with our own back/forward stack.
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({ stack: ["/"], idx: 0 });
  const pendingNav = useRef<"back" | "forward" | null>(null);
  const currentPath = nav.stack[nav.idx] ?? "/";
  // Chrome-style tabs: saved spots (page + title) in the app; the active one follows navigation.
  const [tabs, setTabs] = useState<PreviewTab[]>([{ id: "t1", path: "/", title: "" }]);
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);
  // Split view: a second live view of the app, showing another tab beside the active one.
  const [splitId, setSplitId] = useState<string | null>(null);
  const splitRef = useRef<HTMLIFrameElement>(null);
  const [activeTab, setActiveTabState] = useState("t1");
  const activeTabRef = useRef("t1");
  const setActiveTab = (tabId: string) => {
    activeTabRef.current = tabId;
    setActiveTabState(tabId);
  };
  const barRef = useRef<BrowserBarHandle>(null);
  const onLocation = useCallback((path: string, title = "") => {
    const tabId = activeTabRef.current;
    setTabs((list) => list.map((t) => (t.id === tabId ? { ...t, path, title: title || t.title } : t)));
    // Read and clear the pending direction here, not inside the updater: React may run
    // updaters twice (development), and the second run must see the same direction.
    const dir = pendingNav.current;
    pendingNav.current = null;
    setNav((n) => {
      if (dir === "back" && n.stack[n.idx - 1] === path) return { ...n, idx: n.idx - 1 };
      if (dir === "forward" && n.stack[n.idx + 1] === path) return { ...n, idx: n.idx + 1 };
      if (n.stack[n.idx] === path) return n;
      const stack = [...n.stack.slice(0, n.idx + 1), path].slice(-50);
      return { stack, idx: stack.length - 1 };
    });
  }, []);

  // The app's files (Code view, "Add context") and its pages (address bar).
  const [files, setFiles] = useState<string[] | null>(null);
  // Viewers see the app, chat and versions, and comment; builders and admins change things.
  const canBuild = project?.myRole === "admin" || project?.myRole === "builder";
  const me = useMe(); // also scopes the open-project tabs to this account
  const openTabs = useOpenProjects();
  useEffect(() => {
    if (project && me) openProject({ id: project.id, name: project.name });
  }, [project, me]);
  const showError = useCallback((msg: string) => setError(msg), []);

  const items = useMemo(() => toItems(events), [events]);
  // Running: the latest run has no run.finished yet (checked by run id, not by counting).
  const running = useMemo(() => {
    const last = events.findLast((e) => e.type === "run.started");
    return Boolean(last && !events.some((e) => e.type === "run.finished" && e.runId === last.runId));
  }, [events]);
  // The agent is waiting for the user: the latest pause has no answer and its run is still going.
  const pendingPause = useMemo(() => {
    if (!running) return null;
    const answered = new Set(events.flatMap((e) => (e.type === "resume" ? [e.pauseId] : [])));
    const last = [...events].reverse().find((e) => e.type === "pause");
    return last && last.type === "pause" && !answered.has(last.pauseId) ? last : null;
  }, [events, running]);
  // When the preview can't be reached, Forge's own panel covers the frame (not the browser's error page).
  const reloadPreview = useCallback(() => setPreviewKey((k) => k + 1), []);
  const preview = usePreviewReachable(sandbox?.previewUrl, reloadPreview);
  const runCount = useMemo(() => events.filter((e) => e.type === "run.started").length, [events]);
  // Models the admin allows (the picker next to the mode). Reloaded when the tab regains focus,
  // so a change in Settings shows up without a reload.
  const [models, setModels] = useState<ProjectModels | null>(null);
  const [modelKey, setModelKey] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.projectModels(id).then(
        (m) => {
          if (!live) return;
          setModels(m);
          setModelKey((k) => (k && m.models.some((x) => x.key === k && x.available) ? k : m.currentKey));
        },
        () => undefined,
      );
    void load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
    // runCount: reload when any run starts, so the picker shows what the server will use.
  }, [id, runCount]);
  // A chat-only model can't build: outside Chat mode the picker and the request use the default.
  const effectiveModelKey = (() => {
    if (!models || !modelKey) return modelKey;
    const m = models.models.find((x) => x.key === modelKey);
    return m && !m.canCode && mode !== "chat" ? models.defaultKey : modelKey;
  })();
  // Messages waiting for the agent (orchestrator queue.ts), refetched when the server says so.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const refreshQueue = useCallback(() => api.queue(id).then(setQueue, () => undefined), [id]);
  useEffect(() => {
    let live = true;
    api.queue(id).then((q) => live && setQueue(q), () => undefined);
    return () => {
      live = false;
    };
  }, [id, queueVersion]);
  // The project's Autonomous switch (prompt box toggle and mode menu): saved right away, undone on error.
  const setAutonomous = useCallback(
    (on: boolean) => {
      setProject((p) => (p ? { ...p, autonomous: on } : p));
      api.updateSettings(id, { autonomous: on }).catch((e) => {
        setProject((p) => (p ? { ...p, autonomous: !on } : p));
        setError(errText(e));
      });
    },
    [id],
  );
  // Previews are private: the frame opens through an entry link that gives this browser a pass.
  // `accessEpoch` goes up when the preview asks for access again (its pass expired).
  const [accessEpoch, setAccessEpoch] = useState(0);
  const previewEntry = usePreviewEntry(id, Boolean(sandbox?.previewUrl), { next: currentPath, reloadKey: `${previewKey}:${accessEpoch}` });
  const [sharing, setSharing] = useState(false);
  // A plan with steps opens the Plan panel over the preview; "Hide" tucks it away until reopened.
  const planHasSteps = Boolean(
    pendingPause?.kind === "plan" && ((pendingPause.payload as { steps?: unknown[] } | null)?.steps?.length ?? 0) > 0,
  );
  const [hiddenPlan, setHiddenPlan] = useState<string | null>(null);
  const planOpen = Boolean(planHasSteps && canBuild && pendingPause && hiddenPlan !== pendingPause.pauseId);
  // What the agent is doing right now (the bar at the bottom of the chat).
  const activity = useMemo(() => (running ? currentActivity(events, Boolean(streaming?.text)) : null), [running, events, streaming?.text]);
  const runStartedAt = useMemo(() => (running ? events.findLast((e) => e.type === "run.started")?.at : undefined), [running, events]);
  // Stop was pressed for this run (by its start time), so a later run starts with Stop enabled.
  const [stoppingRun, setStoppingRun] = useState<string | null>(null);
  const stopping = running && stoppingRun !== null && stoppingRun === (runStartedAt ?? "");
  const stopRun = useCallback(() => {
    setStoppingRun(runStartedAt ?? "");
    api.cancelRun(id).then(
      (r) => {
        // Nothing to stop on the server: this page missed the run's end. Reload the events.
        if (!r.cancelled) {
          setStoppingRun(null);
          resync();
        }
      },
      (e) => {
        setStoppingRun(null);
        setError(errText(e));
      },
    );
  }, [id, runStartedAt, resync]);
  // The browser tab says so too, so people can switch away and see when it's done.
  useEffect(() => {
    if (!running || !project) return;
    const before = document.title;
    document.title = `${pendingPause ? "Waiting for you" : "Working…"} · ${project.name}`;
    return () => {
      document.title = before;
    };
  }, [running, pendingPause, project]);
  const commitCount = useMemo(
    // Anything that changes the files: a saved version, a discard, or switching lines (ideas).
    () => events.filter((e) => e.type === "commit" || e.type === "changes.discarded" || e.type === "branch").length,
    [events],
  );
  // The last run ended with changes that were not saved (checks failed, stopped, or errored),
  // and nothing has been saved or discarded since.
  const unsaved = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === "commit" || e.type === "changes.discarded" || e.type === "run.started") return false;
      if (e.type === "run.finished") return Boolean(e.unsaved);
    }
    return false;
  }, [events]);
  const [discarding, setDiscarding] = useState(false);
  // Secret changes show up as notices; teammates' Secrets lists refresh on them.
  const secretNotices = useMemo(
    () => events.filter((e) => e.type === "notice" && e.runId.startsWith("secrets-")).length,
    [events],
  );

  // Load the project and start its sandbox.
  useEffect(() => {
    let cancelled = false;
    api.getProject(id).then(
      (p) => {
        if (cancelled) return;
        setProject(p);
        setSandbox({ state: "starting", previewUrl: null, activeRunId: null });
        api.startSandbox(id).then(
          (s) => !cancelled && setSandbox(s),
          (e) => !cancelled && setSandbox({ state: "error", previewUrl: null, activeRunId: null, error: errText(e) }),
        );
      },
      (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setError(e instanceof ApiError && e.status === 404 ? "Project not found." : errText(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  // While an imported repo is being prepared (install, baseline checks), poll its status.
  useEffect(() => {
    if (sandbox?.state !== "starting" || !sandbox.stage) return;
    const t = setInterval(() => {
      api.sandbox(id).then(
        (s) => {
          if (s.state === "stopped") api.startSandbox(id).then(setSandbox, () => undefined);
          else setSandbox(s);
        },
        () => undefined,
      );
    }, 3000);
    return () => clearInterval(t);
  }, [id, sandbox?.state, sandbox?.stage]);

  // While a run shows as active, check with the server now and then. If it has no active run
  // twice in a row, this page missed the run's end (e.g. the connection died during sleep): reload.
  useEffect(() => {
    if (!running) return;
    let misses = 0;
    const t = setInterval(() => {
      api.sandbox(id).then(
        (s) => {
          misses = s.activeRunId ? 0 : misses + 1;
          if (misses >= 2) resync();
        },
        () => undefined,
      );
    }, 30_000);
    return () => clearInterval(t);
  }, [id, running, resync]);

  // Visual edit: the preview's inspector script posts the clicked element back here.
  type Picked = { tag: string; text: string; role: string; classes: string; path: string; section: string; url: string; html: string };
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [inspecting, setInspecting] = useState(false);
  /** What the next click in the preview is for: a visual edit, or a new comment. */
  const [inspectFor, setInspectFor] = useState<"edit" | "comment" | "text">("edit");
  const [picked, setPicked] = useState<Picked | null>(null);
  const previewOrigin = sandbox?.previewUrl ? new URL(sandbox.previewUrl).origin : null;
  useEffect(() => {
    if (!previewOrigin) return;
    return onPreviewAccessRequest([previewOrigin], () => setAccessEpoch((n) => n + 1));
  }, [previewOrigin]);
  const toggleInspect = (on: boolean, purpose: "edit" | "comment" | "text" = "edit") => {
    setInspecting(on);
    setInspectFor(purpose);
    if (previewOrigin) iframeRef.current?.contentWindow?.postMessage({ type: "forge:inspect", on, mode: purpose === "text" ? "text" : "select" }, previewOrigin);
  };

  // Review toolbar: one active tool at a time.
  const [drawing, setDrawing] = useState(false);
  const [strokes, setStrokes] = useState<{ x: number; y: number }[][]>([]);
  const [attachingDrawing, setAttachingDrawing] = useState(false);
  const frameBox = useRef<HTMLDivElement>(null);
  const scrollWaiter = useRef<((v: { x: number; y: number; path: string }) => void) | null>(null);
  const activeTool: ReviewTool | null = drawing
    ? "draw"
    : inspecting
      ? inspectFor === "edit"
        ? "select"
        : inspectFor === "text"
          ? "text"
          : "comment"
      : null;
  const setTool = (t: ReviewTool | null) => {
    setDrawing(t === "draw");
    if (t !== "draw") setStrokes([]);
    if (t === "select") toggleInspect(true, "edit");
    else if (t === "comment") toggleInspect(true, "comment");
    else if (t === "text") toggleInspect(true, "text");
    else toggleInspect(false);
  };
  const toolbarPrefs = useToolbarPrefs();
  // The previewed app's theme (per project), sent to the preview whenever it changes or reloads.
  const previewTheme = usePreviewTheme(id);
  const [frameReady, setFrameReady] = useState(0);
  useEffect(() => {
    if (previewOrigin) iframeRef.current?.contentWindow?.postMessage({ type: "forge:theme", mode: previewTheme }, previewOrigin);
  }, [previewTheme, previewOrigin, frameReady]);
  const shortcutRef = useRef<(key: string) => void>(() => undefined);
  useEffect(() => {
    shortcutRef.current = (key: string) => {
      if (!toolbarPrefs.shortcuts || view !== "preview") return;
      const map: Record<string, ReviewTool> = { s: "select", t: "text", d: "draw", c: "comment" };
      if (key === "Escape") setTool(null);
      else if (map[key] && (canBuild || map[key] === "comment")) setTool(activeTool === map[key] ? null : map[key]);
    };
  });
  useEffect(() => {
    const fromPreview = (e: Event) => shortcutRef.current((e as CustomEvent<string>).detail);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (["s", "t", "d", "c", "Escape"].includes(k)) shortcutRef.current(k);
    };
    window.addEventListener("forge:shortcut", fromPreview);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("forge:shortcut", fromPreview);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /** Drawing done: screenshot this view of the page, draw the strokes on it, attach the result. */
  async function attachDrawing() {
    const frame = frameBox.current;
    if (!frame || !previewOrigin || strokes.length === 0) return;
    setAttachingDrawing(true);
    setError(null);
    try {
      const where = await new Promise<{ x: number; y: number; path: string }>((resolve) => {
        scrollWaiter.current = resolve;
        iframeRef.current?.contentWindow?.postMessage({ type: "forge:get-scroll" }, previewOrigin);
        setTimeout(() => resolve({ x: 0, y: 0, path: currentPath }), 1500); // no answer: top of the page
      });
      const width = Math.round(frame.clientWidth);
      const height = Math.round(frame.clientHeight);
      // The colours the user sees: the theme forced in the toolbar, else their system's.
      const colorScheme =
        previewTheme === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : previewTheme;
      const shot = await api.screenshot(id, {
        path: where.path,
        width,
        height,
        scrollX: Math.round(where.x),
        scrollY: Math.round(where.y),
        colorScheme,
        forced: previewTheme !== "auto",
      });
      const img = new Image();
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error("Could not read the screenshot."));
        img.src = `data:image/png;base64,${shot.png}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      ctx.strokeStyle = "#e5484d";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const st of strokes) {
        ctx.beginPath();
        st.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.stroke();
      }
      const dataBase64 = canvas.toDataURL("image/png").split(",")[1]!;
      const name = `drawing-${where.path.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "home"}.png`;
      const saved = await api.upload(id, { name, type: "image/png", dataBase64 });
      setAttachments((a) => [...a, { path: saved.path, name, type: "image/png" }]);
      setPrompt((pr) => pr || "In the attached drawing (marked in red), ");
      setTool(null);
      setTimeout(() => promptRef.current?.focus(), 0);
    } catch (e) {
      setError(errText(e));
    } finally {
      setAttachingDrawing(false);
    }
  }

  // Comments pinned to elements in the preview (shared with the team, live).
  const [comments, setComments] = useState<ProjectComment[]>([]);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [draftAnchor, setDraftAnchor] = useState<CommentAnchor | null>(null);
  const threads = useMemo(() => toThreads(comments), [comments]);
  const openThreads = threads.filter((t) => !t.resolved).length;
  useEffect(() => {
    api.listComments(id).then(setComments, () => undefined);
  }, [id, commentsVersion]);
  // Fix from logs: the app's recorded problems (live via problems_changed).
  const [problems, setProblems] = useState<AppProblem[] | null>(null);
  useEffect(() => {
    api.problems(id).then(setProblems, () => undefined);
  }, [id, problemsVersion]);
  const openProblems = problems?.filter((p) => p.status === "open").length ?? 0;
  // Saved tests change when they're replayed or the QA agent reports new proposals.
  const pushCount = useMemo(() => events.filter((e) => e.type === "github.push" || e.type === "pull_request" || e.type === "github.sync").length, [events]);
  const testEvents = useMemo(() => events.filter((e) => e.type === "tests.result" || e.type === "qa.report").length, [events]);
  const pinsScroll = useRef(false);
  const [missingPins, setMissingPins] = useState<Set<string>>(() => new Set());
  const sendPins = useCallback(() => {
    if (!previewOrigin) return;
    const pins = threads
      .filter((t) => t.anchor && !t.resolved)
      .map((t) => ({
        id: t.id,
        n: t.n,
        page: t.anchor!.page,
        selector: t.anchor!.selector,
        // What the preview needs to find the element again if the page changed since.
        tag: t.anchor!.tag,
        html: t.anchor!.html,
        text: t.anchor!.text,
        section: t.anchor!.section,
        title: `${t.userName}: ${t.body.slice(0, 80)}`,
        active: t.id === activeComment,
      }));
    iframeRef.current?.contentWindow?.postMessage({ type: "forge:pins", pins, scroll: pinsScroll.current }, previewOrigin);
    pinsScroll.current = false;
  }, [previewOrigin, threads, activeComment]);
  useEffect(sendPins, [sendPins]);
  const activateComment = (commentId: string | null) => {
    pinsScroll.current = commentId !== null;
    setActiveComment(commentId);
  };
  // "Ask the agent to fix this": the comment becomes the prompt, aimed at its element.
  const askAgent = (t: Thread) => {
    if (t.anchor) {
      setPicked({
        tag: t.anchor.tag,
        text: t.anchor.text ?? "",
        role: "",
        classes: "",
        path: t.anchor.selector,
        section: t.anchor.section ?? "",
        url: t.anchor.page,
        html: t.anchor.html ?? "",
      });
    }
    const replies = t.replies.map((r) => `${r.userName}: ${r.body}`).join("\n");
    setPrompt(`${t.body}${replies ? `\n\nDiscussion:\n${replies}` : ""}\n\n(From comment #${t.n} by ${t.userName}${t.guest ? ", a reviewer outside the team" : ""}.)`);
    setTab("chat");
  };
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!previewOrigin || e.origin !== previewOrigin) return;
      if (e.data?.type === "forge:selected" && e.data.element) {
        const el = e.data.element as Picked;
        if (inspectFor === "comment") {
          const label = `<${el.tag}>${el.text ? ` "${el.text.slice(0, 40)}"` : ""}${el.section ? ` in ${el.section.slice(0, 40)}` : ""}`;
          setDraftAnchor({
            page: el.url,
            selector: el.path,
            label,
            tag: el.tag,
            text: el.text.slice(0, 200),
            section: el.section.slice(0, 120),
            html: el.html.slice(0, 1200),
          });
          setTab("comments");
        } else {
          setPicked(el);
        }
        setInspecting(false);
      } else if (e.data?.type === "forge:location" && typeof e.data.path === "string") {
        const title = typeof e.data.title === "string" ? e.data.title.slice(0, 80) : "";
        if (splitRef.current && e.source === splitRef.current.contentWindow) {
          const path = e.data.path as string;
          setTabs((list) => list.map((t) => (t.id === splitId ? { ...t, path, title: title || t.title } : t)));
          return;
        }
        if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
        onLocation(e.data.path, title);
      } else if (e.data?.type === "forge:text-edit" && e.data.element) {
        // Edited in place: aim a ready-to-send request at that element.
        setInspecting(false);
        setPicked(e.data.element as Picked);
        setMode("build");
        setPrompt(`Change the text "${String(e.data.before)}" to "${String(e.data.after)}".`);
        setTimeout(() => promptRef.current?.focus(), 0);
      } else if (e.data?.type === "forge:text-cancel") {
        setInspecting(false);
      } else if (e.data?.type === "forge:key" && typeof e.data.key === "string") {
        window.dispatchEvent(new CustomEvent("forge:shortcut", { detail: e.data.key }));
      } else if (e.data?.type === "forge:scroll") {
        scrollWaiter.current?.({ x: Number(e.data.x) || 0, y: Number(e.data.y) || 0, path: String(e.data.path || currentPath) });
        scrollWaiter.current = null;
      } else if (e.data?.type === "forge:open-palette") {
        window.dispatchEvent(new Event("forge:open-palette"));
      } else if (e.data?.type === "forge:pin-reanchor" && typeof e.data.id === "string" && typeof e.data.selector === "string") {
        // The preview found a pinned element again after the page changed: remember its new path.
        api.updateComment(id, e.data.id, { selector: e.data.selector }).catch(() => undefined);
      } else if (e.data?.type === "forge:pins-missing" && Array.isArray(e.data.ids)) {
        setMissingPins(new Set((e.data.ids as unknown[]).filter((x): x is string => typeof x === "string")));
      } else if (e.data?.type === "forge:pin-click" && typeof e.data.id === "string") {
        activateComment(e.data.id);
        setTab("comments");
      } else if (e.data?.type === "forge:inspector-ready") {
        sendPins();
        setFrameReady((n) => n + 1); // a new page loaded: re-apply the app theme
        // The page reloaded while selecting: switch the new page's inspector on too.
        if (inspecting) iframeRef.current?.contentWindow?.postMessage({ type: "forge:inspect", on: true, mode: inspectFor === "text" ? "text" : "select" }, previewOrigin);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id, previewOrigin, inspecting, inspectFor, sendPins, onLocation, currentPath, splitId]);

  // Reload the preview when a run finishes or a version is restored (HMR covers most edits).
  const lastFinished = useMemo(() => events.filter((e) => e.type === "run.finished").length, [events]);
  // After a run or a restore, reload the page the user is on (not a remount back to "/").
  const autoReloadKey = lastFinished + commitCount;
  useEffect(() => {
    if (autoReloadKey > 0 && previewOrigin) {
      iframeRef.current?.contentWindow?.postMessage({ type: "forge:nav", action: "reload" }, previewOrigin);
    }
  }, [autoReloadKey, previewOrigin]);
  useEffect(() => {
    if (!project) return;
    api.files(id).then((r) => setFiles(r.files), () => setFiles([]));
  }, [id, project, commitCount]);
  const routes = useMemo(() => routesFromFiles(files ?? []), [files]);
  const navigate = (action: "back" | "forward" | "reload" | "go", path?: string) => {
    if (!previewOrigin) return;
    if (action === "back" || action === "forward") pendingNav.current = action;
    iframeRef.current?.contentWindow?.postMessage({ type: "forge:nav", action, path }, previewOrigin);
  };

  async function attach(list: FileList | File[]) {
    const files = Array.from(list);
    const problem = attachmentProblem(files, attachments.length);
    if (problem) return setError(problem);
    setUploading(true);
    setError(null);
    try {
      // One at a time, so each chip appears as soon as its file is saved.
      for (const f of files) {
        const [saved] = await uploadFiles(id, [f]);
        setAttachments((a) => [...a, saved!]);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setUploading(false);
    }
  }
  const insertAtCursor = (text: string) => {
    const el = promptRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    // Typing "@" opened the menu: replace that "@" with the reference.
    const from = prompt[start - 1] === "@" ? start - 1 : start;
    const next = prompt.slice(0, from) + text + prompt.slice(end);
    setPrompt(next);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(from + text.length, from + text.length);
    }, 0);
  };
  // A secret change restarts the app's server; reload the preview once it is back up.
  const seenSecretNotices = useRef<number | null>(null);
  useEffect(() => {
    if (!caughtUp) return;
    if (seenSecretNotices.current === null || secretNotices <= seenSecretNotices.current) {
      seenSecretNotices.current = secretNotices; // history on page load: nothing to reload for
      return;
    }
    seenSecretNotices.current = secretNotices;
    const t = setTimeout(() => setPreviewKey((k) => k + 1), 6000);
    return () => clearTimeout(t);
  }, [secretNotices, caughtUp]);

  useEffect(() => {
    feedEnd.current?.scrollIntoView({ block: "end" });
    // Also when coming back to the Chat tab, which remounts the feed at the top.
  }, [items.length, streaming?.text, tab, panel.collapsed]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = prompt.trim();
    // While the agent works, the message joins the queue (it runs when the agent is done).
    if (!text || sending || pendingPause) return;
    setSending(true);
    setError(null);
    const withElement0 = picked
      ? [
          text,
          "",
          `(Selected in the preview on ${picked.url}: a <${picked.tag}>${picked.text ? ` showing "${picked.text}"` : ""}${picked.section ? `, in the "${picked.section}" section` : ""}. Apply the request to this element.`,
          `DOM path: ${picked.path}`,
          `Classes: ${picked.classes || "(none)"}`,
          `HTML: ${picked.html})`,
        ].join("\n")
      : text;
    // Attached files live in .forge/uploads/; the agent opens them with its Read tool (images too).
    const withElement = withElement0 + attachmentSuffix(attachments);
    try {
      const r = await api.startRun(id, withElement, mode, models && models.models.length > 1 ? (effectiveModelKey ?? undefined) : undefined);
      if (r.queued) void refreshQueue();
      setPrompt("");
      setPicked(null);
      setAttachments([]);
    } catch (err) {
      setError(errText(err));
    } finally {
      setSending(false);
    }
  }

  if (error && !project) {
    return (
      <main className="p-8">
        <Link href="/" className="btn btn-sm">
          All projects
        </Link>
        <p className="mt-6 text-danger">{error}</p>
      </main>
    );
  }

  // The frame's size in CSS pixels, scaled down to fit the stage when larger.
  const vpSize = viewportSize(viewport);
  // Filling the stage leaves room at the right and bottom for the resize handles.
  const frameW = vpSize.width ?? Math.max(240, stage.w - 28);
  const frameH = vpSize.height ?? Math.max(240, stage.h - 16);
  const frameScale = Math.min(1, stage.w / frameW, stage.h / frameH);
  const startFrameResize = (e: React.PointerEvent, edges: { x: boolean; y: boolean }) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const w0 = frameW;
    const h0 = frameH;
    const sc = frameScale;
    setFrameResizing(true);
    const size = (ev: PointerEvent) => ({
      preset: "responsive",
      rotated: false,
      // Dragging one edge keeps the other dimension filling the space (null) unless already fixed.
      width: edges.x ? Math.max(240, Math.round(w0 + ((ev.clientX - sx) * 2) / sc)) : vpSize.width,
      height: edges.y ? Math.max(240, Math.round(h0 + (ev.clientY - sy) / sc)) : vpSize.height,
    });
    const move = (ev: PointerEvent) => setViewport(size(ev), false);
    const up = (ev: PointerEvent) => {
      setViewport(size(ev));
      setFrameResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const MODES = [
    { id: "chat", label: "Build", icon: Hammer },
    { id: "comments", label: "Comments", icon: MessagesSquare },
    { id: "versions", label: "Versions", icon: History },
    { id: "spec", label: "Spec", icon: ScrollText },
    { id: "brain", label: "Brain", icon: Brain },
    { id: "health", label: "Health", icon: HeartPulse },
  ] as const;

  return (
    <main className="flex h-dvh min-h-0 flex-col bg-paper">
      {/* Top bar: project switcher, modes, go-to search, project actions */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <ProjectSwitcher
          projectId={id}
          name={project?.name ?? "…"}
          onRename={
            canBuild && project
              ? async (name) => {
                  const updated = await api.updateSettings(id, { name });
                  setProject((p) => (p ? { ...p, name: updated.name } : p));
                }
              : undefined
          }
        />
        <div role="tablist" aria-label="Mode" className="seg">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={tab === m.id} onClick={() => setTab(m.id)} className="mode">
              <m.icon size={14} aria-hidden />
              {m.label}
              {m.id === "comments" && openThreads > 0 && <span className="pill pill-count text-[11px]">{openThreads}</span>}
              {m.id === "health" && openProblems > 0 && (
                <span className="pill pill-count bg-danger text-[11px]" aria-label={`${openProblems} open problems`}>
                  {openProblems}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex min-w-48 max-w-sm flex-1">
          <CommandPalette placeholder="Go to a project or page" />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <PresenceStack users={presence} meId={meId} />
          <ShareButton projectId={id} onError={showError} />
          {canBuild && (
            <>
              <SecretsButton projectId={id} disabled={running} refreshKey={secretNotices} onError={showError} />
              <ApisPicker projectId={id} disabled={running} onError={showError} />
              {project && <AutoQaSwitch project={project} onChange={setProject} onError={showError} />}
              <button
                disabled={running}
                title={running ? "Wait for the agent to finish" : "A QA agent clicks through the app and reports problems"}
                onClick={() => api.startQa(id).catch((e) => setError(errText(e)))}
                className="btn btn-sm"
              >
                <FlaskConical size={14} aria-hidden />
                Test the app
              </button>
            </>
          )}
          {project?.myRole === "viewer" && <span className="pill">View only</span>}
          {canBuild && (
            <GitHubButton
              projectId={id}
              projectName={project?.name ?? "app"}
              disabled={running || unsaved}
              disabledReason={running ? "Wait for the agent to finish" : "Save or discard changes first"}
              refreshKey={pushCount}
              onOpenHealth={() => {
                setTab("health");
                setPanelPrefs({ collapsed: false });
              }}
              onStarted={() => {
                setTab("chat");
                setPanelPrefs({ collapsed: false });
              }}
            />
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Open projects as tabs */}
      <nav aria-label="Open projects" className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-surface px-4">
        {openTabs.map((t) => (
          <span key={t.id} className="tab pr-1" aria-current={t.id === id ? "page" : undefined}>
            <Link href={`/projects/${t.id}`} className="flex items-center gap-2">
              <ProjectBadge id={t.id} name={t.name} size={16} />
              {t.name}
            </Link>
            {t.id !== id && (
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                onClick={() => closeProject(t.id)}
                className="flex size-[22px] items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
              >
                <X size={13} aria-hidden />
              </button>
            )}
          </span>
        ))}
        {project?.repo && (
          <span className="ml-auto hidden items-center gap-1.5 pb-2 text-xs text-ink-2 sm:flex">
            <GitBranch size={13} aria-hidden />
            {project.repo} · <code className="font-mono">{project.workBranch}</code>
          </span>
        )}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Left panel: the selected mode */}
        {panel.collapsed && (
          <div className="hidden shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-2 md:flex md:w-11">
            <button
              type="button"
              className="btn btn-g btn-sm btn-icon"
              aria-label="Show the chat panel"
              title="Show the chat panel"
              onClick={() => setPanelPrefs({ collapsed: false })}
            >
              <PanelLeftOpen size={16} aria-hidden />
            </button>
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.label}
                aria-label={m.label}
                onClick={() => {
                  setTab(m.id);
                  setPanelPrefs({ collapsed: false });
                }}
                className={`flex size-8 items-center justify-center rounded-md ${tab === m.id ? "bg-primary-weak text-primary" : "text-ink-2 hover:bg-surface-2"}`}
              >
                <m.icon size={16} aria-hidden />
              </button>
            ))}
            {running && <span className="mt-1 size-2 animate-pulse rounded-full bg-primary" title="Agent working…" />}
          </div>
        )}
        <section
          aria-label={MODES.find((m) => m.id === tab)?.label}
          className={`relative min-h-0 w-full flex-col border-line bg-surface md:w-[var(--panel-w)] md:shrink-0 md:border-r ${panel.collapsed ? "flex md:hidden" : "flex"}`}
          style={{ ["--panel-w" as string]: `${panel.width}px` }}
        >
          <div className="hidden shrink-0 items-center justify-between border-b border-line px-3 py-1 md:flex">
            <span className="lab">{tab === "chat" ? "Chat" : MODES.find((m) => m.id === tab)?.label}</span>
            <button
              type="button"
              className="btn btn-g btn-sm btn-icon h-7"
              aria-label="Hide the chat panel"
              title="Hide the chat panel"
              onClick={() => setPanelPrefs({ collapsed: true })}
            >
              <PanelLeftClose size={16} aria-hidden />
            </button>
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the chat panel"
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            aria-valuenow={panel.width}
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={() => setPanelPrefs({ width: PANEL_DEFAULT })}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setPanelPrefs({ width: panel.width - 24 });
              if (e.key === "ArrowRight") setPanelPrefs({ width: panel.width + 24 });
            }}
            title="Drag to resize · double-click to reset"
            className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize md:block [&:hover>span]:bg-primary [&:focus-visible>span]:bg-primary"
          >
            <span className={`mx-auto block h-full w-0.5 ${resizing ? "bg-primary" : "bg-transparent"}`} />
          </div>
          {tab === "comments" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CommentsPanel
                projectId={id}
                threads={threads}
                meId={meId}
                activeId={activeComment}
                onActivate={activateComment}
                draft={draftAnchor}
                onDraftDone={() => setDraftAnchor(null)}
                onAskAgent={canBuild ? askAgent : undefined}
                onError={showError}
                missingPins={missingPins}
              />
            </div>
          ) : tab === "versions" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <VersionsPanel
                projectId={id}
                refreshKey={commitCount}
                reviewKey={reviewVersion}
                disabled={running || !canBuild}
                onError={showError}
                onCompare={(pair) => {
                  setComparePair(pair);
                  setView("changes");
                }}
              />
            </div>
          ) : tab === "spec" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SpecPanel projectId={id} canBuild={canBuild} running={running} refreshKey={specVersion + testEvents} onStarted={() => setTab("chat")} onError={showError} />
            </div>
          ) : tab === "brain" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <BrainPanel projectId={id} onError={showError} />
            </div>
          ) : tab === "health" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <HealthPanel
                projectId={id}
                problems={problems}
                canBuild={canBuild}
                running={running}
                onStarted={() => setTab("chat")}
                onError={showError}
                refreshKey={testEvents}
                securityKey={securityVersion}
                reviewKey={reviewVersion}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-4">
              {items.length === 0 && !streaming && (
                <p className="text-ink-2">Describe what to build or change. The agent edits the app and you see it update on the right.</p>
              )}
              {items.map((it, i) =>
                it.kind === "qa" ? (
                  <QaReport
                    key={i}
                    e={it.e}
                    disabled={running || !canBuild}
                    onFix={(prompt) => api.startRun(id, prompt).catch((err) => setError(errText(err)))}
                    onSaveTest={canBuild ? (t) => api.saveTest(id, t) : undefined}
                  />
                ) : it.kind === "tests" ? (
                  <TestsResultCard
                    key={i}
                    e={it.e}
                    disabled={running || !canBuild}
                    onFix={async (testId) => {
                      const t = (await api.tests(id)).find((x) => x.id === testId);
                      const r = it.e.results.find((x) => x.testId === testId);
                      if (!t || !r) return setError("That test was deleted.");
                      await api.startRun(id, failedTestPrompt(t.title, t.steps, r.failedStep, r.error)).catch((err) => setError(errText(err)));
                    }}
                  />
                ) : (
                  <FeedItem key={i} item={it} projectId={id} />
                ),
              )}
              {streaming && <Markdown className="leading-relaxed text-ink">{streaming.text}</Markdown>}
              {activity && !pendingPause && (
                <AgentWorking
                  startedAt={runStartedAt}
                  title={activity.title}
                  detail={activity.detail}
                  onStop={canBuild ? stopRun : undefined}
                  stopping={stopping}
                />
              )}
              {pendingPause && canBuild && (planHasSteps ? (
                <PlanSummaryCard pause={pendingPause} open={planOpen} onOpen={() => setHiddenPlan(null)} />
              ) : (
                <PauseCard key={pendingPause.pauseId} projectId={id} pause={pendingPause} onError={showError} />
              ))}
              {unsaved && !running && canBuild && (
                <div className="space-y-2 rounded-[10px] border border-warn/40 bg-warn-weak p-3">
                  <p className="font-semibold">These changes are not saved yet</p>
                  <p className="text-xs text-ink-2">
                    Forge only saves a version when all checks pass. You can ask the agent to keep fixing, or discard the changes and
                    go back to the last saved version.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      disabled={discarding}
                      onClick={async () => {
                        setDiscarding(true);
                        try {
                          await api.discardChanges(id);
                        } catch (e) {
                          setError(errText(e));
                        } finally {
                          setDiscarding(false);
                        }
                      }}
                      className="btn btn-sm"
                    >
                      {(discarding) && <Spinner size={13} />}
                      {discarding ? "Discarding…" : "Discard changes"}
                    </button>
                    <button
                      disabled={discarding}
                      onClick={() =>
                        api
                          .startRun(id, "Forge's checks are still failing. Keep fixing them until everything passes.")
                          .catch((e) => setError(errText(e)))
                      }
                      className="btn btn-p btn-sm"
                    >
                      Keep fixing
                    </button>
                  </div>
                </div>
              )}
              <div ref={feedEnd} />
            </div>
          )}

          {project && !canBuild ? (
            <div className="flex shrink-0 flex-col gap-1 border-t border-line p-3">
              {error && (
                <p className="text-xs text-danger" role="alert">
                  {error}
                </p>
              )}
              <p className="text-[13px] text-ink-2">
                You have <strong className="text-ink">view</strong> access. You can look around, use the app and leave comments with{" "}
                <strong className="text-ink">Comment</strong> above the preview. Ask a project admin (Share) for builder access to make changes.
              </p>
            </div>
          ) : (
          <form
            onSubmit={send}
            // @container: the controls row tightens when the chat column is narrow.
            className={`@container relative flex shrink-0 flex-col gap-2 border-t border-line p-3 ${dragging ? "bg-primary-weak/40" : ""}`}
            onDragOver={(e) => {
              if (!canBuild || !e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.files.length) return;
              e.preventDefault();
              setDragging(false);
              void attach(e.dataTransfer.files);
            }}
          >
            {queue.length > 0 && (
              <QueueList
                items={queue}
                running={running}
                canEdit={canBuild}
                onRemove={(qid) => {
                  setQueue((q) => q.filter((x) => x.id !== qid));
                  api.removeQueued(id, qid).catch((err) => {
                    setError(errText(err));
                    void refreshQueue();
                  });
                }}
                onRunNext={() => api.runNextQueued(id).catch((err) => setError(errText(err)))}
              />
            )}
            {dragging && (
              <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-[10px] border-2 border-dashed border-primary bg-surface/80 text-[13px] font-semibold text-primary">
                Drop files to attach them
              </div>
            )}
            {error && (
              <p className="text-xs text-danger" role="alert">
                {error}
              </p>
            )}
            {picked && (
              <div className="flex items-center gap-2 text-xs">
                <span className="pill pill-pri">Editing</span>
                <code className="truncate font-mono text-ink-2">
                  &lt;{picked.tag}&gt; {picked.text || picked.path}
                </code>
                <button
                  type="button"
                  disabled={running}
                  onClick={() =>
                    setPrompt(
                      "Save the component that renders this element to the team component library, so other projects can reuse it. " +
                        "Make it self-contained first (props for its data and labels), keep this app working, then save it with every file it needs.",
                    )
                  }
                  title="Prepare a request to save this component for the whole team"
                  className="btn btn-sm ml-auto h-7 shrink-0"
                >
                  Save to library
                </button>
                <button type="button" onClick={() => setPicked(null)} className="btn btn-g btn-sm btn-icon h-7" aria-label="Clear selected element">
                  <X size={14} aria-hidden />
                </button>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span key={a.path} className="pill gap-1.5 bg-surface-2 py-1 pr-1">
                    <AttachmentIcon name={a.name} type={a.type} />
                    <span className="max-w-40 truncate">{a.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => setAttachments((list) => list.filter((x) => x.path !== a.path))}
                      className="rounded p-0.5 hover:bg-surface"
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {importingFigma && (
              <p className="flex items-center gap-2 text-xs text-ink-2" role="status">
                <Spinner size={13} />
                Importing the Figma frame…
              </p>
            )}
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => {
                const v = e.target.value;
                setPrompt(v);
                // "@" at the start or after a space opens "Add context".
                const at = e.target.selectionStart;
                if (v[at - 1] === "@" && (at === 1 || /\s/.test(v[at - 2] ?? ""))) setMenu({ open: true, startIn: "context", query: "" });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                // Pasting a screenshot attaches it.
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void attach(e.clipboardData.files);
                  return;
                }
                // Pasting a Figma frame link imports the frame (image + spec) and switches to Design.
                const pasted = e.clipboardData.getData("text").trim();
                if (/^https:\/\/(www\.)?figma\.com\/(design|file|proto|board)\//.test(pasted)) {
                  e.preventDefault();
                  setImportingFigma(true);
                  setError(null);
                  api.importFigma(id, pasted).then(
                    (r) => {
                      setAttachments((list) => [...list, ...r.attachments]);
                      setMode("design");
                    },
                    (err) => setError(errText(err)),
                  ).finally(() => setImportingFigma(false));
                }
              }}
              aria-label={mode === "chat" ? "Ask a question" : "Ask for a change"}
              placeholder={
                pendingPause
                  ? "Answer the agent above to continue"
                  : running
                    ? "Keep going: your message waits in the queue until the agent is done…"
                    : mode === "chat"
                      ? "Ask anything about this app…"
                      : mode === "plan"
                        ? "Describe what to build; you'll get a spec to approve first…"
                        : mode === "design"
                          ? "Paste a Figma frame link or a screenshot, and say where it goes…"
                        : "Ask for a change… (@ to add a page or file)"
              }
              disabled={Boolean(pendingPause)}
              className="in min-h-20 resize-none disabled:opacity-60"
            />
            <div className="flex items-center gap-2 @max-[28rem]:gap-1.5">
              <ComposerMenu
                open={menu.open}
                onOpenChange={(o) => setMenu((m) => ({ ...m, open: o, startIn: o ? m.startIn : "root" }))}
                startIn={menu.startIn}
                initialQuery={menu.query}
                routes={routes}
                files={files ?? []}
                canAttach
                onInsert={insertAtCursor}
                onAttach={(list) => void attach(list)}
                projectActions={[
                  { id: "comments", label: "Comments", run: () => setTab("comments") },
                  { id: "versions", label: "Versions", run: () => setTab("versions") },
                  { id: "spec", label: "Spec (what the app does, acceptance criteria)", run: () => setTab("spec") },
                  { id: "brain", label: "Brain (project notes)", run: () => setTab("brain") },
                  { id: "health", label: "Health (problems, tests, security)", run: () => setTab("health") },
                  { id: "code", label: "Code", run: () => setView("code") },
                  { id: "test", label: "Test the app", run: () => void api.startQa(id).catch((e) => setError(errText(e))) },
                  { id: "download", label: "Download code (.zip)", run: () => window.location.assign(api.downloadUrl(id, project?.name ?? id)) },
                ]}
              />
              {uploading && <span className="lab">Attaching…</span>}
              <span className="ml-auto" />
              {models && effectiveModelKey && <ModelPicker data={models} value={effectiveModelKey} onChange={setModelKey} mode={mode} />}
              {canBuild && (
                <AutoToggle on={Boolean(project?.autonomous)} mode={mode} onChange={setAutonomous} />
              )}
              <ModeSelect mode={mode} onChange={setMode} autonomous={Boolean(project?.autonomous)} onAutonomous={canBuild ? setAutonomous : undefined} />
              {running && (
                <button type="button" onClick={stopRun} disabled={stopping} className="btn btn-sm" title="Stop the agent (queued messages wait)">
                  {stopping ? <Spinner size={13} /> : <Square size={11} className="fill-current" aria-hidden />}
                  {stopping ? "Stopping…" : "Stop"}
                </button>
              )}
              <button
                type="submit"
                disabled={!prompt.trim() || sending || uploading || Boolean(pendingPause)}
                className="btn btn-p btn-sm"
                title={running ? "Runs when the agent is done" : undefined}
              >
                {sending ? <Spinner size={13} /> : running ? <ListPlus size={14} aria-hidden /> : <SendHorizontal size={14} aria-hidden />}
                {sending ? "Sending…" : running ? "Queue" : mode === "chat" ? "Ask" : "Send"}
              </button>
            </div>
          </form>
          )}
        </section>

        {/* Preview */}
        <section aria-label="Preview" className="relative flex min-h-[50vh] min-w-0 flex-1 flex-col">
          {canBuild && <SharePreviewModal projectId={id} open={sharing} onClose={() => setSharing(false)} />}
          {planOpen && pendingPause && (
            <PlanPanel
              key={pendingPause.pauseId}
              projectId={id}
              pause={pendingPause}
              onClose={() => setHiddenPlan(pendingPause.pauseId)}
              onError={showError}
            />
          )}
          <div className="flex shrink-0 flex-wrap items-end gap-2 bg-surface px-3 pt-1.5">
            <div className="seg mb-1" role="tablist" aria-label="View">
              <button role="tab" aria-selected={view === "preview"} className="mode" onClick={() => setView("preview")}>
                <Globe size={14} aria-hidden />
                Preview
              </button>
              <button role="tab" aria-selected={view === "code"} className="mode" onClick={() => setView("code")}>
                <Code2 size={14} aria-hidden />
                Code
              </button>
              <button role="tab" aria-selected={view === "changes"} className="mode" onClick={() => setView("changes")} data-tip="Compare versions">
                <GitCompare size={14} aria-hidden />
                Changes
              </button>
            </div>
            {view === "preview" && sandbox?.previewUrl ? (
              <PreviewTabs
                tabs={tabs}
                groups={tabGroups}
                activeId={activeTab}
                splitId={splitId}
                routes={routes}
                onSelect={(tabId) => {
                  const t = tabs.find((x) => x.id === tabId);
                  if (!t) return;
                  if (tabId === splitId) setSplitId(null); // it moves to the main view
                  setActiveTab(tabId);
                  if (t.path !== currentPath) navigate("go", t.path);
                }}
                onChange={(nextTabs, nextGroups) => {
                  setTabs(nextTabs);
                  setTabGroups(nextGroups);
                }}
                onCloseMany={(ids) => {
                  let rest = tabs.filter((x) => !ids.includes(x.id));
                  if (!rest.length) rest = [{ id: `t${Date.now().toString(36)}`, path: "/", title: "" }];
                  const used = new Set(rest.map((t) => t.group).filter(Boolean));
                  setTabs(rest);
                  setTabGroups((g) => g.filter((x) => used.has(x.id)));
                  if (splitId && ids.includes(splitId)) setSplitId(null);
                  if (ids.includes(activeTab)) {
                    const i = tabs.findIndex((x) => x.id === activeTab);
                    const next = rest[Math.min(Math.max(0, i), rest.length - 1)]!;
                    setActiveTab(next.id);
                    navigate("go", next.path);
                  }
                }}
                onSplit={setSplitId}
                onOpen={(r) => {
                  const tabId = `t${Date.now().toString(36)}`;
                  setTabs((list) => [...list, { id: tabId, path: r.path, title: "" }]);
                  setActiveTab(tabId);
                  if (r.dynamic) barRef.current?.edit(r.path);
                  else navigate("go", r.path);
                }}
              />
            ) : (
              <span className="mb-2 min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
                {view === "code" ? `${files?.length ?? "…"} files · read only` : view === "changes" ? "Compare two versions" : sandboxLabel(sandbox)}
              </span>
            )}
            {sandbox?.previewUrl && (
              <div className="mb-1 ml-auto flex flex-wrap items-center gap-1.5">
                {view === "preview" && (
                  <>
                    {!splitId && <ViewportPicker actual={{ width: Math.round(frameW), height: Math.round(frameH) }} scale={frameScale} />}
                  </>
                )}
                <MoreMenu
                  toolbarHidden={toolbarPrefs.placement === "hide"}
                  onOpenInTab={() => {
                    // A new tab is a different context: open it through its own entry link.
                    const w = window.open("about:blank", "_blank");
                    api.previewAccess(id, { next: currentPath }).then(
                      (r) => {
                        if (w) w.location.href = r.url;
                      },
                      (e) => {
                        w?.close();
                        setError(errText(e));
                      },
                    );
                  }}
                  onShare={canBuild ? () => setSharing(true) : undefined}
                  downloadUrl={api.downloadUrl(id, project?.name ?? id)}
                  canBuild={canBuild}
                  onHardReload={() => {
                    setNav({ stack: ["/"], idx: 0 });
                    setPreviewKey((k) => k + 1);
                  }}
                  onRestart={() =>
                    api.restartApp(id).then(
                      () => setTimeout(() => setPreviewKey((k) => k + 1), 6000),
                      (e) => setError(errText(e)),
                    )
                  }
                />
              </div>
            )}
          </div>
          {view === "preview" && sandbox?.previewUrl && (
            <div className="flex shrink-0 items-center gap-2 border-y border-line bg-paper px-3 py-1.5">
              <BrowserBar
                ref={barRef}
                path={currentPath}
                routes={routes}
                canBack={nav.idx > 0}
                canForward={nav.idx < nav.stack.length - 1}
                onBack={() => navigate("back")}
                onForward={() => navigate("forward")}
                onReload={() => navigate("reload")}
                onGo={(pth) => navigate("go", pth)}
                disabled={Boolean(qaFrame && running)}
                live={{
                  color: running ? "animate-pulse bg-primary" : connected ? "bg-ok" : "bg-ink-3",
                  label: running ? "Agent working…" : connected ? "Live" : "Reconnecting…",
                }}
              />
            </div>
          )}
          {view !== "preview" && <div className="border-b border-line" />}
          <div className="dots relative min-h-0 flex-1 overflow-auto p-4 pb-20 sm:p-6 sm:pb-20">
            {view === "preview" && sandbox?.previewUrl && !(qaFrame && running) && (
              <ReviewToolbar
                active={activeTool}
                onTool={setTool}
                canBuild={canBuild}
                drawing={{ onDone: () => void attachDrawing(), onClear: () => setStrokes([]), busy: attachingDrawing }}
                theme={previewTheme}
                onTheme={(m) => setPreviewTheme(id, m)}
              />
            )}
            {view === "code" ? (
              <CodeView projectId={id} files={files} refreshKey={commitCount} />
            ) : view === "changes" ? (
              <CompareView projectId={id} pair={comparePair} onPair={setComparePair} previewUrl={sandbox?.previewUrl ?? null} refreshKey={commitCount} />
            ) : qaFrame && running ? (
              <QaLiveView frame={qaFrame.data} events={events} runId={qaFrame.runId} />
            ) : sandbox?.previewUrl ? (
              <div ref={stageRef} className={`flex h-full gap-3 ${splitId ? "" : "justify-center"}`}>
              <div
                className={`relative ${splitId ? "min-w-0 flex-1" : "shrink-0"}`}
                style={splitId ? undefined : { width: frameW * frameScale, height: frameH * frameScale }}
              >
              <div
                ref={frameBox}
                className="pop relative overflow-hidden bg-white"
                style={
                  splitId
                    ? { width: "100%", height: "100%" }
                    : { width: frameW, height: frameH, transform: frameScale < 1 ? `scale(${frameScale})` : undefined, transformOrigin: "top left" }
                }
              >
                {drawing && <DrawLayer strokes={strokes} onStrokes={setStrokes} scale={splitId ? 1 : frameScale} />}
                {preview.state === "down" && <PreviewOffline onRetry={preview.retry} />}
                <iframe
                  ref={iframeRef}
                  key={`${previewKey}:${accessEpoch}`}
                  src={previewEntry ?? undefined}
                  title="App preview"
                  className={`h-full w-full border-0 ${resizing || frameResizing ? "pointer-events-none" : ""}`}
                />
              </div>
              {!splitId && (
                <>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Drag to change the preview width"
                    onPointerDown={(e) => startFrameResize(e, { x: true, y: false })}
                    onDoubleClick={() => setViewport({ preset: "responsive", width: null, height: null, rotated: false })}
                    className="group absolute -right-3 top-1/2 flex h-16 w-3 -translate-y-1/2 cursor-ew-resize items-center justify-center"
                  >
                    <span className="h-10 w-1 rounded-full bg-line-2 group-hover:bg-primary" />
                  </div>
                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Drag to change the preview height"
                    onPointerDown={(e) => startFrameResize(e, { x: false, y: true })}
                    onDoubleClick={() => setViewport({ preset: "responsive", width: null, height: null, rotated: false })}
                    className="group absolute -bottom-3 left-1/2 flex h-3 w-16 -translate-x-1/2 cursor-ns-resize items-center justify-center"
                  >
                    <span className="h-1 w-10 rounded-full bg-line-2 group-hover:bg-primary" />
                  </div>
                  <div
                    role="separator"
                    aria-label="Drag to change the preview size"
                    onPointerDown={(e) => startFrameResize(e, { x: true, y: true })}
                    onDoubleClick={() => setViewport({ preset: "responsive", width: null, height: null, rotated: false })}
                    className="absolute -bottom-3 -right-3 size-4 cursor-nwse-resize rounded-br-md border-b-2 border-r-2 border-line-2 hover:border-primary"
                  />
                  {frameResizing && (
                    <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded bg-ink px-2 py-0.5 font-mono text-xs text-paper">
                      {Math.round(frameW)} × {Math.round(frameH)}
                    </span>
                  )}
                </>
              )}
              </div>
              {splitId && (() => {
                const st = tabs.find((t) => t.id === splitId);
                if (!st) return null;
                return (
                  <div className="pop relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-white">
                    <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs">
                      <Columns2 size={13} className="text-primary" aria-hidden />
                      <span className="truncate font-semibold text-ink">{st.title || st.path}</span>
                      <code className="truncate font-mono text-ink-3">{st.path}</code>
                      <button type="button" className="btn btn-g btn-sm btn-icon ml-auto h-6" aria-label="Close split view" onClick={() => setSplitId(null)}>
                        <X size={13} aria-hidden />
                      </button>
                    </div>
                    <iframe
                      ref={splitRef}
                      key={`split-${splitId}-${previewKey}-${accessEpoch}`}
                      src={sandbox.previewUrl + st.path}
                      title="Split view of the app"
                      className={`min-h-0 w-full flex-1 border-0 ${resizing ? "pointer-events-none" : ""}`}
                    />
                  </div>
                );
              })()}
              </div>
            ) : (
              <div className="grid h-full place-items-center p-6 text-center text-ink-2">
                {sandbox?.state === "error" ? (
                  <span className="text-danger">Sandbox failed to start: {sandbox.error}</span>
                ) : sandbox?.stage ? (
                  <ForgeLoader
                    label={`${sandbox.stage}…`}
                    sub="Imported repos install their dependencies and run Forge's checks once. This can take a few minutes."
                  />
                ) : (
                  <ForgeLoader label="Starting the app…" sub="The first start takes a little longer." />
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/** "More" in the preview toolbar: open, copy link, download code, reload, restart the app server. */
function MoreMenu({
  toolbarHidden,
  onOpenInTab,
  onShare,
  downloadUrl,
  canBuild,
  onHardReload,
  onRestart,
}: {
  toolbarHidden: boolean;
  onOpenInTab: () => void;
  /** Share links for people outside Forge (builders). */
  onShare?: () => void;
  downloadUrl: string;
  canBuild: boolean;
  onHardReload: () => void;
  onRestart: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !e.composedPath().includes(box.current)) setOpen(false);
    };
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setOpen(false), 0);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);
  const item = "nav text-[14px]";
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="More" title="More" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Layers size={15} aria-hidden />
      </button>
      {open && (
        <div className="pop absolute right-0 top-10 z-30 w-60 p-1.5">
          {toolbarHidden && (
            <button type="button" className={item} onClick={() => (setToolbarPrefs({ placement: "dock" }), setOpen(false))}>
              <PanelBottom size={15} aria-hidden />
              Show the review toolbar
            </button>
          )}
          <button type="button" className={item} onClick={() => (onOpenInTab(), setOpen(false))}>
            <ExternalLink size={15} aria-hidden />
            Open in a new tab
          </button>
          {onShare && (
            <button type="button" className={item} onClick={() => (onShare(), setOpen(false))}>
              <Link2 size={15} aria-hidden />
              Share preview link…
            </button>
          )}
          <a className={item} href={downloadUrl} onClick={() => setOpen(false)}>
            <Download size={15} aria-hidden />
            Download code (.zip)
          </a>
          <button type="button" className={item} onClick={() => (onHardReload(), setOpen(false))}>
            <RotateCw size={15} aria-hidden />
            Reload from the home page
          </button>
          {canBuild && (
            <button type="button" className={item} onClick={() => (onRestart(), setOpen(false))}>
              <Power size={15} aria-hidden />
              Restart the app server
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The project name button; opens a list of the team's projects (Flowkite's app switcher). */
function ProjectSwitcher({ projectId, name, onRename }: { projectId: string; name: string; onRename?: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  // Renaming happens in place at the top of this menu (builders and admins).
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const startRename = () => {
    setDraft(name);
    setRenameError(null);
    setRenaming(true);
  };
  const saveRename = async () => {
    const next = draft.trim();
    if (!onRename || !next || next === name) return setRenaming(false);
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(next);
      setRenaming(false);
    } catch (e) {
      setRenameError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const [projects, setProjects] = useState<Project[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    api.listProjects().then(setProjects, () => undefined);
    const close = (e: MouseEvent) => {
      if (box.current && !e.composedPath().includes(box.current)) setOpen(false);
    };
    // Clicks inside the preview iframe never reach this document; the window losing focus to it does.
    const closeOnBlur = () => setTimeout(() => document.activeElement?.tagName === "IFRAME" && setOpen(false), 0);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setRenaming(false);
        }}
        onDoubleClick={() => {
          if (!onRename) return;
          setOpen(true);
          startRename();
        }}
        title={onRename ? "Switch project (double-click to rename)" : "Switch project"}
        aria-expanded={open}
        aria-label={`Project: ${name}. Switch or rename project`}
        className="flex h-9 items-center gap-2 rounded-lg border border-line-2 bg-surface pl-1 pr-2.5 font-semibold"
      >
        <ProjectBadge id={projectId} name={name} />
        <span className="max-w-48 truncate">{name}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="pop absolute left-0 top-11 z-30 flex w-80 flex-col gap-2 p-3">
          <div className="flex items-center gap-2.5 border-b border-line pb-2.5">
            <ProjectBadge id={projectId} name={renaming ? draft || name : name} size={32} />
            {renaming ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveRename();
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  maxLength={80}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setRenaming(false);
                    }
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Project name"
                  className="in h-8 min-w-0 flex-1 text-[13.5px] font-semibold"
                  disabled={saving}
                />
                <button type="submit" className="btn btn-p btn-sm btn-icon" aria-label="Save name" disabled={saving || !draft.trim()}>
                  {saving ? <Spinner size={13} /> : <Check size={14} aria-hidden />}
                </button>
                <button type="button" className="btn btn-g btn-sm btn-icon" aria-label="Cancel" onClick={() => setRenaming(false)} disabled={saving}>
                  <X size={14} aria-hidden />
                </button>
              </form>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
                {onRename && (
                  <button type="button" className="btn btn-g btn-sm" onClick={startRename}>
                    <Pencil size={13} aria-hidden />
                    Rename
                  </button>
                )}
              </>
            )}
          </div>
          {renameError && (
            <p className="text-[12.5px] text-danger" role="alert">
              {renameError}
            </p>
          )}
          <span className="lab">Team projects</span>
          <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
            {(projects ?? []).map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                onClick={() => setOpen(false)}
                className={`flex flex-col items-center gap-1.5 rounded-[10px] border p-3 text-center ${p.id === projectId ? "border-primary" : "border-line hover:bg-surface-2"}`}
              >
                <ProjectBadge id={p.id} name={p.name} size={36} />
                <span className="line-clamp-2 text-[13px] font-semibold">{p.name}</span>
              </Link>
            ))}
          </div>
          <Link href="/" className="btn btn-sm" onClick={() => setOpen(false)}>
            All projects
          </Link>
        </div>
      )}
    </div>
  );
}

/** A one-line event in the feed: icon + text. */
function EventLine({ icon, tone = "muted", children }: { icon: React.ReactNode; tone?: "muted" | "ok" | "bad" | "pri"; children: React.ReactNode }) {
  const color = { muted: "text-ink-2", ok: "text-ok", bad: "text-danger", pri: "text-primary" }[tone];
  return (
    <p className={`flex items-start gap-2 text-[13px] ${tone === "bad" ? "text-danger" : "text-ink-2"}`}>
      <span className={`mt-0.5 shrink-0 ${color}`}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function FeedItem({ item, projectId }: { item: Item; projectId: string }) {
  switch (item.kind) {
    case "prompt":
      if (item.e.mode === "qa") {
        return (
          <EventLine icon={<FlaskConical size={15} aria-hidden />} tone="pri">
            <strong className="font-semibold text-ink">{item.e.userName}</strong> started a test: the QA agent is clicking through the app in a
            browser.
          </EventLine>
        );
      }
      {
        // Element details from "Select element" are for the agent; show people a short chip instead.
        const [withoutFiles, attached] = splitAttachments(item.e.prompt);
        const [request, context] = splitElementContext(withoutFiles);
        const modeLabel = item.e.mode === "chat" ? "Chat" : item.e.mode === "plan" ? "Plan" : item.e.mode === "design" ? "Design" : null;
        return (
          <div className="ml-auto max-w-[88%] rounded-[10px] rounded-br-sm bg-primary-weak px-3 py-2.5">
            <p className="whitespace-pre-wrap leading-relaxed">{request}</p>
            {(context || attached.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {context && <span className="pill bg-surface font-mono">{context}</span>}
                {attached.map((f) => {
                  // Office files are attached as their text copy (<name>.docx.md): show the original name.
                  const name = f.replace(/^.*\/[a-z0-9]+-/, "").replace(/\.(docx|xlsx|pptx)\.md$/, ".$1");
                  return isImagePath(f) ? (
                    <span key={f} className="flex max-w-[14rem] items-center gap-2 rounded-lg bg-surface p-1 pr-2.5 text-[12px]">
                      <AttachmentThumb projectId={projectId} path={f} name={name} size={36} />
                      <span className="truncate">{name}</span>
                    </span>
                  ) : (
                    <span key={f} className="pill bg-surface">
                      <AttachmentIcon name={name} size={12} />
                      {name}
                    </span>
                  );
                })}
              </div>
            )}
            <p className="lab mt-1 flex items-center gap-1.5">
              {item.e.userName}
              {modeLabel && <span className="pill pill-pri">{modeLabel}</span>}
            </p>
          </div>
        );
      }
    case "text":
      return <Markdown className="leading-relaxed text-ink">{item.e.text}</Markdown>;
    case "tool": {
      const { call, result } = item.row;
      // An attached file shows by its name (older runs stored Forge's internal path).
      const upload = /^(?:\.forge\/uploads\/[a-z0-9]+-|attachment · )(.+)$/.exec(call.summary ?? "");
      const isAttachment = call.tool === "Read" && upload;
      const label = isAttachment ? "Viewed" : (TOOL_LABELS[call.tool] ?? call.tool.replace(/^mcp__[^_]+__/, ""));
      const summary = isAttachment ? `attachment · ${upload[1]}` : call.summary;
      // The attached image itself, when the agent looked at one: shown instead of "[image]".
      const inputPath = String((call.input as { file_path?: unknown } | null)?.file_path ?? "").replace(/^\/workspace\//, "");
      const imagePath = isAttachment ? [inputPath, call.summary ?? ""].find(isImagePath) : undefined;
      return (
        <details className="group rounded-md px-2 py-1 hover:bg-surface-2 open:bg-surface-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
            {!result ? (
              <Spinner size={14} className="spinner-pri" label="Running" />
            ) : result.ok ? (
              <Check size={14} className="shrink-0 text-ok" aria-label="Done" />
            ) : (
              <XCircle size={14} className="shrink-0 text-danger" aria-label="Failed" />
            )}
            <span className="shrink-0 font-semibold">{label}</span>
            {imagePath && <AttachmentThumb projectId={projectId} path={imagePath} name={upload![1]!} size={22} className="rounded" />}
            <span className="truncate text-ink-2">{summary}</span>
            <ChevronRight size={14} className="ml-auto shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          {result && imagePath && result.ok ? (
            <AttachmentPreview projectId={projectId} path={imagePath} name={upload![1]!} />
          ) : result && (
            <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 font-mono text-[11px] text-ink-2">
              {result.output || "(no output)"}
            </pre>
          )}
        </details>
      );
    }
    case "commit":
      return item.e.restoredFrom ? (
        <EventLine icon={<History size={15} aria-hidden />}>
          {item.e.userName ?? "Someone"} restored version <code className="font-mono text-ink">{item.e.restoredFrom.slice(0, 7)}</code>, saved as{" "}
          <code className="font-mono text-ink">{item.e.sha.slice(0, 7)}</code>
        </EventLine>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-ink-2">
          <span className="pill pill-pri">Saved</span>
          Version <code className="font-mono text-ink">{item.e.sha.slice(0, 7)}</code>
        </p>
      );
    case "checking":
      return (
        <EventLine icon={<Spinner size={14} className="spinner-pri" />}>
          Running Forge&apos;s checks{item.e.attempt > 1 ? ` (attempt ${item.e.attempt})` : ""}…
        </EventLine>
      );
    case "checks": {
      const entries = Object.entries(item.e.checks);
      return (
        <div className="card flex flex-col gap-2 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pill ${item.e.ok ? "pill-ok" : "pill-bad"}`}>{item.e.ok ? "All checks passed" : "Some checks failed"}</span>
            {item.e.attempt > 1 && <span className="lab">attempt {item.e.attempt}</span>}
            {!item.e.ok && <span className="lab">The agent will try to fix them.</span>}
          </div>
          <div className="flex flex-col">
            {entries.map(([name, c]) =>
              c ? (
                <details key={name} className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-surface-2">
                    {c.skipped ? (
                      <Minus size={14} className="text-ink-3" aria-label="Skipped" />
                    ) : c.ok ? (
                      <Check size={14} className="text-ok" aria-label="Passed" />
                    ) : (
                      <XCircle size={14} className="text-danger" aria-label="Failed" />
                    )}
                    <span>{CHECK_LABELS[name] ?? name}</span>
                    {c.skipped && <span className="lab">skipped</span>}
                    {c.advisory && <span className="pill pill-warn">already failing before import</span>}
                    <ChevronRight size={13} className="ml-auto text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
                  </summary>
                  <pre className="mb-1 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-ink-2">
                    {c.output || "(no output)"}
                  </pre>
                </details>
              ) : null,
            )}
          </div>
        </div>
      );
    }
    case "notice":
      return <EventLine icon={<Info size={15} aria-hidden />}>{item.e.text}</EventLine>;
    case "push":
      return (
        <EventLine icon={<GitBranch size={15} aria-hidden />} tone="pri">
          {item.e.userName} {item.e.created ? "created" : "pushed to"}{" "}
          <a href={item.e.url} target="_blank" rel="noreferrer" className="font-semibold text-primary underline">
            {item.e.repo}
          </a>
          {item.e.created ? " and pushed" : ""} {item.e.commits} version{item.e.commits === 1 ? "" : "s"}.
          {item.e.overridden && <span className="pill pill-warn ml-1.5">checks failed; pushed by a project admin</span>}
        </EventLine>
      );
    case "branch": {
      const b = <code className="font-mono text-ink">{item.e.branch}</code>;
      return (
        <EventLine icon={<GitBranch size={15} aria-hidden />} tone="pri">
          {item.e.userName}{" "}
          {item.e.action === "created" ? (
            <>
              started the idea {b} from version <code className="font-mono text-ink">{item.e.sha?.slice(0, 7)}</code>. New changes go there; the main line is untouched.
            </>
          ) : item.e.action === "switched" ? (
            <>switched to {b}.</>
          ) : item.e.action === "used" ? (
            <>brought the idea {b} into the main line.</>
          ) : (
            <>deleted the idea {b}.</>
          )}
        </EventLine>
      );
    }
    case "pr":
      return (
        <EventLine icon={<GitPullRequest size={15} aria-hidden />} tone="pri">
          {item.e.userName} {item.e.action === "opened" ? "opened" : "updated"}{" "}
          <a href={item.e.url} target="_blank" rel="noreferrer" className="font-semibold text-primary underline">
            pull request #{item.e.number}
          </a>{" "}
          with {item.e.commits} saved version{item.e.commits === 1 ? "" : "s"}.
        </EventLine>
      );
    case "discarded":
      return (
        <EventLine icon={<Undo2 size={15} aria-hidden />}>
          {item.e.userName} discarded unsaved changes to {item.e.files.length} file{item.e.files.length === 1 ? "" : "s"}.
        </EventLine>
      );
    case "answered": {
      const by = (item.answer.answer as { by?: string })?.by ?? "User";
      if (item.pause.kind === "plan") {
        const a = item.answer.answer as { decision?: string; feedback?: string };
        const title = (item.pause.payload as { title?: string })?.title ?? "Plan";
        return (
          <details className="card group px-3.5 py-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
              <span className={`pill ${a.decision === "approve" ? "pill-ok" : "pill-warn"}`}>{a.decision === "approve" ? "Approved" : "Changes asked"}</span>
              <span className="truncate font-semibold">{title}</span>
              <span className="lab shrink-0">by {by}</span>
              <ChevronRight size={14} className="ml-auto shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
            </summary>
            <Markdown className="mt-2 text-ink">{(item.pause.payload as { plan?: string })?.plan ?? ""}</Markdown>
            {a.feedback && <p className="mt-2 text-[13px]">Feedback: {a.feedback}</p>}
          </details>
        );
      }
      const qs = (item.pause.payload as { questions?: { id: string; question: string }[] })?.questions ?? [];
      const answers = (item.answer.answer as { answers?: Record<string, string> })?.answers ?? {};
      return (
        <div className="card flex flex-col gap-1.5 px-3.5 py-2.5 text-[13px]">
          <span className="lab flex items-center gap-1.5">
            <MessageCircleQuestion size={14} aria-hidden />
            Answered by {by}
          </span>
          {qs.map((q) => (
            <p key={q.id}>
              <span className="text-ink-2">{q.question}</span> <span className="font-semibold">{answers[q.id]}</span>
            </p>
          ))}
        </div>
      );
    }
    case "usage":
      return (
        <p className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-ink-3">
          {item.model && (
            <span className="flex items-center gap-1 font-sans font-medium text-ink-2" title="The model that answered">
              <Sparkles size={11} aria-hidden />
              {item.model}
              <span className="text-ink-3">·</span>
            </span>
          )}
          {Math.round((item.e.inputTokens + item.e.cacheReadTokens) / 1000)}k in · {Math.round(item.e.outputTokens / 1000)}k out · $
          {item.e.costUsd.toFixed(2)}
        </p>
      );
    case "finished":
      if (item.e.status === "completed") return null;
      return item.e.status === "cancelled" ? (
        <EventLine icon={<CircleStop size={15} aria-hidden />}>Stopped.</EventLine>
      ) : (
        <EventLine icon={<XCircle size={15} aria-hidden />} tone="bad">
          <span className="font-semibold">The request didn&apos;t finish.</span> <LinkedText text={cleanRunError(item.e.error)} />
        </EventLine>
      );
  }
}

const SEVERITY_STYLE: Record<string, string> = {
  blocker: "pill pill-bad",
  major: "pill pill-warn",
  minor: "pill",
};

function QaReport({
  e,
  disabled,
  onFix,
  onSaveTest,
}: {
  e: Extract<RunEvent, { type: "qa.report" }>;
  disabled: boolean;
  onFix: (prompt: string) => void;
  /** Builders: keep a proposed test. */
  onSaveTest?: (t: SaveTestInput) => Promise<unknown>;
}) {
  const fixPrompt = () =>
    [
      "The QA agent tested the app in a browser and found these problems. Fix them, then summarize what you changed:",
      "",
      ...e.issues.map(
        (i, n) =>
          `${n + 1}. [${i.severity}] ${i.title}\n   Steps: ${i.steps}\n   Expected: ${i.expected}\n   Actual: ${i.actual}`,
      ),
    ].join("\n");
  return (
    <div className="card flex flex-col gap-2.5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical size={16} className="text-primary" aria-hidden />
        <span className="h2">Test report</span>
        <span className={`pill ${e.issues.length === 0 ? "pill-ok" : "pill-warn"}`}>
          {e.issues.length === 0 ? "No problems found" : `${e.issues.length} problem${e.issues.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {e.summary && <Markdown className="text-[13px] leading-relaxed text-ink">{e.summary}</Markdown>}
      {e.issues.length > 0 && (
        <div className="overflow-hidden rounded-md border border-line">
          {e.issues.map((i, n) => (
            <details key={n} className={`group ${n ? "border-t border-line" : ""}`}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface-2">
                <span className={`${SEVERITY_STYLE[i.severity] ?? "pill"} capitalize`}>{i.severity}</span>
                <span className="min-w-0 flex-1">{i.title}</span>
                <ChevronRight size={14} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
              </summary>
              <dl className="flex flex-col gap-1 px-3 pb-3 text-[13px] text-ink-2">
                <div>
                  <dt className="inline font-semibold text-ink">Steps: </dt>
                  <dd className="inline whitespace-pre-wrap">{i.steps}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-ink">Expected: </dt>
                  <dd className="inline">{i.expected}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-ink">Actual: </dt>
                  <dd className="inline">{i.actual}</dd>
                </div>
              </dl>
            </details>
          ))}
        </div>
      )}
      {e.tests && e.tests.length > 0 && <ProposedTests tests={e.tests} onSave={onSaveTest} />}
      {e.issues.length > 0 && (
        <div className="flex justify-end">
          <button disabled={disabled} onClick={() => onFix(fixPrompt())} className="btn btn-p btn-sm">
            Fix these issues
          </button>
        </div>
      )}
    </div>
  );
}

/** Tests the QA agent proposed; Forge replayed each once. Passing ones can be kept. */
function ProposedTests({ tests, onSave }: { tests: ProposedTest[]; onSave?: (t: SaveTestInput) => Promise<unknown> }) {
  const [saved, setSaved] = useState<Record<number, "saving" | "saved" | string>>({});
  return (
    <div className="flex flex-col gap-1.5">
      <p className="lab">Tests to keep · Forge replays saved tests after every new version, without the AI</p>
      <div className="overflow-hidden rounded-md border border-line">
        {tests.map((t, n) => (
          <details key={n} className={`group ${n ? "border-t border-line" : ""}`}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-surface-2">
              <span className={t.result.ok ? "pill pill-ok" : "pill pill-bad"}>{t.result.ok ? "Passes" : "Failed replay"}</span>
              <span className="min-w-0 flex-1">{t.title}</span>
              {t.criterionId && <span className="pill pill-pri text-[11px]" title="It proves an acceptance criterion in the Spec tab">Spec</span>}
              {t.saved && (
                <span className="pill pill-ok text-[11px]">
                  <Check size={11} aria-hidden /> Saved
                </span>
              )}
              {onSave && t.result.ok && !t.saved && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={saved[n] === "saving" || saved[n] === "saved"}
                  onClick={(ev) => {
                    ev.preventDefault();
                    setSaved((s) => ({ ...s, [n]: "saving" }));
                    onSave({ title: t.title, steps: t.steps, ...(t.criterionId ? { criterionId: t.criterionId } : {}) }).then(
                      () => setSaved((s) => ({ ...s, [n]: "saved" })),
                      (err) => setSaved((s) => ({ ...s, [n]: err instanceof Error ? err.message : "Couldn't save" })),
                    );
                  }}
                >
                  {saved[n] === "saved" ? <><Check size={13} aria-hidden /> Saved</> : saved[n] === "saving" ? <><Spinner size={13} /> Saving…</> : "Save as test"}
                </button>
              )}
              <ChevronRight size={14} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
            </summary>
            <div className="px-3 pb-3">
              <StepList steps={t.steps} failedStep={t.result.failedStep} />
              {!t.result.ok && <p className="mt-1.5 text-xs text-danger">{t.result.error} It isn&apos;t offered for saving.</p>}
              {saved[n] && !["saving", "saved"].includes(saved[n]!) && <p className="mt-1.5 text-xs text-danger">{saved[n]}</p>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

/** Saved tests replayed (after a new version, or on request). */
function TestsResultCard({
  e,
  disabled,
  onFix,
}: {
  e: Extract<RunEvent, { type: "tests.result" }>;
  disabled: boolean;
  onFix: (testId: string) => Promise<void>;
}) {
  const failed = e.results.filter((r) => !r.ok);
  return (
    <div className="card flex flex-col gap-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListChecks size={16} className="text-primary" aria-hidden />
        <span className="text-[13px] font-semibold">Saved tests</span>
        <span className={failed.length ? "pill pill-bad" : "pill pill-ok"}>
          {failed.length ? `${failed.length} of ${e.results.length} failed` : `All ${e.results.length} passed`}
        </span>
        <span className="lab">
          {e.trigger === "version" ? "after the new version" : "run by hand"}
          {e.sha ? ` · ${e.sha.slice(0, 7)}` : ""}
        </span>
      </div>
      {failed.map((r) => (
        <div key={r.testId} className="flex flex-wrap items-start gap-2 rounded-md bg-danger-weak px-3 py-2 text-[13px]">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{r.title}</p>
            <p className="text-ink-2">
              {r.failedStep !== undefined ? `Step ${r.failedStep + 1}: ` : ""}
              {r.error}
            </p>
          </div>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => void onFix(r.testId)}>
            Fix
          </button>
        </div>
      ))}
    </div>
  );
}

const CHECK_LABELS: Record<string, string> = {
  install: "Dependencies install",
  typecheck: "Type check",
  lint: "Lint",
  unit: "Unit tests",
  e2e: "Pages load without errors",
};

const TOOL_LABELS: Record<string, string> = {
  mcp__forge__save_to_library: "Saved to library",
  mcp__forge__ask_user: "Asked you",
  mcp__forge__present_plan: "Shared a plan",
  mcp__forge__look_at_page: "Looked at the page",
  mcp__browser__open: "Browser",
  mcp__browser__click: "Browser",
  mcp__browser__fill: "Browser",
  mcp__browser__press: "Browser",
  mcp__browser__snapshot: "Looked at the page",
  mcp__browser__screenshot: "Took a screenshot",
  mcp__browser__report_issue: "Reported a problem",
  mcp__browser__propose_test: "Proposed a test",
  TodoWrite: "Updated its task list",
};

const sandboxLabel = (s: SandboxStatus | null) =>
  !s ? "" : s.state === "error" ? "Sandbox error" : s.state === "running" ? "Running" : "Starting sandbox…";

const errText = (e: unknown) => {
  if (e instanceof ApiError) {
    try {
      const body = JSON.parse(e.message);
      if (typeof body.error === "string") return body.error;
    } catch {
      /* not JSON */
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

/** "Auto-test" switch: run the QA agent after every saved version, within a daily budget. */
function AutoQaSwitch({
  project,
  onChange,
  onError,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const on = project.autoQa ?? false;
  const budget = (project.autoQaDailyBudgetCents ?? 200) / 100;
  const save = async (input: { autoQa?: boolean; autoQaDailyBudgetCents?: number }) => {
    // Show the change right away; roll back if the server rejects it.
    onChange({ ...project, ...input });
    setBusy(true);
    try {
      onChange(await api.updateSettings(project.id, input));
    } catch (e) {
      onChange(project);
      onError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Test the app automatically after each saved version"
        className="btn btn-sm"
      >
        <span className={`size-1.5 rounded-full ${on ? "bg-ok" : "bg-ink-3"}`} />
        Auto-test {on ? "on" : "off"}
      </button>
      {open && (
        <div className="pop absolute right-0 top-full z-40 mt-1 w-80 p-3.5 text-[13px]">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>Test automatically after each saved version</span>
            <input type="checkbox" role="switch" className="peer sr-only" checked={on} onChange={(e) => save({ autoQa: e.target.checked })} />
            <span
              aria-hidden
              className="relative h-5 w-9 shrink-0 rounded-full bg-line-2 transition-colors peer-checked:bg-primary peer-focus-visible:shadow-[0_0_0_3px_var(--primary-ring)] after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
            />
          </label>
          <label className="mt-3 flex items-center justify-between gap-3">
            <span>Daily budget for automatic tests</span>
            <span className="flex items-center gap-1">
              $
              <input
                type="number"
                min={0.1}
                max={50}
                step={0.5}
                defaultValue={budget}
                disabled={busy}
                onBlur={(e) => {
                  const cents = Math.round(Number(e.target.value) * 100);
                  if (cents !== project.autoQaDailyBudgetCents) void save({ autoQaDailyBudgetCents: cents });
                }}
                aria-label="Daily budget in dollars"
                className="in h-8 w-20 px-2 py-0"
              />
            </span>
          </label>
          <p className="lab mt-3">
            Each test usually costs $0.20 to $0.60. When today&apos;s budget is used up, automatic tests pause until
            tomorrow; &quot;Test the app&quot; still works.
          </p>
        </div>
      )}
    </div>
  );
}


/** Text with its web addresses as links (e.g. a provider's billing page in an error). */
function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+?)(?=[.,;:)]?(?:\s|$))/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="break-all underline underline-offset-2 hover:opacity-80">
            {p.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
