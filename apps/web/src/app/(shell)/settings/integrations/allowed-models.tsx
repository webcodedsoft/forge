"use client";

import type { AiModel, AiProvider, AllowedModel, CostTier, ModelPrice } from "@forge/protocol";
import { modelCanCode } from "@forge/protocol";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Select } from "@/components/select";
import { api } from "@/lib/api";

/*
 * Settings › Integrations › AI model › "Models people can choose": the models builders may pick
 * per message in the prompt box, each with a cost level and a short hint. The default model is
 * always on the list.
 */

const PROVIDER_TITLE: Record<AiProvider, string> = { anthropic: "Claude", openai: "ChatGPT" };

export const COST_HINT: Record<CostTier, string> = {
  1: "Fast and cheap, for small edits",
  2: "Good balance for everyday changes",
  3: "Best for big changes",
};

/** Same guess as the server (ai.ts guessCost). */
export function guessCost(id: string): CostTier {
  if (/haiku|mini|nano|flash|lite/.test(id)) return 1;
  if (/opus|fable|^o\d|gpt-5|gpt-6/.test(id)) return 3;
  return 2;
}

export const COST_NAME: Record<CostTier, string> = { 1: "Low", 2: "Medium", 3: "High" };
/** "Low cost", "Medium cost", "High cost": a rough level set by an admin, not a price. */
export const costLabel = (c: CostTier) => `${COST_NAME[c]} cost`;

/**
 * The short description shown under a model in the admin's lists: its cost level and what it's
 * good for (the provider's own hint when there is one, else the hint for its cost level).
 */
export function describeModel(m: AiModel, allowed?: AllowedModel[], provider?: AiProvider): string {
  const known = allowed?.find((a) => a.id === m.id);
  const cost = known?.cost ?? guessCost(m.id);
  const what = known?.hint || m.hint || COST_HINT[cost];
  void provider;
  return `${costLabel(cost)} · ${what}${m.label !== m.id ? ` · ${m.id}` : ""}`;
}

/**
 * Dropdown options for picking models: each tagged "Coding and chat" or "Chat only", with the
 * models that can build listed first (they're the ones that can run Build, Plan and Design).
 */
export function modelOptions(list: AiModel[], provider: AiProvider, allowed?: AllowedModel[]) {
  const code = (id: string) => modelCanCode(provider, id);
  return [...list]
    .sort((a, b) => Number(code(b.id)) - Number(code(a.id)))
    .map((m) => ({
      value: m.id,
      label: m.label,
      hint: describeModel(m, allowed, provider),
      tag: code(m.id) ? { label: "Coding and chat", tone: "pri" as const } : { label: "Chat only", tone: "muted" as const },
    }));
}

/** "Coding and chat" or "Chat only", as a small tag. */
export function UseTag({ provider, id }: { provider: AiProvider; id: string }) {
  const code = modelCanCode(provider, id);
  return (
    <span
      className={`rounded px-1.5 py-px text-[10.5px] font-medium ${code ? "bg-primary-weak text-primary" : "bg-surface-2 text-ink-2"}`}
      title={code ? "Can build and change apps, and answer questions" : "Can answer questions in Chat mode; can't build"}
    >
      {code ? "Coding and chat" : "Chat only"}
    </span>
  );
}

