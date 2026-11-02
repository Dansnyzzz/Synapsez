/**
 * The cloud computer on E2B (owner, 2026-11-02), with Vercel Sandbox standing in.
 *
 * Nothing here reaches E2B: a stand-in SDK plays the platform, so the suite
 * checks what this app asks of it — who a command runs as, what is paid for,
 * when the other platform is used instead — and leaves "does E2B do what its
 * documentation says" to `npm run e2b:probe`, which runs on the real thing.
 *
 *   node test/e2b.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-the-e2b-suite';
for (const name of ['E2B_CREDIT_MILLS', 'E2B_CREDIT_LASTING_MILLS', 'E2B_CREDIT_EXPIRES', 'FREE_TIER_ONLY']) delete process.env[name];

const { initStore } = await import('../server/store/index.js');
const memory = await PGlite.create();
const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
const tiers = await import('../server/freeTier.js');

section("E2B's credit: all of it used, none of it overspent (owner, 2026-11-02)");
{
  const at = (iso) => new Date(iso);
  const cap = (usedBefore, iso) => tiers.e2bMonthCap({ usedBefore, now: at(iso), env: {} });
  check('thirteen months before it lapses, a thirteenth of the lapsing $100 (less the margin)', cap(0, '2026-11-15T00:00:00Z') === Math.floor(97_000 / 13), String(cap(0, '2026-11-15T00:00:00Z')));
  check('a quiet start passes its share on: $30 used, ten months left', cap(30_000, '2027-02-03T00:00:00Z') === 6_700, String(cap(30_000, '2027-02-03T00:00:00Z')));
  check('the last month before it lapses may use all that is left of it', cap(90_000, '2027-11-20T00:00:00Z') === 7_000, String(cap(90_000, '2027-11-20T00:00:00Z')));
  check('once the lapsing part is gone, what is left of the lasting $5', cap(97_000, '2027-05-01T00:00:00Z') === 4_850 && cap(98_000, '2027-05-01T00:00:00Z') === 3_850);
  check('after it lapses, only the lasting $5 — untouched if the $100 was never all used', cap(40_000, '2027-12-02T00:00:00Z') === 4_850 && cap(99_000, '2028-03-01T00:00:00Z') === 2_850);
  check('and nothing at all once both are spent', cap(110_000, '2028-03-01T00:00:00Z') === 0);
  check('each figure can be set', tiers.e2bMonthCap({ usedBefore: 0, now: at('2026-11-15T00:00:00Z'), env: { E2B_CREDIT_MILLS: '13000', E2B_CREDIT_EXPIRES: '2027-12-01' } }) === Math.floor(12_610 / 13));

  const now = at('2026-11-15T00:00:00Z');
  const fresh = await tiers.allowance('e2b', now);
  check("the month's allowance is that ceiling", fresh.limit === Math.floor(97_000 / 13) && fresh.left === fresh.limit, JSON.stringify(fresh));
  await tiers.spend('e2b', 25, now);
  const after = await tiers.allowance('e2b', now);
  check('  and what is spent comes off it', after.left === fresh.limit - 25, JSON.stringify(after));
  check('  counted for the month and for the whole credit', (await store.readCounter('free:e2b:2026-11')) === 25 && (await store.readCounter('free:e2b:total')) === 25);
  const next = await tiers.allowance('e2b', at('2026-12-02T00:00:00Z'));
  check("next month's ceiling is worked out from what is left", next.limit === Math.floor((97_000 - 25) / 12), JSON.stringify(next));
  await tiers.exhaust('e2b', now);
  check('E2B saying it is spent closes the month, without counting against the credit', (await tiers.allowance('e2b', now)).left === 0 && (await store.readCounter('free:e2b:total')) === 25);
  const report = await tiers.freeTierReport(now);
  const row = report.services.find((s) => s.service === 'e2b');
  check("the administrators' view has it, with this month's ceiling", row?.limit === Math.floor(97_000 / 13) && row?.per === 'month', JSON.stringify(row));
}

/**
 * A stand-in for the `e2b` SDK: sandboxes in a map, every call written down,
 * errors named the way the SDK names them (`name`, and `statusCode` from the
 * API), which is all server/e2b.js reads of them.
 */
