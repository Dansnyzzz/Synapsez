/**
 * Devices, pairing, and the new-model announcement.
 *
 * Three features that all turn on the same question — "is this the right
 * account?" — and all of which touch the one boundary this project treats as
 * non-negotiable: an account must never reach another account's computer.
 *
 * Pairing is the interesting one, because two of its endpoints are
 * unauthenticated. That is unavoidable (a computer that has never been paired
 * has nothing to authenticate with) and therefore worth pinning down hard: what
 * an unclaimed pairing can do, what a code is worth once spent, and what happens
 * when two people race for the same one.
 *
 *   node test/devices.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'devices-test-encryption-key';
process.env.SESSION_SECRET ||= 'devices-test-session-secret';
// Force the relay path. Without it the first account — an admin on a locally-run
// server — gets the in-process tools and never consults a paired device at all,
// which is correct behaviour and the wrong thing to be testing here.
process.env.WORKER_MODE = 'remote';
// Ask for the idle behaviour explicitly. It is off by default on a local server
// — where holding a connection costs nothing — and on by default on a
// deployment, where it is billed execution time. Naming it here tests the
// mechanism without having to pretend to be Vercel.
process.env.WORKER_IDLE_SLEEP_MS = '1500';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-devices-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();

/**
 * Whatever port is free, on loopback only.
 *
 * This was a fixed 5199 on every interface, and Windows hands out ports in that
 * range as the *source* of ordinary outgoing connections — an editor talking to
 * GitHub was holding it, and the suite failed with EADDRINUSE before a single
 * check ran, twice in a row, with nothing wrong in the code. Port 0 asks the
 * operating system for one nobody is using; nothing here needs to know which.
 */
const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body, headers = {}) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 120) };
      }
      return { status: res.status, json };
    },
  };
}

const anon = jar();
const alice = jar();
const bob = jar();

await alice.call('POST', '/api/register', {
  email: 'alice@example.com',
  password: 'a-long-enough-password',
  name: 'Alice',
});
await bob.call('POST', '/api/register', {
  email: 'bob@example.com',
  password: 'bobs-long-enough-password',
  name: 'Bob',
});

// ── the pairing code ────────────────────────────────────────────────
section('pairing codes');
{
  const { normaliseCode, pairingCode } = await import('../server/devices.js');

  const code = pairingCode();
  check('a code is ABCD-2K7M shaped', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);
  check(
    'and avoids the characters people misread',
    !/[IO01]/.test(code.replace('-', '')),
    code,
  );
  check('codes differ', new Set(Array.from({ length: 40 }, pairingCode)).size > 35);

  // Typed off a screen, so it has to survive being typed badly.
  check('lower case is accepted', normaliseCode('abcd-2k7m') === 'ABCD-2K7M');
  check('a missing dash is accepted', normaliseCode('ABCD2K7M') === 'ABCD-2K7M');
  check('spaces are accepted', normaliseCode(' ABCD 2K7M ') === 'ABCD-2K7M');
  check('the wrong length is refused', normaliseCode('ABCD') === null);
  check('nothing is refused', normaliseCode('') === null);
}

// ── what an unpaired computer can do ────────────────────────────────
section('an unclaimed pairing grants nothing');
let pairingId;
let pairingCodeValue;
{
  const started = await anon.call('POST', '/api/pair/start', {
    name: "Alice's laptop",
    info: { platform: 'win32 x64', workspace: 'D:\\projects' },
  });
  check('a computer may ask to be adopted', started.status === 201, `got ${started.status}`);
  check('and gets a code back', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(started.json?.code || ''), started.json?.code);
  check('with an expiry', started.json?.expiresInSec > 0, `${started.json?.expiresInSec}s`);

  pairingId = started.json.id;
  pairingCodeValue = started.json.code;

  const polled = await anon.call('GET', `/api/pair/poll?id=${pairingId}`);
  check('polling before anyone claims it says so', polled.json?.status === 'pending', JSON.stringify(polled.json));
  check('and hands out no token', !polled.json?.token);

  // The whole security argument: this request names no account and is attached
  // to none, so there is nothing for it to reach.
  const unknown = await anon.call('GET', '/api/pair/poll?id=not-a-real-pairing');
  check('an invented pairing id gets nothing', unknown.json?.status === 'unknown', JSON.stringify(unknown.json));

  const noSession = await anon.call('GET', '/api/devices');
  check('and the device list still needs a session', noSession.status === 401, `got ${noSession.status}`);
}

