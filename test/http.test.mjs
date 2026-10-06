/**
 * HTTP suite — the app as something on a port.
 *
 * The tenancy suite proves the store cannot be talked across accounts. This one
 * proves the layer in front of it: that middleware actually runs, that a route
 * marked admin is one, that a session stops being a session when it should, and
 * that the throttles exist. None of that was covered, which is how a bodyless
 * admin PATCH could return 500 and nobody know.
 *
 * Needs no browser and no keys — just a port.
 *
 *   node test/http.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'http-test-encryption-key';
process.env.SESSION_SECRET ||= 'http-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-http-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();

const PORT = 5195;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/** A tiny cookie jar, so a "session" here means what it means in a browser. */
function jar() {
  let cookie = '';
  return {
    get value() {
      return cookie;
    },
    set value(next) {
      cookie = next;
    },
    async call(method, url, body, options = {}) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie && !options.noCookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie && options.keepCookie !== false) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 120) };
      }
      return { status: res.status, json, headers: res.headers };
    },
  };
}

// ── headers ─────────────────────────────────────────────────────────
section('security headers');
{
  const anon = jar();
  const res = await anon.call('GET', '/api/session');
  check('a Content-Security-Policy is sent', !!res.headers.get('content-security-policy'));
  check(
    'and it forbids scripts from anywhere else',
    /script-src 'self'/.test(res.headers.get('content-security-policy') || ''),
  );
  check('the page cannot be framed', res.headers.get('x-frame-options') === 'DENY');
  check('content types are not sniffed', res.headers.get('x-content-type-options') === 'nosniff');
  check('no referrer leaks out', res.headers.get('referrer-policy') === 'no-referrer');
  check('the server does not announce itself', !res.headers.get('x-powered-by'));
  check(
    'HSTS is withheld over plain HTTP',
    !res.headers.get('strict-transport-security'),
    'sending it on a LAN address would break the phone that saw it',
  );
}

// ── one id, all the way through ─────────────────────────────────────
section('every request carries a correlation id');
{
  const anon = jar();
  const fresh = await anon.call('GET', '/api/session');
  const id = fresh.headers.get('x-request-id');
  check('a request id comes back on every response', !!id, String(id));
  check('  and it is not the same one twice', (await anon.call('GET', '/api/session')).headers.get('x-request-id') !== id);

  /*
   * An agent turn fans out through the loop, the provider adapters, the tool
   * executor, a queue the user's own machine reads, and back. Until this there
   * was nothing to join those records on — the browser can now quote the id of
   * the exact turn that went wrong.
   */
  const supplied = await fetch(`${base}/api/session`, { headers: { 'X-Request-Id': 'abc-123' } });
  check("a caller's own id is honoured", supplied.headers.get('x-request-id') === 'abc-123');

  /*
   * Not verbatim, though. This value lands in log lines, and a header is
   * whatever the caller typed — spaces and brackets are enough to forge
   * something that reads like a second record. (A newline would be the real
   * prize; fetch refuses to send one, so the defence is tested with what can
   * actually arrive.)
   */
  const hostile = await fetch(`${base}/api/session`, {
    headers: { 'X-Request-Id': 'evil [error] fake log line' },
  });
  const cleaned = hostile.headers.get('x-request-id');
  check(
    'but not verbatim — a forged id cannot dress itself up as a log record',
    !/[^\w-]/.test(cleaned || ''),
    JSON.stringify(cleaned),
  );
  check('  and it is capped rather than unbounded', (cleaned || '').length <= 64, String((cleaned || '').length));
}

// ── authentication ──────────────────────────────────────────────────
section('routes that need a session');
{
  const anon = jar();
  for (const [method, url] of [
    ['GET', '/api/bootstrap'],
    ['GET', '/api/chats'],
    ['GET', '/api/skills'],
    ['GET', '/api/tasks'],
    ['GET', '/api/connectors'],
    ['GET', '/api/devices/status'],
    ['GET', '/api/admin/users'],
  ]) {
    const res = await anon.call(method, url);
    check(`${method} ${url} refuses an anonymous caller`, res.status === 401, `got ${res.status}`);
  }

  const cron = await anon.call('GET', '/api/cron/run-tasks');
  check(
    'the cron endpoint is not open either',
    cron.status === 401 || cron.status === 503,
    `got ${cron.status}`,
  );

  const worker = await anon.call('POST', '/api/worker/heartbeat', { workerId: 'w' });
  check('the worker relay needs its token', worker.status === 401, `got ${worker.status}`);
}

/**
 * Nothing a browser calls may live under `/api/worker/`.
 *
 * That prefix is mounted to the relay router, whose first middleware demands a
 * bearer token — so a session-authenticated route placed there answers 401 to a
 * perfectly valid session, and no route below it is ever consulted. Two lived
 * there: the worker-status poll, and "Generate worker token", which had
 * therefore never worked at all. The mistake is invisible in review because both
 * halves look right on their own.
 */
