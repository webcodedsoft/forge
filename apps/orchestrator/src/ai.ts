import type { AiModel, AiProvider, AiSettings, AllowedModel, CostTier, ProjectModels, UpdateAiSettingsInput } from "@forge/protocol";
import { modelCanCode, type ModelPrice } from "@forge/protocol";
import { listPrice } from "./openai-pricing.ts";
import { env } from "./env.ts";
import { IntegrationError, load, save } from "./integrations.ts";

/*
 * Settings › Integrations › AI model: which AI builds the apps.
 *
 *   Claude (Anthropic)  the agent talks to Anthropic directly (through the model proxy).
 *   ChatGPT (OpenAI)    the same agent, tools and checks; the model proxy translates its requests
 *                       to OpenAI's Chat Completions API and the answers back (openai-bridge.ts).
 *
 * API keys are stored encrypted (integration "ai"); ANTHROPIC_API_KEY / OPENAI_API_KEY in .env
 * are used when no key was added here. Keys never enter project containers.
 */

type Config = {
  provider: AiProvider;
  model: string;
  fastModel: string | null;
  keys: Partial<Record<AiProvider, { last4: string; updatedBy: string }>>;
  /** Models people may pick per message (the default is always allowed). */
  allowed?: AllowedModel[];
};
type Secret = Partial<Record<AiProvider, string>>;

const KEY = "ai";

export const PROVIDER_NAME: Record<AiProvider, string> = { anthropic: "Claude", openai: "ChatGPT" };

/** Used before anyone picks a model (and when the list can't be loaded). */
const CLAUDE_MODELS: AiModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable for building apps" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Fast and capable" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest, good for small steps" },
];

