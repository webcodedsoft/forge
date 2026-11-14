import type { ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { env } from "./env.ts";

/*
 * ChatGPT behind Forge's agent. The agent (Claude Agent SDK) speaks Anthropic's Messages API;
 * when an admin picks an OpenAI model, the model proxy hands /v1/messages here and this file:
 *   1. turns the Anthropic request into an OpenAI Chat Completions request
 *      (system prompt, text, images, PDFs, tool calls and tool results, tool definitions), and
 *   2. turns OpenAI's answer back into Anthropic's format, streaming included
 *      (message_start, content blocks with text and tool-use deltas, message_delta, message_stop).
 * Claude-only features (thinking blocks, prompt caching, server tools such as web search) are
 * dropped on the way out. Errors come back in Anthropic's error shape so the agent retries the same way.
 */

/* ------------------------------ Anthropic types ----------------------------- */

type ImageSource = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } | { type: "text"; data: string } | { type: "url"; url: string }; title?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | Block[]; is_error?: boolean }
  | { type: "thinking" | "redacted_thinking" | "server_tool_use" | "web_search_tool_result"; [k: string]: unknown };
type AMessage = { role: "user" | "assistant"; content: string | Block[] };
type ATool = { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string };
export type AnthropicRequest = {
  model: string;
  system?: string | { type: "text"; text: string }[];
  messages: AMessage[];
  tools?: ATool[];
  tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
  max_tokens?: number;
  stream?: boolean;
  thinking?: { type: "enabled" | "disabled" | "adaptive"; budget_tokens?: number };
};

/* ------------------------------- OpenAI types ------------------------------- */

type OPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };
type OToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/* -------------------------------- request -------------------------------- */

const blocks = (c: string | Block[] | undefined): Block[] => (c === undefined ? [] : typeof c === "string" ? [{ type: "text", text: c }] : c);

function imagePart(src: ImageSource): OPart {
  return { type: "image_url", image_url: { url: src.type === "base64" ? `data:${src.media_type};base64,${src.data}` : src.url } };
}

/** User-side content (text, images, documents) as OpenAI parts. */
function userParts(list: Block[]): OPart[] {
  const out: OPart[] = [];
  for (const b of list) {
    if (b.type === "text") {
      if (b.text) out.push({ type: "text", text: b.text });
    } else if (b.type === "image") out.push(imagePart(b.source));
    else if (b.type === "document") {
      const s = b.source;
      if (s.type === "text") out.push({ type: "text", text: s.data });
      else if (s.type === "base64") out.push({ type: "file", file: { filename: b.title || "document.pdf", file_data: `data:${s.media_type};base64,${s.data}` } });
      else out.push({ type: "text", text: `(Document: ${s.url})` });
    }
  }
  return out;
}

/** The text of a tool result; images in it are returned separately (tool messages can't hold images). */
function toolResult(b: Extract<Block, { type: "tool_result" }>): { text: string; images: OPart[] } {
  const list = blocks(b.content);
  const text = list.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n");
  const images = list.flatMap((x) => (x.type === "image" ? [imagePart(x.source)] : []));
  const body = text || (images.length ? "(The result is the image in the next message.)" : "(no output)");
  return { text: b.is_error ? `Error: ${body}` : body, images };
}

/** OpenAI's function parameters: a JSON schema object, without keys it rejects. */
function parameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  const { $schema: _s, ...rest } = schema;
  return rest.type ? rest : { type: "object", ...rest };
}

/**
 * How hard a reasoning model thinks. The agent asks for extended thinking on most turns; "high"
 * is slow and costly, so it's kept for large thinking budgets and "medium" is the default.
 */
const effortFor = (req: AnthropicRequest) => ((req.thinking?.budget_tokens ?? 0) >= 24_000 ? "high" : "medium");

/** Reasoning models (o-series, GPT-5 family) take reasoning_effort and no temperature. */
/**
 * Reasoning models (o-series, GPT-5 and later) take reasoning_effort and no temperature, and can
 * only use tools through the Responses API, so they go through toResponses() below.
 */
export const isReasoning = (model: string) => /^(o\d|gpt-([5-9]|\d{2}))/.test(model);

