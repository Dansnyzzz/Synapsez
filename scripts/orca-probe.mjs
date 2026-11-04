/**
 * OrcaRouter, asked about one key with read-only requests (owner, 2026-11-04).
 *
 * The suites drive stand-ins, so they prove what this app asks and nothing about
 * what OrcaRouter answers. This prints what the documented read endpoints return
 * for a real key: the billing summary the Usage page draws, and whether a key
 * changes what the catalogue says. No model is called, so no free request or
 * credit is spent, and the key is never printed.
 *
 *   npm run orca:probe
 *
 * Reads ORCAROUTER_API_KEY from the environment or .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../.env');
if (fs.existsSync(envFile) && !process.env.ORCAROUTER_API_KEY) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('ORCAROUTER_API_KEY=')) {
      process.env.ORCAROUTER_API_KEY = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}
const key = process.env.ORCAROUTER_API_KEY;
if (!key) {
  console.error('ORCAROUTER_API_KEY is not set.');
  process.exit(1);
}

const BASE = 'https://api.orcarouter.ai';
const ask = async (url, withKey = true) => {
  const res = await fetch(`${BASE}${url}`, {
    headers: withKey ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
};

const subscription = await ask('/v1/dashboard/billing/subscription');
console.log('GET /v1/dashboard/billing/subscription', subscription.status, JSON.stringify(subscription.body, null, 1));
const usage = await ask('/v1/dashboard/billing/usage');
console.log('GET /v1/dashboard/billing/usage', usage.status, JSON.stringify(usage.body, null, 1));

const signedIn = await ask('/api/pricing');
const open = await ask('/api/pricing', false);
if (signedIn.body?.data) {
  const top = ['user_group', 'workspace_id', 'workspace_zdr', 'workspace_discount'];
  for (const name of top) console.log(`/api/pricing ${name}:`, JSON.stringify(signedIn.body[name]), '| without a key:', JSON.stringify(open.body?.[name]));
  console.log('/api/pricing rows with the key:', signedIn.body.data.length, '| without:', open.body?.data?.length);
} else {
  console.log('GET /api/pricing', signedIn.status);
}

const models = await ask('/v1/models');
const free = (models.body?.data || []).filter((m) => /-free$/.test(m.id));
console.log('GET /v1/models', models.status, 'models:', models.body?.data?.length, 'free:', free.map((m) => m.id).join(', '));
const one = await ask(`/v1/models/${encodeURIComponent('deepseek/deepseek-v4.1-flash-free').replace('%2F', '/')}`);
console.log('GET /v1/models/deepseek/deepseek-v4.1-flash-free', one.status, JSON.stringify(one.body).slice(0, 500));

/*
 * `--call` spends one free request, through the adapter a turn uses and with the
 * output budget a turn would ask for: does a free model take a picture, take a
 * budget this large, and say what it cost?
 */
if (process.argv.includes('--call')) {
  const { streamOpenAICompatible } = await import('../server/providers/openaiCompatible.js');
  const { orcaHeaders, __testing } = await import('../server/providers/index.js');
  const entry = { id: 'orcarouter/deepseek/deepseek-v4.1-flash-free', provider: 'orcarouter', model: 'deepseek/deepseek-v4.1-flash-free', context: 1_048_576, maxOutput: 384_000, reasoning: true, vision: true };
  // A 2×2 red square.
  const picture = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
  const maxTokens = __testing.outputBudget(entry, 200);
  let text = '';
  let thinking = 0;
  let done = null;
  try {
    for await (const event of streamOpenAICompatible({
      apiKey: key,
      baseURL: `${BASE}/v1`,
      headers: orcaHeaders(),
      router: 'orcarouter',
      model: entry.model,
      entry,
      system: 'Answer in one word.',
      messages: [{ role: 'user', text: 'What colour is this square?', parts: [{ type: 'image', mime: 'image/png', data: picture }] }],
      tools: [],
      effort: 'low',
      maxTokens,
      signal: AbortSignal.timeout(90_000),
    })) {
      if (event.type === 'text') text += event.delta;
      else if (event.type === 'thinking') thinking += event.delta.length;
      else if (event.type === 'done') done = event;
    }
    console.log('a call:', JSON.stringify({ maxTokens, text: text.slice(0, 200), thinkingChars: thinking, stop: done?.stop?.kind, raw: done?.stopReason, usage: done?.usage }));
  } catch (err) {
    console.log('a call failed:', err.status, String(err.message).slice(0, 300), JSON.stringify(err.error?.metadata || {}).slice(0, 200));
  }
}