section('the relay prefix shadows nothing');
{
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'app.js'), 'utf8');
  const sessionRoutes = [...source.matchAll(/\n\s+api\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'/g)]
    .map((m) => m[2]);

  const shadowed = sessionRoutes.filter((route) => route.startsWith('/worker/'));
  check(
    'no session route sits under /worker/',
    shadowed.length === 0,
    shadowed.join(', ') || 'none',
  );
  check('and there are session routes to check', sessionRoutes.length > 10, `${sessionRoutes.length} found`);
}

// ── accounts ────────────────────────────────────────────────────────
section('registration and session');
const alice = jar();
{
  const short = await alice.call('POST', '/api/register', {
    email: 'alice@example.com',
    password: 'short',
  });
  check('a short password is refused', short.status === 400, `got ${short.status}`);

  const bad = await alice.call('POST', '/api/register', {
    email: 'not-an-email',
    password: 'a-long-enough-password',
  });
  check('a malformed address is refused', bad.status === 400, `got ${bad.status}`);

  const made = await alice.call('POST', '/api/register', {
    email: 'alice@example.com',
    password: 'a-long-enough-password',
    name: 'Alice',
  });
  check('the first account is created', made.status === 201, `got ${made.status}`);
  check('and it is the administrator', made.json?.user?.role === 'admin', made.json?.user?.role);
  check('a session cookie came back', alice.value.startsWith('ai_remote_session='));

  const boot = await alice.call('GET', '/api/bootstrap');
  check('the session opens the app', boot.status === 200, `got ${boot.status}`);

  // Provider *status* travels to the browser; the key never does. The payload
  // legitimately contains "sk-ant-…" as a placeholder, so the assertion is about
  // the shape of what is sent, not about a substring.
  const providers = boot.json?.providers || {};
  check(
    'providers report status, not secrets',
    Object.values(providers).every((p) =>
      Object.keys(p).every((k) => ['configured', 'own', 'shared', 'envVar', 'keys', 'spare'].includes(k)),
    ),
    JSON.stringify(providers.anthropic),
  );
  check(
    'and the shared-key flag is present, so the UI can say whose key pays',
    'shared' in (providers.anthropic || {}),
    'the interface used to read a `fromEnv` that never existed',
  );

  /**
   * Several keys per provider, and none of them readable.
   *
   * The list exists so a key that runs out has somewhere to fall back to. What
   * travels to the browser is a position, the last four characters and a date —
   * enough to tell one key from another and not enough to use one.
   */
  const secret = 'sk-ant-test-SUPERSECRET-abcd';
  await alice.call('PUT', '/api/providers/anthropic/key', { apiKey: secret });
  const added = await alice.call('POST', '/api/providers/anthropic/keys', { apiKey: 'sk-ant-second-key-wxyz' });

  check('a second key can be added', added.status === 201, `got ${added.status}`);
  check('and both are listed, in the order they will be tried', added.json?.anthropic?.keys?.length === 2, JSON.stringify(added.json?.anthropic?.keys));
  check(
    'the key itself never travels',
    !JSON.stringify(added.json).includes('SUPERSECRET'),
    'only a hint and a date should reach the browser',
  );
  check(
    'the hint is the last four characters',
    added.json?.anthropic?.keys?.[0]?.hint === '…abcd',
    added.json?.anthropic?.keys?.[0]?.hint,
  );
  check('and the provider reports having a spare', added.json?.anthropic?.spare >= 1, String(added.json?.anthropic?.spare));

  const duplicate = await alice.call('POST', '/api/providers/anthropic/keys', { apiKey: secret });
  check('the same key twice is refused', duplicate.status === 400, `got ${duplicate.status}`);
  check('because it is not a fallback', /already/.test(duplicate.json?.error || ''), duplicate.json?.error);

  const dropped = await alice.call('DELETE', '/api/providers/anthropic/keys/1');
  check('a key can be removed by position', dropped.json?.anthropic?.keys?.length === 1, JSON.stringify(dropped.json?.anthropic?.keys));
  check('and the one that remains is the other one', dropped.json?.anthropic?.keys?.[0]?.hint === '…wxyz', dropped.json?.anthropic?.keys?.[0]?.hint);

  const gone = await alice.call('DELETE', '/api/providers/anthropic/keys/9');
  check('removing a position that is not there fails cleanly', gone.status === 400, `got ${gone.status}`);

  await alice.call('PUT', '/api/providers/anthropic/key', { apiKey: '' });
  await alice.call('PUT', '/api/providers/anthropic/key', { apiKey: '' });

  /**
   * Auditing the catalogue.
   *
   * With no keys there is nothing to call, and saying "no key" for every entry
   * is the correct answer — the check that matters offline is that it reports
   * per model rather than failing as a whole.
   */
  const audit = await alice.call('POST', '/api/models/audit');
  check('the catalogue can be audited', audit.status === 200, `got ${audit.status}`);
  check('one row per built-in model', (audit.json?.checked || []).length >= 4, String(audit.json?.checked?.length));
  check(
    'each row names the model and its state',
    (audit.json?.checked || []).every((row) => row.id && row.provider && row.state),
    JSON.stringify(audit.json?.checked?.[0]),
  );
  check(
    'and with no keys saved it says so, per model',
    (audit.json?.checked || []).every((row) => row.state === 'no key'),
    audit.json?.checked?.[0]?.state,
  );
  check('it needs a session', (await jar().call('POST', '/api/models/audit')).status === 401);
}

// ── a provider's failure, in words ──────────────────────────────────
section('a dead model reads as a sentence, not as JSON');
{
  const { readableFailure } = await import('../server/app.js');

  // Exactly the shape Google's SDK produces: a JSON body whose `message` is
  // itself JSON. This reached a user as an unreadable wall in the transcript.
  const inner = JSON.stringify({
    error: {
      code: 404,
      message:
        'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model for the latest features and improvements.',
      status: 'NOT_FOUND',
    },
  });
  const outer = JSON.stringify({ error: { message: inner, code: 404, status: 'Not Found' } });
  const said = readableFailure(new Error(outer));

  check('the nesting is unwrapped', !said.startsWith('{'), said.slice(0, 60));
  check('the model is named', /gemini-2\.5-flash/.test(said), said.slice(0, 80));
  check('and it says what to do', /pick another model/i.test(said), said.slice(-60));
  // The sentence also has to say whose fault it is. This arrives in front of
  // somebody who pressed send and got a red box, and "not found" reads as
  // something they typed wrong when it is a catalogue entry that expired.
  check('and that it was not the user', /nothing you did/i.test(said), said.slice(0, 120));
  check('an ordinary error is left alone', readableFailure(new Error('Connection reset')) === 'Connection reset');

  /**
   * The one that was actually on screen.
   *
   * An aggregator announcing a withdrawal does it in the body of a 404, in
   * prose, cheerfully: "Thank you for participating in the Stealth Ox Alpha
   * testing period. This model was ZAI's GLM-5.3 Flash. Use it now: <url>".
   * None of that parses as an error and none of the old patterns matched it, so
   * it reached the transcript verbatim — in English, in red, on every attempt,
   * with nothing saying the model was the problem.
   */
  const retired = readableFailure(
    new Error(
      '404 Thank you for participating in the Stealth Ox Alpha testing period. ' +
        "This model was ZAI's GLM-5.3 Flash. Use it now: https://openrouter.ai/z-ai/glm-5.3-flash",
    ),
  );
  check('a chatty withdrawal notice is recognised', /no longer available/.test(retired), retired.slice(0, 80));
  check('and the successor it names is kept', /z-ai\/glm-5\.3-flash/.test(retired), retired);
  check('with somewhere to go next', /chip in the header/.test(retired), retired.slice(-60));
  // What the owner's workflow showed, raw, every morning.
  const noEndpoints = readableFailure(new Error('404 No endpoints found for stealth/space-bunny-alpha.'));
  check('"No endpoints found for <model>" is read as the model having gone', /no longer available/.test(noEndpoints), noEndpoints.slice(0, 80));
  check('  but the strict privacy refusal keeps its own sentence', !/no longer available/.test(readableFailure(new Error('No endpoints found matching your data policy'))));

  const { translateMessage } = await import('../server/i18n/index.js');
  check(
    'and a Vietnamese account reads it in Vietnamese',
    /không còn được cung cấp/.test(translateMessage(retired, 'vi')),
    translateMessage(retired, 'vi').slice(0, 80),
  );

  /**
   * The log line has to be as careful as the reply.
   *
   * `readableFailure` redacts because a provider client handed a malformed key
   * quotes the value back in its error message — that is recorded in
   * `tools/execute.js` as something observed, not feared. The same string went
   * into `log.error` untouched from ten call sites, several of which unpack a
   * provider error directly.
   *
   * `LOG_FORMAT=json` is the default on a deployment, so that line lands in the
   * platform's log under the platform's retention, readable by everyone with
   * log access — including operators who have no business holding that tenant's
   * key. CLAUDE.md §6 is explicit about not logging sensitive data.
   */
  const { log } = await import('../server/util/trace.js');

  // Captured off the real stream rather than through a seam built for the test,
  // so what is asserted is the line an operator would actually read. `error`
  // goes to stderr via `console.error`, and the format is decided at import
  // time — so the text form is what this run produces, and it carries the same
  // message either way.
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
  try {
    log.error(
      'turn failed',
      new Error('Headers.append: "Bearer sk-or-v1-0123456789abcdef0123456789abcdef" is an invalid header value'),
      { ms: 1 },
    );
  } finally {
    process.stderr.write = realWrite;
  }

  const line = written.join('');
  check('the log line was written at all', /turn failed/.test(line), line.slice(0, 80));
  check('  a key quoted back by a provider does not reach it', !/sk-or-v1-0123456789/.test(line));
  check('  and it still says what went wrong', /invalid header value/.test(line));

  /*
   * And not only `error`. The fields of a `warn` or an `info` are the same
   * channel — a store failure's message carries a connection string, a
   * connector's error carries a token — and only `log.error` unpacked its
   * argument through the redactor. The rate limiter logs a warning when it
   * fails open, which is exactly such a field.
   */
  const warned = [];
  const realWarn = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    warned.push(String(chunk));
    return realWarn(chunk, ...rest);
  };
  try {
    log.warn('rate limit not counted — failing open', {
      action: 'login',
      errMsg: 'connect ECONNREFUSED postgres://user:hunter2@db.example:5432/app',
    });
  } finally {
    process.stderr.write = realWarn;
  }
  const warnLine = warned.join('');
  check('a warning redacts its fields too', !/hunter2/.test(warnLine), warnLine.slice(0, 120));
  check('  and still names what happened', /failing open/.test(warnLine));
}

