"use client";

import type { ActivityResponse, GitHubRepo, GitHubReposResponse, Project, ProjectTemplate } from "@forge/protocol";
import { ArrowRight, GitBranch, Globe, LayoutTemplate, Lock, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pagination, usePagination } from "@/components/pagination";
import { BusyLabel, Skeleton, SkeletonRows } from "@/components/loading";
import { Modal, ModalActions } from "@/components/modal";
import { Avatar, ProjectBadge } from "@/components/project-badge";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { canCreateProjects, isAdmin, useMe } from "@/lib/me";

// The clock is read on the client only (prerendering must not depend on the time of day).
const noSubscribe = () => () => undefined;
const greetingNow = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const useGreeting = () => useSyncExternalStore(noSubscribe, greetingNow, () => "Welcome");

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

const IDEAS = [
  "A weekly team lunch poll: vote for each weekday and show the winners",
  "A leave request tracker where managers approve or decline",
  "An equipment checkout log with due dates and reminders",
  "A customer feedback board with votes and status labels",
];

/** A project name from the first words of the idea. */
const nameFrom = (idea: string) => {
  const words = idea.replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().split(/\s+/).filter((w) => !/^(a|an|the)$/i.test(w)).slice(0, 4);
  const n = words.join(" ");
  return n ? n[0]!.toUpperCase() + n.slice(1) : "New app";
};

