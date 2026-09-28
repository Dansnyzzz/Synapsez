import { GoogleGenAI } from '@google/genai';
import { normaliseStop } from './stop.js';

/**
 * The effort dial, in Gemini's units.
 *
 * The dial in the interface reached Anthropic (`output_config.effort`) and the
 * reasoning models behind the OpenAI shape (`reasoning_effort`), and reached
 * Gemini not at all: this adapter sent `{ includeThoughts: true }` and nothing
 * else, so a conversation set to "low" thought exactly as hard — and cost
 * exactly as much — as one set to "max". A setting that silently does nothing
 * on a third of the providers is worse than no setting.
 *
 * `thinkingLevel` is the current control and takes MINIMAL / LOW / MEDIUM /
 * HIGH. Our scale has two rungs above Gemini's top one, so both land on HIGH —
 * asking for more than a provider offers is not a reason to send it something
 * it will reject.
 */
const THINKING_LEVEL = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'HIGH',
  max: 'HIGH',
};

/**
 * The same dial as a token budget, for the models that predate `thinkingLevel`.
 *
 * `-latest` is an alias that moves, and Gemini 2.5 answers `thinkingLevel` with
 * a 400 while Gemini 3 still takes a budget — so which of the two a request may
 * carry is not something this code can know ahead of time. 24,576 is the top of
 * every 2.5 model's range; `-1` is "decide for yourself".
 */
const THINKING_BUDGET = { low: 1024, medium: 8192, high: -1, xhigh: 24_576, max: 24_576 };

/**
 * What to try, in order, until the model takes one: the level the person
 * chose; the nearest level every Gemini 3 model accepts (not all of them take
 * MEDIUM); the budget form for an older model; and finally no setting at all,
 * which is still a working turn.
 */
export function thinkingAttempts(effort) {
  const level = THINKING_LEVEL[effort] || 'HIGH';
  /** @type {Record<string, any>[]} */
  const attempts = [{ thinkingLevel: level }];
  if (level === 'MEDIUM') attempts.push({ thinkingLevel: 'HIGH' });
  attempts.push({ thinkingBudget: THINKING_BUDGET[effort] ?? -1 });
  if ((THINKING_BUDGET[effort] ?? -1) !== -1) attempts.push({ thinkingBudget: -1 });
  attempts.push({});
  return attempts;
}

/**
 * What one `usageMetadata` block is worth.
 *
 * `cachedContentTokenCount` is a subset of `promptTokenCount`, exactly as the
 * Anthropic cache figures are a subset of the prompt there — so it rides
 * alongside the total rather than being netted out of it, and `estimateCost`
 * can charge it at the cached rate instead of the full one.
 *
 * `thoughtsTokenCount` is billed as output and is *not* included in
 * `candidatesTokenCount`, so it has to be added rather than assumed.
 */
function readUsage(meta) {
  if (!meta) return null;
  return {
    input: meta.promptTokenCount || 0,
    output: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
    cacheRead: meta.cachedContentTokenCount || 0,
    reasoning: meta.thoughtsTokenCount || 0,
  };
}

/** Gemini accepts an OpenAPI subset — unknown JSON Schema keywords are rejected. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const allowed = ['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format'];
  const out = {};
  for (const key of allowed) {
    if (!(key in schema)) continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(schema.items);
    } else {
      out[key] = schema[key];
    }
  }
  return out;
}

/**
 * Attachments, in Gemini's shape.
 *
 * `inlineData` covers images and PDFs alike — Gemini reads a PDF directly, so
 * there is nothing special to do for it beyond passing the right mime type.
 */
function attachmentParts(parts) {
  const out = [];
  for (const part of parts) {
    if (part.type === 'text') out.push({ text: part.text });
    else if (part.type === 'image') out.push({ inlineData: { mimeType: part.mime, data: part.data } });
    else if (part.type === 'document') {
      out.push({ inlineData: { mimeType: 'application/pdf', data: part.data } });
    }
  }
  return out;
}

function toContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = [...attachmentParts(m.parts || [])];
      if (m.text) parts.push({ text: m.text });
      out.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls || []) {
        // The signature goes back exactly as it came. Gemini 3 treats it as
        // part of the call: without it, tool use is explicitly degraded and the
        // API says so on every turn that replays one.
        parts.push({
          functionCall: { name: c.name, args: c.input ?? {} },
          ...(c.signature ? { thoughtSignature: c.signature } : {}),
        });
      }
      if (parts.length) out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: (m.results || []).map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.isError ? { error: String(r.content ?? '') } : { result: String(r.content ?? '') },
          },
        })),
      });
    }
  }
  return out;
}

export async function* streamGoogle({
  apiKey,
  model,
  entry,
  system,
  messages,
  tools,
  effort = 'high',
  maxTokens = 32000,
  signal,
}) {
  const ai = new GoogleGenAI({ apiKey });

  const config = {
    maxOutputTokens: maxTokens,
    ...(system ? { systemInstruction: system } : {}),
    ...(tools?.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: toGeminiSchema(t.parameters),
              })),
            },
          ],
        }
      : {}),
    /**
     * Reasoning is shown live in the interface, so ask for the summaries; and
     * ask for the depth the user actually chose.
     *
     * `thinkingLevel` is opt-out per catalogue entry for the same reason
     * `effort` is on the Anthropic side — an older model rejects the field
     * outright, and a rejected request is a worse outcome than an unhonoured
     * dial.
     */
    thinkingConfig: { includeThoughts: true },
    abortSignal: signal,
  };

  const contents = toContents(messages);
  const attempts = entry?.effort === false ? [{}] : thinkingAttempts(effort);
  let stream;
  for (const [i, attempt] of attempts.entries()) {
    config.thinkingConfig = { includeThoughts: true, ...attempt };
    try {
      stream = await ai.models.generateContentStream({ model, contents, config });
      break;
    } catch (err) {
      // Only a refusal of the thinking setting moves to the next form; anything
      // else — a bad key, a quota — is the real answer and goes straight back.
      const aboutThinking = /thinking|budget|level/i.test(String(err?.message || '')) && /400|INVALID_ARGUMENT/i.test(String(err?.status ?? err?.message ?? ''));
      if (!aboutThinking || i === attempts.length - 1) throw err;
    }
  }

  const toolCalls = [];
  let usage = { input: 0, output: 0 };
  let stopReason = null;
  /** The most recent thought signature seen, for the call it belongs to. */
  let signature = null;

  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) stopReason = candidate.finishReason;
    if (chunk.usageMetadata) usage = readUsage(chunk.usageMetadata);

    for (const part of candidate?.content?.parts || []) {
      /**
       * The signature Gemini expects to see again.
       *
       * From Gemini 3 on, a part carrying a function call also carries a
       * `thoughtSignature` — an opaque token standing for the reasoning that
       * produced the call. Send the call back on the next turn without it and
       * the API says so: *"Function call is missing a thought_signature in
       * functionCall parts. This is required for tools to work correctly."*
       * The turn still completes, which is what makes it easy to miss, and the
       * model works from a redacted version of its own reasoning.
       *
       * It arrives on the same part as the call, but not always in the same
       * chunk of the stream, so the last one seen is carried forward.
       */
      if (part.thoughtSignature) signature = part.thoughtSignature;

      if (part.text) {
        // Gemini marks summarised reasoning with `thought: true` on the part.
        yield part.thought ? { type: 'thinking', delta: part.text } : { type: 'text', delta: part.text };
      }
      if (part.functionCall) {
        const id = part.functionCall.id || `gcall_${toolCalls.length}_${part.functionCall.name}`;
        toolCalls.push({
          id,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          // Stored with the call, so it survives into the database and comes
          // back on the resumed turn as well as on the next step.
          ...(part.thoughtSignature || signature ? { signature: part.thoughtSignature || signature } : {}),
        });
        signature = null;
        yield { type: 'tool_call_start', id, name: part.functionCall.name };
      }
    }
  }

  yield {
    type: 'done',
    stopReason,
    // `SAFETY`, `RECITATION` and `MAX_TOKENS` all end a reply early, and all
    // three used to reach the browser looking like a finished answer.
    stop: normaliseStop(stopReason),
    toolCalls,
    usage,
  };
}

/** Exposed so the suite can assert what Gemini is actually handed. */
export const __testing = { toContents, readUsage, THINKING_LEVEL };