export function toOpenAI(req: AnthropicRequest, model: string): Record<string, unknown> {
  const messages: OMessage[] = [];
  const system = typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n\n");
  if (system) messages.push({ role: "system", content: system });

  for (const m of req.messages) {
    const list = blocks(m.content);
    if (m.role === "assistant") {
      const text = list.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls: OToolCall[] = list.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turn: tool results first (they must follow the assistant's tool calls), then the rest.
    const extra: OPart[] = [];
    for (const b of list) {
      if (b.type !== "tool_result") continue;
      const r = toolResult(b);
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: r.text });
      extra.push(...r.images);
    }
    const parts = [...extra, ...userParts(list.filter((b) => b.type !== "tool_result"))];
    if (parts.length) messages.push({ role: "user", content: parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts });
  }

  const tools = (req.tools ?? [])
    .filter((t) => t.input_schema && (!t.type || t.type === "custom"))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: parameters(t.input_schema) } }));

  const body: Record<string, unknown> = { model, messages };
  if (tools.length) {
    body.tools = tools;
    const tc = req.tool_choice;
    if (tc) body.tool_choice = tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : tc.type;
  }
  if (req.max_tokens) body.max_completion_tokens = req.max_tokens;
  if (isReasoning(model)) body.reasoning_effort = effortFor(req);
  if (req.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

/* -------------------------------- response -------------------------------- */

type OUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };

const STOP: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };
const msgId = () => `msg_${randomBytes(12).toString("hex")}`;
const usage = (u: OUsage | undefined) => ({
  input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - (u?.prompt_tokens_details?.cached_tokens ?? 0)),
  output_tokens: u?.completion_tokens ?? 0,
  cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
  cache_creation_input_tokens: 0,
});
const parseArgs = (s: string) => {
  try {
    return s ? (JSON.parse(s) as unknown) : {};
  } catch {
    return {};
  }
};

export function fromOpenAI(
  r: { choices: { message: { content?: string | null; refusal?: string | null; tool_calls?: OToolCall[] }; finish_reason: string }[]; usage?: OUsage },
  model: string,
) {
  const c = r.choices[0];
  const content: unknown[] = [];
  const text = c?.message.content ?? c?.message.refusal ?? "";
  if (text) content.push({ type: "text", text });
  for (const t of c?.message.tool_calls ?? []) content.push({ type: "tool_use", id: t.id, name: t.function.name, input: parseArgs(t.function.arguments) });
  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP[c?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: usage(r.usage),
  };
}

/** Anthropic-shaped error, with the status the agent expects for retries (429, 5xx). */
export function anthropicError(res: ServerResponse, status: number, message: string) {
  const type =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 429
        ? "rate_limit_error"
        : status === 400 || status === 404 || status === 413
          ? "invalid_request_error"
          : status === 529 || status === 503
            ? "overloaded_error"
            : "api_error";
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/** Reads OpenAI's SSE stream and writes Anthropic's. */
/** Tokens one request used (input excludes cached), for pricing. */
export type BridgeUsage = { input: number; cached: number; output: number };
const asBridgeUsage = (u: ReturnType<typeof usage>): BridgeUsage => ({ input: u.input_tokens, cached: u.cache_read_input_tokens, output: u.output_tokens });

async function streamBack(upstream: Response, res: ServerResponse, model: string): Promise<BridgeUsage | null> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: { id: msgId(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: usage(undefined) },
  });

  let index = -1; // the open content block, if any
  let open: "text" | "tool" | null = null;
  const toolBlock = new Map<number, number>(); // OpenAI tool_call index -> our block index
  let finish = "stop";
  let lastUsage: OUsage | undefined;
  const close = () => {
    if (open) send("content_block_stop", { type: "content_block_stop", index });
    open = null;
  };

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: {
        choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: OUsage;
        error?: { message?: string };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        close();
        send("error", { type: "error", error: { type: "api_error", message: chunk.error.message ?? "OpenAI stream error" } });
        res.end();
        return null;
      }
      if (chunk.usage) lastUsage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      const text = d.content ?? d.refusal;
      if (text) {
        if (open !== "text") {
          close();
          index++;
          open = "text";
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        }
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
      }
      for (const t of d.tool_calls ?? []) {
        if (!toolBlock.has(t.index)) {
          close();
          index++;
          open = "tool";
          toolBlock.set(t.index, index);
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: t.id ?? `call_${randomBytes(8).toString("hex")}`, name: t.function?.name ?? "", input: {} },
          });
        }
        const args = t.function?.arguments;
        if (args) send("content_block_delta", { type: "content_block_delta", index: toolBlock.get(t.index)!, delta: { type: "input_json_delta", partial_json: args } });
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  close();
  const u = usage(lastUsage);
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: STOP[finish] ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: u.output_tokens, input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
  return asBridgeUsage(u);
}