async function stored() {
  const row = await load<Config, Secret>(KEY);
  return {
    config: row?.config ?? null,
    secret: row?.secret ?? {},
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

const envKey = (p: AiProvider) => (p === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || undefined;

/** The picker's "Auto": Forge chooses per request (pickAuto) and moves up when checks keep failing. */
export const AUTO_MODEL = "auto";

/** "provider:model", how a model is named in requests and on projects. */
export const modelKey = (provider: AiProvider, id: string) => `${provider}:${id}`;

/** A best guess at how expensive a model is, from its name (admins can change it). */
export function guessCost(id: string): CostTier {
  if (/haiku|mini|nano|flash|lite/.test(id)) return 1;
  if (/opus|fable|^o\d|gpt-5|gpt-6/.test(id)) return 3;
  return 2;
}
export const COST_HINT: Record<CostTier, string> = {
  1: "Fast and cheap, for small edits",
  2: "Good balance for everyday changes",
  3: "Best for big changes",
};

/** The allowed list with the default model in it (first, if it was missing). */
function allowedOf(config: Config | null): AllowedModel[] {
  const provider = config?.provider ?? "anthropic";
  const model = config?.model ?? env.FORGE_MODEL;
  const list = config?.allowed ?? [];
  if (list.some((m) => m.provider === provider && m.id === model)) return list;
  const label = CLAUDE_MODELS.find((m) => m.id === model)?.label ?? model;
  return [{ provider, id: model, label, hint: COST_HINT[guessCost(model)], cost: guessCost(model) }, ...list];
}

export async function aiSettings(): Promise<AiSettings> {
  const s = await stored();
  const keyInfo = (p: AiProvider): AiSettings["keys"][AiProvider] => {
    if (s.secret[p]) return { source: "settings", last4: s.config?.keys[p]?.last4 ?? null, updatedBy: s.config?.keys[p]?.updatedBy ?? null };
    const k = envKey(p);
    return k ? { source: "env", last4: k.slice(-4), updatedBy: null } : { source: null, last4: null, updatedBy: null };
  };
  return {
    provider: s.config?.provider ?? "anthropic",
    model: s.config?.model ?? env.FORGE_MODEL,
    fastModel: s.config?.fastModel ?? null,
    keys: { anthropic: keyInfo("anthropic"), openai: keyInfo("openai") },
    allowed: allowedOf(s.config),
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt?.toISOString() ?? null,
  };
}

export type RunAiChoice = {
  provider: AiProvider;
  model: string;
  label: string;
  fastModel: string | null;
  apiKey: string;
  /** Admin-set prices of OpenAI models, by id (model-proxy.ts prices each request). */
  prices: Record<string, ModelPrice>;
};

/**
 * What a run uses: `choice` ("provider:model") when the admin allows it and its provider has a
 * key, else the workspace default. Throws (with a message for people) when there's no key.
 */
export async function aiForRun(choice?: string | null): Promise<RunAiChoice> {
  const s = await stored();
  const allowed = allowedOf(s.config);
  const defProvider = s.config?.provider ?? "anthropic";
  const defModel = s.config?.model ?? env.FORGE_MODEL;
  const keyFor = (p: AiProvider) => s.secret[p] ?? envKey(p);
  const picked = choice ? allowed.find((m) => modelKey(m.provider, m.id) === choice && keyFor(m.provider)) : undefined;
  const provider = picked?.provider ?? defProvider;
  const model = picked?.id ?? defModel;
  const apiKey = keyFor(provider);
  if (!apiKey) throw new IntegrationError(`${PROVIDER_NAME[provider]} has no API key. An admin can add one in Settings › Integrations › AI model.`);
  const label = allowed.find((m) => m.provider === provider && m.id === model)?.label ?? model;
  // The fast model (the agent's small side tasks) is set for the default provider. Claude without
  // one uses its own default (Haiku). ChatGPT without one uses the cheapest allowed OpenAI model
  // that isn't dearer than the chosen one, so titles and command checks don't run on the big model.
  const cheapestOpenAi = allowed
    .filter((m) => m.provider === "openai" && modelCanCode("openai", m.id))
    .sort((a, b) => a.cost - b.cost)[0];
  const ownCost = allowed.find((m) => m.provider === provider && m.id === model)?.cost ?? guessCost(model);
  const fastModel =
    provider === defProvider && s.config?.fastModel
      ? s.config.fastModel
      : provider === "openai"
        ? cheapestOpenAi && cheapestOpenAi.cost < ownCost
          ? cheapestOpenAi.id
          : model
        : null;
  const prices = Object.fromEntries(allowed.flatMap((m) => (m.provider === "openai" && m.price ? [[m.id, m.price] as const] : [])));
  return { provider, model, label, fastModel, apiKey, prices };
}

/* --------------------------------- Auto --------------------------------- */

/** Models with a key that can build, cheapest first; the default's provider first among equals. */
async function buildModels() {
  const s = await stored();
  const defProvider = s.config?.provider ?? "anthropic";
  const defModel = s.config?.model ?? env.FORGE_MODEL;
  const usable = allowedOf(s.config).filter((m) => (s.secret[m.provider] ?? envKey(m.provider)) && modelCanCode(m.provider, m.id));
  const sorted = [...usable].sort((a, b) => a.cost - b.cost || Number(b.provider === defProvider) - Number(a.provider === defProvider));
  const def = usable.find((m) => m.provider === defProvider && m.id === defModel) ?? sorted[sorted.length - 1];
  return { sorted, def };
}

/** Requests that are small, self-contained edits. */
const SMALL =
  /\b(typo|spelling|rename|reword|wording|text|label|title|heading|caption|copy|colou?r|font|bold|italic|size|bigger|smaller|padding|margin|spacing|gap|align|center|centre|icon|emoji|logo|border|radius|rounded|shadow|hide|remove the|delete the|swap|capitali[sz]e|placeholder|tooltip|link)\b/i;
/** Requests that need the strong model whatever their length. */
const BIG =
  /\b(new page|add a page|pages|dashboard|auth|login|sign[- ]?in|sign[- ]?up|database|schema|migration|api|endpoint|integrat|refactor|architecture|redesign|rebuild|from scratch|workflow|permissions?|roles?|payment|upload|search|filter|chart|table|form|wizard|import|export|sync|real[- ]?time|notification|tests?|bugs?|errors?|broken|crash\w*|fix\w*|doesn'?t work|not working|fail\w*|conflicts?)\b/i;

export type AutoPick = { key: string; label: string; tier: "small" | "standard" | "large"; why: string };

/**
 * Auto: which model a request starts on. No AI involved: the mode, the request's length, whether
 * it has attachments and a few keywords decide. Small edits start on the cheapest model; plans,
 * designs and anything that reads like a feature or a bug use the workspace default.
 */
export async function pickAuto(prompt: string, mode: string): Promise<AutoPick | null> {
  const { sorted, def } = await buildModels();
  if (!def) return null;
  const pick = (m: (typeof sorted)[number], tier: AutoPick["tier"], why: string): AutoPick => ({ key: modelKey(m.provider, m.id), label: m.label, tier, why });
  const cheapest = sorted[0]!;
  const text = prompt.replace(/\(Forge:[\s\S]*?\)/g, "").trim();
  const attached = /\.forge\/uploads\//.test(text) || /figma\.com\//i.test(text);
  if (mode === "plan" || mode === "design") return pick(def, "large", mode === "plan" ? "a plan" : "a design to rebuild");
  if (mode === "chat") return pick(cheapest, "small", "a question");
  if (cheapest.cost >= def.cost) return pick(def, "standard", "the only model allowed");
  if (attached || text.length > 600 || BIG.test(text)) return pick(def, "large", attached ? "it has attachments" : text.length > 600 ? "a long request" : "it reads like a feature or a fix");
  if (text.length <= 240 && SMALL.test(text)) return pick(cheapest, "small", "a small edit");
  // In between: the middle model when there is one, else the default.
  const mid = sorted.find((m) => m.cost > cheapest.cost && m.cost < def.cost);
  return mid ? pick(mid, "standard", "an everyday change") : pick(def, "standard", "an everyday change");
}

/** The next model up from `key` (for Auto when checks keep failing), or null when it's already the default or dearer. */
export async function strongerThan(key: string | null): Promise<{ key: string; label: string } | null> {
  const { sorted, def } = await buildModels();
  if (!def) return null;
  const cur = sorted.find((m) => modelKey(m.provider, m.id) === key);
  if (!cur || cur.cost >= def.cost) return null;
  return { key: modelKey(def.provider, def.id), label: def.label };
}

/**
 * The model for testing (the QA agent). Testing is many small steps (open, click, read what
 * changed), so it runs on the cheapest allowed model that can use tools, preferring the default's
 * provider. FORGE_QA_MODEL ("provider:model", or "default") overrides this. null: the default.
 */
export async function qaModelKey(): Promise<string | null> {
  const { sorted, def } = await buildModels();
  if (!def) return null;
  const forced = process.env.FORGE_QA_MODEL?.trim();
  if (forced === "default") return null;
  if (forced && sorted.some((m) => modelKey(m.provider, m.id) === forced)) return forced;
  const cheaper = sorted.filter((m) => m.cost < def.cost);
  const pick = cheaper.find((m) => m.provider === def.provider) ?? cheaper[0];
  return pick ? modelKey(pick.provider, pick.id) : null;
}

/** The prompt box's model picker for a project. */
export async function projectModels(lastModel: string | null): Promise<ProjectModels> {
  const s = await stored();
  const defaultKey = modelKey(s.config?.provider ?? "anthropic", s.config?.model ?? env.FORGE_MODEL);
  const models = allowedOf(s.config).map((m) => ({
    ...m,
    key: modelKey(m.provider, m.id),
    available: Boolean(s.secret[m.provider] ?? envKey(m.provider)),
    canCode: modelCanCode(m.provider, m.id),
  }));
  // Auto is offered when there is something to choose between.
  const auto = new Set(models.filter((m) => m.available && m.canCode).map((m) => m.cost)).size > 1;
  const current = lastModel === AUTO_MODEL && auto ? AUTO_MODEL : (models.find((m) => m.key === lastModel && m.available)?.key ?? defaultKey);
  return { models, defaultKey, currentKey: current, auto };
}

/** Whether any run can start (a key for the chosen AI exists). */
export async function aiReady(): Promise<boolean> {
  return aiForRun().then(
    () => true,
    () => false,
  );
}

/* ------------------------------ models and keys ----------------------------- */

const OPENAI_SKIP = /audio|realtime|transcribe|tts|image|search|embedding|instruct|dall-e|whisper|moderation|codex-mini|computer-use|-preview-\d|babbage|davinci/;

async function fetchModels(provider: AiProvider, apiKey: string): Promise<AiModel[]> {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("Anthropic didn't accept that API key.");
    if (!res.ok) throw new IntegrationError(`Anthropic answered ${res.status} when listing models.`);
    const body = (await res.json()) as { data: { id: string; display_name?: string }[] };
    return body.data.map((m) => ({ id: m.id, label: m.display_name ?? m.id, hint: CLAUDE_MODELS.find((c) => c.id === m.id)?.hint }));
  }
  const res = await fetch(`${env.OPENAI_BASE_URL}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new IntegrationError("OpenAI didn't accept that API key.");
  if (!res.ok) throw new IntegrationError(`OpenAI answered ${res.status} when listing models.`);
  const body = (await res.json()) as { data: { id: string; created?: number }[] };
  return body.data
    .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_SKIP.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, label: m.id, price: listPrice(m.id) }));
}

/** Models people can pick for a provider. `apiKey`: a key being added (else the saved one). */
export async function listModels(provider: AiProvider, apiKey?: string): Promise<{ models: AiModel[]; source: "api" | "builtin" }> {
  const s = await stored();
  const key = apiKey || s.secret[provider] || envKey(provider);
  if (!key) {
    if (provider === "anthropic") return { models: CLAUDE_MODELS, source: "builtin" };
    throw new IntegrationError("Add an OpenAI API key first, then pick a model.");
  }
  try {
    const models = await fetchModels(provider, key);
    return models.length ? { models, source: "api" } : { models: provider === "anthropic" ? CLAUDE_MODELS : [], source: "builtin" };
  } catch (err) {
    if (provider === "anthropic" && !(err instanceof IntegrationError && /accept/.test(err.message))) return { models: CLAUDE_MODELS, source: "builtin" };
    throw err;
  }
}

export async function updateAiSettings(input: UpdateAiSettingsInput, by: string): Promise<void> {
  const s = await stored();
  const secret: Secret = { ...s.secret };
  const keys = { ...(s.config?.keys ?? {}) };
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    await fetchModels(input.provider, apiKey); // throws when the key is wrong
    secret[input.provider] = apiKey;
    keys[input.provider] = { last4: apiKey.slice(-4), updatedBy: by };
  }
  if (!secret[input.provider] && !envKey(input.provider)) throw new IntegrationError(`Add a ${PROVIDER_NAME[input.provider]} API key first.`);
  const model = input.model.trim();
  if (!model) throw new IntegrationError("Pick a model.");
  if (input.provider === "anthropic" && !model.startsWith("claude")) throw new IntegrationError("Pick a Claude model.");
  if (input.provider === "openai" && model.startsWith("claude")) throw new IntegrationError("Pick an OpenAI model.");
  if (!modelCanCode(input.provider, model)) throw new IntegrationError(`${model} can only chat, it can't build apps. Pick a model that can code as the default.`);
  const allowed = (input.allowed ?? s.config?.allowed ?? [])
    .filter((m) => m.id.trim() && (secret[m.provider] || envKey(m.provider)))
    .slice(0, 24)
    .map((m) => ({
      provider: m.provider,
      id: m.id.trim(),
      label: m.label.trim().slice(0, 60) || m.id,
      hint: m.hint.trim().slice(0, 80),
      cost: m.cost,
      ...(m.provider === "openai" && m.price ? { price: m.price } : {}),
    }));
  await save(KEY, { provider: input.provider, model, fastModel: input.fastModel?.trim() || null, keys, allowed } satisfies Config, secret, by);
}

/** Forget a key added in Settings (a key in .env stays). */
export async function removeAiKey(provider: AiProvider, by: string): Promise<void> {
  const s = await stored();
  if (!s.config) return;
  const secret = { ...s.secret };
  delete secret[provider];
  const keys = { ...s.config.keys };
  delete keys[provider];
  await save(KEY, { ...s.config, keys }, secret, by);
}

/** A chosen model ("provider:model") that can only chat, or null when it can build (or isn't allowed). */
export async function chatOnlyModel(choice: string | null | undefined): Promise<string | null> {
  if (!choice) return null;
  const s = await stored();
  const m = allowedOf(s.config).find((x) => modelKey(x.provider, x.id) === choice);
  return m && !modelCanCode(m.provider, m.id) ? m.label : null;
}