// ── the password box is reachable ───────────────────────────────────
section('the change-password form is not hidden');
{
  const html = await (await fetch(`${base}/index.html`)).text();
  const block = html.match(/<div id="password-block"[^>]*>/)?.[0] || '';
  check('#password-block exists', !!block, block);
  check('and is not marked hidden', !/\bhidden\b/.test(block), block);
}

// ── the session actually ends ───────────────────────────────────────
section('changing a password ends the other sessions');
{
  // A second browser, signed in as the same person.
  const laptop = jar();
  const signIn = await laptop.call('POST', '/api/login', {
    email: 'alice@example.com',
    password: 'a-long-enough-password',
  });
  check('a second device signs in', signIn.status === 200, `got ${signIn.status}`);
  check('and works', (await laptop.call('GET', '/api/bootstrap')).status === 200);

  const changed = await alice.call('POST', '/api/account/password', {
    current: 'a-long-enough-password',
    next: 'an-entirely-different-password',
  });
  check('the password changes', changed.status === 200, JSON.stringify(changed.json));
  check('and it says the other devices were signed out', changed.json?.signedOutOtherDevices === true);

  const stale = await laptop.call('GET', '/api/bootstrap');
  check(
    'the other device is signed out',
    stale.status === 401,
    `got ${stale.status} — a stolen cookie used to survive this`,
  );

  const mine = await alice.call('GET', '/api/bootstrap');
  check('the browser that did it stays in', mine.status === 200, `got ${mine.status}`);

  const reused = await alice.call('POST', '/api/account/password', {
    current: 'an-entirely-different-password',
    next: 'an-entirely-different-password',
  });
  check('setting the same password again is refused', reused.status === 400);
}

