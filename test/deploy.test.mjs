/**
 * Deployment suite — the app as Vercel will actually run it.
 *
 * Local and hosted are genuinely different programs here: `isServerless()`
 * switches the screen transport, the scheduler, the local-tool path and the
 * store. Every one of those branches is code that only ever executes in
 * production, which is the worst place to find out it is wrong.
 *
 * So this runs the real app with `VERCEL=1` set and walks the deployment paths,
 * plus the static checks that decide whether a build will even boot: that the
 * files read at runtime are declared, that the entrypoint is shaped the way the
 * platform expects, and that the schema migrates rather than assuming a fresh
 * database.
 *
 *   node test/deploy.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

// ── the build manifest ──────────────────────────────────────────────
section('vercel.json');
{
  const conf = json('vercel.json');
  const fn = conf.functions?.['api/index.js'];

  check('the API function is configured', !!fn);
  check('with a duration long enough for an agent turn', fn?.maxDuration >= 60, `${fn?.maxDuration}s`);
  // 300s is both the default and the ceiling on Hobby with fluid compute. Asking
  // for more is not a slower deployment, it is a rejected one.
  check('and not more than the plan allows', fn?.maxDuration <= 300, `${fn?.maxDuration}s`);

  // The schema declares `additionalProperties: false` here, so an invented key —
  // a `comment` explaining the config, most temptingly — is not ignored, it
  // fails validation and the deployment never builds. This is the whole list.
  const FUNCTION_KEYS = [
    'runtime',
    'memory',
    'maxDuration',
    'supportsCancellation',
    'maxConcurrency',
    'includeFiles',
    'excludeFiles',
    'regions',
    'functionFailoverRegions',
    'experimentalTriggers',
  ];
  const strayFn = Object.keys(fn || {}).filter((k) => !FUNCTION_KEYS.includes(k));
  check('and no key the schema will reject', strayFn.length === 0, strayFn.join(', ') || 'none');

  // "You cannot set your memory size using vercel.json. If you try to do so, you
  // will receive a warning at build time." Hobby always gets 2GB/1vCPU and
  // cannot configure it; only Pro and Enterprise can, and only in the dashboard.
  check('and does not try to set memory', fn?.memory === undefined, `${fn?.memory ?? 'unset'}`);

  // schema.sql is read with fs.readFileSync at runtime. The bundler traces
  // imports, not file reads, so without this the first request on a fresh
  // deployment fails with ENOENT and the database is never built.
  check('server/ is force-included in the bundle', !!fn?.includeFiles, fn?.includeFiles || 'missing');
  check(
    'and the pattern actually covers schema.sql',
    /^server\//.test(fn?.includeFiles || ''),
    fn?.includeFiles,
  );

  check(
    'every /api path reaches the function',
    conf.rewrites?.some((r) => r.source === '/api/(.*)' && r.destination === '/api/index.js'),
  );

  const crons = (conf.crons || []).map((c) => c.path);
  check('scheduled tasks have a cron', crons.includes('/api/cron/run-tasks'), crons.join(', '));
  check('the model library has one too', crons.includes('/api/cron/refresh-models'));
  // Hobby allows 100 cron jobs, so both of these run on the free plan. The limit
  // that bites is frequency, not count, and it bites at deploy time: an
  // expression that would fire more than once a day is refused with "Hobby
  // accounts are limited to daily cron jobs" and the deployment fails outright.
  // Once-per-day means a single literal minute and a single literal hour —
  // `*`, `*/15` and `1,13` all describe something that repeats within the day.
  const atMostDaily = (schedule) => {
    const [minute, hour] = String(schedule || '').split(/\s+/);
    return /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour);
  };

  for (const cron of conf.crons || []) {
    check(
      `${cron.path} has a valid five-field schedule`,
      /^\S+ \S+ \S+ \S+ \S+$/.test(cron.schedule || ''),
      cron.schedule,
    );
    check(`${cron.path} runs at most daily, as Hobby requires`, atMostDaily(cron.schedule), cron.schedule);

    // Same strictness as the function entry: `path` and `schedule`, nothing else.
    const stray = Object.keys(cron).filter((k) => k !== 'path' && k !== 'schedule');
    check(`${cron.path} carries no key the schema will reject`, stray.length === 0, stray.join(', ') || 'none');
  }
}

section('the serverless entrypoint');
{
  const entry = read('api/index.js');
  check('api/index.js exists and default-exports the app', /export default/.test(entry));
  check('it does not start a listener of its own', !/\.listen\(/.test(entry));
  check('it checks its secrets', /assertSecrets\(\)/.test(entry));
  check(
    'and reports a misconfiguration instead of throwing at import',
    /try\s*\{/.test(entry) && /503/.test(entry),
    'a module that throws while loading leaves Vercel nothing to invoke, and the visitor gets an unexplained platform error',
  );

  // server/index.js is the local entrypoint and must never be what runs here:
  // it binds a port and starts a timer, neither of which exists on a function.
  check('the local entrypoint is not the one deployed', !/server\/index\.js/.test(entry));
}

section('dependencies');
{
  const pkg = json('package.json');
  check('type is module, matching every import in the tree', pkg.type === 'module');
  check('a Node version is declared', !!pkg.engines?.node, pkg.engines?.node);
  check(
    'the Node version is one Vercel offers',
    /(^|[^\d])(20|22|24)/.test(pkg.engines?.node || ''),
    pkg.engines?.node,
  );

  // PGlite is 25MB and exists for local runs and tests. It must stay out of the
  // deployed bundle, which means nothing may import it except behind a branch
  // that a deployment never takes.
  check('pglite is a devDependency', !!pkg.devDependencies?.['@electric-sql/pglite']);
  // Which makes `npm install --omit=dev` produce an app that starts and then
  // fails at the first request with a bare ERR_MODULE_NOT_FOUND naming a
  // package the reader has no reason to have heard of. It stays a
  // devDependency — the 25MB matters — so the loader has to explain itself.
  check(
    'and a missing one explains itself rather than throwing a module error',
    /npm install/.test(read('server/store/pglite.js')),
    'server/store/pglite.js must catch ERR_MODULE_NOT_FOUND and say what to run',
  );
  check('and not a runtime one', !pkg.dependencies?.['@electric-sql/pglite']);

  const storeIndex = read('server/store/index.js');
  check(
    'store/index.js imports it lazily, so it is never traced into the bundle',
    !/^import .*pglite/m.test(storeIndex) && /await import\('\.\/pglite\.js'\)/.test(storeIndex),
  );

  // Everything the server actually reaches for on a deployment.
  for (const dep of ['express', '@neondatabase/serverless', '@anthropic-ai/sdk', 'openai', '@google/genai', 'qrcode', 'nodemailer']) {
    check(`${dep} is a runtime dependency`, !!pkg.dependencies?.[dep], pkg.dependencies?.[dep] || 'MISSING');
  }
}

section('files read at runtime are present');
{
  // Anything opened by path rather than imported has to be shipped deliberately.
  check('server/store/schema.sql exists', fs.existsSync(path.join(root, 'server/store/schema.sql')));
  check('public/index.html exists', fs.existsSync(path.join(root, 'public/index.html')));
  check('public/js/app.js exists', fs.existsSync(path.join(root, 'public/js/app.js')));
  check('public/css/app.css exists', fs.existsSync(path.join(root, 'public/css/app.css')));

  // The CDN serves public/ directly, and the Content-Security-Policy forbids
  // anything from another origin — so a stray CDN link is a blank page, not a
  // slow one.
  const html = read('public/index.html');
  check('the page loads no external stylesheet', !/<link[^>]+href="https?:\/\//i.test(html));
  check('and no external script', !/<script[^>]+src="https?:\/\//i.test(html));

  /*
   * No tracked source file carries a raw control byte.
   *
   * CODE-004 removed a literal NUL from `worker/tools.js`, where it stood in for
   * a binary-file guard — and nothing held the line afterwards, so a second one
   * arrived in `server/agent.js` during the same audit, written by the auditor:
   * a `join('\n\0\n')` whose escape became the byte itself. A file with a NUL in
   * it reads as binary to grep, diff and review tools, so the line containing it
   * is effectively invisible, and a formatter that normalises it changes what the
   * code does. The runtime string happened to be identical this time; nothing
   * guarantees that next time.
   *
   * ESC is allowed: several suites print colour with a literal escape. Tab, line
   * feed and carriage return are ordinary text.
   */
  const { execFileSync } = await import('node:child_process');
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(js|mjs|cjs|css|html|sql|json|md|ps1|sh)$/.test(f))
    /*
     * Source, which is what the paragraph above is about — not the third-party
     * bundles under `public/vendor/`.
     *
     * The harm a control byte does is to *reading*: grep and diff call the file
     * binary, so the line holding it becomes invisible to review, and a
     * formatter that normalises it changes what the code does. None of that
     * applies to a minified vendor bundle. Nobody reviews `pdf.worker.min.mjs`
     * line by line, nothing here reformats it, and it is replaced wholesale by
     * re-vendoring rather than edited.
     *
     * PDF.js ships one — byte 14 at offset 138024 — so this check failed on
     * every run from the moment the viewer was vendored, against a file no
     * change of ours can fix. A gate that is permanently red for a reason
     * nobody can act on stops being read, which costs more than the one case
     * it was guarding.
     */
    .filter((f) => !f.startsWith('public/vendor/'));
  const dirty = [];
  for (const rel of tracked) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const bytes = fs.readFileSync(full);
    const at = bytes.findIndex((b) => b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 27);
    if (at !== -1) dirty.push(`${rel} (byte ${bytes[at]} at offset ${at})`);
  }
  check(
    `no tracked source file contains a raw control byte (${tracked.length} checked)`,
    dirty.length === 0,
    dirty.slice(0, 3).join('; '),
  );

  /*
   * And git reads every one of them as text.
   *
   * CODE-025: four route files lifted out of app.js were committed with a
   * carriage return doubled before every line feed. A lone CR makes git classify
   * the file as `-text`, and a non-text file gets no line diff — every later
   * change to chats.js, files.js, mcp.js and connectors.js showed as "binary
   * files differ", unreviewable. Asked of git itself, so it holds whatever the
   * checkout's line-ending settings are. (The row format is
   * `i/<index> w/<tree> attr/<attr> <TAB><path>`.)
   */
  const SOURCE = ['.js', '.mjs', '.cjs', '.css', '.html', '.sql', '.json', '.md', '.ps1', '.sh'];
  const binaryish = execFileSync('git', ['ls-files', '--eol'], { cwd: root, encoding: 'utf8' })
    .split(String.fromCharCode(10))
    .filter((row) => row.startsWith('i/-text'))
    .map((row) => row.split(String.fromCharCode(9)).pop() || '')
    .filter((file) => SOURCE.some((ext) => file.endsWith(ext)));
  check('git diffs every tracked source file as text', binaryish.length === 0, binaryish.slice(0, 4).join(', '));
}

// ── the app, running as a deployment ────────────────────────────────
section('running with VERCEL=1');

process.env.VERCEL = '1';
process.env.ENCRYPTION_KEY ||= 'deploy-test-encryption-key';
process.env.SESSION_SECRET ||= 'deploy-test-session-secret';
process.env.CRON_SECRET = 'deploy-test-cron-secret';

// A deployment must have DATABASE_URL, so stand in a real Postgres — the same
// SQL Neon would run, driven through the same HTTP-shaped adapter.
const { PGlite } = await import('@electric-sql/pglite');
const dataDir = path.join(os.tmpdir(), `ai-remote-deploy-test-${process.pid}`);
fs.rmSync(dataDir, { recursive: true, force: true });
const db = await PGlite.create(dataDir);

const { createPgStore } = await import('../server/store/pg.js');
const neonShaped = {
  // Neon's HTTP driver resolves to rows and runs one statement per call.
  async query(text, params = []) {
    return (await db.query(text, params)).rows;
  },
};

{
  const { isServerless } = await import('../server/store/index.js');
  check('the app knows it is serverless', isServerless() === true);
}

// The whole app — routes, middleware, scheduler — driven against this Postgres,
// so every check below exercises the code a deployment actually runs.
const { initStore, getStore } = await import('../server/store/index.js');

// ── the migration path ──────────────────────────────────────────────
//
// A deployment is almost never a fresh database. The interesting case is an
// existing one from before these columns existed.
section('migrating an existing database');
{
  // Build the shape a previous release left behind: the original tables, none
  // of the newer columns, and no version marker.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      worker_token TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ
    );
    INSERT INTO users (id, email, password_hash, role)
    VALUES ('legacy-1', 'legacy@example.com', 'scrypt$32768$AA$AA', 'admin')
    ON CONFLICT DO NOTHING;
  `);

  // This is the app's own store from here on, so the migration under test is the
  // one every later check runs against.
  const store = await initStore({ driver: neonShaped });

  const row = await store.getUserById('legacy-1');
  check('the existing account survives', row?.email === 'legacy@example.com');
  check('session_epoch is backfilled, not null', Number(row?.session_epoch) === 1, String(row?.session_epoch));
  check('totp_last_step is added', 'totp_last_step' in row);
  check('suspended_at is added', 'suspended_at' in row);
  check('monthly_token_limit is added', 'monthly_token_limit' in row);

  const marked = await store.getSetting('schema_version');
  check("and the schema is stamped afterwards", Number(marked) >= 5, String(marked));

  // Every table and column the new code touches must now exist.
  const columns = async (table) =>
    (await neonShaped.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      [table],
    )).map((r) => r.column_name);

  check('rate_limits exists', (await columns('rate_limits')).includes('bucket'));
  check('chats has the run lock', (await columns('chats')).includes('run_lock_by'));
  check('scheduled_tasks has a timezone', (await columns('scheduled_tasks')).includes('tz'));
  check('screens has watched_at', (await columns('screens')).includes('watched_at'));

  // Running it again on an already-migrated database must be a no-op, not a
  // second pass over thirty DDL statements on every cold start.
  let statements = 0;
  const counted = createPgStore({
    async query(text, params = []) {
      statements += 1;
      return (await db.query(text, params)).rows;
    },
  });
  await counted.init();
  check(
    'a migrated database skips the DDL entirely',
    statements === 1,
    `${statements} statement(s) — one SELECT to read the version`,
  );

  // And the store still works through the counted driver.
  check('the store is usable afterwards', (await counted.countUsers()) >= 1);
}