const named = (name, message, extra = {}) => Object.assign(new Error(message), { name }, extra);
function fakeSdk() {
  const state = { boxes: new Map(), calls: [], next: 1, clock: 1, files: {}, onRun: null, createError: null, afterCreate: null };
  class Sandbox {
    constructor(id, metadata) {
      this.sandboxId = id;
      this.metadata = metadata;
      this.startedAt = state.clock++;
      this.commands = {
        run: async (cmd, opts) => {
          state.calls.push({ kind: 'run', id, cmd, opts });
          return state.onRun ? state.onRun(cmd, opts) : { exitCode: 0, stdout: 'ok', stderr: '' };
        },
      };
      this.files = {
        write: async (entries) => state.calls.push({ kind: 'write', entries }),
        read: async (path, opts) => {
          state.calls.push({ kind: 'read', path, opts });
          if (!(path in state.files)) throw named('FileNotFoundError', `${path} not found`);
          return new Uint8Array(Buffer.from(state.files[path]));
        },
      };
    }
    getHost(port) {
      return `${port}-${this.sandboxId}.e2b.app`;
    }
    async setTimeout(ms) {
      state.calls.push({ kind: 'setTimeout', ms });
    }
    async getInfo() {
      return { cpuCount: 2, memoryMB: 1024 };
    }
    async pause() {
      state.calls.push({ kind: 'pause', id: this.sandboxId });
    }
    async kill() {
      state.boxes.delete(this.sandboxId);
      state.calls.push({ kind: 'kill', id: this.sandboxId });
    }
    static async create(template, opts) {
      state.calls.push({ kind: 'create', template, opts });
      if (state.createError) throw state.createError;
      const box = new Sandbox(`sbx${state.next++}`, opts.metadata);
      state.boxes.set(box.sandboxId, box);
      if (state.afterCreate) await state.afterCreate(box);
      return box;
    }
    static async connect(id, opts) {
      state.calls.push({ kind: 'connect', id, opts });
      const box = state.boxes.get(id);
      if (!box) throw named('SandboxNotFoundError', `404: sandbox ${id} not found`, { statusCode: 404 });
      return box;
    }
    static list({ query } = {}) {
      return {
        hasNext: false,
        nextItems: async () =>
          [...state.boxes.values()]
            .filter((b) => Object.entries(query?.metadata || {}).every(([k, v]) => b.metadata?.[k] === v))
            .map((b) => ({ sandboxId: b.sandboxId, metadata: b.metadata, startedAt: new Date(b.startedAt), state: 'running' })),
      };
    }
  }
  return { state, sdk: { Sandbox } };
}

process.env.E2B_API_KEY = 'e2b_test_key';
const e2b = await import('../server/e2b.js');
const { shellFor } = await import('../server/sandbox.js');
await store.createUser({ id: 'u-e2b', email: 'e2b@example.com', passwordHash: 'x', name: 'E', role: 'user' });
// The credit checks above closed November; this suite's machines run in today's month.
const resetCounters = async () => memory.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:e2b:%'");