// ── admin ───────────────────────────────────────────────────────────
section('admin routes');
const bob = jar();
{
  const made = await bob.call('POST', '/api/register', {
    email: 'bob@example.com',
    password: 'bobs-long-enough-password',
    name: 'Bob',
  });
  check('a second account is an ordinary user', made.json?.user?.role === 'user', made.json?.user?.role);

  const denied = await bob.call('GET', '/api/admin/users');
  check('and cannot list people', denied.status === 403, `got ${denied.status}`);

  const denied2 = await bob.call('DELETE', `/api/admin/users/${made.json.user.id}`);
  check('nor delete anybody', denied2.status === 403, `got ${denied2.status}`);

  // A stdio MCP server is not a URL, it is "spawn this program on the server",
  // and the child inherits ENCRYPTION_KEY — the key every account's stored
  // provider keys are encrypted under. The MCP routes hang off the router whose
  // only guard is requireAuth, so this was reachable by any signed-in account:
  // one ordinary user could read every other user's credentials. ALLOW_MCP_STDIO
  // was carrying the whole weight, and it answers a different question — whether
  // the machine may spawn things, not who may decide what it spawns.
  // Where stdio servers run beside the server (ALLOW_MCP_STDIO on a single-owner
  // machine) — the case this is about. On a deployment they run on each
  // account's own cloud computer instead, which any account may use; that is
  // tested in mcp.test.
  const sneaky = {
    name: 'Sneaky',
    transport: 'stdio',
    command: 'node',
    args: ['-e', 'console.log(process.env.ENCRYPTION_KEY)'],
  };
  const hadStdio = process.env.ALLOW_MCP_STDIO;
  process.env.ALLOW_MCP_STDIO = '1';
  const stdio = await bob.call('POST', '/api/mcp', sneaky);
  if (hadStdio === undefined) delete process.env.ALLOW_MCP_STDIO;
  else process.env.ALLOW_MCP_STDIO = hadStdio;
  check('an ordinary account cannot add a stdio MCP server that would run beside the server', stdio.status === 403, `got ${stdio.status}`);
  check(
    '  and is told why, not just refused',
    /administrator/i.test(stdio.json?.error || ''),
    stdio.json?.error,
  );
  // And where it could run nowhere, nobody can add one, and is told why.
  const nowhere = await bob.call('POST', '/api/mcp', sneaky);
  check('with neither the cloud computer nor ALLOW_MCP_STDIO, it is refused for everyone', nowhere.status === 400 && /cloud computer/.test(nowhere.json?.error || ''), `${nowhere.status} ${nowhere.json?.error}`);

  // http servers spawn nothing and are screened for private addresses, so they
  // stay open to everyone. Asserted so the fix above cannot be widened into
  // "only admins get MCP at all", which would be a different product.
  const viaHttp = await bob.call('POST', '/api/mcp', {
    name: 'Ordinary',
    transport: 'http',
    url: 'http://127.0.0.1:9/never-answers',
  });
  check(
    'but an http one is still theirs to add',
    viaHttp.status !== 403,
    `got ${viaHttp.status} ${JSON.stringify(viaHttp.json?.error || '')}`,
  );

  const allowed = await alice.call('GET', '/api/admin/users');
  check('an administrator can', allowed.status === 200, `got ${allowed.status}`);
  check('and sees both accounts', allowed.json?.users?.length === 2, `${allowed.json?.users?.length}`);

  // Express 5 leaves req.body undefined with no JSON body, and `'x' in undefined`
  // is a TypeError — this used to be a 500.
  const bodyless = await fetch(`${base}/api/admin/users/${made.json.user.id}`, {
    method: 'PATCH',
    headers: { Cookie: alice.value },
  });
  check('a bodyless PATCH does not crash the server', bodyless.status !== 500, `got ${bodyless.status}`);

  const selfHarm = await alice.call('PATCH', '/api/admin/users/' + (await store.getUserByEmail('alice@example.com')).id, {
    suspended: true,
  });
  check('an admin cannot suspend themselves', selfHarm.status === 400, `got ${selfHarm.status}`);
}