// ── claiming ────────────────────────────────────────────────────────
section('claiming a computer');
let laptopToken;
let laptopId;
{
  const wrong = await alice.call('POST', '/api/devices/pair', { code: 'ZZZZ-ZZZZ' });
  check('a code nobody is showing is refused', wrong.status === 400, `got ${wrong.status}`);

  const malformed = await alice.call('POST', '/api/devices/pair', { code: 'nope' });
  check('a malformed code is refused', malformed.status === 400, `got ${malformed.status}`);

  const claimed = await alice.call('POST', '/api/devices/pair', { code: pairingCodeValue });
  check('the right code pairs the computer', claimed.status === 201, JSON.stringify(claimed.json));
  check('and it keeps the name the machine gave', claimed.json?.device?.name === "Alice's laptop", claimed.json?.device?.name);
  check(
    'the browser is never given the token',
    !JSON.stringify(claimed.json).toLowerCase().includes('token'),
    JSON.stringify(claimed.json),
  );

  const collected = await anon.call('GET', `/api/pair/poll?id=${pairingId}`);
  check('the computer collects its token', collected.json?.status === 'paired', JSON.stringify(collected.json).slice(0, 80));
  check('and it is a real token', (collected.json?.token || '').length > 20);
  laptopToken = collected.json.token;
  laptopId = collected.json.deviceId;

  const again = await anon.call('GET', `/api/pair/poll?id=${pairingId}`);
  check('collected exactly once, then the row is gone', again.json?.status === 'unknown', JSON.stringify(again.json));

  const replay = await alice.call('POST', '/api/devices/pair', { code: pairingCodeValue });
  check('and the code cannot be spent twice', replay.status === 400, `got ${replay.status}`);
}

// ── every pairing is its own code ───────────────────────────────────
section('a code is never reused');
{
  const codes = [];
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const started = await anon.call('POST', '/api/pair/start', { name: `box-${i}` });
    codes.push(started.json.code);
    ids.push(started.json.id);
  }
  check('six pairings, six different codes', new Set(codes).size === 6, codes.join(' '));
  check('and six different ids', new Set(ids).size === 6);

  // The one already spent above must stay spent, whatever else is in flight.
  const replay = await bob.call('POST', '/api/devices/pair', { code: pairingCodeValue });
  check('a spent code stays spent', replay.status === 400, `got ${replay.status}`);

  // Claiming one of these must not disturb the others: each is its own offer.
  const claimed = await bob.call('POST', '/api/devices/pair', { code: codes[2] });
  check('claiming one works', claimed.status === 201, JSON.stringify(claimed.json).slice(0, 80));
  const other = await anon.call('GET', `/api/pair/poll?id=${ids[3]}`);
  check('and leaves the rest waiting', other.json?.status === 'pending', JSON.stringify(other.json));

  const spent = await alice.call('POST', '/api/devices/pair', { code: codes[2] });
  check('but that one cannot be claimed twice', spent.status === 400, `got ${spent.status}`);

  // Tidy up so later counts are predictable.
  const bobsBox = (await bob.call('GET', '/api/devices')).json.devices.find((d) => d.name === 'box-2');
  if (bobsBox) await bob.call('DELETE', `/api/devices/${bobsBox.id}`);
}

section('pairing does not care whose account it is');
{
  // The whole point of a code: the machine names nobody, so whoever is signed in
  // and holding it adopts it. A shared office computer, a colleague's laptop —
  // it is the person with the code who decides, which is what a code is for.
  const started = await anon.call('POST', '/api/pair/start', { name: 'Shared workstation' });
  const claimed = await bob.call('POST', '/api/devices/pair', { code: started.json.code });
  check("a second account can adopt a machine", claimed.status === 201, `got ${claimed.status}`);

  const bobs = (await bob.call('GET', '/api/devices')).json.devices;
  check('and it is theirs', bobs.some((d) => d.name === 'Shared workstation'));

  const alices = (await alice.call('GET', '/api/devices')).json.devices;
  check('not the other account\'s', !alices.some((d) => d.name === 'Shared workstation'));

  const box = bobs.find((d) => d.name === 'Shared workstation');
  await bob.call('DELETE', `/api/devices/${box.id}`);
}

section('the manual token path is gone');
{
  // One token per account meant adding a second computer silently cut off the
  // first, and it took a text editor and a restart. Pairing replaced it.
  const gone = await alice.call('POST', '/api/devices/token');
  check('generating an account-wide token is no longer offered', gone.status === 404, `got ${gone.status}`);

  const html = await (await fetch(`${base}/index.html`)).text();
  check('and the button is out of the interface', !/gen-worker-token/.test(html));
  /*
   * Pairing a computer is out of the interface altogether (2026-10-04): the
   * cloud computer and the sandbox do what a paired machine did, so the owner
   * asked for the Computers tab, the pairing sheet and the Workspace browser to
   * go. The routes above stay for a machine already paired.
   */
  check('no pairing sheet', !/id="pair"/.test(html));
  check('no Settings → Computers tab', !/data-tab="worker"/.test(html) && !/id="open-pair"/.test(html));
  check('nor a pairing chip in the header', !/id="pair-chip"/.test(html));
}

// ── the token works, and only for its owner ─────────────────────────
section('a device token is scoped to its account');
{
  const auth = { Authorization: `Bearer ${laptopToken}` };

  const beat = await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'win32 x64' } }, auth);
  check('the computer can check in', beat.status === 200, JSON.stringify(beat.json));
  check('and is told whose it is', beat.json?.account === 'alice@example.com', beat.json?.account);
  check('and what it is called', beat.json?.device === "Alice's laptop", beat.json?.device);

  const mine = await alice.call('GET', '/api/devices');
  check('it appears on the owner list', mine.json?.devices?.length === 1, `${mine.json?.devices?.length}`);
  check('as online', mine.json?.devices?.[0]?.online === true);
  check('with its platform', mine.json?.devices?.[0]?.platform === 'win32 x64', mine.json?.devices?.[0]?.platform);

  const theirs = await bob.call('GET', '/api/devices');
  check("and on nobody else's", theirs.json?.devices?.length === 0, `${theirs.json?.devices?.length}`);

  const stolen = await bob.call('DELETE', `/api/devices/${laptopId}`);
  check("another account cannot unpair it", stolen.status === 404, `got ${stolen.status}`);
  check(
    'and it is still there',
    (await alice.call('GET', '/api/devices')).json.devices.length === 1,
  );

  const garbage = await anon.call('POST', '/api/worker/heartbeat', { info: {} }, { Authorization: 'Bearer nonsense' });
  check('an invented token is refused', garbage.status === 401, `got ${garbage.status}`);
}

