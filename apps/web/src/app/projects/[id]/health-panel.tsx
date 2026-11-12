"use client";

import type { AppProblem, SavedTest, SecurityFinding, SecurityReport } from "@forge/protocol";
import {
  ChevronRight,
  EyeOff,
  FormInput,
  Globe,
  KeyRound,
  ListChecks,
  Package,
  Play,
  RotateCcw,
  ScanSearch,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserLock,
  Wand2,
  Wifi,
} from "lucide-react";
import { useEffect, useState } from "react";
import { failedTestPrompt, StepList } from "./test-steps";
import { SkeletonCards, Spinner } from "@/components/loading";
import { Pagination, usePagination } from "@/components/pagination";
import { api } from "@/lib/api";

/*
 * Health: is the app working?
 *   Problems  errors the running app produced (Fix from logs)
 *   Tests     saved tests, replayed after every new version
 *   Security  checks before pushing to GitHub
 * Failing tests and critical/high security findings block pushing to GitHub.
 */

const SOURCE = {
  browser: { icon: Globe, label: "Browser error" },
  network: { icon: Wifi, label: "Failed request" },
  server: { icon: Server, label: "Server error" },
} as const;

const STATUS: Record<AppProblem["status"], { cls: string; text: string }> = {
  open: { cls: "pill pill-bad", text: "Open" },
  fixing: { cls: "pill pill-pri", text: "Agent fixing" },
  fixed: { cls: "pill pill-ok", text: "Fixed" },
  ignored: { cls: "pill", text: "Ignored" },
};

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function HealthPanel({
  projectId,
  problems,
  canBuild,
  running,
  onStarted,
  onError,
  refreshKey,
  securityKey,
}: {
  projectId: string;
  problems: AppProblem[] | null;
  canBuild: boolean;
  running: boolean;
  /** A fix run started: show the chat. */
  onStarted: () => void;
  onError: (msg: string) => void;
  /** Bumps when tests ran or were saved (new events), so the lists reload. */
  refreshKey: number;
  /** Bumps when a new security report is ready. */
  securityKey: number;
}) {
  return (
    <div className="flex flex-col gap-6 p-4 text-sm">
      <ProblemsSection projectId={projectId} problems={problems} canBuild={canBuild} running={running} onStarted={onStarted} onError={onError} />
      <TestsSection projectId={projectId} canBuild={canBuild} running={running} onStarted={onStarted} onError={onError} refreshKey={refreshKey} />
      <SecuritySection projectId={projectId} canBuild={canBuild} running={running} onStarted={onStarted} onError={onError} refreshKey={securityKey} />
    </div>
  );
}

const CATEGORY: Record<SecurityFinding["category"], { icon: typeof Package; label: string }> = {
  dependencies: { icon: Package, label: "Package" },
  secrets: { icon: KeyRound, label: "Secret" },
  access: { icon: UserLock, label: "Access" },
  input: { icon: FormInput, label: "Input" },
};
const SEVERITY: Record<SecurityFinding["severity"], string> = {
  critical: "pill pill-bad",
  high: "pill pill-bad",
  medium: "pill pill-warn",
  low: "pill",
};