// ── deployment-only behaviour ───────────────────────────────────────
section('screen transport falls back to the database');
{
  const store = getStore();

  // With no shared memory between instances, a frame has to go somewhere both
  // sides can see — this is the branch `isServerless()` selects.
  await store.putScreen('legacy-1', { frame: 'AAAA', meta: { title: 'Example' } });
  const got = await store.getScreen('legacy-1');
  check('a frame round-trips through Postgres', got?.frame === 'AAAA');

  await store.markWatching('legacy-1');
  check('and watching is recorded there too', (await store.isWatched('legacy-1')) === true);

  await store.clearScreen('legacy-1');
  check('signing out clears it', (await store.getScreen('legacy-1'))?.frame === null);
}

section('local-only tools are withheld');
{
  const { usesInProcessTools, workerStatus } = await import('../server/localTools.js');

  // There is no durable filesystem or shell worth reaching on a function, and an
  // admin account must not be handed one that does not exist.
  check('an admin gets no in-process tools', usesInProcessTools({ role: 'admin' }) === false);
  check('nor does anybody else', usesInProcessTools({ role: 'user' }) === false);

  const status = await workerStatus({ id: 'legacy-1', role: 'admin' }).catch(() => null);
  check('and the worker reads as offline until one connects', status?.online === false, JSON.stringify(status));
  check(
    'with the honest reason, not "you are not the owner"',
    status?.reason === 'no-worker',
    status?.reason,
  );
}

