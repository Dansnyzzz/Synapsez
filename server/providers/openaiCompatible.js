import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { normaliseStop } from './stop.js';

/**
 * What one usage block from a Chat-Completions-shaped API is worth.
 *
 * Three things were being dropped on the floor here, and all three cost money
 * or credibility:
 *
 * **Cached prompt tokens.** OpenAI reports them at
 * `prompt_tokens_details.cached_tokens` and OpenRouter at the same path, and
 * they are *included in* `prompt_tokens` rather than sitting beside it. Reading
 * only the total means `estimateCost` charges the full input rate for tokens
 * that were billed at a tenth of it. The Anthropic adapter was fixed for
 * exactly this; the other two providers were left overstating every cached turn.
 *
 * **Cache writes.** OpenRouter reports `cache_write_tokens` — billed at a
 * premium, not a discount — so netting it off with the reads would be wrong in
 * the other direction. It is carried separately for the same reason.
 *
 * **The real price.** OpenRouter puts the actual billed cost on `usage.cost`,
 * in dollars, on the last streamed chunk, with no request parameter needed.
 * That is not an estimate derived from a price table that may be stale or
 * absent — it is what the account was charged. Most of the library's models
 * carry `price: null`, so for them this is the difference between a real figure
 * and no figure at all.
 */
function readUsage(raw) {
  if (!raw) return null;
  const promptDetails = raw.prompt_tokens_details || {};
  const cost = Number(raw.cost);
  return {
    input: raw.prompt_tokens || 0,
    output: raw.completion_tokens || 0,
    cacheRead: Number(promptDetails.cached_tokens) || 0,
    cacheWrite: Number(promptDetails.cache_write_tokens) || 0,
    // Reasoning tokens are already inside `completion_tokens`; kept only so the
    // interface can say how much of an answer was thinking rather than prose.
    reasoning: Number(raw.completion_tokens_details?.reasoning_tokens) || 0,
    // Only when the provider actually stated one. A zero here would be read as
    // "this turn was free", which is a different claim from "nobody told us".
    ...(Number.isFinite(cost) && cost > 0 ? { costUsd: cost } : {}),
  };
}

/**
 * Shared adapter for every OpenAI-Chat-Completions-shaped API: OpenAI itself
 * and OpenRouter, which deliberately mirrors the same wire format.
 */

/**
 * Attachments, in the OpenAI chat shape.
 *
 * Images become `image_url` parts with a data: URI, which OpenAI and OpenRouter
 * both take. PDFs do not exist in this wire format at all, so by the time a
 * document reaches here it has already been turned into text upstream — the
 * attachment layer knows which providers can be handed a file and which cannot.
 *
 * A `document` part arriving here anyway means something bypassed that, and it
 * is still not allowed to vanish quietly: a file that uploads, appears, and is
 * silently not looked at is the worst outcome available.
 */
function attachmentParts(parts) {
  const out = [];
  for (const part of parts) {
    if (part.type === 'text') out.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      out.push({ type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } });
    } else if (part.type === 'document') {
      out.push({
        type: 'text',
        text:
          `[The user attached "${part.name}" (PDF) and it could not be read for this model. Say ` +
          'so plainly and suggest a Claude or Gemini model, which can read the pages themselves.]',
      });
    }
  }
  return out;
}

function toMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'user') {
      const files = attachmentParts(m.parts || []);
      if (files.length) {
        // The multi-part form is only used when there is something to put in it:
        // a plain string is what every model handles best, including the many
        // that reject the array form outright.
        const content = [...files];
        if (m.text) content.push({ type: 'text', text: m.text });
        out.push({ role: 'user', content });
      } else {
        out.push({ role: 'user', content: m.text || '' });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      // A turn with neither text nor tool calls is rejected as empty.
      if (msg.content || msg.tool_calls) out.push(msg);
    } else if (m.role === 'tool') {
      // One `tool` message per result, unlike Anthropic's single grouped turn.
      for (const r of m.results || []) {
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: String(r.content ?? '') });
      }
    }
  }
  return out;
}

const REASONING = /^(o\d|gpt-5|.*\bthinking\b)/i;