function SecuritySection({
  projectId,
  canBuild,
  running,
  onStarted,
  onError,
  refreshKey,
}: {
  projectId: string;
  canBuild: boolean;
  running: boolean;
  onStarted: () => void;
  onError: (msg: string) => void;
  refreshKey: number;
}) {
  const [report, setReport] = useState<SecurityReport | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const pager = usePagination(report?.findings, 8);

  useEffect(() => {
    let cancelled = false;
    api.security(projectId).then((r) => !cancelled && setReport(r), (e) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, onError]);

  async function act(key: string, fn: () => Promise<unknown>, started = false) {
    setBusy(key);
    try {
      const r = await fn();
      if (started) onStarted();
      else if (r && typeof r === "object" && "findings" in r) setReport(r as SecurityReport);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="security-h" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="security-h" className="h2 flex items-center gap-2">
          <ShieldCheck size={16} className="text-ink-2" aria-hidden />
          Security
        </h2>
        {report && (report.blocking > 0 ? <span className="pill pill-bad">{report.blocking} blocking</span> : <span className="pill pill-ok">Nothing blocking</span>)}
        {canBuild && (
          <span className="ml-auto flex gap-1.5">
            {report && report.findings.length > 1 && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={running || busy !== null}
                onClick={() => void act("fixall", () => api.fixSecurity(projectId, "all"), true)}
              >
                <Wand2 size={13} aria-hidden />
                Fix all
              </button>
            )}
            <button type="button" className="btn btn-sm" disabled={running || busy !== null} onClick={() => void act("scan", () => api.scanSecurity(projectId))}>
              <ScanSearch size={13} aria-hidden />
              {(busy === "scan") && <Spinner size={13} />}
              {busy === "scan" ? "Scanning…" : "Scan now"}
            </button>
          </span>
        )}
      </div>
      <p className="lab">
        Checked after every new version and before pushing: weak packages, keys in the code, routes without sign-in checks, unchecked input. Critical and high
        findings block pushing to GitHub.
      </p>
      {report === undefined ? (
        <SkeletonCards n={3} />
      ) : report === null ? (
        <p className="card px-3 py-4 text-center text-ink-2">Not scanned yet. It runs after the next saved version, or use Scan now.</p>
      ) : (
        <>
          <p className="lab">
            Last scan {new Date(report.at).toLocaleString()}
            {report.sha ? ` on ${report.sha.slice(0, 7)}` : ""}
            {!report.dependenciesChecked && " · packages couldn't be checked (no access to the npm registry)"}
          </p>
          {report.findings.length === 0 ? (
            <p className="card flex items-center justify-center gap-2 px-3 py-4 text-ok">
              <ShieldCheck size={16} aria-hidden />
              No problems found.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pager.items.map((f) => {
                const C = CATEGORY[f.category];
                return (
                  <li key={f.id} className="card p-3">
                    <div className="flex items-start gap-2.5">
                      <C.icon size={15} className="mt-0.5 shrink-0 text-ink-3" aria-label={C.label} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold leading-snug">{f.title}</p>
                        <p className="lab mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className={`${SEVERITY[f.severity]} capitalize`}>{f.severity}</span>
                          {f.file && (
                            <span className="font-mono">
                              {f.file}
                              {f.line ? `:${f.line}` : ""}
                            </span>
                          )}
                        </p>
                        <p className="mt-1.5 text-[13px] text-ink-2">{f.detail}</p>
                        <p className="mt-1 text-[13px]">
                          <span className="font-semibold">Fix: </span>
                          {f.fix}
                        </p>
                      </div>
                    </div>
                    {canBuild && (
                      <button
                        type="button"
                        className="btn btn-p btn-sm mt-2.5"
                        disabled={running || busy !== null}
                        onClick={() => void act(f.id, () => api.fixSecurity(projectId, [f.id]), true)}
                        data-tip="Ask the agent to check it and fix it if it's real"
                      >
                        <Wand2 size={13} aria-hidden />
                        Fix
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Pagination pager={pager} noun="findings" compact />
        </>
      )}
    </section>
  );
}

function TestsSection({
  projectId,
  canBuild,
  running,
  onStarted,
  onError,
  refreshKey,
}: {
  projectId: string;
  canBuild: boolean;
  running: boolean;
  onStarted: () => void;
  onError: (msg: string) => void;
  refreshKey: number;
}) {
  const [tests, setTests] = useState<SavedTest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [describe, setDescribe] = useState("");
  const pager = usePagination(tests, 8);

  useEffect(() => {
    let cancelled = false;
    api.tests(projectId).then((t) => !cancelled && setTests(t), (e) => !cancelled && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, reload, onError]);

  async function act(key: string, fn: () => Promise<unknown>, started = false) {
    setBusy(key);
    try {
      await fn();
      if (started) onStarted();
      else setReload((r) => r + 1);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const failing = tests?.filter((t) => t.lastResult && !t.lastResult.ok).length ?? 0;
  return (
    <section aria-labelledby="tests-h" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="tests-h" className="h2 flex items-center gap-2">
          <ListChecks size={16} className="text-ink-2" aria-hidden />
          Saved tests
        </h2>
        {failing > 0 && <span className="pill pill-bad">{failing} failing</span>}
        {canBuild && tests && tests.length > 0 && (
          <button
            type="button"
            className="btn btn-sm ml-auto"
            disabled={running || busy !== null}
            onClick={() => void act("all", () => api.runTests(projectId))}
            data-tip={running ? "Wait for the agent to finish" : "Replay every saved test now"}
          >
            <Play size={13} aria-hidden />
            {(busy === "all") && <Spinner size={13} />}
            {busy === "all" ? "Running…" : "Run all"}
          </button>
        )}
      </div>
      <p className="lab">Replayed in a real browser after every new version, without the AI. Failing tests block pushing to GitHub.</p>
      {tests === null ? (
        <SkeletonCards n={3} />
      ) : tests.length === 0 ? (
        <p className="card px-3 py-4 text-center text-ink-2">
          No saved tests yet. Run &ldquo;Test the app&rdquo;: the QA agent proposes tests for flows that work, and you keep the ones you want. Or describe
          one below.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pager.items.map((t) => {
            const r = t.lastResult;
            return (
              <li key={t.id} className="card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={!r ? "pill" : r.ok ? "pill pill-ok" : "pill pill-bad"}>{!r ? "Not run yet" : r.ok ? "Passing" : "Failing"}</span>
                  <span className="min-w-0 flex-1 font-semibold">{t.title}</span>
                </div>
                {r && !r.ok && (
                  <p className="mt-1.5 text-[13px] text-danger">
                    {r.failedStep !== undefined ? `Step ${r.failedStep + 1}: ` : ""}
                    {r.error}
                  </p>
                )}
                <p className="lab mt-1">
                  {t.steps.length} steps · saved by {t.createdBy}
                  {r ? ` · last run ${new Date(r.at).toLocaleString()}${r.sha ? ` on ${r.sha.slice(0, 7)}` : ""}` : ""}
                </p>
                <details className="group mt-2">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-ink-2 hover:text-ink">
                    <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden />
                    Steps
                  </summary>
                  <div className="mt-1.5">
                    <StepList steps={t.steps} failedStep={r && !r.ok ? r.failedStep : undefined} />
                  </div>
                </details>
                {canBuild && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {r && !r.ok && (
                      <button
                        type="button"
                        className="btn btn-p btn-sm"
                        disabled={running || busy !== null}
                        onClick={() => void act(`fix${t.id}`, () => api.startRun(projectId, failedTestPrompt(t.title, t.steps, r.failedStep, r.error)), true)}
                      >
                        <Wand2 size={13} aria-hidden />
                        Fix
                      </button>
                    )}
                    <button type="button" className="btn btn-sm" disabled={running || busy !== null} onClick={() => void act(`run${t.id}`, () => api.runTests(projectId, [t.id]))}>
                      <Play size={13} aria-hidden />
                      {busy === `run${t.id}` ? "Running…" : "Run"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-g btn-sm btn-icon ml-auto"
                      aria-label={`Delete the test ${t.title}`}
                      disabled={busy !== null}
                      onClick={() => void act(`del${t.id}`, () => api.deleteTest(projectId, t.id))}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pagination pager={pager} noun="tests" compact />
      {canBuild && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (describe.trim().length < 5) return;
            void act("draft", () => api.draftTest(projectId, describe.trim()), true).then(() => setDescribe(""));
          }}
        >
          <label className="lab" htmlFor="describe-test">
            Describe a test
          </label>
          <textarea
            id="describe-test"
            className="in min-h-16 text-[13px]"
            placeholder="e.g. Vote for Sushi Bar twice on Monday; it should show the Leading badge."
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
          />
          <button type="submit" className="btn btn-sm self-start" disabled={running || busy !== null || describe.trim().length < 5}>
            <Sparkles size={13} aria-hidden />
            {(busy === "draft") && <Spinner size={13} />}
            {busy === "draft" ? "Starting…" : "Create with the QA agent"}
          </button>
        </form>
      )}
    </section>
  );
}

function ProblemsSection({
  projectId,
  problems,
  canBuild,
  running,
  onStarted,
  onError,
}: {
  projectId: string;
  problems: AppProblem[] | null;
  canBuild: boolean;
  running: boolean;
  onStarted: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const pager = usePagination(problems, 8);
  const open = problems?.filter((p) => p.status === "open") ?? [];
  const settled = problems?.some((p) => p.status === "fixed" || p.status === "ignored");

  async function act(key: string, fn: () => Promise<unknown>, started = false) {
    setBusy(key);
    try {
      await fn();
      if (started) onStarted();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="problems-h" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="problems-h" className="h2 flex items-center gap-2">
          <TriangleAlert size={16} className="text-ink-2" aria-hidden />
          Problems
        </h2>
        {open.length > 0 && <span className="pill pill-bad">{open.length} open</span>}
        <span className="ml-auto flex gap-1.5">
          {settled && (
            <button type="button" className="btn btn-g btn-sm" disabled={!canBuild || busy !== null} onClick={() => void act("clear", () => api.clearSettledProblems(projectId))}>
              Clear fixed
            </button>
          )}
          {canBuild && open.length > 1 && (
            <button
              type="button"
              className="btn btn-p btn-sm"
              disabled={running || busy !== null}
              onClick={() => void act("all", () => api.fixProblems(projectId, "all"), true)}
              data-tip={running ? "Wait for the agent to finish" : "One request to the agent for all open problems (up to 10)"}
            >
              <Wand2 size={13} aria-hidden />
              Fix all
            </button>
          )}
        </span>
      </div>
      <p className="lab">
        Errors from the running app: in the browser, failed requests, and on the server. Errors while the agent is editing are ignored.
      </p>
      {problems === null ? (
        <SkeletonCards n={3} />
      ) : problems.length === 0 ? (
        <p className="card px-3 py-4 text-center text-ink-2">No problems recorded. Use the app in the preview; anything that breaks shows up here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pager.items.map((p) => {
            const S = SOURCE[p.source];
            const st = STATUS[p.status];
            return (
              <li key={p.id} className={`card p-3 ${p.status === "ignored" || p.status === "fixed" ? "opacity-75" : ""}`}>
                <div className="flex items-start gap-2.5">
                  <S.icon size={15} className="mt-0.5 shrink-0 text-ink-3" aria-label={S.label} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-mono text-[12.5px] leading-snug">{p.message}</p>
                    <p className="lab mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={st.cls}>{st.text}</span>
                      <span>{S.label}</span>
                      {p.page && <span className="font-mono">{p.page}</span>}
                      <span>
                        {p.count}× · last {ago(p.lastSeen)}
                      </span>
                      {p.fixedSha && <span>in version {p.fixedSha.slice(0, 7)}</span>}
                    </p>
                  </div>
                </div>
                {p.detail && p.detail !== p.message && (
                  <details className="group mt-2">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-ink-2 hover:text-ink">
                      <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden />
                      Details
                    </summary>
                    <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-ink-2">
                      {p.detail}
                    </pre>
                  </details>
                )}
                {canBuild && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {p.status === "open" && (
                      <>
                        <button
                          type="button"
                          className="btn btn-p btn-sm"
                          disabled={running || busy !== null}
                          onClick={() => void act(p.id, () => api.fixProblems(projectId, [p.id]), true)}
                          data-tip={running ? "Wait for the agent to finish" : "Ask the agent to find the cause and fix it"}
                        >
                          <Wand2 size={13} aria-hidden />
                          {(busy === p.id) && <Spinner size={13} />}
                          {busy === p.id ? "Starting…" : "Fix this"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-g btn-sm"
                          disabled={busy !== null}
                          onClick={() => void act(`i${p.id}`, () => api.setProblemStatus(projectId, p.id, "ignored"))}
                          data-tip="Hide it until it happens again"
                        >
                          <EyeOff size={13} aria-hidden />
                          Ignore
                        </button>
                      </>
                    )}
                    {(p.status === "ignored" || p.status === "fixed") && (
                      <button type="button" className="btn btn-g btn-sm" disabled={busy !== null} onClick={() => void act(`o${p.id}`, () => api.setProblemStatus(projectId, p.id, "open"))}>
                        <RotateCcw size={13} aria-hidden />
                        Reopen
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pagination pager={pager} noun="problems" compact />
    </section>
  );
}
