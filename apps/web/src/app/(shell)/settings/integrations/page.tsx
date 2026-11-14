"use client";

import type { AiModel, AiProvider, AiSettings, AllowedModel, IntegrationsStatus } from "@forge/protocol";
import { modelCanCode } from "@forge/protocol";
import { Bot, BrainCircuit, CheckCircle2, ChevronRight, ExternalLink, GitBranch, Info, KeyRound, PenTool, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { BusyLabel, Skeleton } from "@/components/loading";
import { ApiError, api } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/me";
import { OptionCard } from "@/components/option-card";
import { Select, type SelectOption } from "@/components/select";
import { AllowedModels, COST_HINT, guessCost, modelOptions } from "./allowed-models";

/** Settings › Integrations: the AI that builds apps, the company's GitHub, and Figma (workspace admins). */
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
      <div className="mt-6 flex gap-4 border-b border-line pb-2.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="skel-line w-20" />
        ))}
      </div>
      {[0].map((i) => (
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
  }, [load]);

  // The open tab is in the address (?tab=github), so links and reloads come back to it. GitHub's
  // redirects (?github=connected, ?error=…) open the GitHub tab.
  const [tab, setTab] = useState<TabId>(() => {
    const t = params.get("tab");
    if (TABS.some((x) => x.id === t)) return t as TabId;
    return params.has("github") || params.has("error") ? "github" : "ai";
  });
  const choose = (t: TabId) => {
    setTab(t);
    setError(null);
    window.history.replaceState(null, "", `/settings/integrations?tab=${t}`);
  };
  useEffect(() => {
    // Drop ?github=…/?error=… once shown.
    if (params.has("github") || params.has("error")) router.replace(`/settings/integrations?tab=github`);
  }, [params, router]);

  if (me && !isAdmin(me)) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="h1">Integrations</h1>
        <p className="mt-2 text-ink-2">Only workspace admins can change the AI model and connect GitHub and Figma.</p>
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
      <div role="tablist" aria-label="Integrations" className="mt-6 flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => {
          const on = t.connected(status);
          return (
            <button
              key={t.id}
              id={`int-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`int-panel-${t.id}`}
              onClick={() => choose(t.id)}
              className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13.5px] font-medium transition-colors ${
                tab === t.id ? "border-primary text-primary" : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              <t.icon size={15} aria-hidden />
              {t.label}
              <span
                className={`size-1.5 rounded-full ${on ? "bg-ok" : "bg-ink-3/50"}`}
                aria-label={on ? "Connected" : "Not set up"}
                title={on ? "Connected" : "Not set up"}
              />
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`int-panel-${tab}`} aria-labelledby={`int-tab-${tab}`} className="fade-in [&>section]:mt-5" key={tab}>
        {tab === "ai" && <AiCard status={status.ai} onChange={load} onError={setError} />}
        {tab === "github" && <GitHubCard status={status.github} onChange={load} onError={setError} />}
        {tab === "figma" && <FigmaCard status={status.figma} onChange={load} onError={setError} />}
      </div>
    </main>
  );
}

type TabId = "ai" | "github" | "figma";
const TABS: { id: TabId; label: string; icon: typeof BrainCircuit; connected: (s: IntegrationsStatus) => boolean }[] = [
  { id: "ai", label: "AI model", icon: BrainCircuit, connected: (s) => s.ai.keys[s.ai.provider].source !== null },
  { id: "github", label: "GitHub", icon: GitBranch, connected: (s) => s.github.state === "connected" },
  { id: "figma", label: "Figma", icon: PenTool, connected: (s) => s.figma.configured },
];

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

/* --------------------------------- AI model -------------------------------- */

const PROVIDERS: { id: AiProvider; title: string; text: string; icon: React.ReactNode; keyHint: string; keyPlaceholder: string }[] = [
  {
    id: "anthropic",
    title: "Claude",
    text: "Anthropic's models. Forge's agent is built for them.",
    icon: <Sparkles size={16} aria-hidden />,
    keyHint: "Anthropic Console › API keys",
    keyPlaceholder: "sk-ant-…",
  },
  {
    id: "openai",
    title: "ChatGPT",
    text: "OpenAI's models, with the same agent, tools and checks.",
    icon: <Bot size={16} aria-hidden />,
    keyHint: "platform.openai.com › API keys",
    keyPlaceholder: "sk-…",
  },
];

function AiCard({ status, onChange, onError }: { status: AiSettings; onChange: () => void; onError: (m: string | null) => void }) {
  const [provider, setProvider] = useState<AiProvider>(status.provider);
  const [model, setModel] = useState(status.model);
  const [fastModel, setFastModel] = useState<string | null>(status.fastModel);
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [allowed, setAllowed] = useState<AllowedModel[]>(status.allowed);

  const key = status.keys[provider];
  const hasKey = key.source !== null;
  const meta = PROVIDERS.find((p) => p.id === provider)!;

  const loadModels = useCallback(
    async (p: AiProvider, withKey?: string) => {
      setLoading(true);
      onError(null);
      try {
        const r = await api.aiModels(p, withKey);
        setModels(r.models);
        return r.models;
      } catch (e) {
        setModels(null);
        onError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  // The saved provider's models (again after a save, e.g. with a new key).
  const savedSource = status.keys[status.provider].source;
  useEffect(() => {
    if (!savedSource && status.provider !== "anthropic") return;
    let live = true;
    api.aiModels(status.provider).then(
      (r) => live && setModels(r.models),
      (e) => live && onError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [status.provider, savedSource, onError]);

  function choose(p: AiProvider) {
    if (p === provider) return;
    setProvider(p);
    setApiKey("");
    setReplacingKey(false);
    setSaved(false);
    setModels(null);
    // Keep the saved choice when switching back; otherwise pick after the list loads.
    setModel(p === status.provider ? status.model : "");
    setFastModel(p === status.provider ? status.fastModel : null);
    if (status.keys[p].source || p === "anthropic") {
      void loadModels(p).then((list) => {
        if (list?.length && p !== status.provider) setModel(list[0]!.id);
      });
    }
  }

  async function checkKey() {
    const list = await loadModels(provider, apiKey.trim());
    if (list?.length && !list.some((m) => m.id === model)) setModel(list[0]!.id);
  }

  async function save() {
    setBusy("save");
    onError(null);
    try {
      await api.updateAi({ provider, model, fastModel, allowed: allowedView, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setApiKey("");
      setReplacingKey(false);
      setSaved(true);
      onChange();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // The saved model stays pickable even if the provider no longer lists it.
  const options: SelectOption[] = modelOptions(models ?? [], provider, allowed);
  // The default model has to build apps, so chat-only models can't be picked for it.
  const defaultOptions: SelectOption[] = options.map((o) => (modelCanCode(provider, o.value) ? o : { ...o, disabled: true }));
  if (model && !options.some((o) => o.value === model)) options.unshift({ value: model, label: model, hint: "Current model" });
  const fastOptions: SelectOption[] = [
    { value: "", label: provider === "anthropic" ? "Default (Claude Haiku)" : "Same as the main model" },
    ...options.filter((o) => o.value !== model),
  ];
  const needsKey = !hasKey || replacingKey;
  // The default model is always on the allowed list (first, when it isn't there yet).
  const allowedView: AllowedModel[] =
    !model || allowed.some((m) => m.provider === provider && m.id === model)
      ? allowed
      : [
          {
            provider,
            id: model,
            label: options.find((o) => o.value === model)?.label ?? model,
            hint: COST_HINT[guessCost(model)],
            cost: guessCost(model),
          },
          ...allowed,
        ];
  const keyedProviders = (["anthropic", "openai"] as AiProvider[]).filter((p) => status.keys[p].source !== null);
  // Field order differs between the server's copy and ours, so compare field by field.
  const sameAllowed =
    allowedView.length === status.allowed.length &&
    allowedView.every((m, i) => {
      const o = status.allowed[i]!;
      const samePrice = JSON.stringify(m.price ? [m.price.input, m.price.cachedInput, m.price.output] : null) ===
        JSON.stringify(o.price ? [o.price.input, o.price.cachedInput, o.price.output] : null);
      return m.provider === o.provider && m.id === o.id && m.label === o.label && m.hint === o.hint && m.cost === o.cost && samePrice;
    });
  const changed = !sameAllowed || provider !== status.provider || model !== status.model || (fastModel ?? null) !== (status.fastModel ?? null) || Boolean(apiKey.trim());
  const current = PROVIDERS.find((p) => p.id === status.provider)!;

  return (
    <Card
      icon={<BrainCircuit size={22} aria-hidden />}
      title="AI model"
      state={
        status.keys[status.provider].source ? (
          <span className="pill pill-ok">
            {current.title} · {status.model}
          </span>
        ) : (
          <span className="pill pill-warn">No API key</span>
        )
      }
    >
      <p className="text-ink-2">Choose the AI that builds and changes apps for everyone in the workspace. A change applies from the next request.</p>

      <div role="radiogroup" aria-label="AI provider" className="grid gap-2 sm:grid-cols-2">
        {PROVIDERS.map((p) => (
          <OptionCard
            key={p.id}
            selected={provider === p.id}
            onSelect={() => choose(p.id)}
            title={p.title}
            text={p.text}
            icon={p.icon}
            badge={status.provider === p.id ? <span className="pill pill-pri">In use</span> : undefined}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="lab">{meta.title} API key</span>
        {!needsKey ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-[13px]">
            <KeyRound size={15} className="text-ink-3" aria-hidden />
            <span className="font-mono">••••{key.last4}</span>
            <span className="text-ink-3">{key.source === "env" ? "from the server's .env file" : `added by ${key.updatedBy ?? "an admin"}`}</span>
            <span className="ml-auto flex gap-1.5">
              <button type="button" className="btn btn-sm" onClick={() => setReplacingKey(true)}>
                Replace
              </button>
              {key.source === "settings" && (
                <button
                  type="button"
                  className="btn btn-g btn-sm btn-danger"
                  aria-busy={busy === "remove"}
                  onClick={() => {
                    setBusy("remove");
                    void api
                      .removeAiKey(provider)
                      .then(onChange, (e) => onError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setBusy(null));
                  }}
                >
                  <BusyLabel busy={busy === "remove"}>Remove</BusyLabel>
                </button>
              )}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <input
                className="in flex-1 font-mono"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={meta.keyPlaceholder}
                autoComplete="off"
                aria-label={`${meta.title} API key`}
              />
              <button type="button" className="btn btn-sm h-auto" disabled={apiKey.trim().length < 20 || loading} onClick={() => void checkKey()}>
                <BusyLabel busy={loading} busyText="Checking…">
                  Check key
                </BusyLabel>
              </button>
              {replacingKey && (
                <button type="button" className="btn btn-g btn-sm h-auto" onClick={() => setReplacingKey(false)}>
                  Cancel
                </button>
              )}
            </div>
            <p className="lab">
              Create one in {meta.keyHint}. It&apos;s stored encrypted and never reaches project sandboxes.
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="lab">Model</span>
          <Select
            ariaLabel="Model"
            value={model}
            onChange={(v) => {
              setModel(v);
              setSaved(false);
              if (v === fastModel) setFastModel(null);
            }}
            options={defaultOptions}
            searchable
            disabled={!models && !model}
            placeholder={loading ? "Loading models…" : needsKey ? "Check the key to see models" : "Choose a model"}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="lab">Model for small steps</span>
          <Select
            ariaLabel="Model for small steps"
            value={fastModel ?? ""}
            onChange={(v) => {
              setFastModel(v || null);
              setSaved(false);
            }}
            options={fastOptions}
            searchable
            disabled={!models}
          />
        </label>
      </div>
      <p className="lab -mt-1">
        Small steps are quick background jobs (naming a session, checking a command). A cheaper, faster model is enough.
      </p>

      {keyedProviders.length > 0 && (
        <AllowedModels value={allowedView} onChange={setAllowed} providers={keyedProviders} defaultModel={{ provider, id: model }} />
      )}

      {provider === "openai" && (
        <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
          <Info size={14} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
          Forge&apos;s agent was designed for Claude. With ChatGPT it uses the same tools and checks, but web search isn&apos;t available to it, and costs on the
          Usage page are estimates.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-p btn-sm" disabled={!model || !changed || busy !== null || (needsKey && !apiKey.trim() && !hasKey)} onClick={() => void save()}>
          <BusyLabel busy={busy === "save"} busyText={apiKey.trim() ? "Checking the key…" : "Saving…"}>
            Save
          </BusyLabel>
        </button>
        {saved && !changed && (
          <span className="flex items-center gap-1.5 text-[13px] text-ok" role="status">
            <CheckCircle2 size={14} aria-hidden />
            Saved. New requests use {PROVIDERS.find((p) => p.id === status.provider)!.title}.
          </span>
        )}
        {status.updatedBy && !saved && <span className="lab">Last changed by {status.updatedBy}</span>}
      </div>
    </Card>
  );
}