/**
 * A tool call written into the reply as text, in the XML shape some models
 * were trained on — `<dots_function_call><invoke name="list_tasks">…` — rather
 * than sent on the API's `tool_calls` field.
 *
 * Seen from free models behind OpenRouter's router. Left alone, the markup is
 * printed in the conversation as the answer and nothing runs, so the turn ends
 * on a line of angle brackets. The opening tag is recognised by shape rather
 * than by one exact name, because each model family spells its wrapper
 * differently.
 */
const TEXT_CALL_OPEN = /<([a-z_]*function_calls?|tool_calls?|invoke)\b/i;

/**
 * Withhold streamed text from the first call-shaped tag onwards.
 *
 * Text before the tag passes through as it arrives. A `<` near the end of a
 * fragment is held back briefly, since the tag's name may arrive in the next
 * fragment. What is withheld is only decided on at the end of the stream —
 * released as ordinary text if it did not parse into a real call.
 */
function textCallFilter() {
  let held = null;
  let tail = '';
  return {
    push(delta) {
      if (held !== null) {
        held += delta;
        return '';
      }
      const s = tail + delta;
      tail = '';
      const m = s.match(TEXT_CALL_OPEN);
      if (m) {
        held = s.slice(m.index);
        return s.slice(0, m.index);
      }
      const lt = s.lastIndexOf('<');
      if (lt >= 0 && s.length - lt < 24 && !s.includes('>', lt)) {
        tail = s.slice(lt);
        return s.slice(0, lt);
      }
      return s;
    },
    rest: () => (held ?? '') + tail,
  };
}

/**
 * The calls in withheld text, keeping only tools this request offered.
 *
 * A parameter's value is JSON when it parses as JSON — a number, a list — and
 * the raw string otherwise, which is how these formats write plain text.
 */
function parseTextCalls(text, tools) {
  const offered = new Set((tools || []).map((t) => t.name));
  const calls = [];
  const invoke = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  const param = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
  for (const [, name, body] of text.matchAll(invoke)) {
    if (!offered.has(name)) continue;
    const input = {};
    for (const [, key, raw] of body.matchAll(param)) {
      const value = raw.trim();
      try {
        input[key] = JSON.parse(value);
      } catch {
        input[key] = value;
      }
    }
    // Unique per step, not only per reply: `call_text_0_x` on every step put the
    // same id in the transcript twice, which strict providers refuse and which
    // let an answer meant for one pause match another.
    calls.push({ id: `call_text_${randomUUID().slice(0, 8)}_${calls.length}_${name}`, name, input });
  }
  return calls;
}

/**
 * Ask OpenRouter to cache the prefix, for the two families that only cache when asked.
 *
 * OpenAI, DeepSeek, Grok and Gemini 2.5+ cache on their own. Claude does not:
 * without a marker every step of a turn re-bought the tool catalogue and the
 * system prompt at full price — the same prefix the direct Anthropic adapter
 * caches at 0.1×. For Claude a root `cache_control` is OpenRouter's automatic
 * mode, which moves the breakpoint forward as the conversation grows; Gemini
 * takes it only on a content block, so it goes on the system prompt.
 * https://openrouter.ai/docs/features/prompt-caching
 */
export function markPromptCache(params, model) {
  const id = String(model || '').replace(/^~/, '');
  if (id.startsWith('anthropic/')) {
    params.cache_control = { type: 'ephemeral' };
  } else if (id.startsWith('google/gemini')) {
    const sys = params.messages[0];
    if (sys?.role === 'system' && typeof sys.content === 'string') {
      sys.content = [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }];
    }
  }
  return params;
}

