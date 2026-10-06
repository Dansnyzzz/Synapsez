import crypto from 'node:crypto';
import { log, mark, since } from './trace.js';

/**
 * One model call as an OpenTelemetry GenAI span, written as a log line (HAR-004).
 *
 * Every request already carries a trace id (trace.js); what was missing was the
 * call itself as a span with the attributes the GenAI semantic conventions
 * name — so latency, tokens and failures per model can be read off the logs by
 * any tool that understands the convention, and nothing has to be invented to
 * answer "which model was slow yesterday". Written as a structured line rather
 * than through the OpenTelemetry SDK and an exporter: that needs a collector to
 * send to — a decision outside this repository — and every dependency costs a
 * cold start on the free plan. A collector that tails JSON logs can lift these
 * as they are; the names are the convention's.
 *
 * Content is never captured — no prompt, no reply, no tool argument, and no
 * error message (a provider may quote the request back). The convention keeps
 * content capture off by default for the same reason.
 */

/** The convention's well-known provider names, where there is one. */
const PROVIDER_NAME = { anthropic: 'anthropic', openai: 'openai', google: 'gcp.gemini' };

/** A failure as the convention's `error.type`: a status, a code, or a class name — never its words. */
const errorType = (error) => {
  const failure = /** @type {any} */ (error);
  const status = Number(failure?.status ?? failure?.statusCode);
  if (status) return String(status);
  return String(failure?.code || failure?.name || '_OTHER');
};

/**
 * Open a span for one call. `end` closes it once, with what the call returned
 * or how it failed.
 *
 * @param {{ provider: string, model: string, maxTokens?: number, shared?: boolean }} call
 */
export function startChatSpan({ provider, model, maxTokens, shared }) {
  const started = mark();
  const spanId = crypto.randomBytes(8).toString('hex');
  let ended = false;
  return {
    /** @param {{ done?: any, error?: unknown, aborted?: boolean }} [outcome] */
    end({ done = null, error = null, aborted = false } = {}) {
      if (ended) return;
      ended = true;
      const usage = done?.usage || {};
      const fields = {
        'span.name': `chat ${model}`,
        'span.kind': 'client',
        'span.id': spanId,
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': PROVIDER_NAME[provider] || provider,
        'gen_ai.request.model': model,
        ...(maxTokens ? { 'gen_ai.request.max_tokens': maxTokens } : {}),
        ...(done?.stopReason ? { 'gen_ai.response.finish_reasons': [String(done.stopReason)] } : {}),
        ...(Number.isFinite(usage.input) ? { 'gen_ai.usage.input_tokens': usage.input } : {}),
        ...(Number.isFinite(usage.output) ? { 'gen_ai.usage.output_tokens': usage.output } : {}),
        ...(Number.isFinite(usage.cacheRead) ? { 'gen_ai.usage.cache_read.input_tokens': usage.cacheRead } : {}),
        ...(error ? { 'error.type': errorType(error) } : aborted ? { 'error.type': 'cancelled' } : {}),
        'synapsez.key': shared ? 'shared' : 'own',
        duration_ms: since(started),
      };
      if (error) log.warn('gen_ai.span', fields);
      else log.info('gen_ai.span', fields);
    },
  };
}