// ── more than one computer ──────────────────────────────────────────
section('an account can hold several computers');
{
  // The whole point: this used to invalidate the first machine.
  const started = await anon.call('POST', '/api/pair/start', {
    name: "Alice's desktop",
    info: { platform: 'linux x64' },
  });
  await alice.call('POST', '/api/devices/pair', { code: started.json.code });
  const collected = await anon.call('GET', `/api/pair/poll?id=${started.json.id}`);
  const desktopToken = collected.json.token;
  const desktopId = collected.json.deviceId;

  await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'linux x64' } }, {
    Authorization: `Bearer ${desktopToken}`,
  });

  const devices = (await alice.call('GET', '/api/devices')).json.devices;
  check('both are listed', devices.length === 2, `${devices.length}`);
  check('with different names', new Set(devices.map((d) => d.name)).size === 2);

  // And — the regression that made multi-device impossible before — the first
  // one still works.
  const stillAlive = await anon.call('POST', '/api/worker/heartbeat', { info: {} }, {
    Authorization: `Bearer ${laptopToken}`,
  });
  check(
    'pairing the second did not cut off the first',
    stillAlive.status === 200,
    `got ${stillAlive.status} — the old single-token scheme broke exactly here`,
  );

  // With two online, the assistant must act on one deliberately rather than
  // whichever polled first.
  const statusRes = await alice.call('GET', '/api/devices/status');
  const status = statusRes.json?.worker;
  check('the worker status answers', !!status, `${statusRes.status} ${JSON.stringify(statusRes.json).slice(0, 160)}`);
  check('the status names an active machine', !!status?.activeId, status?.activeId || 'none');
  check('and lists them both', status.machines?.length === 2, `${status.machines?.length}`);

  await alice.call('PUT', '/api/prefs', { activeDevice: laptopId });
  const switched = (await alice.call('GET', '/api/devices/status')).json.worker;
  check('the choice is honoured', switched.activeId === laptopId, switched.activeId);

  // A job is addressed, so the other machine must not be able to take it.
  await store.enqueueJob((await store.getUserByEmail('alice@example.com')).id, {
    id: 'job-for-laptop',
    chatId: null,
    tool: 'list_dir',
    input: { path: '.' },
    deviceId: laptopId,
  });
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  check(
    'the desktop cannot claim the laptop\'s job',
    (await store.claimJob(aliceId, desktopId)) === null,
  );
  check(
    'and the laptop can',
    (await store.claimJob(aliceId, laptopId))?.id === 'job-for-laptop',
  );

  // Unpairing must not leave work queued for a machine that will never answer.
  await store.enqueueJob(aliceId, {
    id: 'job-orphaned',
    chatId: null,
    tool: 'list_dir',
    input: {},
    deviceId: desktopId,
  });
  await alice.call('DELETE', `/api/devices/${desktopId}`);
  const orphan = await store.getJob(aliceId, 'job-orphaned');
  check('unpairing fails its queued jobs', orphan.status === 'error', orphan.status);
  check(
    'rather than leaving the agent to wait out the timeout',
    /unpaired/i.test(JSON.stringify(orphan.result)),
    JSON.stringify(orphan.result),
  );

  const revoked = await anon.call('POST', '/api/worker/heartbeat', { info: {} }, {
    Authorization: `Bearer ${desktopToken}`,
  });
  check('and its token stops working', revoked.status === 401, `got ${revoked.status}`);
  check(
    'while the other computer carries on',
    (await anon.call('POST', '/api/worker/heartbeat', { info: {} }, {
      Authorization: `Bearer ${laptopToken}`,
    })).status === 200,
  );
}

