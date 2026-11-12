"use client";

import type { IntegrationsStatus } from "@forge/protocol";
import { CheckCircle2, ChevronRight, ExternalLink, GitBranch, KeyRound, PenTool, ShieldCheck, TriangleAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { BusyLabel, Skeleton } from "@/components/loading";
import { ApiError, api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";

/** Settings › Integrations: connect the company's GitHub and Figma (workspace admins). */
export default function IntegrationsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Integrations />
    </Suspense>
  );
}

function PageSkeleton() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="skel-line mt-3 w-80 max-w-full opacity-70" />
      {[0, 1].map((i) => (
        <div key={i} className="card mt-6 flex gap-4 p-5">
          <Skeleton className="size-11 shrink-0 rounded-xl" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="skel-line w-32" />
            <Skeleton className="skel-line h-[0.7em] w-3/4" />
            <Skeleton className="mt-2 h-9 w-40 rounded-md" />
          </div>
        </div>
      ))}
    </main>
  );
}

function Integrations() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [notice] = useState<string | null>(params.get("github") === "connected" ? "GitHub is connected. Projects can now be pushed to the organization." : null);

  const load = useCallback(
    () =>
      api.integrations().then(setStatus, (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setError(e instanceof Error ? e.message : String(e));
      }),
    [router],
  );
  useEffect(() => {
    void load();
    // Drop ?github=…/?error=… from the address once shown.
    if (params.size) router.replace("/settings/integrations");
  }, [load, params, router]);

  if (me && !isAdmin(me)) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="h1">Integrations</h1>
        <p className="mt-2 text-ink-2">Only workspace admins can connect GitHub and Figma.</p>
      </main>
    );
  }
  if (!status) return error ? <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 text-danger sm:px-6">{error}</main> : <PageSkeleton />;

  return (
    <main className="fade-in mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="h1">Integrations</h1>
      <p className="mt-1 text-ink-2">Connect the services Forge works with. Everyone in the workspace uses these connections.</p>
      {notice && (
        <p className="mt-4 flex items-center gap-2 rounded-[10px] bg-ok-weak px-3.5 py-2.5 text-ok" role="status">
          <CheckCircle2 size={16} aria-hidden />
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-4 flex items-start gap-2 rounded-[10px] bg-danger-weak px-3.5 py-2.5 text-danger" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <GitHubCard status={status.github} onChange={load} onError={setError} />
      <FigmaCard status={status.figma} onChange={load} onError={setError} />
    </main>
  );
}

function Card({ icon, title, state, children }: { icon: React.ReactNode; title: string; state: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card mt-6 flex flex-col gap-4 p-5 sm:flex-row" aria-label={title}>
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-weak text-primary">{icon}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="h2">{title}</h2>
          {state}
        </div>
        {children}
      </div>
    </section>
  );
}

function GitHubCard({ status, onChange, onError }: { status: IntegrationsStatus["github"]; onChange: () => void; onError: (m: string | null) => void }) {
  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function connect() {
    setBusy("connect");
    onError(null);
    try {
      const f = await api.connectGitHub(org.trim() || undefined);
      // GitHub's manifest flow: the browser posts the app definition to GitHub, which asks the admin to confirm.
      const form = document.createElement("form");
      form.method = "post";
      form.action = f.action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = f.manifest;
      form.append(input);
      document.body.append(form);
      form.submit();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  const pill =
    status.state === "connected" ? (
      <span className="pill pill-ok">Connected</span>
    ) : status.state === "needs_install" ? (
      <span className="pill pill-warn">One step left</span>
    ) : (
      <span className="pill">Not connected</span>
    );

  return (
    <Card icon={<GitBranch size={22} aria-hidden />} title="GitHub" state={pill}>
      {status.state === "not_connected" ? (
        <>
          <p className="text-ink-2">
            Forge pushes each project to a private repository in the company&apos;s organization, and sends changes to imported repos as pull requests.
          </p>
          <GitHubSteps />
          <p className="flex items-start gap-2 text-[13px] text-ink-2">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-ok" aria-hidden />
            The app can only create repositories, push code and open pull requests. No personal tokens are copied anywhere.
          </p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
                <ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden />
                Advanced: create the app inside the organization
              </summary>
              <div className="mt-2 flex flex-col gap-1.5 rounded-md bg-surface-2 p-3">
                <label className="flex flex-col gap-1.5">
                  <span className="lab">Organization on GitHub (optional)</span>
                  <input className="in" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="my-company" autoComplete="off" spellCheck={false} />
                </label>
                <p className="lab">
                  Then the app belongs to the organization from the start and stays private. You need to be an owner of the organization. Leave it
                  empty to pick the organization on GitHub instead.
                </p>
              </div>
            </details>
            <button type="submit" className="btn btn-p self-start" aria-busy={busy === "connect"}>
              <BusyLabel busy={busy === "connect"} busyText="Opening GitHub…">
                Continue to GitHub <ExternalLink size={14} aria-hidden />
              </BusyLabel>
            </button>
          </form>
        </>
      ) : status.state === "needs_install" ? (
        <>
          <p className="text-ink-2">
            Forge&apos;s app is ready on GitHub. Now choose where it works: GitHub lists your account and every organization you belong to. Pick the
            company&apos;s organization and allow <span className="font-semibold text-ink">all repositories</span>, so Forge can create new ones.
          </p>
          <div className="flex flex-wrap gap-2">
            {status.installUrl && (
              <a href={status.installUrl} className="btn btn-p">
                Choose organization
                <ExternalLink size={14} aria-hidden />
              </a>
            )}
            <button
              type="button"
              className="btn btn-g"
              onClick={() => void api.disconnectGitHub(true).then(onChange)}
              data-tip="Forget Forge's GitHub app; connecting again creates a new one"
            >
              Start over
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-ink-2">{status.accountType === "User" ? "Account" : "Organization"}</dt>
            <dd className="font-semibold">
              {status.account}
              {status.accountType === "User" && (
                <span className="mt-1 block font-normal text-warn">
                  This is a personal account, so Forge can&apos;t create repositories here. Install the app on the company&apos;s organization instead.
                </span>
              )}
            </dd>
            <dt className="text-ink-2">Repositories</dt>
            <dd>
              {status.repositorySelection === "all" ? (
                "All (Forge can create new ones)"
              ) : (
                <span className="text-warn">Only selected ones: Forge can&apos;t create new repositories. Change it to all repositories on GitHub.</span>
              )}
            </dd>
            {status.appOwner && status.appOwner !== status.account && (
              <>
                <dt className="text-ink-2">App owner</dt>
                <dd>
                  {status.appOwner}{" "}
                  <span className="text-ink-2">
                    (a person&apos;s account: move it to the organization in the app&apos;s settings › Advanced › Transfer ownership)
                  </span>
                </dd>
              </>
            )}
            <dt className="text-ink-2">Connected by</dt>
            <dd>
              {status.connectedBy}, {new Date(status.connectedAt).toLocaleDateString()}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2">
            {status.installUrl && (
              <a href={status.installUrl} className="btn btn-sm" data-tip="Opens GitHub's list of your account and organizations">
                Change organization
                <ExternalLink size={13} aria-hidden />
              </a>
            )}
            {status.manageUrl && (
              <a href={status.manageUrl} target="_blank" rel="noreferrer" className="btn btn-sm">
                Manage on GitHub
                <ExternalLink size={13} aria-hidden />
              </a>
            )}
            {confirm ? (
              <>
                <span className="self-center text-[13px] text-ink-2">Pushing stops until it&apos;s connected again.</span>
                <button type="button" className="btn btn-g btn-sm" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  aria-busy={busy === "disconnect"}
                  onClick={() => {
                    setBusy("disconnect");
                    void api
                      .disconnectGitHub()
                      .then(onChange, (e) => onError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setBusy(null));
                  }}
                >
                  <BusyLabel busy={busy === "disconnect"}>Disconnect</BusyLabel>
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-g btn-sm btn-danger" onClick={() => setConfirm(true)}>
                Disconnect
              </button>
            )}
          </div>
          <p className="lab">Disconnecting keeps Forge&apos;s app, so connecting again only asks for the organization. It doesn&apos;t uninstall the app on GitHub.</p>
        </>
      )}
    </Card>
  );
}

function FigmaCard({ status, onChange, onError }: { status: IntegrationsStatus["figma"]; onChange: () => void; onError: (m: string | null) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function save() {
    setBusy("save");
    onError(null);
    try {
      await api.setFigmaToken(token.trim());
      setToken("");
      setEditing(false);
      onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      icon={<PenTool size={22} aria-hidden />}
      title="Figma"
      state={status.configured ? <span className="pill pill-ok">Connected</span> : <span className="pill">Not connected</span>}
    >
      <p className="text-ink-2">
        In Design mode, paste a Figma frame link into the prompt box: Forge imports the frame and its exact sizes, colours, fonts and texts, and the agent
        builds it.
      </p>
      {status.configured && !editing ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <KeyRound size={15} className="text-ink-3" aria-hidden />
          <span>
            Token for <span className="font-semibold">{status.user ?? "a Figma account"}</span>, added by {status.updatedBy}
          </span>
          <span className="ml-auto flex gap-1.5">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              Replace
            </button>
            <button
              type="button"
              className="btn btn-g btn-sm btn-danger"
              aria-busy={busy === "remove"}
              onClick={() => {
                setBusy("remove");
                void api
                  .removeFigmaToken()
                  .then(onChange, (e) => onError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(null));
              }}
            >
              <BusyLabel busy={busy === "remove"}>Remove</BusyLabel>
            </button>
          </span>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="lab">Figma access token</span>
            <input
              className="in font-mono"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="figd_…"
              autoComplete="off"
            />
          </label>
          <p className="lab">
            In Figma: Settings › Security › Personal access tokens. Give it read access to file content. Use an account that can open the team&apos;s files.
          </p>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-p btn-sm" aria-busy={busy === "save"} disabled={token.trim().length < 10}>
              <BusyLabel busy={busy === "save"} busyText="Checking with Figma…">
                Save token
              </BusyLabel>
            </button>
            {editing && (
              <button type="button" className="btn btn-g btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

/** What happens on GitHub, so the "Create GitHub App" screen isn't a surprise. */
function GitHubSteps() {
  const steps = [
    {
      title: "Create Forge's app (first time only)",
      text: "GitHub shows a \u201cCreate GitHub App\u201d page. Click the green button. Forge needs its own app; this happens once per Forge installation.",
    },
    {
      title: "Pick your organization",
      text: "GitHub lists your account and every organization you belong to. Choose the company's organization and \u201cAll repositories\u201d.",
    },
    { title: "Back in Forge, connected", text: "You land here again. Teams can now import repos and push to the organization." },
  ];
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((s, i) => (
        <li key={s.title} className="flex items-start gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold text-primary-fg">{i + 1}</span>
          <span className="text-[13px]">
            <span className="block font-semibold text-ink">{s.title}</span>
            <span className="text-ink-2">{s.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