section('a command on E2B runs as root, and drops to the account itself (HAR-001)');
{
  await resetCounters();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  const machine = await e2b.e2bMachineFor('u-e2b', 'synz-test');
  const done = await machine.runCommand({ ...shellFor("echo 'it''s'", {}, { userBin: true }), timeoutMs: 30_000 });
  const run = state.calls.find((c) => c.kind === 'run');
  check('every command is sent as root, from the account\'s home', run.opts.user === 'root' && run.opts.cwd === '/home/user', JSON.stringify(run.opts));
  check('  so E2B\'s login shell reads only files root can write', /^exec /.test(run.cmd));
  check('  and an ordinary command drops to the account before it starts', /\/usr\/bin\/setpriv --reuid="\$\(\/usr\/bin\/id -u user\)" --regid="\$\(\/usr\/bin\/id -g user\)" --init-groups \/usr\/bin\/env HOME=\/home\/user USER=user LOGNAME=user 'bash' '--noprofile' '--norc' '-c' /.test(run.cmd), run.cmd.slice(0, 240));
  check('  with a time limit kept inside the machine', /^exec \/usr\/bin\/timeout -k 5 30 \/usr\/bin\/setpriv /.test(run.cmd));
  /*
   * SBX-004: root runs these before the drop, and E2B's /usr/local is writable
   * by the account. A bare `id` or `timeout` would be whatever the account last
   * put in /usr/local/sbin — run as root, ahead of every later command.
   */
  const rootRuns = run.cmd.replace(/'[^']*'/g, '').match(/(?:^exec |\$\(|\s)(timeout|setpriv|id|env)\b/g) || [];
  check('  every program root starts before the drop is named by its full path (SBX-004)', rootRuns.length === 0, rootRuns.join(' | '));
  check('  the script quoted whole, quotes and all', run.cmd.includes(`echo '\\''it'\\'''\\''s'\\''`), run.cmd.slice(-60));
  check('  the environment passed as the platform\'s own', run.opts.envs?.BASH_ENV === '' && run.opts.envs?.ENV === '');
  // E2B's /etc/profile ends by sourcing ~/.bashrc and ~/.profile (live probe, 2026-11-02).
  for (const [label, options] of [['ordinary', { userBin: true }], ['root', { root: true }]]) {
    const script = shellFor('true', {}, options).args[3];
    check(`  /etc/profile is read with no home to find the account's files from (${label})`, script.startsWith('_home="$HOME"; HOME=/nonexistent; source /etc/profile >/dev/null 2>&1 || true; HOME="$_home"; unset _home\n'), script.slice(0, 120));
  }
  check('  and the answer read the way the Vercel one is', done.exitCode === 0 && (await done.stdout()) === 'ok' && (await done.stderr()) === '');

  state.calls.length = 0;
  await machine.runCommand({ ...shellFor('apt-get install -y jq', {}, { root: true }), sudo: true, timeoutMs: 60_000 });
  const root = state.calls.find((c) => c.kind === 'run');
  check('as_root stays root, still without a login profile', root.opts.user === 'root' && !root.cmd.includes('setpriv') && /^exec \/usr\/bin\/timeout -k 5 60 \/usr\/bin\/env PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin 'bash' '--noprofile' '--norc' '-c' /.test(root.cmd), root.cmd.slice(0, 120));
  check('  its shell found on a fixed PATH of root-only folders, not on what the account can write (SBX-004)', /PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin 'bash'/.test(root.cmd));

  state.onRun = async () => {
    throw named('CommandExitError', 'exit status 3', { exitCode: 3, stdout: 'partial', stderr: 'boom' });
  };
  const failed = await machine.runCommand({ ...shellFor('false'), timeoutMs: 5_000 });
  check('a command that fails is an exit code, as on Vercel — not a thrown error', failed.exitCode === 3 && (await failed.stdout()) === 'partial' && (await failed.stderr()) === 'boom');

  state.onRun = async () => ({ wait: async () => Promise.reject(named('CommandExitError', 'killed', { exitCode: 143 })) });
  const started = await machine.runCommand({ ...shellFor('exec node service.mjs'), detached: true });
  const background = state.calls.filter((c) => c.kind === 'run').pop();
  check('a detached start runs in the background, with no time limit of its own', background.opts.background === true && !/timeout -k/.test(background.cmd));
  check('  and its end reads as an exit code', (await started.wait()).exitCode === 143);
  state.onRun = async () => ({ wait: async () => Promise.reject(named('TimeoutError', 'stream closed')) });
  const watched = await machine.runCommand({ ...shellFor('exec node service.mjs'), detached: true });
  check('  while losing sight of it is not mistaken for its end', (await watched.wait().then(() => 'resolved', (e) => e.name)) === 'TimeoutError');
  state.onRun = null;

  check('a port is the https address E2B gives it', machine.domain(3000) === `https://3000-${machine.sandboxId}.e2b.app`);
  check('the working folder is the account\'s home', machine.currentSession().cwd === '/home/user');
  state.files['/home/user/out/a.txt'] = 'hello';
  check('a relative path is read from the home folder', String(await machine.readFileToBuffer({ path: 'out/a.txt' })) === 'hello');
  check('  and a missing file is null, as on Vercel', (await machine.readFileToBuffer({ path: '/nowhere.txt' })) === null);
  await machine.writeFiles([{ path: 'data/in.csv', content: Buffer.from('a,b') }]);
  const wrote = state.calls.find((c) => c.kind === 'write');
  check('files are written under the home folder', wrote.entries[0].path === '/home/user/data/in.csv' && Buffer.from(wrote.entries[0].data).toString() === 'a,b');
  e2b.__testing.useSdk(null);
}

