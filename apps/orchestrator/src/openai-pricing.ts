import type { ModelPrice } from "@forge/protocol";

/*
 * OpenAI list prices (USD per million tokens) for the models Forge knows. Admins can override a
 * model's price in Settings › Integrations › AI model (newer models need one there). Claude runs
 * are priced by the agent itself.
 */

const LIST: [RegExp, ModelPrice][] = [
  [/^gpt-4\.1-nano/, { input: 0.1, cachedInput: 0.025, output: 0.4 }],
  [/^gpt-4\.1-mini/, { input: 0.4, cachedInput: 0.1, output: 1.6 }],
  [/^gpt-4\.1/, { input: 2, cachedInput: 0.5, output: 8 }],
  [/^gpt-4o-mini/, { input: 0.15, cachedInput: 0.075, output: 0.6 }],
  [/^gpt-4o/, { input: 2.5, cachedInput: 1.25, output: 10 }],
  [/^gpt-5-nano/, { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  [/^gpt-5-mini/, { input: 0.25, cachedInput: 0.025, output: 2 }],
  [/^gpt-5(-\d{4}-\d{2}-\d{2})?$/, { input: 1.25, cachedInput: 0.125, output: 10 }],
  [/^o4-mini/, { input: 1.1, cachedInput: 0.275, output: 4.4 }],
  [/^o3-mini/, { input: 1.1, cachedInput: 0.55, output: 4.4 }],
  [/^o3(-\d{4}-\d{2}-\d{2})?$/, { input: 2, cachedInput: 0.5, output: 8 }],
  [/^o1(-\d{4}-\d{2}-\d{2})?$/, { input: 15, cachedInput: 7.5, output: 60 }],
];

/** Forge's list price for an OpenAI model, or null when it doesn't know one. */
export function listPrice(id: string): ModelPrice | null {
  return LIST.find(([re]) => re.test(id))?.[1] ?? null;
}

/** Cost in USD of one request. `input` excludes cached tokens. */
export function priceTokens(p: ModelPrice, t: { input: number; cached: number; output: number }): number {
  return (t.input * p.input + t.cached * p.cachedInput + t.output * p.output) / 1_000_000;
}