// ── changing where a computer works ─────────────────────────────────
section('the working folder is changed from the app');
{
  const auth = { Authorization: `Bearer ${laptopToken}` };

  const before = (await alice.call('GET', '/api/devices')).json.devices[0];
  check('a fresh device has no chosen folder', before.wanted === null, String(before.wanted));

  const relative = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'projects' });
  check('a relative path is refused', relative.status === 400, `got ${relative.status}`);
  check('and says what is wanted', /absolute path/i.test(relative.json?.error || ''), relative.json?.error);

  const tooLong = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, {
    path: `D:\\${'x'.repeat(500)}`,
  });
  check('an absurd path is refused', tooLong.status === 400, `got ${tooLong.status}`);

  const set = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'D:\\projects\\shop' });
  check('an absolute path is accepted', set.status === 200, JSON.stringify(set.json));
  check('and remembered', set.json?.device?.wanted === 'D:\\projects\\shop', set.json?.device?.wanted);

  // The reply to a heartbeat is the only channel to the machine — nothing on the
  // internet connects inward — so this is how the setting actually gets there.
  const beat = await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'win32 x64' } }, auth);
  check(
    'the machine is told on its next heartbeat',
    beat.json?.config?.workspace === 'D:\\projects\\shop',
    JSON.stringify(beat.json?.config),
  );

  // What it is really using, versus what it was asked to use.
  await anon.call('POST', '/api/worker/heartbeat', {
    info: { platform: 'win32 x64', workspace: 'D:\\projects\\shop' },
  }, auth);
  const adopted = (await alice.call('GET', '/api/devices')).json.devices[0];
  check('and reports back where it actually is', adopted.workspace === 'D:\\projects\\shop', adopted.workspace);
  check('with no complaint', !adopted.workspaceError, adopted.workspaceError);

  // A folder that is not there is the machine's problem to notice, and the app
  // has to show that rather than a path quietly not in use.
  await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'D:\\nope' });
  await anon.call('POST', '/api/worker/heartbeat', {
    info: { platform: 'win32 x64', workspace: 'D:\\projects\\shop', workspaceError: 'There is no folder at D:\\nope' },
  }, auth);
  const failed = (await alice.call('GET', '/api/devices')).json.devices[0];
  check('a bad folder surfaces as an error', /no folder/i.test(failed.workspaceError || ''), failed.workspaceError);
  check('and it keeps working where it was', failed.workspace === 'D:\\projects\\shop', failed.workspace);

  const cleared = await alice.call('PUT', `/api/devices/${laptopId}/workspace`, { path: '' });
  check('clearing it is allowed', cleared.status === 200, JSON.stringify(cleared.json));
  check('and hands the choice back to the machine', cleared.json?.device?.wanted === null, String(cleared.json?.device?.wanted));

  const theirs = await bob.call('PUT', `/api/devices/${laptopId}/workspace`, { path: 'D:\\mine' });
  check("another account cannot move somebody else's computer", theirs.status === 400, `got ${theirs.status}`);
}

// ── setting a computer up from a link ───────────────────────────────
//
// Pairing, run the other way: the token is minted by a signed-in person and
// carried to a machine, so nobody types an eight-character code. The direction
// is also what makes it dangerous — see the confirmation step below.
section('a computer can be set up from a one-line link');
{
  const noSession = await anon.call('POST', '/api/devices/enrolment');
  check('minting a setup link needs a session', noSession.status === 401, `got ${noSession.status}`);

  const made = await alice.call('POST', '/api/devices/enrolment');
  check('a signed-in person can mint one', made.status === 201, JSON.stringify(made.json).slice(0, 90));
  check('it comes with a command for Windows', /AIR_TOKEN=/.test(made.json?.windows || ''), made.json?.windows);
  check('and one for everything else', /AIR_TOKEN=/.test(made.json?.unix || ''), made.json?.unix);
  check('and says how long it lasts', made.json?.expiresInSec > 0, `${made.json?.expiresInSec}`);

  /**
   * The token is passed in the environment, never joined into the script body.
   * A script assembled by string-joining a parameter and then piped into `iex`
   * runs whatever that parameter contains.
   */
  check(
    'the token rides in an environment variable, not the script',
    /\$env:AIR_TOKEN='[^']+';/.test(made.json?.windows || ''),
    made.json?.windows,
  );

  const token = /AIR_TOKEN='([^']+)'/.exec(made.json.windows)[1];

  // Phase one: say whose account this is, and spend nothing. Somebody who
  // answers "no" must not have lost their token by asking the question.
  const preview = await anon.call('POST', '/api/pair/enrol', { token });
  check('asking whose account it is works without a session', preview.status === 200, `got ${preview.status}`);
  check('and names the account', preview.json?.account === 'alice@example.com', preview.json?.account);
  check('and hands out no token', !preview.json?.token, JSON.stringify(preview.json));

  const again = await anon.call('POST', '/api/pair/enrol', { token });
  check('asking twice is still allowed — it spends nothing', again.json?.account === 'alice@example.com');

  // Phase two: spend it.
  const redeemed = await anon.call('POST', '/api/pair/enrol', {
    token,
    confirm: true,
    name: 'Set-up box',
    info: { platform: 'linux x64' },
  });
  check('confirming pairs the computer', redeemed.status === 201, JSON.stringify(redeemed.json).slice(0, 90));
  check('and hands over a device token', (redeemed.json?.token || '').length > 20);
  check('named as the machine asked', redeemed.json?.name === 'Set-up box', redeemed.json?.name);

  const replay = await anon.call('POST', '/api/pair/enrol', { token, confirm: true });
  check('a token cannot be spent twice', replay.status === 400, `got ${replay.status}`);
  const stale = await anon.call('POST', '/api/pair/enrol', { token });
  check('and is gone even for the question', stale.status === 400, `got ${stale.status}`);

  const invented = await anon.call('POST', '/api/pair/enrol', { token: 'not-a-real-token', confirm: true });
  check('an invented token gets nothing', invented.status === 400, `got ${invented.status}`);

  // The machine it created belongs to the account that minted the link, and to
  // nobody else — the same boundary as every other route here.
  const mine = (await alice.call('GET', '/api/devices')).json.devices.find((d) => d.name === 'Set-up box');
  check('the computer lands on the right account', !!mine, mine ? mine.name : 'it is not in the list');
  const theirs = (await bob.call('GET', '/api/devices')).json.devices.find((d) => d.name === 'Set-up box');
  check("and on nobody else's", !theirs);

  /**
   * The token enrolment hands back has to actually authenticate.
   *
   * Nothing checked this end to end, and it is the whole point of the flow: a
   * setup that pairs a machine and then hands it a credential the server refuses
   * leaves the computer showing "offline — last seen never" while the row sits
   * in the list looking fine.
   */
  const workerAuth = { Authorization: `Bearer ${redeemed.json.token}` };
  const beat = await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'linux x64' } }, workerAuth);
  check('the token it returns is accepted by the relay', beat.status === 200, `got ${beat.status}`);
  check('and names the account it belongs to', beat.json?.account === 'alice@example.com', beat.json?.account);
  check('and the device row it belongs to', beat.json?.deviceId === redeemed.json.deviceId, beat.json?.deviceId);

  const jobs = await anon.call('GET', '/api/worker/jobs', null, workerAuth);
  check('and it can collect work', jobs.status === 200, `got ${jobs.status}`);

  // After a heartbeat the machine is no longer "last seen never".
  const seen = (await alice.call('GET', '/api/devices')).json.devices.find((d) => d.id === redeemed.json.deviceId);
  check('so the computer stops looking offline', !!seen?.lastSeen, String(seen?.lastSeen));
  check('and is reported online', seen?.online === true, String(seen?.online));

  if (mine) await alice.call('DELETE', `/api/devices/${mine.id}`);
}