section("one machine per account, found again — and paid for before it runs");
{
  await resetCounters();
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  const first = await e2b.e2bMachineFor('u-e2b', 'synz-a');
  const create = state.calls.find((c) => c.kind === 'create');
  check('made from the template, named for the account, pausing when idle', create.template === 'base' && create.opts.metadata.machine === 'synz-a' && create.opts.lifecycle?.onTimeout === 'pause' && create.opts.timeoutMs === 600_000, JSON.stringify(create.opts));
  check("  its ports open to the person's browser, which cannot send E2B's traffic token (owner, 2026-11-02)", create.opts.network?.allowPublicTraffic === true);  const record = await store.getUserSetting('u-e2b', e2b.__testing.SETTING);
  check('  and written down with its size', record?.id === first.sandboxId && record.cpu === 2 && record.memMb === 1024, JSON.stringify(record));
  const paid = await store.readCounter(`free:e2b:${new Date().toISOString().slice(0, 7)}`);
  check('  its first ten minutes paid for, at the price for its size', paid > 0 && paid <= Math.ceil(600 * (2 * 0.014 + 2 * 0.0045)), String(paid));

  state.calls.length = 0;
  const again = await e2b.e2bMachineFor('u-e2b', 'synz-a');
  check('the next call resumes the same machine', again.sandboxId === first.sandboxId && state.calls.some((c) => c.kind === 'connect') && !state.calls.some((c) => c.kind === 'create'));
  check('  without paying twice for time already paid', (await store.readCounter(`free:e2b:${new Date().toISOString().slice(0, 7)}`)) - paid <= 1);

  await again.extendTimeout(15 * 60_000);
  check('keeping it awake longer sets its timeout and pays only the extra time', state.calls.some((c) => c.kind === 'setTimeout' && c.ms === 900_000));

  /*
   * HAR-010: paid for before it runs — and given back when it did not. With
   * E2B's twenty machines all busy, every failed start used to cost ten
   * minutes of the month's credit; about 325 of them closed E2B for the month
   * with no machine time used at all.
   */
  {
    const month = `free:e2b:${new Date().toISOString().slice(0, 7)}`;
    await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
    state.boxes.clear();
    const before = await store.readCounter(month);
    state.createError = named('RateLimitError', 'Rate limit exceeded', { statusCode: 429 });
    const busy = await e2b.e2bMachineFor('u-e2b', 'synz-a').then(() => '', (e) => e.name);
    state.createError = null;
    check('a start that does not happen costs nothing: what it paid is given back (HAR-010)', busy === 'RateLimitError' && (await store.readCounter(month)) === before, `${busy} ${before} → ${await store.readCounter(month)}`);
  }

  state.boxes.clear();
  state.calls.length = 0;
  const remade = await e2b.e2bMachineFor('u-e2b', 'synz-a');
  check('a machine that no longer exists is made again', remade.sandboxId !== first.sandboxId && state.calls.some((c) => c.kind === 'create'));

  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  state.calls.length = 0;
  const found = await e2b.e2bMachineFor('u-e2b', 'synz-a');
  check('with no record, a machine of that name is found rather than made', found.sandboxId === remade.sandboxId && !state.calls.some((c) => c.kind === 'create'));

  // Two instances making the same account's machine at once.
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  state.boxes.clear();
  state.afterCreate = async () => {
    state.afterCreate = null;
    const other = new sdk.Sandbox('sbx-other', { app: 'synapsez', machine: 'synz-b' });
    other.startedAt = 0;
    state.boxes.set(other.sandboxId, other);
  };
  const raced = await e2b.e2bMachineFor('u-e2b', 'synz-b');
  check('two made at once: the older is kept, the newer killed', raced.sandboxId === 'sbx-other' && state.calls.some((c) => c.kind === 'kill' && c.id !== 'sbx-other'), raced.sandboxId);

  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  state.boxes.clear();
  state.calls.length = 0;
  await tiers.exhaust('e2b');
  const refused = await e2b.e2bMachineFor('u-e2b', 'synz-c').then(() => null, (err) => err);
  check("with this month's credit spent, no machine is made at all", refused instanceof e2b.E2BOutOfCredit && !state.calls.some((c) => c.kind === 'create'), String(refused?.message));
  e2b.__testing.useSdk(null);
  await resetCounters();
}