/* --------------------------------- handler -------------------------------- */

/** Rough token count for /v1/messages/count_tokens (OpenAI has no such endpoint). */
export function estimateTokens(req: Partial<AnthropicRequest>) {
  return Math.ceil(JSON.stringify({ s: req.system, m: req.messages, t: req.tools }).length / 3.5);
}

/**
 * Handle one Anthropic /v1/messages request with OpenAI. `model` is the model the request asked
 * for when it's an OpenAI one, else the run's model (the agent asks for Claude ids for side tasks).
 */
/* --------------------------- Responses API (reasoning) --------------------------- */

type RItem = Record<string, unknown>;

/** User-side content as Responses input parts. */
function inputParts(list: Block[]): RItem[] {
  return userParts(list).map((p) =>
    p.type === "text"
      ? { type: "input_text", text: p.text }
      : p.type === "image_url"
        ? { type: "input_image", image_url: p.image_url.url }
        : { type: "input_file", filename: p.file.filename, file_data: p.file.file_data },
  );
}

/** An Anthropic request as an OpenAI Responses request (reasoning models with tools). */
export function toResponses(req: AnthropicRequest, model: string): Record<string, unknown> {
  const input: RItem[] = [];
  for (const m of req.messages) {
    const list = blocks(m.content);
    if (m.role === "assistant") {
      const text = list.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const b of list) {
        if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    const images: RItem[] = [];
    for (const b of list) {
      if (b.type !== "tool_result") continue;
      const r = toolResult(b);
      input.push({ type: "function_call_output", call_id: b.tool_use_id, output: r.text });
      images.push(...r.images.map((p) => ({ type: "input_image", image_url: (p as { image_url: { url: string } }).image_url.url })));
    }
    const parts = [...images, ...inputParts(list.filter((b) => b.type !== "tool_result"))];
    if (parts.length) input.push({ role: "user", content: parts });
  }
  const system = typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n\n");
  const tools = (req.tools ?? [])
    .filter((t) => t.input_schema && (!t.type || t.type === "custom"))
    .map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: parameters(t.input_schema), strict: false }));
  const body: Record<string, unknown> = { model, input, store: false };
  if (system) body.instructions = system;
  if (tools.length) {
    body.tools = tools;
    const tc = req.tool_choice;
    if (tc) body.tool_choice = tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", name: tc.name } : tc.type;
  }
  if (req.max_tokens) body.max_output_tokens = req.max_tokens;
  body.reasoning = { effort: effortFor(req) };
  if (req.stream) body.stream = true;
  return body;
}

type RUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
const rUsage = (u: RUsage | undefined) => usage(u && { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, prompt_tokens_details: u.input_tokens_details });
type ROutput = { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string; refusal?: string }[] };
type RResponse = { status?: string; output?: ROutput[]; usage?: RUsage; incomplete_details?: { reason?: string } | null; error?: { message?: string } | null };

const rStop = (r: RResponse, sawTool: boolean) =>
  r.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : sawTool ? "tool_use" : r.incomplete_details?.reason === "content_filter" ? "refusal" : "end_turn";

export function fromResponses(r: RResponse, model: string) {
  const content: unknown[] = [];
  let sawTool = false;
  for (const o of r.output ?? []) {
    if (o.type === "message") {
      const text = (o.content ?? []).map((c) => c.text ?? c.refusal ?? "").join("");
      if (text) content.push({ type: "text", text });
    } else if (o.type === "function_call") {
      sawTool = true;
      content.push({ type: "tool_use", id: o.call_id, name: o.name, input: parseArgs(o.arguments ?? "") });
    }
  }
  return { id: msgId(), type: "message", role: "assistant", model, content, stop_reason: rStop(r, sawTool), stop_sequence: null, usage: rUsage(r.usage) };
}