// ── which computer the assistant acts on ────────────────────────────
section('the assistant works on the computer you are sitting at');
{
  const { workerStatus } = await import('../server/localTools.js');
  const aliceRow = await store.getUserByEmail('alice@example.com');
  const user = { id: aliceRow.id, role: 'user' };

  // Two machines, both answering. Without a hint this is a coin toss dressed up
  // as "most recent", which is how a file opens on the computer at home.
  await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'win32 x64' } }, {
    Authorization: `Bearer ${laptopToken}`,
  });
  const both = await workerStatus(user, {});
  check('at least one machine is online for this', both.online === true, JSON.stringify(both.machines));

  const hinted = await workerStatus(user, {}, laptopId);
  check('a hint picks that machine', hinted.activeId === laptopId, hinted.activeId);

  // An explicit choice is not something software may quietly override. "Always
  // use the one at home" is a real thing to want, and losing it silently is a
  // worse bug than picking the wrong machine.
  const pinned = await workerStatus(user, { activeDevice: laptopId }, 'some-other-machine');
  check('a pinned machine beats the hint', pinned.activeId === laptopId, pinned.activeId);

  // The hint arrives from a browser, and everything from a browser is something
  // somebody can type. It may only ever name a machine this account already owns.
  /**
   * The worker has to be *told* which row it is.
   *
   * It only ever learns a device id during pairing, so a machine that starts
   * with a token already saved keeps the random placeholder it generated at
   * boot — and that placeholder was what it handed to the browser as its
   * identity. It matched no device on the account, so the hint matched nothing
   * and the whole feature silently did nothing on every machine except one that
   * had *just* been paired. Found by curling the endpoint on a real worker.
   */
  const beat = await anon.call('POST', '/api/worker/heartbeat', { info: { platform: 'win32 x64' } }, {
    Authorization: `Bearer ${laptopToken}`,
  });
  check('a heartbeat tells the machine which device it is', beat.json?.deviceId === laptopId, beat.json?.deviceId);

  const workerSource = fs.readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  check('and the worker adopts it', /if \(res\?\.deviceId\)/.test(workerSource));
  check(
    'reporting nothing until it is confirmed',
    /identityConfirmed \? WORKER_ID : null/.test(workerSource),
    'an id that matches no device looks like the feature working while doing nothing',
  );

  const forged = await workerStatus(user, {}, 'a-device-belonging-to-someone-else');
  check(
    'a hint naming a machine on another account is ignored',
    forged.activeId !== 'a-device-belonging-to-someone-else',
    forged.activeId,
  );
  check('and it falls back rather than refusing to work', both.online === true);
}

// ── two things attaching to a real browser got wrong ────────────────
//
// Both were found by attaching to an actual Chrome started with
// --remote-debugging-port, and neither could have been found any other way:
// every mode looks fine until something is genuinely already open.
section('attaching to a browser that is already running');
{
  const source = fs.readFileSync(new URL('../worker/browser.js', import.meta.url), 'utf8');

  /**
   * **Reading must connect first.** `browser_tabs` and `browser_look` only
   * consulted whatever was already connected — which, in attach mode, was
   * nothing, because connecting used to happen inside `browser_open`. So the
   * two tools whose entire job is "tell me what is already open" answered "No
   * tabs are open" and "No page is open. Use browser_open first." against a
   * Chrome with a dozen tabs in front of the user. The model would then open a
   * new tab, which is exactly what attaching exists to avoid.
   */
  const body = (name) => {
    const at = source.indexOf(`async function ${name}(`);
    return at < 0 ? '' : source.slice(at, source.indexOf('\n}', at));
  };
  check('browser_tabs connects before answering', /ensureAttached\(s\)/.test(body('browserTabs')));
  check('and so does browser_look', /ensureAttached\(s\)/.test(body('browserLook')));
  check(
    'and only in attach mode — launching a browser to answer a question is a surprise',
    /mode !== 'attach'/.test(body('ensureAttached')),
  );

  /**
   * **Nothing of the user's is ever closed.** Verified against a live Chrome:
   * after `closeBrowser()` the browser was still serving on its debugging port
   * with every tab intact. These pin the three lines that make that true.
   */
  const closing = body('closeSession');
  check('closing in attach mode disconnects rather than closes', /const borrowed = mode === 'attach'/.test(closing));
  check('and never closes the context holding their tabs', /if \(borrowed\)/.test(closing));
  check(
    'and the last tab is refused outright',
    /mode === 'attach' && open\.length === 1/.test(body('browserCloseTab')),
  );
}