section('which refusals send the work elsewhere');
{
  const u = e2b.e2bUnavailable;
  check('too many machines at once: busy', u(named('RateLimitError', 'Rate limit exceeded', { statusCode: 429 })) === 'busy');
  check('  even when it speaks of a quota or credits — busy never closes the month', u(named('RateLimitError', 'Rate limit exceeded - concurrent sandbox quota, upgrade for more credits', { statusCode: 429 })) === 'busy');
  check('no capacity: down', u(named('ServiceBusyError', 'Service temporarily unavailable', { statusCode: 503 })) === 'down');
  check('a bad key: auth', u(named('AuthenticationError', 'Unauthorized')) === 'auth');
  check('credit spent, however it is said: credit', u(named('SandboxError', '402: payment required', { statusCode: 402 })) === 'credit' && u(named('SandboxError', '403: You have run out of credits')) === 'credit' && u(new e2b.E2BOutOfCredit()) === 'credit');
  check('the network: down', u(new TypeError('fetch failed')) === 'down' && u(named('TimeoutError', 'Request timed out')) === 'down');
  check('a command that failed is not a reason to move', u(named('CommandExitError', 'exit status 1', { exitCode: 1 })) === null && u(new Error('something else')) === null);
  check('configured by its key alone', e2b.e2bConfigured({ E2B_API_KEY: 'k' }) && !e2b.e2bConfigured({}));
  check('a library that will not load here: broken (SBX-002)', u(new e2b.E2BSdkError(new Error('require() of ES Module x not supported'))) === 'broken');
}