// ── one run per conversation ────────────────────────────────────────
section('a conversation runs in one place at a time');
{
  const made = await alice.call('POST', '/api/chats', { model: 'anthropic/claude-opus-5' });
  const chatId = made.json.chat.id;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hello' });
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;

  // Take the lock the way another tab would, rather than racing a real run: with
  // no API key configured a real run fails in milliseconds, and a test that
  // depends on losing that race is a test that fails on a fast machine.
  check('another tab can hold the lock', await store.claimChatRun(aliceId, chatId, 'other-tab'));

  const blocked = await alice.call('POST', `/api/chats/${chatId}/run`, {});
  check('a second run is refused while it is held', blocked.status === 409, `got ${blocked.status}`);
  check('and says why', blocked.json?.code === 'already_running', JSON.stringify(blocked.json));

  check(
    'the holder may re-enter its own lock (a resume, not a race)',
    await store.claimChatRun(aliceId, chatId, 'other-tab'),
  );
  check(
    'but nobody else may',
    !(await store.claimChatRun(aliceId, chatId, 'third-tab')),
  );

  await store.releaseChatRun(aliceId, chatId, 'other-tab');
  const freed = await alice.call('POST', `/api/chats/${chatId}/run`, {});
  check('and it is released afterwards', freed.status !== 409, `got ${freed.status}`);
  await new Promise((r) => setTimeout(r, 150));

  /**
   * The reconnect case, which is the normal one on a deployment.
   *
   * A hosted run is routinely killed at the function timeout, so the `finally`
   * that releases the lock never runs and the lease is still held when the
   * browser reconnects a second later to continue. The browser sends the same
   * `runId` for every leg of one run precisely so that it re-enters its own
   * lease rather than being refused by the lock meant to protect it.
   */
  const runId = '11111111-2222-3333-4444-555555555555';
  await store.claimChatRun(aliceId, chatId, runId); // the leg that got killed

  const resumed = await alice.call('POST', `/api/chats/${chatId}/run`, { runId });
  check(
    'a reconnect with the same runId is allowed through',
    resumed.status !== 409,
    `got ${resumed.status} — a fresh id per request would deadlock every hosted run`,
  );

  await store.claimChatRun(aliceId, chatId, runId);
  const otherTab = await alice.call('POST', `/api/chats/${chatId}/run`, {
    runId: '99999999-8888-7777-6666-555555555555',
  });
  check('but a different runId is still kept out', otherTab.status === 409, `got ${otherTab.status}`);

  await store.releaseChatRun(aliceId, chatId, runId);
  await new Promise((r) => setTimeout(r, 150));

  /**
   * Stopping, as a fact rather than as a hint.
   *
   * Aborting the browser's fetch closes the socket and the route notices — most
   * of the time. Behind a proxy that buffers, or on a host that keeps the
   * connection open after the client has gone, that close can arrive late or
   * never, and the loop carries on spending the account's tokens on an answer
   * nobody will read. So the lease is the signal: `/stop` takes it away, and the
   * invocation doing the work learns it no longer holds it on the next
   * heartbeat.
   */
  const stopId = '77777777-6666-5555-4444-333333333333';
  await store.claimChatRun(aliceId, chatId, stopId);
  check('a heartbeat from the holder reports the lease is still theirs', await store.touchChatRun(aliceId, chatId, stopId));

  const stopped = await alice.call('POST', `/api/chats/${chatId}/stop`, {});
  check('stop answers', stopped.status === 200, `got ${stopped.status}`);
  check('and says it stopped something', stopped.json?.stopped === true, JSON.stringify(stopped.json));
  check(
    'after it, the running invocation learns the lease is gone',
    (await store.touchChatRun(aliceId, chatId, stopId)) === false,
    'this false is what aborts the agent loop — without it a stop is only a hope',
  );

  const stopAgain = await alice.call('POST', `/api/chats/${chatId}/stop`, {});
  check('stopping twice is harmless', stopAgain.status === 200 && stopAgain.json?.stopped === false);

  // Somebody else's conversation reads as missing rather than as stoppable —
  // the same answer every other chat route gives, so stop cannot be used to
  // discover which ids exist.
  const foreign = await bob.call('POST', `/api/chats/${chatId}/stop`, {});
  check("another account cannot stop Alice's run", foreign.status === 404, `got ${foreign.status}`);

  // A client-supplied id lands in the database, so it must be checked rather
  // than trusted.
  await alice.call('POST', `/api/chats/${chatId}/run`, { runId: "'; DROP TABLE chats; --" });
  check(
    'a malformed runId is ignored, not stored',
    (await store.listChats(aliceId)).length > 0,
    'the chats table is still there',
  );
  await new Promise((r) => setTimeout(r, 150));

  // A run killed mid-flight — the normal way a serverless invocation ends —
  // must not wedge the conversation forever.
  await store.claimChatRun(aliceId, chatId, 'dead-run');
  check(
    'a stale lease expires rather than wedging the chat',
    await store.claimChatRun(aliceId, chatId, 'new-run', 0),
  );
  await store.releaseChatRun(aliceId, chatId, 'new-run');
}