// ── a picture with every step, on both kinds of machine ─────────────
section('desktop steps carry a picture too');
{
  const desktop = fs.readFileSync(new URL('../worker/desktop.js', import.meta.url), 'utf8');

  // `reportOn` is the funnel every desktop action ends in, so this one line is
  // what puts a thumbnail on click, type, key, scroll, wait and close.
  check('every desktop action reports a shot', /return \{ text: describe\(snapshot, note\), shot: await stepShot\(\) \}/.test(desktop));

  // The tools that bypass `reportOn` because they describe a launch or a list.
  for (const name of ['desktopList', 'desktopFocus', 'desktopLaunch', 'desktopClose']) {
    const at = desktop.indexOf(`async function ${name}(`);
    const fn = at < 0 ? '' : desktop.slice(at, desktop.indexOf('\n}', at));
    check(`${name} does too`, /shot: await stepShot\(\)/.test(fn));
  }

  /**
   * The frame is reused rather than captured fresh, and that is a measurement,
   * not laziness: a one-off spawn of the capture host took 1516ms on Windows,
   * which would be added to every desktop action somebody is watching. The
   * camera is already running — every desktop tool calls `takeScreen` — and its
   * frames cost nothing to reuse.
   */
  check('the shot comes from the running camera', /latestFrame = \{ data: payload\.frame/.test(desktop));
  check('and is only used if it is newer than the action', /latestFrame\.at >= since/.test(desktop));
  check('with a bound on how long it will wait', /SHOT_WAIT_MS/.test(desktop));
}

// ── how long the job poll is held open ──────────────────────────────
//
// The long poll is what makes a tool call feel instant, and on a deployment it
// is also billed execution time — a worker left running overnight would spend a
// whole free tier waiting for nothing. So an idle account is answered at once
// and told how long to sleep; a busy one gets the full hold.
section('the job poll holds only while somebody is waiting');
{
  // A fresh account with no history, because "has this account had work
  // recently" is the whole question — and Alice has been queueing jobs
  // throughout this file, which would make her permanently busy.
  const cara = jar();
  await cara.call('POST', '/api/register', {
    email: 'cara@example.com',
    password: 'caras-long-enough-password',
    name: 'Cara',
  });
  const started = await anon.call('POST', '/api/pair/start', { name: "Cara's box" });
  await cara.call('POST', '/api/devices/pair', { code: started.json.code });
  const collected = await anon.call('GET', `/api/pair/poll?id=${started.json.id}`);
  const auth = { Authorization: `Bearer ${collected.json.token}` };
  const caraDeviceId = collected.json.deviceId;

  const at = Date.now();
  const idle = await anon.call('GET', '/api/worker/jobs', null, auth);
  const idleMs = Date.now() - at;

  check('an idle account is answered immediately', idleMs < 3000, `${idleMs}ms`);
  check('with no job', idle.json?.job === null, JSON.stringify(idle.json));
  check('and told how long to sleep', idle.json?.sleepMs === 1500, JSON.stringify(idle.json));

  // Queue something, and the account is busy: the hold comes back, because now
  // there is a person on the other end watching a spinner.
  const caraId = (await store.getUserByEmail('cara@example.com')).id;
  await store.enqueueJob(caraId, {
    id: 'job-poll-test',
    chatId: null,
    tool: 'read_file',
    input: { path: 'x.txt' },
    deviceId: caraDeviceId,
  });

  const claimed = await anon.call('GET', '/api/worker/jobs', null, auth);
  check('a queued job is handed over', claimed.json?.job?.id === 'job-poll-test', JSON.stringify(claimed.json));
  check('and no sleep is suggested alongside it', claimed.json?.sleepMs === undefined, JSON.stringify(claimed.json));

  // Recent work means the next poll is a real long poll rather than an instant
  // "go away". Not waited out in full here — the point is only that it does not
  // come back at once with a sleep.
  const busy = await Promise.race([
    anon.call('GET', '/api/worker/jobs', null, auth),
    new Promise((r) => setTimeout(() => r({ heldOpen: true }), 2500)),
  ]);
  check('and the next poll is held open rather than deflected', busy.heldOpen === true, JSON.stringify(busy));

  const noToken = await anon.call('GET', '/api/worker/jobs');
  check('the queue still needs a device token', noToken.status === 401, `got ${noToken.status}`);

  /*
   * A running job can hear that it was called off (AUTO-009).
   *
   * There was no channel: the worker ran a claimed job to completion, and a
   * person pressing stop only made the server stop waiting. The worker now asks
   * for the job's status while it runs, and these pin the three things that make
   * that trustworthy — it sees the cancellation, a late result cannot erase it,
   * and it cannot be used to look at another account's work.
   */
  const running = await anon.call('GET', '/api/worker/jobs/job-poll-test', null, auth);
  check('a claimed job reports itself running', running.json?.status === 'running', JSON.stringify(running.json));

  await store.completeJob(caraId, 'job-poll-test', {
    status: 'cancelled',
    result: { error: 'Cancelled by the user.' },
    onlyIfOpen: true,
  });
  const told = await anon.call('GET', '/api/worker/jobs/job-poll-test', null, auth);
  check('  and reports the cancellation once the server records it', told.json?.status === 'cancelled', JSON.stringify(told.json));

  await anon.call('POST', '/api/worker/jobs/job-poll-test/result', { output: 'finished anyway' }, auth);
  const kept = await store.getJob(caraId, 'job-poll-test');
  check('  and a result that arrives after the stop does not overwrite it', kept?.status === 'cancelled', kept?.status);

  const missing = await anon.call('GET', '/api/worker/jobs/no-such-job', null, auth);
  check('an unknown job is a 404', missing.status === 404, `got ${missing.status}`);

  const dan = jar();
  await dan.call('POST', '/api/register', { email: 'dan-cancel@example.com', password: 'dans-long-enough-password', name: 'Dan' });
  const danStart = await anon.call('POST', '/api/pair/start', { name: "Dan's box" });
  await dan.call('POST', '/api/devices/pair', { code: danStart.json.code });
  const danToken = (await anon.call('GET', `/api/pair/poll?id=${danStart.json.id}`)).json.token;
  const peek = await anon.call('GET', '/api/worker/jobs/job-poll-test', null, { Authorization: `Bearer ${danToken}` });
  check("another account's machine cannot see this job — 404, not its status", peek.status === 404, `got ${peek.status}`);
}

// ── the picture a step comes back with ──────────────────────────────
section('a step thumbnail is stored, not inlined');
{
  const { keepStepShot } = await import('../server/attachments.js');

  // A 1×1 JPEG is enough: what is being tested is the plumbing and the limits,
  // not the encoder.
  const tiny =
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

  const aliceUserId = (await store.getUserByEmail('alice@example.com')).id;
  const kept = await keepStepShot(aliceUserId, { mime: 'image/jpeg', data: tiny });
  check('a thumbnail is kept', !!kept?.id, JSON.stringify(kept));
  // Only the id travels on. Inlining base64 would put megabytes into every
  // transcript that gets read back on load.
  check('and only its id travels on', Object.keys(kept).join(',') === 'id', Object.keys(kept).join(','));

  const fetched = await alice.call('GET', `/api/attachments/${kept.id}`);
  check('it is fetchable by its owner', fetched.status === 200, `got ${fetched.status}`);
  const notTheirs = await bob.call('GET', `/api/attachments/${kept.id}`);
  check('and by nobody else', notTheirs.status === 404 || notTheirs.status === 403, `got ${notTheirs.status}`);

  const huge = await keepStepShot(aliceUserId, { mime: 'image/jpeg', data: 'A'.repeat(200_000) });
  check('an oversized one is dropped rather than stored', huge === null, JSON.stringify(huge));
  // Dropped, never thrown: the step itself succeeded, and failing a completed
  // browser action over a missing illustration would make the assistant redo
  // work it has already done.
  check('and a missing one is not an error', (await keepStepShot(aliceUserId, null)) === null);
}

section('set_workspace asks first');
{
  const { assessRisk, riskReason, TOOLS_BY_NAME } = await import('../server/tools/definitions.js');

  check('the tool is offered', !!TOOLS_BY_NAME.set_workspace);
  check('it runs on the machine', TOOLS_BY_NAME.set_workspace.scope === 'local');
  check('and is not read-only', TOOLS_BY_NAME.set_workspace.readOnly === false);

  // Moving the boundary the file tools are confined to is the user's call, not
  // something the assistant settles on its own along the way.
  check(
    'moving the workspace always stops for a yes',
    assessRisk('set_workspace', { path: 'D:\\projects' }) === 'sensitive',
    assessRisk('set_workspace', { path: 'D:\\projects' }),
  );
  check(
    'and says where it is going',
    /D:\\projects/.test(riskReason('set_workspace', { path: 'D:\\projects' }) || ''),
    riskReason('set_workspace', { path: 'D:\\projects' }),
  );

  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');
  check('the worker implements it', typeof LOCAL_IMPLEMENTATIONS.set_workspace === 'function');
}

// ── a new model has arrived ─────────────────────────────────────────
section('new-model announcement');
{
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();

  // Already in the library before anybody looked: this must never be announced,
  // whatever its release date, or the first sign-in is a stack of catch-up.
  await store.upsertModels([
    {
      id: 'openrouter/nobody/ancient-model',
      provider: 'openrouter',
      model: 'nobody/ancient-model',
      family: 'nobody',
      label: 'Ancient Model',
      context: 4096,
      priceIn: 1,
      priceOut: 1,
      isFree: false,
      releasedAt: old,
    },
    {
      id: 'openrouter/google/pre-existing-gemini',
      provider: 'openrouter',
      model: 'google/pre-existing-gemini',
      family: 'google',
      label: 'Pre-existing Gemini',
      context: 1_000_000,
      priceIn: 2,
      priceOut: 8,
      isFree: false,
      releasedAt: recent,
    },
  ]);

  // The notice follows the list: the newest model in the tier, the day it is
  // there — including on the first look. Never the ancient one.
  const firstLook = await alice.call('GET', '/api/models/news');
  check(
    'the newest in the list is announced, first look included',
    firstLook.json?.model?.id === 'openrouter/google/pre-existing-gemini',
    firstLook.json?.model?.id || 'none',
  );
  // Once it has been on screen, the same top of the list is not news tomorrow.
  await alice.call('POST', '/api/models/news', { id: 'openrouter/google/pre-existing-gemini', action: 'shown' });
  check('and once shown, not again while it is still the newest', (await alice.call('GET', '/api/models/news')).json?.model === null);
  await bob.call('POST', '/api/models/news', { id: 'openrouter/google/pre-existing-gemini', action: 'shown' });

  // Now something genuinely arrives.
  await store.upsertModels([
    {
      id: 'openrouter/anthropic/claude-fictional-9',
      provider: 'openrouter',
      model: 'anthropic/claude-fictional-9',
      family: 'anthropic',
      label: 'Claude Fictional 9',
      description: 'A model invented by the test suite.',
      context: 500_000,
      priceIn: 4,
      priceOut: 20,
      isFree: false,
      releasedAt: recent,
    },
  ]);

  const news = await alice.call('GET', '/api/models/news');
  check('a model that arrives afterwards is announced', news.json?.model?.id === 'openrouter/anthropic/claude-fictional-9', news.json?.model?.id || 'none');

  const m = news.json.model;
  check('with the vendor named', m.vendor === 'Claude', m.vendor);
  check('the context window', m.context === 500_000, String(m.context));
  // As charged: the provider's $4 / $20 plus the service's ten percent.
  check('the price, as charged', m.price?.in === 4.4 && m.price?.out === 22, JSON.stringify(m.price));
  check('the release date', !!m.releasedAt);
  check('and what it is', /invented by the test suite/.test(m.description || ''), m.description);

  check('the same news is waiting for another account', (await bob.call('GET', '/api/models/news')).json?.model?.id === m.id);

  // Declining is a decision, and decisions are not re-litigated.
  const declined = await alice.call('POST', '/api/models/news', { id: m.id, action: 'decline' });
  check('declining is accepted', declined.status === 200, JSON.stringify(declined.json).slice(0, 80));
  check('and does not change the default model', declined.json?.prefs?.defaultModel !== m.id, declined.json?.prefs?.defaultModel);
  check('asked once per account', (await alice.call('GET', '/api/models/news')).json?.model === null);

  // Alice's decision is Alice's. Checked against the stored state rather than by
  // re-asking, because what is on trial is whose record was written — and reading
  // it directly says that, where a second GET would only say what Bob is offered.
  const bobId = (await store.getUserByEmail('bob@example.com')).id;
  const bobState = await store.getUserSetting(bobId, 'modelNews');
  check(
    "one person's answer is not recorded against another",
    !bobState?.seen?.[m.id],
    JSON.stringify(bobState?.seen || {}),
  );
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  const aliceState = await store.getUserSetting(aliceId, 'modelNews');
  check('while her own is', aliceState?.seen?.[m.id]?.action === 'decline', JSON.stringify(aliceState?.seen?.[m.id]));

  // Applying is the point of the button: being told and then having to go
  // hunting in a picker is a half-finished feature.
  const applied = await bob.call('POST', '/api/models/news', { id: m.id, action: 'apply' });
  check('applying sets it as the default', applied.json?.prefs?.defaultModel === m.id, applied.json?.prefs?.defaultModel);
  check('and is also only asked once', (await bob.call('GET', '/api/models/news')).json?.model === null);

  check(
    'an older model is never offered in place of the newest',
    (await alice.call('GET', '/api/models/news')).json?.model === null,
    'the newest was answered; nothing below it is news',
  );

  // A model somebody is already on is not news to them, however new it is.
  await store.upsertModels([
    {
      id: 'openrouter/anthropic/claude-fictional-10',
      provider: 'openrouter',
      model: 'anthropic/claude-fictional-10',
      family: 'anthropic',
      label: 'Claude Fictional 10',
      context: 500_000,
      priceIn: 4,
      priceOut: 20,
      isFree: false,
      releasedAt: new Date().toISOString(),
    },
  ]);
  await alice.call('PUT', '/api/prefs', { defaultModel: 'openrouter/anthropic/claude-fictional-10' });
  check('the model already in use is not announced', (await alice.call('GET', '/api/models/news')).json?.model === null);
  check('  while somebody not on it is told', (await bob.call('GET', '/api/models/news')).json?.model?.id === 'openrouter/anthropic/claude-fictional-10');

  const bogus = await alice.call('POST', '/api/models/news', { id: 'made/up', action: 'apply' });
  check('a model that is not in the library cannot become a default', bogus.status === 400, `got ${bogus.status}`);

  const nonsense = await alice.call('POST', '/api/models/news', { id: m.id, action: 'sideways' });
  check('and neither is a made-up decision', nonsense.status === 400, `got ${nonsense.status}`);

  check('the announcement needs a session', (await anon.call('GET', '/api/models/news')).status === 401);
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n[32mAll device and announcement checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