export async function* streamOpenAICompatible({
  apiKey,
  baseURL,
  headers,
  markCache = false,
  model,
  entry,
  system,
  messages,
  tools,
  effort = 'high',
  maxTokens = 32000,
  signal,
}) {
  // maxRetries: 0 hands all retrying to streamCompletion, which is the layer
  // that knows about the account's other keys. The SDK's own default of 2 would
  // sit through two backoffs on a key already rate limited before this function
  // even returns — so a spare key waits behind the dead one, and a 429 that
  // should have marked a key resting is silently retried away instead.
  const client = new OpenAI({ apiKey, baseURL, defaultHeaders: headers, maxRetries: 0 });

  const params = {
    model,
    messages: toMessages(messages, system),
    stream: true,
    stream_options: { include_usage: true },
    // `max_completion_tokens` is OpenAI's newer spelling; OpenRouter, Ollama,
    // LM Studio and friends still expect `max_tokens`.
    ...(baseURL ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
  };
  if (tools?.length) {
    params.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  // `reasoning_effort` is rejected outright by non-reasoning models, so only
  // send it where the model id says it will be understood.
  if (REASONING.test(model) || entry?.tags?.includes('reasoning')) {
    params.reasoning_effort = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
  }
  if (markCache) markPromptCache(params, model);

  const stream = await client.chat.completions.create(params, { signal });

  /** index -> { id, name, args } — tool call arguments arrive as JSON fragments. */
  const pending = new Map();
  let usage = null;
  let stopReason = null;
  // Only when tools were offered: without them, markup in a reply is content.
  const filter = tools?.length ? textCallFilter() : null;

  for await (const chunk of stream) {
    if (chunk.usage) usage = readUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) stopReason = choice.finish_reason;

    const delta = choice.delta || {};
    if (delta.content) {
      const text = filter ? filter.push(delta.content) : delta.content;
      if (text) yield { type: 'text', delta: text };
    }
    // OpenRouter surfaces reasoning traces on a non-standard field.
    if (delta.reasoning) yield { type: 'thinking', delta: delta.reasoning };

    for (const tc of delta.tool_calls || []) {
      const slot = pending.get(tc.index) || { id: '', name: '', args: '' };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) {
        slot.name = tc.function.name;
        yield { type: 'tool_call_start', id: slot.id, name: slot.name };
      }
      if (tc.function?.arguments) {
        slot.args += tc.function.arguments;
        // A 60 KB page arrives over a minute or more; without this the only sign
        // of it was a status line that never moved.
        if (slot.name) yield { type: 'tool_call_progress', id: slot.id, name: slot.name, chars: slot.args.length };
      }
      pending.set(tc.index, slot);
    }
  }

  const toolCalls = [...pending.values()].map((slot) => {
    let input = {};
    try {
      input = slot.args ? JSON.parse(slot.args) : {};
    } catch {
      /**
       * The arguments never finished arriving, or arrived malformed.
       *
       * This is what a truncated stream looks like from here — and truncation is
       * a first-class `stopReason` in this codebase precisely because it happens.
       * The marker used to be `__unparsed`, written on this line and **read
       * nowhere in the repository**, so the call went on to execute with every
       * declared parameter `undefined` and the tools' own defaults widening it:
       * `resolveInWorkspace(undefined)` is the workspace root, so a cut-off
       * `index_folder` indexed the entire workspace and shipped it to the
       * embedding endpoint.
       *
       * Renamed so the contract is visible, and `executeTool` now refuses it.
       * The raw text travels along so the refusal can quote what arrived, which
       * is the difference between a model that retries correctly and one that
       * tries the same broken call again.
       */
      input = { __malformed: String(slot.args ?? '') };
    }
    return { id: slot.id || `call_${slot.name}`, name: slot.name, input };
  });

  // Withheld text becomes calls when it parses into ones this request offered
  // and the model made no real ones; otherwise it was prose after all.
  const withheld = filter ? filter.rest() : '';
  if (withheld) {
    const textCalls = toolCalls.length ? [] : parseTextCalls(withheld, tools);
    if (textCalls.length) {
      toolCalls.push(...textCalls);
      stopReason = 'tool_calls';
    } else {
      yield { type: 'text', delta: withheld };
    }
  }

  yield {
    type: 'done',
    stopReason,
    // `length` and `content_filter` both end a reply that is not finished, and
    // both used to arrive here looking exactly like `stop`.
    stop: normaliseStop(stopReason),
    toolCalls,
    usage: usage || { input: 0, output: 0 },
  };
}

/** Exposed so the suite can assert what the OpenAI wire format is handed. */
export const __testing = { toMessages, readUsage, textCallFilter, parseTextCalls };