// ── throttling ──────────────────────────────────────────────────────
/* ── coming back to a turn that never stopped ──────────────────── */

/**
 * Reload the page mid-answer and the work carries on; the page has to be able
 * to find its way back into it.
 *
 * What used to happen: the browser's fetch closed, the server read that as a
 * stop and aborted the turn, and the conversation was left frozen mid-thought
 * with nothing on screen saying whether anything was still happening. Sending
 * again was the only way on.
 *
 * Two halves fix it, and this is the server's. A run holds a lease keyed by a
 * run id, and a request carrying that same id is let back into the lease rather
 * than refused by it — the mechanism that already let a turn survive a hosted
 * function timing out. The browser knew its own id for as long as the tab lived
 * and lost it on reload, so opening the conversation now asks the server for it.
 *
 * The browser's half — actually rejoining and drawing the rest of the turn —
 * is in the UI suite.
 */
section('reopening a conversation says whether it is still answering');
{
  const made = await alice.call('POST', '/api/chats', { model: 'anthropic/claude-opus-5' });
  const chatId = made.json.chat.id;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'a long question' });
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;

  const quiet = await alice.call('GET', `/api/chats/${chatId}`);
  check('a conversation nothing is working in says so', quiet.json?.running === null, JSON.stringify(quiet.json?.running));

  // The turn the closed tab left behind, still holding its lease.
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await store.claimChatRun(aliceId, chatId, runId);

  const reopened = await alice.call('GET', `/api/chats/${chatId}`);
  check('one that is answering says so', !!reopened.json?.running, JSON.stringify(reopened.json?.running));
  // The id is the whole point: without it the page can only start a second run
  // or sit there watching nothing.
  check('and hands back the id needed to rejoin it', reopened.json?.running?.runId === runId, JSON.stringify(reopened.json?.running));

  // And that id does let it back in, which is what makes the answer above worth
  // anything. A different one is still refused.
  const stranger = await alice.call('POST', `/api/chats/${chatId}/run`, { runId: '99999999-8888-7777-6666-555555555555' });
  check('a stranger is still kept out', stranger.status === 409, `${stranger.status}`);

  await store.stopChatRun(aliceId, chatId);
  const stopped = await alice.call('GET', `/api/chats/${chatId}`);
  check('a stopped run is no longer reported as running', stopped.json?.running === null, JSON.stringify(stopped.json?.running));


  const notTheirs = await bob.call('GET', `/api/chats/${chatId}`);
  check('and another account learns nothing about it', notTheirs.status === 404, `${notTheirs.status}`);
}

section('login throttling');
{
  const attacker = jar();
  let sawLimit = false;
  let attempts = 0;

  for (let i = 0; i < 16; i += 1) {
    const res = await attacker.call('POST', '/api/login', {
      email: 'alice@example.com',
      password: `guess-number-${i}`,
    });
    attempts += 1;
    if (res.status === 429) {
      sawLimit = true;
      check('the refusal carries Retry-After', !!res.headers.get('retry-after'));
      check('and is labelled', res.json?.code === 'rate_limited', JSON.stringify(res.json));
      break;
    }
  }
  check('guessing gets throttled', sawLimit, `gave up after ${attempts} attempts`);
  check('and well before the tenth guess would have mattered', attempts <= 13, `${attempts}`);
}

// ── chats stay with their owner over HTTP too ───────────────────────
section('cross-account access through the API');
{
  const mine = await alice.call('GET', '/api/chats');
  const chatId = mine.json.chats[0]?.id;
  check('Alice has a conversation to steal', !!chatId);

  const peek = await bob.call('GET', `/api/chats/${chatId}`);
  check("Bob cannot open Alice's chat", peek.status === 404, `got ${peek.status}`);

  const write = await bob.call('POST', `/api/chats/${chatId}/messages`, { text: 'injected' });
  check('nor post into it', write.status === 404, `got ${write.status}`);

  const rename = await bob.call('PATCH', `/api/chats/${chatId}`, { title: 'hacked' });
  check('nor rename it', rename.status === 404, `got ${rename.status}`);

  const run = await bob.call('POST', `/api/chats/${chatId}/run`, {});
  check(
    'nor start the agent on it',
    run.status === 404,
    `got ${run.status} — and 404 rather than 409, which would confirm it exists`,
  );
}