export function AllowedModels({
  value,
  onChange,
  providers,
  defaultModel,
}: {
  value: AllowedModel[];
  onChange: (list: AllowedModel[]) => void;
  /** Providers that have an API key (only their models can be offered). */
  providers: AiProvider[];
  defaultModel: { provider: AiProvider; id: string };
}) {
  const [lists, setLists] = useState<Partial<Record<AiProvider, AiModel[]>>>({});
  const providerKey = providers.join(",");
  useEffect(() => {
    let live = true;
    for (const p of providerKey.split(",").filter(Boolean) as AiProvider[]) {
      api.aiModels(p).then(
        (r) => live && setLists((l) => ({ ...l, [p]: r.models })),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [providerKey]);

  const listPriceOf = (id: string) => lists.openai?.find((x) => x.id === id)?.price ?? null;
  const isDefault = (m: { provider: AiProvider; id: string }) => m.provider === defaultModel.provider && m.id === defaultModel.id;
  const update = (i: number, patch: Partial<AllowedModel>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <p className="text-[13.5px] font-semibold">Models people can choose</p>
        <p className="lab">Builders pick one of these per message in the prompt box. Cheaper models save a lot on small edits.</p>
      </div>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
        {value.map((m, i) => (
          <li key={`${m.provider}:${m.id}`} className="grid gap-x-3 gap-y-2 bg-surface px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <div className="min-w-0">
              {/* Name and tags wrap onto a second line on narrow screens. */}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-medium">
                <span className="min-w-0 break-all">{m.label}</span>
                <span className="pill text-[10.5px]">{PROVIDER_TITLE[m.provider]}</span>
                <UseTag provider={m.provider} id={m.id} />
                {isDefault(m) && <span className="pill pill-pri text-[10.5px]">Default</span>}
              </p>
              <input
                className="mt-1 w-full bg-transparent text-[12.5px] text-ink-2 outline-none placeholder:text-ink-3 focus:text-ink"
                value={m.hint}
                maxLength={80}
                onChange={(e) => update(i, { hint: e.target.value })}
                placeholder="Short hint, e.g. Best for big changes"
                aria-label={`Hint for ${m.label}`}
              />
              {m.provider === "openai" && (
                <PriceLine
                  price={m.price ?? listPriceOf(m.id)}
                  custom={Boolean(m.price)}
                  onChange={(price) => update(i, { price })}
                  label={m.label}
                />
              )}
            </div>
            <div className="seg w-full sm:w-auto" role="radiogroup" aria-label={`Cost level of ${m.label}`}>
              {([1, 2, 3] as CostTier[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={m.cost === c}
                  className="mode min-w-14 flex-1 justify-center text-[12px] sm:flex-none"
                  onClick={() => update(i, { cost: c })}
                  title={COST_HINT[c]}
                >
                  {COST_NAME[c]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-g btn-sm justify-self-end"
              disabled={isDefault(m)}
              title={isDefault(m) ? "The default model is always available" : "Remove"}
              aria-label={`Remove ${m.label}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X size={14} aria-hidden />
              <span className="sm:hidden">Remove</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => {
          const options = modelOptions(
            (lists[p] ?? []).filter((o) => !value.some((m) => m.provider === p && m.id === o.id)),
            p,
          );
          return (
            <div key={p} className="min-w-56 flex-1">
              <Select
                ariaLabel={`Add a ${PROVIDER_TITLE[p]} model`}
                value=""
                placeholder={lists[p] ? `Add a ${PROVIDER_TITLE[p]} model…` : "Loading models…"}
                options={options}
                searchable
                size="sm"
                disabled={!lists[p] || options.length === 0}
                onChange={(id) => {
                  const o = lists[p]!.find((x) => x.id === id)!;
                  const cost = guessCost(id);
                  onChange([...value, { provider: p, id, label: o.label, hint: o.hint || COST_HINT[cost], cost }]);
                }}
              />
            </div>
          );
        })}
      </div>
      {providers.length < 2 && (
        <p className="lab flex items-center gap-1.5">
          <Plus size={12} aria-hidden />
          Add the other provider&apos;s API key to offer its models too.
        </p>
      )}
    </div>
  );
}

const fmt = (n: number) => `$${n < 1 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2)}`;

/**
 * An OpenAI model's price (USD per million tokens), which the Usage page uses. Shows Forge's list
 * price when it knows one; admins can set their own (e.g. for newer models or negotiated prices).
 */
function PriceLine({
  price,
  custom,
  onChange,
  label,
}: {
  price: ModelPrice | null;
  custom: boolean;
  onChange: (p: ModelPrice | null) => void;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ input: "", cachedInput: "", output: "" });
  const begin = () => {
    setDraft({ input: String(price?.input ?? ""), cachedInput: String(price?.cachedInput ?? ""), output: String(price?.output ?? "") });
    setEditing(true);
  };
  if (editing) {
    const num = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Math.max(0, Number(v)));
    const parsed = { input: num(draft.input), cachedInput: num(draft.cachedInput) ?? num(draft.input), output: num(draft.output) };
    const ok = parsed.input !== null && parsed.output !== null;
    return (
      <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-2 p-2">
        {(
          [
            ["input", "Input"],
            ["cachedInput", "Cached input"],
            ["output", "Output"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="flex min-w-24 flex-1 flex-col gap-1">
            <span className="lab">{l} $/1M</span>
            <input
              className="in h-8 text-[13px]"
              inputMode="decimal"
              value={draft[k]}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              placeholder={k === "cachedInput" ? "Same as input" : "0.00"}
              aria-label={`${l} price for ${label}, dollars per million tokens`}
            />
          </label>
        ))}
        <div className="flex gap-1.5">
          <button
            type="button"
            className="btn btn-p btn-sm"
            disabled={!ok}
            onClick={() => {
              onChange(parsed as ModelPrice);
              setEditing(false);
            }}
          >
            Set price
          </button>
          <button type="button" className="btn btn-g btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <p className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] ${price ? "text-ink-3" : "text-warn"}`}>
      {price ? (
        <span>
          {fmt(price.input)} in · {fmt(price.cachedInput)} cached · {fmt(price.output)} out per 1M tokens{" "}
          <span className="text-ink-3/80">({custom ? "your price" : "list price"})</span>
        </span>
      ) : (
        <span>No price set: its costs on the Usage page will be estimates.</span>
      )}
      <button type="button" className="font-medium text-primary hover:underline" onClick={begin}>
        {price ? "Edit price" : "Set price"}
      </button>
      {custom && (
        <button type="button" className="text-ink-3 hover:text-ink hover:underline" onClick={() => onChange(null)}>
          Use list price
        </button>
      )}
    </p>
  );
}