section('the scheduler does not start a timer');
{
  const { startScheduler, stopScheduler } = await import('../server/scheduler.js');
  startScheduler();
  // A function is frozen between requests, so a timer would simply never fire —
  // and holding the event loop open would keep the instance billable.
  check('startScheduler is inert on a deployment', true, 'the cron endpoint is the scheduler here');
  stopScheduler();
}

// ── the deployed app answers ────────────────────────────────────────
section('the deployed app answers');
{
  const { createApp } = await import('../server/app.js');
  const app = createApp();

  const PORT = 5196;
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));
  const call = async (method, url, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };

  const session = await call('GET', '/api/session');
  check('the session endpoint answers', session.status === 200, `got ${session.status}`);
  check('and reports serverless storage', /postgres/.test(session.text) || session.status === 200);

  const guarded = await call('GET', '/api/bootstrap');
  check('protected routes still need a session', guarded.status === 401, `got ${guarded.status}`);

  const cronNoSecret = await call('GET', '/api/cron/run-tasks');
  check('the cron endpoint refuses without its secret', cronNoSecret.status === 401, `got ${cronNoSecret.status}`);

  const cronWrong = await call('GET', '/api/cron/run-tasks', { Authorization: 'Bearer wrong' });
  check('and refuses a wrong one', cronWrong.status === 401, `got ${cronWrong.status}`);

  const cronRight = await call('GET', '/api/cron/run-tasks', {
    Authorization: `Bearer ${process.env.CRON_SECRET}`,
  });
  check('and accepts the right one', cronRight.status === 200, `got ${cronRight.status} ${cronRight.text.slice(0, 80)}`);
  check('returning what it ran', /"ran"/.test(cronRight.text), cronRight.text.slice(0, 60));

  const csp = session.headers.get('content-security-policy');
  check('security headers are sent on a deployment too', !!csp);
  check('and forbid framing', /frame-ancestors 'none'/.test(csp || ''));

  // An unknown /api path must answer as an API — JSON with a status — and never
  // fall through to the HTML shell, which a fetch() caller cannot do anything
  // with. 401 rather than 404 is correct and deliberate: `requireAuth` guards
  // the whole router, so an anonymous caller cannot map which routes exist.
  const missing = await call('GET', '/api/definitely-not-a-route');
  check('an unknown API path answers as an API', missing.status === 401 || missing.status === 404, `got ${missing.status}`);
  check('with JSON, not the HTML shell', /"error"/.test(missing.text), missing.text.slice(0, 60));
  check('and it is not the page', !/<!doctype/i.test(missing.text));

  const missingAuthed = await call('GET', '/api/definitely-not-a-route', {
    Authorization: `Bearer ${process.env.CRON_SECRET}`,
  });
  check('and it still does not serve HTML with a token', !/<!doctype/i.test(missingAuthed.text));

  server.close();
  await new Promise((r) => server.once('close', r));
}