// ── input validation ────────────────────────────────────────────────
section('validation');
{
  const empty = await alice.call('POST', '/api/tasks', { title: 'x', when: '17:00', prompt: '   ' });
  check('a task with no prompt is refused', empty.status === 400, `got ${empty.status}`);
  check(
    'and nothing was scheduled',
    (await alice.call('GET', '/api/tasks')).json.tasks.length === 0,
    'the check used to run after the insert',
  );

  const nonsense = await alice.call('POST', '/api/tasks', { title: 'x', when: 'tomorrow', prompt: 'do it' });
  check('an unparseable time is refused', nonsense.status === 400, `got ${nonsense.status}`);

  const good = await alice.call('POST', '/api/tasks', {
    title: 'Evening summary',
    when: '17:00',
    prompt: 'summarise',
    tz: 'Asia/Ho_Chi_Minh',
  });
  check('a real schedule is accepted', good.status === 201, JSON.stringify(good.json).slice(0, 120));
  check('and the zone is stored with it', good.json?.task?.tz === 'Asia/Ho_Chi_Minh', good.json?.task?.tz);
  check(
    'so it fires at 17:00 there, whatever the server thinks the time is',
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(good.json.task.next_run_at)) === '17:00',
    new Date(good.json.task.next_run_at).toISOString(),
  );

  const badName = await alice.call('PATCH', '/api/account', { name: '   ' });
  check('an empty display name is refused', badName.status === 400, `got ${badName.status}`);
}

// ── the first message must not fail for a fixable reason ────────────
section('the default model is one the account can run');
{
  const fresh = jar();
  await fresh.call('POST', '/api/register', {
    email: 'freshkeys@example.com',
    password: 'a-long-enough-password',
  });

  // No keys at all: the stated default stands, and the error it eventually
  // produces names the provider to add a key for.
  const none = await fresh.call('GET', '/api/bootstrap');
  check(
    'with no keys, the stated default stands',
    none.json?.prefs?.defaultModel === 'anthropic/claude-opus-5',
    none.json?.prefs?.defaultModel,
  );

  // An OpenAI key and nothing else. The default names a Claude model, which
  // would have failed on the very first message with "No API key for Anthropic"
  // and no hint that the *model* was the thing to change.
  await fresh.call('PUT', '/api/providers/openai/key', { apiKey: 'sk-test-openai-key' });
  const withOpenAI = await fresh.call('GET', '/api/bootstrap');
  check(
    'a key for one provider moves the default to it',
    withOpenAI.json?.prefs?.defaultModel?.startsWith('openai/'),
    withOpenAI.json?.prefs?.defaultModel,
  );

  // Adding an Anthropic key does *not* pull the default onto a paid flagship any
  // more. Nothing free is reachable here — this account has no OpenRouter key —
  // so the stated default is still what stands.
  await fresh.call('PUT', '/api/providers/anthropic/key', { apiKey: 'sk-ant-test-key' });
  const withBoth = await fresh.call('GET', '/api/bootstrap');
  check(
    'and the stated default wins once its provider works',
    withBoth.json?.prefs?.defaultModel === 'anthropic/claude-opus-5',
    withBoth.json?.prefs?.defaultModel,
  );

  /**
   * An OpenRouter key outranks the paid flagships, and that is the change.
   *
   * This used to prefer the built-in flagships and reach for a free model only
   * when *nothing else* was configured — so an account with an Anthropic key
   * started on Claude Opus and started spending on its first message, never
   * having been told a free option existed. Free first is the friendlier landing
   * place; the interface says which kind of model it is and offers the swap.
   */
  await store.upsertModels([
    {
      id: 'openrouter/vendor/free-new:free',
      provider: 'openrouter',
      model: 'vendor/free-new:free',
      family: 'vendor',
      label: 'Free New',
      context: 128_000,
      maxOutput: 32_768,
      priceIn: 0,
      priceOut: 0,
      isFree: true,
      releasedAt: new Date().toISOString(),
      vision: false,
    },
    {
      id: 'openrouter/vendor/free-old:free',
      provider: 'openrouter',
      model: 'vendor/free-old:free',
      family: 'vendor',
      label: 'Free Old',
      context: 128_000,
      maxOutput: 32_768,
      priceIn: 0,
      priceOut: 0,
      isFree: true,
      releasedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      vision: false,
    },
    {
      id: 'openrouter/vendor/paid-newest',
      provider: 'openrouter',
      model: 'vendor/paid-newest',
      family: 'vendor',
      label: 'Paid Newest',
      context: 128_000,
      maxOutput: 32_768,
      priceIn: 3,
      priceOut: 15,
      isFree: false,
      releasedAt: new Date(Date.now() + 86_400_000).toISOString(),
      vision: false,
    },
  ]);

  await fresh.call('PUT', '/api/providers/openrouter/key', { apiKey: 'sk-or-v1-test-key' });
  const withRouter = await fresh.call('GET', '/api/bootstrap');
  check(
    'an OpenRouter key lands a new account on the newest free model',
    withRouter.json?.prefs?.defaultModel === 'openrouter/vendor/free-new:free',
    withRouter.json?.prefs?.defaultModel,
  );
  check(
    'and not on the newest model overall, which is a paid one',
    withRouter.json?.prefs?.defaultModel !== 'openrouter/vendor/paid-newest',
    withRouter.json?.prefs?.defaultModel,
  );

  // So the chip can say "free" and offer the swap in one press.
  const facts = await fresh.call('GET', '/api/models/resolve?id=openrouter/vendor/free-new:free');
  check('and the model reports itself as free', facts.json?.model?.isFree === true, JSON.stringify(facts.json?.model));
  const paidFacts = await fresh.call('GET', '/api/models/resolve?id=openrouter/vendor/paid-newest');
  check('while a paid one does not', paidFacts.json?.model?.isFree === false, JSON.stringify(paidFacts.json?.model));

  // An explicit choice is never second-guessed: picking a model and finding it
  // swapped would be far worse than an error message. The one exception is a
  // model its provider has withdrawn — moved to Auto and said so, at the
  // owner's request (2026-10-06; see the section on gone models below). A model
  // that is still served but has no key here is the case this check is about.
  await fresh.call('PUT', '/api/prefs', { defaultModel: 'anthropic/claude-opus-5' });
  await fresh.call('PUT', '/api/providers/anthropic/key', { apiKey: '' });
  const chosen = await fresh.call('GET', '/api/bootstrap');
  check(
    'an explicit choice is left alone even when it cannot run',
    chosen.json?.prefs?.defaultModel === 'anthropic/claude-opus-5' && !chosen.json?.prefs?.modelNotice,
    chosen.json?.prefs?.defaultModel,
  );
}

