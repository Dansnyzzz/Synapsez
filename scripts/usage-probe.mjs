/**
 * What OrcaRouter and Gemini really answer about usage, asked with this machine's
 * keys (owner, 2026-11-06). The suites drive stand-ins, so they prove what this app
 * asks and nothing about what the providers say.
 *
 * Read-only, apart from `--gemini-call`, which spends one token per model named.
 * No key is ever printed.
 *
 *   node scripts/usage-probe.mjs                 OrcaRouter's read endpoints
 *   node scripts/usage-probe.mjs --gemini        Gemini's model list and headers
 *   node scripts/usage-probe.mjs --gemini-call gemini-2.5-flash gemini-flash-latest
 *   node scripts/usage-probe.mjs --orca-abort [model]   spends one request: stops a stream
 *        part-way, then asks OrcaRouter what it settled for it, to see whether a stop
 *        stops the bill. Its docs do not say. Free model by default.
 *
 * Reads ORCAROUTER_API_KEY and GEMINI_API_KEY from the environment or .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../.env');
const wanted = ['ORCAROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const line = raw.trim();
    const name = line.slice(0, line.indexOf('='));
    if (wanted.includes(name) && !process.env[name]) process.env[name] = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const short = (text, n = 1500) => (text.length > n ? `${text.slice(0, n)}… (${text.length} chars)` : text);
const headersOf = (res) => Object.fromEntries([...res.headers.entries()].filter(([name]) => /rate|limit|quota|retry|orca|goog|usage/i.test(name) && !/key/i.test(name)));

async function ask(url, headers = {}, init = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000), ...init });
    return { status: res.status, headers: headersOf(res), text: await res.text() };
  } catch (err) {
    return { status: 0, headers: {}, text: String(err?.message || err) };
  }
}

if (args[0] === '--gemini' || args[0] === '--gemini-call') {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    console.log('No Gemini key on this machine (GEMINI_API_KEY or GOOGLE_API_KEY).');
    process.exit(0);
  }
  const auth = { 'x-goog-api-key': key };
  if (args[0] === '--gemini') {
    const list = await ask('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', auth);
    console.log('models.list', list.status, JSON.stringify(list.headers));
    try {
      for (const m of JSON.parse(list.text).models || []) console.log(' ', m.name, m.inputTokenLimit, m.outputTokenLimit, m.thinking ? 'thinking' : '', (m.supportedGenerationMethods || []).join(','));
    } catch {
      console.log(short(list.text));
    }
  } else {
    for (const model of args.slice(1)) {
      const answer = await ask(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { ...auth, 'Content-Type': 'application/json' }, {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
      });
      console.log(`\n${model}: HTTP ${answer.status}`, JSON.stringify(answer.headers));
      console.log(short(answer.text, 900));
    }
  }
  process.exit(0);
}

const key = process.env.ORCAROUTER_API_KEY;
if (!key) {
  console.log('No OrcaRouter key on this machine (ORCAROUTER_API_KEY).');
  process.exit(0);
}
const auth = { Authorization: `Bearer ${key}` };

if (args[0] === '--orca-abort') {
  const model = args[1] || 'deepseek/deepseek-v4.1-flash-free';
  const abort = new AbortController();
  const res = await fetch('https://api.orcarouter.ai/v1/chat/completions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: 2000, messages: [{ role: 'user', content: 'Write a long essay, at least 1500 words, on the history of the bicycle. Do not think for long.' }] }),
    signal: abort.signal,
  });
  const id = res.headers.get('x-orca-request-id');
  console.log('HTTP', res.status, 'request', id);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let chars = 0;
  let chunks = 0;
  const started = Date.now();
  try {
    while (chunks < 60 && Date.now() - started < 60_000) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try {
          const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta || {};
          const said = (delta.content || '') + (delta.reasoning_content || delta.reasoning || '');
          if (said) {
            chars += said.length;
            chunks += 1;
          }
        } catch {
          /* a frame cut across two reads: only the count suffers */
        }
      }
    }
  } finally {
    abort.abort();
  }
  console.log(`stopped after ${chunks} chunks, ${chars} characters, about ${Math.round(chars / 4)} tokens read, at ${Date.now() - started} ms`);
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const settled = await ask(`https://api.orcarouter.ai/v1/generation?id=${encodeURIComponent(id)}`, auth);
    console.log(`+${(i + 1) * 5}s: HTTP ${settled.status}`, short(settled.text, 500));
    if (settled.status === 200) break;
  }
  process.exit(0);
}

for (const url of ['/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage', '/v1/tools/balance', '/metrics/workspace']) {
  const answer = await ask(`https://api.orcarouter.ai${url}`, auth);
  console.log(`\nGET ${url}: HTTP ${answer.status}`, JSON.stringify(answer.headers));
  console.log(short(answer.text, 3500));
}
const free = await ask('https://api.orcarouter.ai/api/free-package/public');
console.log(`\nGET /api/free-package/public: HTTP ${free.status}`);
console.log(short(free.text, 2500));