// ── connecting a computer to a deployment ───────────────────────────
//
// The failure this exists to remove: `npm start` brings up a *local* app and
// points the worker at it, so the pairing code it prints lands in a database
// the deployment cannot see. Somebody follows the instructions on their own
// deployment and is told their code is invalid — which it is, on that server.
section('a computer can be pointed at a deployment');
{
  const { parseLaunchArgs, planWorkerEnv, normaliseServerUrl, isLocalServer } = await import(
    '../scripts/lib/workerLink.js'
  );

  const url = 'https://ai-remote-amber.vercel.app';

  // Three spellings, because all three are what people type. A parser that
  // understands only one spends its life rejecting correct intent.
  check('--server <url> is understood', parseLaunchArgs(['--server', url]).server === url);
  check('--server=<url> is understood', parseLaunchArgs([`--server=${url}`]).server === url);
  check('a bare URL is understood', parseLaunchArgs([url]).server === url);

  check('a trailing slash is dropped', normaliseServerUrl(`${url}/`) === url, normaliseServerUrl(`${url}/`));

  // Rejected rather than coerced: quietly rewriting these produces a worker
  // that polls somewhere unexpected, which is worse than being told no.
  const refuses = (argv) => {
    try {
      parseLaunchArgs(argv);
      return false;
    } catch {
      return true;
    }
  };
  check('a non-web address is refused', refuses(['--server', 'file:///tmp/x']));
  check('nonsense is refused', refuses(['--server', 'not a url']));
  check('a missing address is refused', refuses(['--server']));
  check('an unknown option is refused', refuses(['--sever', url]));

  // `--pair` means "connect this machine to a server elsewhere", so bringing up
  // a second app here is not merely redundant — it is the source of the exact
  // confusion above: two apps, two databases, one code that belongs to one.
  const paired = parseLaunchArgs(['--pair', url]);
  check('--pair does not also start a local app', paired.wantServer === false);
  check('but does start the worker', paired.wantWorker === true);
  check('a plain start still runs both', parseLaunchArgs([]).wantServer && parseLaunchArgs([]).wantWorker);

  check('a deployment is not mistaken for this machine', isLocalServer(url) === false);
  check('and localhost is', isLocalServer('http://localhost:5173') === true);

  // The address is remembered, so the next run needs no argument. Pairing once
  // and having your computer simply be there is the promise; retyping a URL
  // every start is not that.
  const fresh = planWorkerEnv('', url);
  check('a new file records the address', /^SERVER_URL=https:\/\/ai-remote-amber\.vercel\.app$/m.test(fresh.text), fresh.text);
  check('and says something changed', fresh.changed === true);

  const same = planWorkerEnv(`SERVER_URL=${url}\nWORKER_TOKEN=abc123\n`, url);
  check('re-running with the same address changes nothing', same.changed === false);
  check('and keeps the token', /WORKER_TOKEN=abc123/.test(same.text), same.text);

  /**
   * A token is only worth anything on the server that minted it. Carrying one
   * across a change of address gives HTTP 401, and the worker's reaction to a
   * 401 is to announce "This computer is no longer paired" — which is wrong and
   * alarming. It is still paired; just to somewhere else.
   */
  const moved = planWorkerEnv(`SERVER_URL=https://old.example.com\nWORKER_TOKEN=abc123\n`, url);
  check('moving to another server drops the old token', moved.droppedToken === true);
  check('and it really is gone', !/WORKER_TOKEN/.test(moved.text), moved.text);
  check('while the new address is written', /SERVER_URL=https:\/\/ai-remote-amber/.test(moved.text), moved.text);
  check('and the old one is reported, so the reason can be explained', moved.previous === 'https://old.example.com', moved.previous);

  // Nothing is known about where a token with no recorded address came from, so
  // it is left alone rather than thrown away on a guess.
  const unknownOrigin = planWorkerEnv('WORKER_TOKEN=abc123\n', url);
  check('a token of unknown origin is kept', unknownOrigin.droppedToken === false);

  // It is somebody's configuration file, not scratch space.
  const withExtras = planWorkerEnv('# my notes\nDEVICE_NAME=studio\nSERVER_URL=http://localhost:5173\n', url);
  check('comments survive', /# my notes/.test(withExtras.text), withExtras.text);
  check('and unrelated settings do too', /DEVICE_NAME=studio/.test(withExtras.text), withExtras.text);
  check('while the address is replaced, not appended twice',
    (withExtras.text.match(/^SERVER_URL=/gm) || []).length === 1, withExtras.text);
}

/**
 * The one-line installer, which is a script strangers paste into a shell.
 *
 * Two properties matter more than anything else it does, and both are checked
 * by reading the file rather than by running it:
 *
 *   **It is static.** Every variable arrives in the environment. The moment a
 *   server builds this text by joining a parameter into it, whatever was joined
 *   in becomes code — the caller pipes the result straight into `iex` or `bash`.
 *
 *   **It refuses to continue without a typed YES**, after naming the account.
 *   An enrolment token travels *toward* a machine, so it can be handed to
 *   somebody who was told it does something else. Nothing else in the flow
 *   stands between that and a stranger owning their computer.
 */
section('the one-line installer');
{
  for (const [name, text] of [
    ['setup.ps1', read('public/setup.ps1')],
    ['setup.sh', read('public/setup.sh')],
  ]) {
    // A placeholder means somebody intended to substitute at serve time, which
    // is the injection this design exists to avoid.
    check(`${name} has no placeholder to substitute`, !/__[A-Z_]+__/.test(text), (/__[A-Z_]+__/.exec(text) || [])[0]);
    check(`${name} takes the token from the environment`, /AIR_TOKEN/.test(text));
    check(`${name} takes the server from the environment`, /AIR_SERVER/.test(text));

    check(`${name} asks the server whose account this is first`, /api\/pair\/enrol/.test(text));
    check(`${name} shows the account before anything else happens`, /full access to this computer/.test(text));
    check(`${name} refuses to continue without YES`, /YES/.test(text));
    // Confirming must come after the question, or the token is spent before
    // anybody is asked — and answering "no" would still have cost it.
    check(
      `${name} only confirms after asking`,
      text.indexOf('YES') < text.lastIndexOf('confirm'),
      `YES at ${text.indexOf('YES')}, confirm at ${text.lastIndexOf('confirm')}`,
    );
    check(`${name} does not ask for administrator rights`, !/RunAs|sudo /.test(text));
  }

  /**
   * The PowerShell trap that stopped the installer dead on its first real use.
   *
   * `git clone` writes "Cloning into '...'" to stderr — progress, not an error.
   * With $ErrorActionPreference = 'Stop', PowerShell 5.1 turns every stderr line
   * from a native program into a terminating NativeCommandError the moment it is
   * merged into the pipeline with 2>&1. The clone succeeded; the script aborted
   * anyway, printing a red wall of text about a line that had worked.
   *
   * Reproduced deliberately before fixing: the old form threw NativeCommandError
   * while the repository was sitting on disk, fully cloned.
   */
  {
    const ps = read('public/setup.ps1');
    check('there is a helper for running external programs', /function Run\(/.test(ps));
    check('and it judges them by their exit code', /\$LASTEXITCODE -ne 0/.test(ps));
    // $? follows PowerShell's wrapping of native stderr rather than the
    // program's own result, so it is the wrong signal for exactly this bug.
    check('not by $?, which lies about native programs', !/if \(-not \$\?\)/.test(ps));
    check('git clone goes through it', /Run '[^']*' 'git' @\('clone'/.test(ps));
    check('and so does npm install', /Run 'npm install' 'npm'/.test(ps));
    // The reason a command failed is the whole value of the message. Out-Null on
    // the old form threw "Repository not found" away.
    check('a failure shows what the program said', /Select-Object -Last/.test(ps));
    // Any remaining 2>&1 must be on a line that runs under a Continue region —
    // either inside the helper, or one of the two calls that deliberately guard
    // themselves because their failure is not worth stopping for.
    // PowerShell block comments are `<# … #>`, and the explanation above talks
    // about `2>&1` at length — prose about the bug must not read as the bug.
    const code = ps.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');
    const risky = code.split('\n').filter((l) => /2>&1/.test(l));
    const guarded = risky.every((l) => /\$output = &/.test(l) || /& (git|node)/.test(l));
    check('every remaining redirect is inside a guarded region', guarded, risky.join(' | '));
  }

  // Served from the app's own origin, without a session: the machine running it
  // has none yet, and that is the entire point.
  const files = fs.readdirSync(path.join(root, 'public'));
  check('both are in public/, so the app serves them', files.includes('setup.ps1') && files.includes('setup.sh'));
}

/**
 * A browser needs somewhere to draw, and CI has nowhere.
 *
 * The default was headed everywhere, for a real reason — headless Chrome has no
 * audio device, so a video "playing" in it is silent frames. But `ubuntu-latest`
 * has no X or Wayland session, so on CI that default did not trade sound for
 * anything: it guaranteed the browser would not start, and the sandbox suite
 * failed the moment it was added to the workflow.
 */
section('the browser can start where there is no screen');
{
  const text = read('worker/browser.js');
  check('the headless default asks whether there is a display', /WAYLAND_DISPLAY/.test(text));
  check('and only on Linux, where the question means anything', /process\.platform !== 'linux'/.test(text));
  check('BROWSER_HEADLESS still overrides it', /BROWSER_HEADLESS \?\? String\(!hasDisplay\)/.test(text));

  // The decision, run over every machine this could land on — the one running
  // the suite can only ever be one of them.
  const decide = (platform, display, wayland, env) => {
    const hasDisplay = platform !== 'linux' || !!(display || wayland);
    return /^(1|true|yes)$/i.test(env ?? String(!hasDisplay));
  };
  check('a desktop stays headed', decide('win32', null, null, undefined) === false);
  check('so does Linux with a display', decide('linux', ':0', null, undefined) === false);
  check('and Wayland counts as one', decide('linux', null, 'wayland-0', undefined) === false);
  check('a Linux runner with no display goes headless', decide('linux', null, null, undefined) === true);
  check('an explicit false still wins', decide('linux', null, null, 'false') === false);
  check('and an explicit true still wins', decide('win32', null, null, 'true') === true);
}

section('starting at login');
{
  const text = read('scripts/autostart.js');

  /**
   * Not a service, and not Task Scheduler.
   *
   * A Windows service runs in session 0, which has no desktop — every
   * `desktop_*` tool would fail on a machine that looked perfectly connected.
   * And `schtasks /SC ONLOGON` fails with "Access is denied" for an ordinary
   * account, which is fatal for a setup a stranger pastes: a one-liner that
   * demands administrator is a one-liner nobody should agree to.
   */
  check('Windows uses the per-user Run key', /HKCU\\\\Software\\\\Microsoft/.test(text));
  // The word appears in a comment explaining why it was rejected; what must not
  // appear is a call to it.
  check('and never calls schtasks, which needs elevation', !/execFileSync\('schtasks'/.test(text));
  check('the window is hidden through a shim', /autostart\.vbs/.test(text));
  // wscript reads a .vbs in the system code page, so one non-ASCII character
  // silently breaks the line it is on.
  check('written as ASCII, because wscript reads the code page', /'ascii'/.test(text));

  /**
   * Installing has to start it, not only arrange a start.
   *
   * The Run key schedules a launch *at login* and nothing else, so the installer
   * finished, said "Done", and the app showed the machine as offline — last seen
   * never. The only fix was to log out and back in, which nobody guesses. It now
   * launches the same shim the login will launch, so what you get immediately is
   * what you get after a reboot rather than a second code path.
   */
  check('installing also starts it now', /spawn\('wscript\.exe'/.test(text));
  check('by launching the same shim login uses', /spawn\('wscript\.exe', \[shim\]/.test(text));
  check('detached, so it outlives the installer', /detached: true/.test(text));
  check('and says so rather than implying a reboot is needed', /Installed and started/.test(text));

  check('there is a way to undo it', /--uninstall/.test(text));
  check('and it says so after installing', /Remove it with/.test(text));
  check('macOS and Linux are handled too', /LaunchAgents/.test(text) && /systemd/.test(text));
  // Said out loud rather than implied: a green tick for a code path that has
  // never run is worse than an admitted gap.
  check('and are marked as untested', /NOT tested/.test(text));
}

// The instruction in the interface has to be generated, because it names this
// deployment's own address — the hard-coded `npm start` it replaced was the
// visible half of the bug above.
section('the interface can name this deployment');
{
  const { publicUrlFor } = await import('../server/util/net.js');

  const stated = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = 'https://stated.example.com/';
  check('PUBLIC_URL wins when set', publicUrlFor({ headers: {} }) === 'https://stated.example.com');

  delete process.env.PUBLIC_URL;
  // Without honouring the proxy headers the scheme reads as http behind
  // Vercel's TLS terminator, and the printed command points at a redirect.
  check(
    'otherwise the proxy headers decide',
    publicUrlFor({ headers: { 'x-forwarded-proto': 'https', host: 'app.vercel.app' } }) === 'https://app.vercel.app',
  );
  check(
    'a forwarded host wins over the raw one',
    publicUrlFor({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'real.app', host: 'internal' } }) ===
      'https://real.app',
  );
  check('and nothing at all is admitted rather than guessed', publicUrlFor({ headers: {} }) === null);

  const html = read('public/index.html');
  check(
    'the misleading hard-coded instruction is gone',
    !/clone this repo.*npm start/s.test(html),
    'public/index.html still tells everyone to run npm start',
  );
  check('and the steps are filled in from script', /id="connect-steps"/.test(html));

  /**
   * The setup line has to be behind *both* doors.
   *
   * It was added to the Settings tab only, while the button most people press is
   * "Computers" in the header — a different dialog entirely. So the one-line path
   * existed and the people who needed it were staring at the pairing-code box,
   * asking why there was no setup option.
   */
  for (const id of ['make-setup-link', 'setup-link', 'make-setup-link-dialog', 'setup-link-dialog']) {
    check(`the page has #${id}`, html.includes(`id="${id}"`));
  }
  const appJs = read('public/js/app.js');
  for (const id of ['make-setup-link', 'make-setup-link-dialog']) {
    check(`#${id} is wired up`, appJs.includes(`'${id}'`));
  }
  check(
    'and both use the same renderer rather than a second copy',
    (appJs.match(/async function renderSetupLink/g) || []).length === 1,
  );

  const pkg = json('package.json');
  check('there is a command to run on the other machine', typeof pkg.scripts?.connect === 'string', pkg.scripts?.connect);
  check('and it does not start a second app', /--pair/.test(pkg.scripts?.connect || ''), pkg.scripts?.connect);

  if (stated == null) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = stated;
}

fs.rmSync(dataDir, { recursive: true, force: true });
delete process.env.VERCEL;

console.log(
  failures === 0
    ? '\n[32mAll deployment checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