/** Prompt-first start: describe the app; Forge creates the project and starts building it. */
function StartApp({ templates }: { templates: ProjectTemplate[] }) {
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const tpl = templates.find((t) => t.id === templateId) ?? null;

  async function submit() {
    if (!idea.trim() && !tpl) return setError("Describe what to build, or pick a template to start from.");
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({
        name: name.trim() || (idea.trim() ? nameFrom(idea) : tpl!.name),
        description: idea.trim() || undefined,
        templateId: tpl?.id,
      });
      // The idea is the first request: the agent starts on it while the builder opens.
      if (idea.trim()) await api.startRun(p.id, idea.trim()).catch(() => undefined);
      setIdea("");
      setName("");
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section aria-label="Start an app" className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 sm:p-7">
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary/10 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-16 size-64 rounded-full bg-[#ff8a3d]/10 blur-3xl" />
      <form
        className="relative flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="idea" className="flex items-center gap-2 text-[15px] font-semibold">
          <Sparkles size={17} className="text-primary" aria-hidden />
          What do you want to build?
        </label>
        <div className="overflow-hidden rounded-xl border border-line-2 bg-paper shadow-sm transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_4px_var(--primary-ring)]">
          <textarea
            id="idea"
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            className="block min-h-28 w-full resize-none border-0 bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-ink-3 focus-visible:shadow-none"
            placeholder="Describe the app, who uses it and what they need to do…"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
            maxLength={2000}
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface/60 px-3 py-2.5">
            <label className="flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-surface pl-2.5 text-[13px] text-ink-2 focus-within:border-primary">
              <LayoutTemplate size={14} aria-hidden />
              <span className="sr-only">Start from</span>
              <select className="h-full max-w-52 cursor-pointer rounded-lg bg-transparent pr-2 text-[13px] text-ink outline-none focus-visible:shadow-none" value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Start from">
                <option value="">Blank app</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    Template: {t.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="in h-9 w-48 rounded-lg py-0 text-[13px]"
              placeholder={idea.trim() ? nameFrom(idea) : "Project name (optional)"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Project name"
              maxLength={80}
            />
            <button type="button" className="btn btn-g h-9 px-3 text-[13px]" onClick={() => setImporting(true)}>
              <GitBranch size={14} aria-hidden />
              Import from GitHub
            </button>
            <button
              type="submit"
              className="btn btn-p ml-auto h-9 gap-2 rounded-lg px-4 text-[13.5px] font-semibold shadow-[0_4px_14px_var(--primary-ring)] disabled:shadow-none"
              aria-busy={busy}
              disabled={!idea.trim() && !tpl}
            >
              <BusyLabel busy={busy} busyText="Starting…">
                Build it <ArrowRight size={15} aria-hidden />
              </BusyLabel>
            </button>
          </div>
        </div>
        {tpl && (
          <p className="text-[13px] text-ink-2">
            Starts from <span className="font-semibold text-ink">{tpl.name}</span>
            {tpl.description ? `: ${tpl.description}` : ""}
            {tpl.secretNames.length ? ` · needs secrets: ${tpl.secretNames.join(", ")}` : ""}
          </p>
        )}
        {error && (
          <p className="text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        {!idea && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Ideas">
            <span className="lab">Try:</span>
            {IDEAS.map((x) => (
              <button key={x} type="button" className="rounded-full border border-line-2 bg-surface px-3 py-1 text-[12.5px] text-ink-2 transition-colors hover:border-primary hover:text-primary" onClick={() => setIdea(x)}>
                {x.split(":")[0]}
              </button>
            ))}
          </div>
        )}
        <p className="lab flex items-center gap-1.5">
          <kbd className="rounded border border-line-2 px-1 font-mono text-[11px]">⌘</kbd>
          <kbd className="rounded border border-line-2 px-1 font-mono text-[11px]">↵</kbd>
          builds it. You can keep refining in the builder.
        </p>
      </form>
      <ImportModal open={importing} onClose={() => setImporting(false)} />
    </section>
  );
}

/** Import an existing repository: from the connected GitHub organization's list, or by name. */
function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<GitHubReposResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<GitHubRepo | null>(null);
  const [typed, setTyped] = useState("");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setData(null);
      setLoadError(null);
      setPicked(null);
      setQ("");
      setTyped("");
      setBranch("");
      setName("");
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.githubRepos().then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    api.githubBranches(picked.fullName).then(
      (r) => !cancelled && setBranches(r.branches),
      () => !cancelled && setBranches([]),
    );
    return () => {
      cancelled = true;
    };
  }, [picked]);

  const repos = data?.connected ? data.repos.filter((r) => !q || `${r.fullName} ${r.description ?? ""}`.toLowerCase().includes(q.toLowerCase())) : [];
  const pager = usePagination(repos, 8, q);
  const repo = picked?.fullName ?? typed.trim();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const p = await api.importProject({ repo, branch: branch || picked?.defaultBranch || undefined, name: name.trim() || undefined });
      router.push(`/projects/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      icon={<GitBranch size={19} aria-hidden />}
      title="Import from GitHub"
      description="Forge works on a forge/… branch and sends changes back as a pull request."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {data === null && !loadError ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading repositories">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : data?.connected ? (
          picked ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3 rounded-[10px] border border-primary bg-primary-weak p-3">
                {picked.private ? <Lock size={16} className="text-primary" aria-hidden /> : <Globe size={16} className="text-primary" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] font-semibold">{picked.fullName}</span>
                  {picked.description && <span className="lab block truncate">{picked.description}</span>}
                </span>
                <button type="button" className="btn btn-g btn-sm" onClick={() => setPicked(null)}>
                  Change
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="lab">Branch</span>
                  <select className="in" value={branch || picked.defaultBranch} onChange={(e) => setBranch(e.target.value)} disabled={branches === null}>
                    {(branches ?? [picked.defaultBranch]).map((b) => (
                      <option key={b} value={b}>
                        {b}
                        {b === picked.defaultBranch ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="lab">Project name (optional)</span>
                  <input className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder={picked.fullName.split("/")[1]} maxLength={80} />
                </label>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="relative flex items-center">
                <Search size={14} className="pointer-events-none absolute left-3 text-ink-3" aria-hidden />
                <input
                  className="in h-10 w-full pl-8"
                  placeholder={`Search ${data.repos.length} repositories in ${data.account}`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Search repositories"
                  autoFocus
                />
              </label>
              <ul className="flex flex-col overflow-hidden rounded-[10px] border border-line" aria-label="Repositories">
                {pager.items.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-ink-2">No repository matches.</li>}
                {pager.items.map((r) => (
                  <li key={r.fullName} className="border-t border-line first:border-0">
                    <button type="button" onClick={() => setPicked(r)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2">
                      {r.private ? <Lock size={15} className="shrink-0 text-ink-3" aria-label="Private" /> : <Globe size={15} className="shrink-0 text-ink-3" aria-label="Public" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] font-semibold">{r.fullName}</span>
                        <span className="lab block truncate">
                          {[r.private ? "Private" : "Public", r.language, `updated ${new Date(r.updatedAt).toLocaleDateString()}`].filter(Boolean).join(" · ")}
                          {r.description ? ` · ${r.description}` : ""}
                        </span>
                      </span>
                      <ArrowRight size={15} className="shrink-0 text-ink-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
              <Pagination pager={pager} noun="repositories" compact />
              {data.truncated && <p className="lab">Showing the 1,000 most recently updated repositories. Search to find others.</p>}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <p className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
              {loadError ? `Couldn't list the repositories: ${loadError}` : "GitHub isn't connected, so there's no list to pick from."} An admin connects it in{" "}
              <Link href="/settings/integrations" className="font-semibold text-primary underline">
                Settings › Integrations
              </Link>
              . You can still type a repository this machine can reach.
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <label className="flex flex-col gap-1.5">
                <span className="lab">Repository</span>
                <input className="in" placeholder="owner/repo or https://github.com/owner/repo" value={typed} onChange={(e) => setTyped(e.target.value)} required />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lab">Branch (optional)</span>
                <input className="in" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
              </label>
            </div>
          </div>
        )}
        {error && (
          <p className="rounded-md bg-danger-weak px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </p>
        )}
        <ModalActions>
          <button type="button" className="btn btn-g" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-p" aria-busy={busy} disabled={!repo}>
            <BusyLabel busy={busy} busyText="Cloning…">
              Import repository
            </BusyLabel>
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function HomePage() {
  const { data: session } = useSession();
  const me = useMe();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [usage, setUsage] = useState<{ costUsd: number; runs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectPager = usePagination(projects, 10);

  useEffect(() => {
    api.listProjects().then(setProjects, (e) => setError(String(e.message ?? e)));
    api.listTemplates().then(setTemplates, () => undefined);
    api.activity(8).then(setActivity, () => undefined);
    // Usage is admin-only; for others this request is refused and the tiles stay hidden.
    api.usage(30).then((u) => setUsage({ costUsd: u.totals.costUsd, runs: u.totals.runs }), () => undefined);
  }, []);

  const summaries = activity?.projects ?? {};
  const openComments = Object.values(summaries).reduce((n, p) => n + p.openComments, 0);
  const firstName = session?.user.name.split(" ")[0] ?? "";
  const greeting = useGreeting();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8 sm:px-6">
      <div>
        <h1 className="h1">
          {greeting}
          {firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-1 text-ink-2">
          {openComments
            ? `${openComments} open comment${openComments === 1 ? "" : "s"} across the team's projects.`
            : "Describe an app and the agent builds it, or pick up where the team left off."}
        </p>
      </div>

      {canCreateProjects(me) ? (
        <StartApp templates={templates} />
      ) : me ? (
        <p className="card px-4 py-3 text-ink-2">
          You can open the projects shared with you below. To start new apps, ask a workspace admin for the Builder role.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="tile">
          <div className="lab">Projects</div>
          <div className="big">{projects?.length ?? "—"}</div>
        </div>
        <div className="tile">
          <div className="lab">Open comments</div>
          <div className="big">{activity ? openComments : "—"}</div>
        </div>
        {isAdmin(me) && (
          <>
            <div className="tile">
              <div className="lab">Build runs, last 30 days</div>
              <div className="big">{usage?.runs ?? "—"}</div>
            </div>
            <div className="tile">
              <div className="lab">AI cost, last 30 days</div>
              <div className="big">{usage ? `$${usage.costUsd.toFixed(2)}` : "—"}</div>
            </div>
          </>
        )}
      </div>

      {/* Projects and activity share one row height: activity scrolls inside it. */}
      <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Team projects" className="card min-w-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3.5">
            <h2 className="h2">Team projects</h2>
            <span className="lab">{projects ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : ""}</span>
          </div>
          {error && (
            <p className="px-4 pb-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          {projects === null ? (
            <SkeletonRows n={4} className="border-t border-line" />
          ) : projects.length === 0 ? (
            <p className="px-4 pb-6 text-ink-2">No projects yet. Describe one above and the agent builds it.</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                <div className="th">
                  <span className="flex-[2]">Project</span>
                  <span className="flex-[1.2]">Status</span>
                  <span className="flex-1">Version</span>
                  <span className="w-16">Owner</span>
                  <span className="w-20">Updated</span>
                </div>
                {projectPager.items.map((p) => {
                  const s = summaries[p.id];
                  const status = s?.running
                    ? { cls: "pill pill-pri", text: "Agent working" }
                    : p.status === "error"
                      ? { cls: "pill pill-bad", text: "Last run failed" }
                      : s?.openComments
                        ? { cls: "pill pill-warn", text: `${s.openComments} open comment${s.openComments === 1 ? "" : "s"}` }
                        : s?.latestVersion
                          ? { cls: "pill pill-ok", text: "Saved" }
                          : { cls: "pill", text: "Not started" };
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`} className="row">
                      <span className="flex min-w-0 flex-[2] items-center gap-2.5">
                        <ProjectBadge id={p.id} name={p.name} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{p.name}</span>
                          <span className="lab block truncate">{p.repo ? `GitHub · ${p.repo}` : p.description || "New app"}</span>
                        </span>
                      </span>
                      <span className="flex-[1.2]">
                        <span className={status.cls}>{status.text}</span>
                      </span>
                      <span className="flex-1 font-mono text-xs">{s?.latestVersion?.slice(0, 7) ?? "—"}</span>
                      <span className="w-16">{p.ownerName && <Avatar name={p.ownerName} />}</span>
                      <span className="lab w-20">{ago(s?.lastActivityAt ?? p.updatedAt)}</span>
                    </Link>
                  );
                })}
              </div>
              <Pagination pager={projectPager} noun="projects" className="border-t border-line px-4" />
            </div>
          )}
        </section>

        <section aria-label="Activity" className="card relative flex min-h-[340px] flex-col">
          <h2 className="h2 px-4 pb-2 pt-3.5">Activity</h2>
          <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0 flex flex-col gap-3.5 overflow-y-auto px-4 pb-4 pt-1">
          {activity === null ? (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading activity">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <Skeleton className="size-7 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="skel-line" style={{ width: `${60 + ((i * 13) % 30)}%` }} />
                    <Skeleton className="skel-line h-[0.65em] w-1/3 opacity-70" />
                  </div>
                </div>
              ))}
            </div>
          ) : activity.items.length === 0 ? (
            <p className="text-ink-2">Nothing yet.</p>
          ) : (
            activity.items.map((a, i) => (
              <Link key={i} href={`/projects/${a.projectId}`} className="-mx-2 flex gap-2.5 rounded-md px-2 py-1 leading-snug hover:bg-surface-2">
                <Avatar name={a.who} />
                <span className="min-w-0 text-[13px]">
                  <span className="line-clamp-2">{a.text}</span>
                  <span className="lab block">
                    {a.projectName} · {ago(a.at)}
                  </span>
                </span>
              </Link>
            ))
          )}
          </div>
          </div>
        </section>
      </div>
    </main>
  );
}