/** Reads a Responses SSE stream and writes Anthropic's. */
async function streamResponsesBack(upstream: Response, res: ServerResponse, model: string): Promise<BridgeUsage | null> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: { id: msgId(), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: usage(undefined) },
  });
  let index = -1;
  let open = false;
  let sawTool = false;
  let final: RResponse = {};
  const blockFor = new Map<number, number>(); // output_index -> our block index
  const close = () => {
    if (open) send("content_block_stop", { type: "content_block_stop", index });
    open = false;
  };
  const start = (outputIndex: number, block: unknown) => {
    close();
    index++;
    open = true;
    blockFor.set(outputIndex, index);
    send("content_block_start", { type: "content_block_start", index, content_block: block });
  };

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let ev: { type?: string; output_index?: number; delta?: string; item?: ROutput; response?: RResponse; message?: string };
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      switch (ev.type) {
        case "response.output_item.added":
          if (ev.item?.type === "function_call") {
            sawTool = true;
            start(ev.output_index ?? 0, { type: "tool_use", id: ev.item.call_id, name: ev.item.name, input: {} });
          }
          break;
        case "response.output_text.delta":
        case "response.refusal.delta": {
          const oi = ev.output_index ?? 0;
          if (blockFor.get(oi) !== index || !open) start(oi, { type: "text", text: "" });
          if (ev.delta) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: ev.delta } });
          break;
        }
        case "response.function_call_arguments.delta": {
          const bi = blockFor.get(ev.output_index ?? 0);
          if (bi !== undefined && ev.delta) send("content_block_delta", { type: "content_block_delta", index: bi, delta: { type: "input_json_delta", partial_json: ev.delta } });
          break;
        }
        case "response.output_item.done":
          if (blockFor.get(ev.output_index ?? -1) === index) close();
          break;
        case "response.completed":
        case "response.incomplete":
          final = ev.response ?? {};
          break;
        case "response.failed":
        case "error": {
          close();
          const message = ev.response?.error?.message ?? ev.message ?? "OpenAI stream error";
          send("error", { type: "error", error: { type: "api_error", message: `OpenAI: ${message}` } });
          res.end();
          return null;
        }
      }
    }
  }
  close();
  const u = rUsage(final.usage);
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: rStop(final, sawTool), stop_sequence: null },
    usage: { output_tokens: u.output_tokens, input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
  return asBridgeUsage(u);
}

/** Answers one request; returns the tokens it used (null when it failed). */
export async function bridgeMessages(req: AnthropicRequest, res: ServerResponse, apiKey: string, model: string): Promise<BridgeUsage | null> {
  // Reasoning models can only use tools through the Responses API; others use Chat Completions.
  const responses = isReasoning(model);
  const body = responses ? toResponses(req, model) : toOpenAI(req, model);
  const limitKey = responses ? "max_output_tokens" : "max_completion_tokens";
  const call = () =>
    fetch(`${env.OPENAI_BASE_URL}/${responses ? "responses" : "chat/completions"}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  let upstream: Response;
  try {
    upstream = await call();
    // The agent asks for up to 32k output tokens; some models allow fewer. Retry once with the model's own limit.
    if (upstream.status === 400 && body[limitKey]) {
      const text = await upstream.clone().text();
      if (/max_(completion_|output_)?tokens/.test(text)) {
        delete body[limitKey];
        upstream = await call();
      }
    }
  } catch (err) {
    anthropicError(res, 502, `Forge couldn't reach OpenAI: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    let message = text.slice(0, 1000);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not JSON */
    }
    anthropicError(res, upstream.status, `OpenAI: ${message}`);
    return null;
  }
  if (req.stream) return responses ? streamResponsesBack(upstream, res, model) : streamBack(upstream, res, model);
  const answer = await upstream.json();
  const out = responses ? fromResponses(answer as RResponse, model) : fromOpenAI(answer as Parameters<typeof fromOpenAI>[0], model);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
  return asBridgeUsage(out.usage);
}