section('E2B first, Vercel standing in when it cannot');
{
  const sandbox = await import('../server/sandbox.js');
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  let vercelStarts = 0;
  sandbox.__testing.useSdk({
    Sandbox: {
      getOrCreate: async () => {
        vercelStarts += 1;
        return { provider: undefined, domain: () => 'https://sb.vercel.run' };
      },
      create: async () => ({ domain: () => 'https://scratch.vercel.run', stop: async () => {}, delete: async () => {} }),
    },
  });
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  await resetCounters();
  process.env.VERCEL_TOKEN = 't';
  process.env.VERCEL_TEAM_ID = 'team';
  process.env.VERCEL_PROJECT_ID = 'p';

  const usual = await sandbox.machineForUser('u-e2b');
  check('with a key, the account\'s machine is on E2B', usual.provider === 'e2b' && !usual.standIn && vercelStarts === 0);

  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  state.boxes.clear();
  state.createError = named('RateLimitError', 'Rate limit exceeded', { statusCode: 429 });
  const busy = await sandbox.machineForUser('u-e2b');
  check('all twenty E2B machines running: Vercel stands in, and says it is a stand-in', busy.standIn === true && vercelStarts === 1);
  check('  the model is told what that means', /A stand-in cloud computer for this account: its usual one is unavailable right now/.test(sandbox.machineNote('', { standIn: busy.standIn })));

  state.createError = named('SandboxError', '403: Your team has run out of credits', { statusCode: 403 });
  await sandbox.machineForUser('u-e2b');
  check("E2B saying its credit is gone is believed for the month", (await tiers.allowance('e2b')).left === 0 && vercelStarts === 2);
  state.createError = null;
  state.calls.length = 0;
  await sandbox.machineForUser('u-e2b');
  check('  so the next call goes straight to Vercel, without asking E2B', vercelStarts === 3 && !state.calls.some((c) => c.kind === 'create'));
  await resetCounters();

  state.createError = new Error('something no platform would cure');
  const odd = await sandbox.machineForUser('u-e2b').then(() => '', (e) => e.message);
  check('an error that would follow the work anywhere is not hidden behind a stand-in', odd === 'something no platform would cure' && vercelStarts === 3);

  // SBX-002: the production failure of 2026-11-02, had it been caught — a library that will not load.
  const loadFailure = () => new e2b.E2BSdkError(new Error('require() of ES Module /var/task/node_modules/e2b/node_modules/chalk/source/index.js not supported'));
  sandbox.__testing.clearE2bAside();
  state.createError = loadFailure();
  const before = vercelStarts;
  const stoodIn = await sandbox.machineForUser('u-e2b');
  check('an E2B library that will not load sends the work to Vercel, which is told it stands in (SBX-002)', stoodIn.standIn === true && vercelStarts === before + 1);
  state.calls.length = 0;
  state.createError = null;
  await sandbox.machineForUser('u-e2b');
  check('  and E2B is set aside rather than loaded again at once', !state.calls.some((c) => c.kind === 'create') && vercelStarts === before + 2);
  sandbox.__testing.clearE2bAside();

  for (const name of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID']) delete process.env[name];
  state.createError = named('RateLimitError', 'Rate limit exceeded', { statusCode: 429 });
  const alone = await sandbox.machineForUser('u-e2b').then(() => '', (e) => e.message);
  check('with no Vercel to stand in, busy reads as busy', /in use by other people right now/.test(alone), alone);
  state.createError = named('AuthenticationError', 'Unauthorized, please check your credentials.');
  const badKey = await sandbox.machineForUser('u-e2b').then(() => '', (e) => e.message);
  check('  and a key E2B refuses says whose key to check', /did not accept this deployment's key \(E2B_API_KEY\)/.test(badKey), badKey);
  state.createError = null;
  state.calls.length = 0;
  const aside = await sandbox.machineForUser('u-e2b').then(() => '', (e) => e.message);
  check('  E2B is then set aside for a while rather than asked again at once', /E2B_API_KEY/.test(aside) && !state.calls.some((c) => c.kind === 'create'));

  sandbox.__testing.clearE2bAside();
  state.createError = loadFailure();
  const broken = await sandbox.machineForUser('u-e2b').then(() => '', (e) => e.message);
  check('with no Vercel, a library that will not load says the owner must read the logs — not the raw loader text', /could not load its E2B library/.test(broken) && !/var\/task|require\(\)/.test(broken), broken);
  state.createError = null;
  sandbox.__testing.clearE2bAside();

  sandbox.__testing.useSdk(null);
  e2b.__testing.useSdk(null);
}

section('the SDK loads on a runtime that cannot require() an ES module (SBX-001)');
{
  /*
   * Production broke here (owner, 2026-11-02): every sandbox_run answered
   * "require() of ES Module …/e2b/node_modules/chalk/source/index.js … not
   * supported". `e2b` has no `exports`, so a bare import reaches its CommonJS
   * build, which require()s the ES-only chalk 5 — fine on this PC, fatal on
   * Vercel's runtime. Run the app's own loader in a Node that refuses
   * require(esm), the way that runtime does.
   */
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script =
    "const m = await import('./server/e2b.js');" +
    'const sdk = await m.__testing.loadSdk();' +
    'console.log(typeof sdk.Sandbox?.create);';
  const run = spawnSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ENCRYPTION_KEY: 'test-encryption-key-for-the-e2b-suite' },
  });
  const said = `${run.stdout}${run.stderr}`.trim();
  check('the SDK the app loads has Sandbox.create', run.status === 0 && run.stdout.trim() === 'function', said.split('\n')[0]);
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll E2B checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