section('a failed Google sign-in carries its reason out of the URL');
{
  const res = await fetch(`${base}/api/connectors/google/callback?state=forged&code=x`, {
    headers: { Cookie: alice.value },
    redirect: 'manual',
  });
  const where = res.headers.get('location') || '';
  check('it goes back to the app as an error', res.status === 302 && /google=error/.test(where), `${res.status} ${where}`);
  // A reason in the URL is text anyone can put in a link.
  check('  with no message in the address', !/message=/.test(where), where);
  check('  and the reason in a cookie only this origin sets', /g_err=[^;]+/.test(res.headers.get('set-cookie') || ''), res.headers.get('set-cookie'));
}

section('opening the app on a model that has gone moves the account to Auto, and says so once');
{
  const me = await store.getUserByEmail('alice@example.com');
  // The library knows OpenRouter; the account's model is no longer in it.
  await store.upsertModels([
    {
      id: 'openrouter/lab/still-here', provider: 'openrouter', model: 'lab/still-here', family: 'lab', label: 'Still here',
      description: null, context: 64_000, maxOutput: 8192, priceIn: 0, priceOut: 0, isFree: true, vision: false,
      releasedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await alice.call('PUT', '/api/prefs', { defaultModel: 'openrouter/stealth/space-bunny-alpha' });
  const boot = await alice.call('GET', '/api/bootstrap');
  check('the app opens on Auto', boot.json?.prefs?.defaultModel === 'auto', boot.json?.prefs?.defaultModel);
  check('  with the notice naming the model it replaced', boot.json?.prefs?.modelNotice?.from === 'space-bunny-alpha', JSON.stringify(boot.json?.prefs?.modelNotice));
  const forged = await alice.call('PUT', '/api/prefs', { modelNotice: { from: 'made up by the browser' } });
  check('the browser cannot write a notice of its own', forged.json?.modelNotice?.from === 'space-bunny-alpha', JSON.stringify(forged.json?.modelNotice));
  const cleared = await alice.call('PUT', '/api/prefs', { modelNotice: null });
  check('  only clear the one it has shown', cleared.status === 200 && cleared.json?.modelNotice == null);
  const again = await alice.call('GET', '/api/bootstrap');
  check('  so the next visit is quiet', again.json?.prefs?.modelNotice == null && again.json?.prefs?.defaultModel === 'auto');
  await store.setUserSetting(me.id, 'prefs', { ...(await store.getUserSetting(me.id, 'prefs')), defaultModel: 'openrouter/lab/still-here' });
  const live = await alice.call('GET', '/api/bootstrap');
  check('a model that is still served is left alone', live.json?.prefs?.defaultModel === 'openrouter/lab/still-here' && !live.json?.prefs?.modelNotice);
}

// ── signing out ─────────────────────────────────────────────────────
section('signing out');
{
  const out = await alice.call('POST', '/api/logout');
  check('logout succeeds', out.status === 200);
  const after = await alice.call('GET', '/api/bootstrap');
  check('and the session is gone', after.status === 401, `got ${after.status}`);
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n[32mAll HTTP checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
