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
          const out = state.onRun ? await state.onRun(cmd, opts) : { exitCode: 0, stdout: 'ok', stderr: '' };
          // In the background E2B hands back a handle to wait on or kill, as the real SDK does.
          if (!opts?.background || typeof out?.wait === 'function') return out;
          return { wait: async () => out, kill: async () => state.calls.push({ kind: 'killCommand', id }) };
        },
      };
      this.files = {
        write: async (entries) => state.calls.push({ kind: 'write', entries }),
        read: async (path, opts) => {
          state.calls.push({ kind: 'read', path, opts });
          if (!(path in state.files)) throw named('FileNotFoundError', `${path} not found`);
          return new Uint8Array(Buffer.from(state.files[path]));
        },
        getInfo: async (path) => {
          if (!(path in state.files)) throw named('FileNotFoundError', `${path} not found`);
          return { name: path.split('/').pop(), path, size: state.sizes?.[path] ?? Buffer.byteLength(state.files[path]) };
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
    async downloadUrl(path, opts) {
      state.calls.push({ kind: 'downloadUrl', path, opts });
      return `https://files.example/${this.sandboxId}${path}`;
    }
    async uploadUrl(path, opts) {
      state.calls.push({ kind: 'uploadUrl', path, opts });
      return `https://files.example/up/${this.sandboxId}${path}`;
    }
    async createSnapshot() {
      return { snapshotId: `snap${state.next++}` };
    }
    static async deleteSnapshot(id) {
      state.calls.push({ kind: 'deleteSnapshot', id });
    }
    async kill() {
      state.boxes.delete(this.sandboxId);
      state.calls.push({ kind: 'kill', id: this.sandboxId });
    }
    static async kill(id) {
      state.boxes.delete(id);
      state.calls.push({ kind: 'kill', id });
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
  // The last: the first is the machine being closed, which has a section of its own.
  const run = state.calls.filter((c) => c.kind === 'run').at(-1);
  check('every command is sent as root, from the account\'s home', run.opts.user === 'root' && run.opts.cwd === '/home/user', JSON.stringify(run.opts));
  check('  so E2B\'s login shell reads only files root can write', /^exec /.test(run.cmd));
  check('  and an ordinary command drops to the account before it starts', /\/usr\/bin\/setpriv --reuid="\$\(\/usr\/bin\/id -u user\)" --regid="\$\(\/usr\/bin\/id -g user\)" --init-groups \/usr\/bin\/env PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin HOME=\/home\/user USER=user LOGNAME=user 'bash' '--noprofile' '--norc' '-c' /.test(run.cmd), run.cmd.slice(0, 240));
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
  const ordinary = shellFor('true', {}, { userBin: true }).args[3];
  check("  /etc/profile is read with no home to find the account's files from (ordinary)", ordinary.startsWith('_home="$HOME"; HOME=/nonexistent; source /etc/profile >/dev/null 2>&1 || true; HOME="$_home"; unset _home\n'), ordinary.slice(0, 120));
  // SBX-006: as root it is read as nobody, with no home either, so what it runs never runs as root.
  const asRoot = shellFor('true', {}, { root: true }).args[3];
  check("  (root) as nobody, with no home and nothing in the environment (SBX-006)", asRoot.startsWith('_seen="$(/usr/bin/timeout 5 /usr/bin/setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env -i HOME=/nonexistent /bin/bash --noprofile --norc -c \'source /etc/profile'), asRoot.slice(0, 160));
  check('  and the answer read the way the Vercel one is', done.exitCode === 0 && (await done.stdout()) === 'ok' && (await done.stderr()) === '');

  state.calls.length = 0;
  await machine.runCommand({ ...shellFor('apt-get install -y jq', {}, { root: true }), sudo: true, timeoutMs: 60_000 });
  const root = state.calls.find((c) => c.kind === 'run');
  // Not dropped to the account: its shell reads /etc/profile as nobody (SBX-006), which is not a drop.
  check('as_root stays root, still without a login profile', root.opts.user === 'root' && !root.cmd.includes('--reuid="$(') && !root.cmd.startsWith('exec /usr/bin/setpriv') && /^exec \/usr\/bin\/timeout -k 5 60 \/usr\/bin\/env PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin 'bash' '--noprofile' '--norc' '-c' /.test(root.cmd), root.cmd.slice(0, 120));
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

  // SBX-005: a file of several gigabytes was read whole into the server's memory before any size was checked.
  state.files['/home/user/dump.bin'] = 'x';
  state.sizes = { '/home/user/dump.bin': 3 * 1024 ** 3 };
  state.calls.length = 0;
  const huge = await machine.readFileToBuffer({ path: 'dump.bin' }).then(() => '', (e) => e.message);
  check('a file too large to read is refused by its size, before a byte is read (SBX-005)', /too large/i.test(huge) && !state.calls.some((c) => c.kind === 'read'), huge);
  state.sizes = {};
  const stop = new AbortController();
  await machine.readFileToBuffer({ path: 'out/a.txt', signal: stop.signal });
  check('  and a read carries the caller\'s deadline', state.calls.some((c) => c.kind === 'read' && c.opts?.signal === stop.signal));

  // SBX-005: `cat /dev/urandom | base64` grew one string in the server's memory until the instance fell over.
  state.calls.length = 0;
  state.onRun = async (_cmd, opts) => {
    opts.onStdout?.('x'.repeat(3 * 1024 * 1024));
    return { exitCode: 137, stdout: 'x'.repeat(3 * 1024 * 1024), stderr: '' };
  };
  const flood = await machine.runCommand({ ...shellFor('cat /dev/urandom | base64'), timeoutMs: 30_000 });
  const floodOut = await flood.stdout();
  state.onRun = null;
  check('output past the ceiling stops the command, and is cut with a note (SBX-005)', state.calls.some((c) => c.kind === 'killCommand') && floodOut.length < 2.2 * 1024 * 1024 && /stopped/i.test(floodOut.slice(-200)), `${floodOut.length} chars`);
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
  check('made from the template, named for the account, pausing when idle', create.template === e2b.TEMPLATE_NAME && create.opts.metadata.machine === 'synz-a' && create.opts.lifecycle?.onTimeout === 'pause' && create.opts.timeoutMs === 240_000, JSON.stringify({ ...create.opts, apiKey: undefined }));
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

    // HAR-007: one account keeping its machine awake could spend the whole month's pool for everybody.
    await store.createUser({ id: 'u-e2b-greedy', email: 'greedy@example.com', passwordHash: 'x', name: 'G', role: 'user' }).catch(() => {});
    process.env.E2B_ACCOUNT_SHARE = '0.001';
    try {
      const greedy = await e2b.e2bMachineFor('u-e2b-greedy', 'synz-greedy').then(() => '', (e) => e.name);
      check('an account past its share of the month is not given more of the pool (HAR-007)', greedy === 'E2BOutOfCredit', greedy || 'started');
    } finally {
      delete process.env.E2B_ACCOUNT_SHARE;
    }
    const fair = await e2b.e2bMachineFor('u-e2b-greedy', 'synz-greedy').then((m) => m.provider, (e) => e.name);
    check('  while within its share it starts as before', fair === 'e2b', fair);
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

section('a machine is closed once, before anything of the account\'s runs on it (SBX-011)');
{
  await resetCounters();
  await store.createUser({ id: 'u-e2b-close', email: 'close@example.com', passwordHash: 'x', name: 'C', role: 'user' });
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  let shimmedFirst = null;
  state.afterCreate = async (box) => {
    box.commands.rpc = { start: () => {} };
  };
  state.onRun = async (_cmd, opts) => {
    if (shimmedFirst === null) shimmedFirst = opts?.user === 'root' && Object.getOwnPropertySymbols(state.boxes.values().next().value.commands.rpc).length > 0;
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const runs = () => state.calls.filter((c) => c.kind === 'run');
  const closing = (c) => /chmod -R go-w \/usr\/local/.test(c.cmd);
  const machine = await e2b.e2bMachineFor('u-e2b-close', 'synz-close');
  const first = runs()[0];
  check('the first thing to run on a new machine closes it, as root', closing(first) && first.opts.user === 'root', first?.cmd?.slice(0, 80));
  check('  and with no login shell, already', shimmedFirst === true);
  check('  /usr/local becomes root\'s alone, links not followed', /\/usr\/bin\/chown -hR root:root \/usr\/local && \/usr\/bin\/chmod -R go-w \/usr\/local/.test(first.cmd));
  check('  the account loses its sudo: the line that gives it, and the group', /sed -i '\/\^user\[\[:space:\]\]\.\*NOPASSWD\/d' \/etc\/sudoers/.test(first.cmd) && /gpasswd -d user sudo/.test(first.cmd));
  check('  /etc/inittab, also left open, is closed', /chmod go-w \/etc\/inittab/.test(first.cmd));
  check('  and what the account\'s commands find stays: the system first, npm -g in its own folder', /PATH="\/usr\/bin:\/bin:\/usr\/games:\/usr\/local\/bin:\/usr\/local\/games"\|' \/etc\/profile/.test(first.cmd) && /'prefix=\$\{HOME\}\/\.local' > \/usr\/local\/etc\/npmrc/.test(first.cmd));
  const bare = first.cmd.replace(/'[^']*'/g, '').match(/(?:^|&&\s*|\{\s*|\|\|\s*)(chown|chmod|sed|gpasswd|mkdir|printf)\b/g) || [];
  check('  every program in it named by its full path, /usr/local being what is closed', bare.length === 0, bare.join(' | '));
  const record = await store.getUserSetting('u-e2b-close', e2b.__testing.SETTING);
  check('the record remembers', record?.closed === true, JSON.stringify(record));

  state.calls.length = 0;
  await machine.runCommand({ ...shellFor('true', {}, { userBin: true }), timeoutMs: 5_000 });
  await e2b.e2bMachineFor('u-e2b-close', 'synz-close');
  check('  so it is not done again, on a command or on a resume', !runs().some(closing));

  // A machine made before this, whose account has already had the run of it.
  await store.setUserSetting('u-e2b-close', e2b.__testing.SETTING, { ...record, closed: undefined });
  state.calls.length = 0;
  await e2b.e2bMachineFor('u-e2b-close', 'synz-close');
  check('a machine made before this is closed when it is next opened', runs().some(closing) && (await store.getUserSetting('u-e2b-close', e2b.__testing.SETTING))?.closed === true);

  // A failure leaves the machine usable, and is tried again.
  await store.setUserSetting('u-e2b-close', e2b.__testing.SETTING, { ...record, closed: undefined });
  state.onRun = async (cmd) => {
    if (/go-w \/usr\/local/.test(cmd)) throw new Error('no room');
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const stillThere = await e2b.e2bMachineFor('u-e2b-close', 'synz-close');
  check('one that could not be closed still opens, and is not remembered as closed', typeof stillThere.runCommand === 'function' && !(await store.getUserSetting('u-e2b-close', e2b.__testing.SETTING))?.closed);
  state.onRun = null;
  state.calls.length = 0;
  await e2b.e2bMachineFor('u-e2b-close', 'synz-close');
  check('  so the next time it is opened, it is tried again', runs().some(closing) && (await store.getUserSetting('u-e2b-close', e2b.__testing.SETTING))?.closed === true);

  state.calls.length = 0;
  await e2b.e2bScratch();
  check('a scratch machine is closed too', runs().some(closing));
  e2b.__testing.useSdk(null);
}

section('a command starts without a login shell, whoever it runs as (SBX-008)');
{
  /*
   * Live on E2B, 2026-11-03: a program an ordinary command put at
   * /usr/local/bin/id or .../mesg ran as uid 0 on the next command, because root's
   * login shell calls both by name on a PATH that begins in that writable folder.
   * The real SDK here, with no network: if an upgrade moves the line it builds
   * or the seam it hands it to, this goes red rather than the hole coming back.
   */
  const { Sandbox } = await import('e2b/dist/index.mjs');
  const box = new Sandbox({ sandboxId: 'offline', sandboxDomain: 'e2b.app', envdVersion: '0.4.0', envdAccessToken: 'x', apiKey: `e2b_${'x'.repeat(40)}` });
  const sent = [];
  box.commands.rpc = {
    start: (request) => {
      sent.push(request);
      throw new Error('captured, not run');
    },
  };
  check('the SDK this app pins still hands its line to commands.rpc.start', e2b.withoutLoginShell(box) === true);
  check('  and doing it twice, as a machine wrapped again does, is the same', e2b.withoutLoginShell(box) === true);
  await box.commands.run(e2b.commandLine({ cmd: 'bash', args: ['-c', 'true'] }), { user: 'root' }).catch(() => {});
  const proc = sent[0]?.process;
  check('  bash with no profile and no rc, never -l', proc?.cmd === '/bin/bash' && JSON.stringify(proc.args.slice(0, 3)) === '["--noprofile","--norc","-c"]' && !proc.args.includes('-l'), JSON.stringify(proc?.args?.slice(0, 3)));
  check('  and the line itself is passed on whole', /^exec \/usr\/bin\/setpriv /.test(proc?.args?.[3] || ''), proc?.args?.[3]);
  check("a SDK with no such seam is said, not assumed", e2b.withoutLoginShell({ commands: {} }) === false);

  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  state.calls.length = 0;
  const reached = [];
  let made = null;
  const before = sdk.Sandbox.create;
  sdk.Sandbox.create = async (...args) => {
    made = await before.apply(sdk.Sandbox, args);
    made.commands.rpc = { start: (request) => reached.push(request) };
    return made;
  };
  await e2b.e2bScratch();
  made.commands.rpc.start({ process: { cmd: '/bin/bash', args: ['-l', '-c', 'x'] } });
  check('every machine the app makes goes through it', reached[0]?.process?.args?.[0] === '--noprofile', JSON.stringify(reached[0]?.process?.args));
  sdk.Sandbox.create = before;
  e2b.__testing.useSdk(null);
}

section('a machine comes from the template, with nothing to set (owner, 2026-11-05)');
{
  await resetCounters();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  e2b.__testing.forgetMissingTemplate();
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const machine = await e2b.e2bMachineFor('u-e2b', 'synz-b');
  check('from the template by its own name, with no setting at all', state.calls.find((c) => c.kind === 'create').template === e2b.TEMPLATE_NAME);
  check('  said to be new, so the account\'s packages come back', machine.fresh === true);
  check('  and it knows its size, so what will not fit can be said at once', machine.memMb === 1024 && machine.cpu === 2);
  const saved = await store.getUserSetting('u-e2b', e2b.__testing.SETTING);
  check('  and which build it is from', saved.base === e2b.BASE_VERSION, JSON.stringify(saved));

  // E2B does not know the template: base rather than nothing, and asked again later.
  const missing = fakeSdk();
  e2b.__testing.useSdk(missing.sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const before = missing.sdk.Sandbox.create;
  missing.sdk.Sandbox.create = async (template, opts) => {
    if (template !== 'base') throw named('NotFoundError', `template ${template} not found`, { statusCode: 404 });
    return before.call(missing.sdk.Sandbox, template, opts);
  };
  const fallback = await e2b.e2bMachineFor('u-e2b', 'synz-c');
  check('a template E2B does not have is no reason to go without a machine', !!fallback.sandboxId);
  const noted = await store.getUserSetting('u-e2b', e2b.__testing.SETTING);
  check('  and that machine is written down as base', noted.base === 0, JSON.stringify(noted));
  missing.sdk.Sandbox.create = before;
  e2b.__testing.forgetMissingTemplate();
  e2b.__testing.useSdk(null);
}

section('a machine made from an older build moves, files and all (owner, 2026-11-05: 473 MiB for ever)');
{
  await resetCounters();
  e2b.__testing.forgetMissingTemplate();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const old = await sdk.Sandbox.create('base', { metadata: { app: 'synapsez', machine: 'synz-d' } });
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, { id: old.sandboxId, cpu: 2, memMb: 512, closed: true });
  state.files[`/tmp/synz-move-${old.sandboxId}.tgz`] = 'packed';
  state.calls.length = 0;
  const moved = await e2b.e2bMachineFor('u-e2b', 'synz-d');
  check('it is on a new machine', moved.sandboxId !== old.sandboxId, moved.sandboxId);
  check('  made from the current template', state.calls.find((c) => c.kind === 'create')?.template === e2b.TEMPLATE_NAME);
  const lines = state.calls.filter((c) => c.kind === 'run').map((c) => String(c.cmd));
  const packing = lines.find((line) => line.includes('tar czf'));
  check('  its home packed by the account, not by root', /setpriv/.test(packing || ''), packing);
  const unpacking = lines.find((line) => line.includes('tar xzf'));
  check('  and unpacked by the account', /setpriv/.test(unpacking || ''), unpacking);
  check('  fetched through a signed address, not through this server', state.calls.some((c) => c.kind === 'downloadUrl' && c.opts?.useSignatureExpiration > 0));
  check('  the old one is gone', !state.boxes.has(old.sandboxId));
  const record = await store.getUserSetting('u-e2b', e2b.__testing.SETTING);
  check('  and the record says so, with the size it really is', record.id === moved.sandboxId && record.base === e2b.BASE_VERSION && record.memMb === 1024, JSON.stringify(record));
  check('  and the model and the package list are told', moved.moved === true && moved.fresh === true);

  // Going wrong half way changes nothing.
  const { state: state2, sdk: sdk2 } = fakeSdk();
  e2b.__testing.useSdk(sdk2);
  const old2 = await sdk2.Sandbox.create('base', { metadata: { app: 'synapsez', machine: 'synz-e' } });
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, { id: old2.sandboxId, cpu: 2, memMb: 512, closed: true });
  state2.files[`/tmp/synz-move-${old2.sandboxId}.tgz`] = 'packed';
  state2.onRun = (cmd) => (String(cmd).includes('tar xzf') ? { exitCode: 2, stdout: '', stderr: 'broken' } : { exitCode: 0, stdout: 'ok', stderr: '' });
  const paidBefore = await store.readCounter(`free:e2b:${new Date().toISOString().slice(0, 7)}`);
  const stayed = await e2b.e2bMachineFor('u-e2b', 'synz-e');
  check('a move that fails half way leaves the old machine in use', stayed.sandboxId === old2.sandboxId && state2.boxes.has(old2.sandboxId));
  check('  and the half-made one gone', state2.boxes.size === 1, String(state2.boxes.size));
  const paidAfter = await store.readCounter(`free:e2b:${new Date().toISOString().slice(0, 7)}`);
  check('  and what it was paid for given back', paidAfter - paidBefore <= 20, `${paidBefore} → ${paidAfter}`);
  state2.calls.length = 0;
  await e2b.e2bMachineFor('u-e2b', 'synz-e');
  check('  and it is not tried again on the next call', !state2.calls.some((c) => c.kind === 'create'));
  e2b.__testing.useSdk(null);
}

section('a big file goes straight to the machine, on a link for one path (owner, 2026-11-05)');
{
  process.env.SESSION_SECRET ||= 'test-session-secret-for-the-e2b-suite';
  const { createApp } = await import('../server/app.js');
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  const server = (await createApp()).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, signedIn = true) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie && signedIn ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const made = await call('POST', '/api/register', { email: 'direct@example.com', password: 'a-long-enough-password', name: 'Direct' });
  check('an account to try it with', made.status < 300, JSON.stringify(made.json).slice(0, 160));

  check('nobody signed out gets a link', (await call('POST', '/api/attachments/direct', { name: 'a.zip', bytes: 10 }, false)).status === 401);
  check('it has to say how big', (await call('POST', '/api/attachments/direct', { name: 'a.zip' })).status === 400);
  check('and past the limit it is refused before a machine is woken', (await call('POST', '/api/attachments/direct', { name: 'a.zip', bytes: 3 * 1024 ** 3 })).status === 400);

  const started = await call('POST', '/api/attachments/direct', { name: 'Báo cáo (1).zip', mime: 'application/zip', bytes: 123 });
  check('a link comes back', started.status === 201 && /^https:\/\/files\.example\/up\//.test(started.json?.url || ''), JSON.stringify(started.json));
  check('  for a place only this upload uses, under its own name', /^uploads\/[0-9a-f]{8}\/Báo cáo \(1\)\.zip$/.test(started.json?.path || ''), started.json?.path);
  const signed = state.calls.find((c) => c.kind === 'uploadUrl');
  check('  signed for that one path, for the account, for a short while', signed?.path.endsWith(started.json.path) && signed?.opts?.user === 'user' && signed?.opts?.useSignatureExpiration <= 3600, JSON.stringify(signed?.opts));

  const sly = await call('POST', '/api/attachments/direct', { name: '../../../etc/passwd', bytes: 1 });
  check('a name cannot climb out', /^uploads\/[0-9a-f]{8}\/[^/]+$/.test(sly.json?.path || '') && !sly.json.path.split('/').includes('..'), sly.json?.path);

  check('finishing somewhere else is refused', (await call('POST', '/api/attachments/direct/finish', { path: '../../etc/passwd' })).status === 400);
  check('  or anywhere but an upload folder', (await call('POST', '/api/attachments/direct/finish', { path: '.ssh/authorized_keys' })).status === 400);
  const early = await call('POST', '/api/attachments/direct/finish', { path: started.json.path, mime: 'application/zip' });
  check('a file that never arrived makes no row', early.status === 400 && /did not reach/.test(early.json?.error || ''), JSON.stringify(early.json));

  state.files[signed.path] = 'PK';
  state.sizes = { [signed.path]: 123_456_789 };
  const done = await call('POST', '/api/attachments/direct/finish', { path: started.json.path, mime: 'application/zip' });
  check('once it is there, it is a file like any other', done.status === 201 && done.json?.attachment?.name === 'Báo cáo (1).zip', JSON.stringify(done.json));
  const row = await store.getAttachment((await store.getUserByEmail('direct@example.com')).id, done.json.attachment.id);
  check('  its size is what the machine says, not what the browser said', Number(row?.bytes) === 123_456_789, String(row?.bytes));
  check('  and its bytes stay on the machine', row?.origin === 'machine' && !row?.data && row?.source === started.json.path, JSON.stringify({ origin: row?.origin, source: row?.source }));

  const me = await store.getUserByEmail('direct@example.com');
  const shelf = await store.listDataFiles(me.id, { origin: 'upload' });
  check('it is listed with what the person sent', JSON.stringify(shelf).includes(done.json.attachment.id));
  const before = state.calls.length;
  const gone = await call('DELETE', `/api/data/uploads/${done.json.attachment.id}`);
  const removal = state.calls.slice(before).find((c) => c.kind === 'run' && /rm -f/.test(c.cmd));
  check('deleting it takes the row', gone.status === 200 && !(await store.getAttachment(me.id, done.json.attachment.id)));
  check('  and the bytes on the machine, with the path as a value and not as a command', !!removal && !removal.cmd.includes('Báo cáo') && removal.opts?.envs?.SYNZ_FILE === started.json.path, JSON.stringify({ cmd: removal?.cmd?.slice(0, 120), envs: removal?.opts?.envs }));
  await store.createAttachment(me.id, { id: 'made-on-machine', name: 'report.zip', mime: 'application/zip', kind: 'binary', bytes: 9, data: '', origin: 'machine', source: 'out/report.zip', chatId: null, thumb: null });
  check('something a command made is not this route\'s to delete', (await call('DELETE', '/api/data/uploads/made-on-machine')).status === 404);

  const boot = await call('GET', '/api/bootstrap');
  check('the browser is told it can', boot.json?.attachments?.direct === true && boot.json?.attachments?.directMaxBytes > boot.json?.attachments?.maxBytes);
  server.close();
  e2b.__testing.useSdk(null);
}

section('a long command does not pause under itself');
{
  await resetCounters();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const machine = await e2b.e2bMachineFor('u-e2b', 'synz-long');
  state.calls.length = 0;
  await machine.runCommand({ ...shellFor('sleep 1', {}, { userBin: true }), timeoutMs: 10_000 });
  check('a short one leaves the machine as it was', !state.calls.some((c) => c.kind === 'setTimeout'));
  await machine.runCommand({ ...shellFor('sleep 280', {}, { userBin: true }), timeoutMs: 300_000 });
  check('one longer than a machine stays awake keeps it awake', state.calls.some((c) => c.kind === 'setTimeout' && c.ms >= 300_000), JSON.stringify(state.calls.filter((c) => c.kind === 'setTimeout')));
  e2b.__testing.useSdk(null);
}

section('a machine goes with its account');
{
  await resetCounters();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const machine = await e2b.e2bMachineFor('u-e2b', 'synz-gone');
  const saved = await machine.saveCheckpoint('a note');
  state.calls.length = 0;
  await e2b.e2bForgetAccount('u-e2b');
  check('the machine is deleted, which pausing would never do', state.calls.some((c) => c.kind === 'kill' && c.id === machine.sandboxId));
  check('and its checkpoints', state.calls.some((c) => c.kind === 'deleteSnapshot' && c.id === saved.id), JSON.stringify(state.calls));
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  check('asking after a machine that is not there makes none', (await e2b.e2bExistingMachine('u-e2b')) === null);
  e2b.__testing.useSdk(null);
}

section('a machine that cannot get the template stays where it is');
{
  await resetCounters();
  e2b.__testing.forgetMissingTemplate();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const old = await sdk.Sandbox.create('base', { metadata: { app: 'synapsez', machine: 'synz-stay' } });
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, { id: old.sandboxId, cpu: 2, memMb: 512, closed: true, checkpoints: [{ id: 'snap-kept', at: Date.now() }] });
  state.files[`/tmp/synz-move-${old.sandboxId}.tgz`] = 'packed';
  const realCreate = sdk.Sandbox.create;
  sdk.Sandbox.create = async function create(template, opts) {
    if (template !== 'base') throw Object.assign(new Error('404: template not found'), { name: 'NotFoundError', statusCode: 404 });
    return realCreate.call(this, template, opts);
  };
  const stayed = await e2b.e2bMachineFor('u-e2b', 'synz-stay');
  check('moving to the same small machine is not a move', stayed.sandboxId === old.sandboxId, stayed.sandboxId);
  sdk.Sandbox.create = realCreate;
  e2b.__testing.forgetMissingTemplate();
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, { id: old.sandboxId, cpu: 2, memMb: 512, closed: true, checkpoints: [{ id: 'snap-kept', at: Date.now() }] });
  const moved = await e2b.e2bMachineFor('u-e2b', 'synz-stay');
  const record = await store.getUserSetting('u-e2b', e2b.__testing.SETTING);
  check('a real move keeps its checkpoints', moved.sandboxId !== old.sandboxId && record.checkpoints?.[0]?.id === 'snap-kept', JSON.stringify(record.checkpoints));
  e2b.__testing.useSdk(null);
}

section('a month on, a file sent straight to the machine goes, row and bytes');
{
  await resetCounters();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  await e2b.e2bMachineFor('u-e2b', 'synz-month');
  const row = async (id, source, days) => {
    await store.createAttachment('u-e2b', { id, name: 'a.zip', mime: 'application/zip', kind: 'binary', bytes: 9, data: '', origin: 'machine', source, chatId: null, thumb: null });
    await memory.query(`UPDATE attachments SET created_at = NOW() - INTERVAL '${days} days' WHERE id = '${id}'`);
  };
  await row('up-old', 'uploads/aaaaaaaa/a.zip', 31);
  await row('up-new', 'uploads/bbbbbbbb/b.zip', 3);
  await row('out-old', 'out/report.zip', 31);
  state.calls.length = 0;
  const { expireMachineUploads } = await import('../server/sandbox.js');
  await expireMachineUploads(store);
  const removed = state.calls.filter((c) => c.kind === 'run' && /rm -f/.test(c.cmd)).map((c) => c.opts?.envs?.SYNZ_FILE);
  check('the old one is off the machine', removed.join() === 'uploads/aaaaaaaa/a.zip', removed.join());
  check('  and its row gone', !(await store.getAttachment('u-e2b', 'up-old')));
  check('a recent one stays', !!(await store.getAttachment('u-e2b', 'up-new')));
  check('and so does something a command made', !!(await store.getAttachment('u-e2b', 'out-old')));
  e2b.__testing.useSdk(null);
}

section('a checkpoint');
{
  await resetCounters();
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  const machine = await e2b.e2bMachineFor('u-e2b', 'synz-f');
  const first = await machine.saveCheckpoint('before the upgrade');
  check('saved, with what it is', !!first.id && first.note === 'before the upgrade');
  await machine.saveCheckpoint('b');
  await machine.saveCheckpoint('c');
  await machine.saveCheckpoint('d');
  check('three are kept, and the oldest goes from E2B too', machine.listCheckpoints().length === 3 && state.calls.some((c) => c.kind === 'deleteSnapshot' && c.id === first.id));
  await machine.restoreCheckpoint(machine.listCheckpoints()[0].id).catch((err) => check('restore ran', false, err.message));
  const record = await store.getUserSetting('u-e2b', e2b.__testing.SETTING);
  check('going back makes a machine from it, and the account is on that one', record.id !== machine.sandboxId && state.boxes.has(record.id) && !state.boxes.has(machine.sandboxId), JSON.stringify(record));
  check('one that is not there is refused by name', await machine.restoreCheckpoint('nope').then(() => false, (err) => /no checkpoint nope/.test(err.message)));
  e2b.__testing.useSdk(null);
}

section('the credit, split evenly among whoever is using it (owner, 2026-11-05)');
{
  const share = (over) => tiers.e2bDayShare({ monthLeft: 3000, spentToday: 0, people: 0, usedToday: 0, daysLeft: 30, floor: 15, ...over });
  check("alone, an account gets all of today's part of what is left", share({}) === 100, String(share({})));
  check('with one other, half', share({ people: 1 }) === 50, String(share({ people: 1 })));
  check('counting itself once it has started', share({ people: 2, usedToday: 10 }) === 40, String(share({ people: 2, usedToday: 10 })));
  check('what was spent today is still part of today', share({ monthLeft: 2900, spentToday: 100, people: 2, usedToday: 50 }) === 0, String(share({ monthLeft: 2900, spentToday: 100, people: 2, usedToday: 50 })));
  check('a quiet start leaves more for later days', share({ monthLeft: 3000, daysLeft: 10 }) === 300);
  check('never below a few minutes of machine, however many are using it', share({ people: 1000 }) === 15);
  check('and past that, nothing', share({ people: 1000, usedToday: 15 }) === 0);

  await resetCounters();
  await memory.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:e2b:%'");
  const now = new Date();
  await store.createUser({ id: 'u-share', email: 'share@example.com', passwordHash: 'x', name: 'S', role: 'user' });
  const alone = await tiers.e2bAccountAllowance('u-e2b', now);
  await tiers.spend('e2b', 10, now);
  await tiers.e2bAccountSpend('u-e2b', 10, now);
  const other = await tiers.e2bAccountAllowance('u-share', now);
  check('a second account counts the first, and then itself', other.left <= Math.ceil(alone.left / 2) + 1 && other.left > 0, `${alone.left} → ${other.left}`);
  const peopleToday = () => store.readCounter(`free:e2b:day:${now.toISOString().slice(0, 10)}:people`);
  await tiers.e2bAccountSpend('u-e2b', -10, now);
  check('a start given back was nobody\'s first of the day', (await peopleToday()) === 0, String(await peopleToday()));
  await tiers.e2bAccountSpend('u-e2b', 10, now);
  check('giving back does not count somebody twice', (await peopleToday()) === 1, String(await peopleToday()));
}

/*
 * E2B holds one key (owner, 2026-11-12, spec A): the environment's, which every machine is
 * made with. It is in the pool so it has a state and may be the owner's paid key, so a
 * machine's time is counted through the pool on that key — and a charged one may go past the
 * free month on it, up to its cap, once spec B charges people.
 */
section('E2B: one key, counted through the pool on the environment\'s (spec A, owner 2026-11-12)');
{
  const pool = await import('../server/keyPool.js');
  const { state, sdk } = fakeSdk();
  e2b.__testing.useSdk(sdk);
  await resetCounters();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthBucket = `free:e2b:${thisMonth}`;
  const paidBucket = `paid:e2b@env:${thisMonth}`;
  const counted = async () => ({ month: await store.readCounter(monthBucket), credit: await store.readCounter('free:e2b:total'), paid: await store.readCounter(paidBucket) });
  // Six minutes of two vCPUs and 2 GiB, the size a scratch machine is assumed to be: 13.32 thousandths of a dollar, rounded up.
  const SCRATCH = 14;

  await pool.markKey('e2b', 'env', 'invalid');
  check('a key the pool holds refused is no key to start a machine with', !e2b.e2bConfigured() && e2b.e2bConfigured({ E2B_API_KEY: 'k' }));
  await pool.markKey('e2b', 'env', 'ok');
  check('  and back in use, it is one again', e2b.e2bConfigured());

  await e2b.e2bScratch();
  const made = state.calls.find((c) => c.kind === 'create');
  const first = await counted();
  check("a machine is made with the environment's key, its time counted on that key's month and credit", made?.opts.apiKey === process.env.E2B_API_KEY && first.month === SCRATCH && first.credit === SCRATCH && first.paid === 0, JSON.stringify(first));

  await tiers.exhaust('e2b');
  const unpaid = await e2b.e2bScratch().then(() => 'started', (err) => err.name);
  await pool.setPaidKey('e2b', 'env', 100);
  const charged = await e2b.e2bScratch({ paid: true }).then((m) => m.provider, (err) => err.name);
  const second = await counted();
  check('the free month spent: an uncharged machine is refused, a charged one goes on the paid key', unpaid === 'E2BOutOfCredit' && charged === 'e2b' && second.paid === SCRATCH, `${unpaid} ${charged} ${JSON.stringify(second)}`);
  check('  its time comes off the whole credit too, as every machine\'s does', second.credit === first.credit + SCRATCH, JSON.stringify(second));
  const still = await e2b.e2bScratch().then(() => 'started', (err) => err.name);
  check('  and an uncharged machine is still refused after it', still === 'E2BOutOfCredit', still);
  await pool.setPaidKey('e2b', 'env', SCRATCH + 5);
  const capped = await e2b.e2bScratch({ paid: true }).then(() => 'started', (err) => err.name);
  check("  past the paid key's monthly cap a charged machine is refused too, and nothing of it stays counted", capped === 'E2BOutOfCredit' && (await counted()).paid === SCRATCH && (await counted()).credit === second.credit, `${capped} ${JSON.stringify(await counted())}`);

  // An account's machine, charged: the option goes from the start to every extension of it.
  await pool.setPaidKey('e2b', 'env', 1_000);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  state.boxes.clear();
  const before = await counted();
  state.createError = named('RateLimitError', 'Rate limit exceeded', { statusCode: 429 });
  const busy = await e2b.e2bMachineFor('u-e2b', 'synz-paid', { paid: true }).then(() => '', (err) => err.name);
  state.createError = null;
  const given = await counted();
  check('a charged start that does not happen is given back — its paid count and the credit (HAR-010)', busy === 'RateLimitError' && given.paid === before.paid && given.credit === before.credit && given.month === before.month, JSON.stringify({ before, given }));
  const mine = await e2b.e2bMachineFor('u-e2b', 'synz-paid', { paid: true }).catch((err) => ({ provider: err.name, extendTimeout: async () => {} }));
  const started = await counted();
  await mine.extendTimeout(15 * 60_000);
  const kept = await counted();
  check('  a charged machine started, then kept awake longer, pays on the paid key each time', mine.provider === 'e2b' && started.paid > before.paid && kept.paid > started.paid, JSON.stringify({ before, started, kept }));

  await pool.setPaidKey('e2b', null);
  await store.setUserSetting('u-e2b', e2b.__testing.SETTING, null);
  e2b.__testing.useSdk(null);
  await resetCounters();
  await memory.query("DELETE FROM rate_limits WHERE bucket LIKE 'paid:e2b%'");
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll E2B checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
