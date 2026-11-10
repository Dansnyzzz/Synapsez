/**
 * The email that says an event's theme is out (owner, 2026-11-08): when it goes, what
 * it says, and that nobody sees anybody else's address.
 *
 *   node test/event-mail.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'event-mail-encryption-key';
process.env.SESSION_SECRET ||= 'event-mail-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-event-mail-${process.pid}`);
process.env.EVENT_MAIL_BATCH = '2';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { eventEmail, eventsToAnnounce, sweepEventMail } = await import('../server/eventMail.js');
const { AURORA_EVENT, NEW_YEAR_EVENT } = await import('../server/themes.js');
const { setPrefs } = await import('../server/settings.js');

section('when an event is announced: when its theme comes out, three days before it starts');
{
  const ids = (when) => eventsToAnnounce(new Date(when)).map((t) => t.id).join();
  check('nothing in November', ids('2026-11-08T12:00:00+07:00') === '');
  check('the aurora from the 21st of December', ids('2026-12-21T00:00:00+07:00') === 'aurora-peak' && ids('2026-12-20T23:59:00+07:00') === '');
  check('both from the 29th', ids('2026-12-29T00:00:00+07:00') === 'new-year-fireworks,aurora-peak', ids('2026-12-29T00:00:00+07:00'));
  check('the aurora no more once it is over', ids('2027-01-02T00:00:00+07:00') === 'new-year-fireworks');
}

section('what the email says, in the owner\'s shape');
{
  const mail = eventEmail({ themeId: 'aurora-peak', event: AURORA_EVENT, language: 'vi', baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('the subject names the theme', /Cực quang/.test(mail.subject), mail.subject);
  check('the moving picture comes first', mail.html.indexOf('/assets/scenes/aurora-peak.gif') > -1 && mail.html.indexOf('/assets/scenes/aurora-peak.gif') < mail.html.indexOf('Nhiệm vụ'));
  check('then the description, the mission and how many', /Nhiệm vụ:<\/strong> dùng 2\.000\.000 token từ 24\/12\/2026 đến 31\/12\/2026/.test(mail.html) && /Số lượng:<\/strong> 100 suất \(100 người đầu tiên hoàn thành nhiệm vụ\)/.test(mail.html), mail.text);
  check('and how to stop them, in the plain text too', /#settings\/general/.test(mail.text) && /#settings\/general/.test(mail.html));
  const english = eventEmail({ themeId: 'new-year-fireworks', event: NEW_YEAR_EVENT, language: 'en', baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('in English for English readers', /Mission:<\/strong> use 2,000,000 tokens from 1\/1\/2027 to 1\/7\/2027/.test(english.html), english.text.split('\n').find((l) => l.startsWith('- Mission')));
}

section('sending: in Bcc, by language, once each, and the opt-out holds');
{
  const make = async (id, language, extra = {}) => {
    await store.createUser({ id, email: `${id}@example.com`, name: id, passwordHash: 'x', role: 'user' });
    await store.markEmailVerified(id);
    await setPrefs(id, { language, ...extra });
  };
  await make('va', 'vi');
  await make('vb', 'vi');
  await make('vc', 'vi');
  await make('ea', 'en');
  await make('out', 'vi', { eventMail: false });
  const sent = [];
  const send = async (message) => {
    sent.push(message);
    return { ok: true };
  };
  const when = new Date('2026-12-21T09:00:00+07:00');
  const first = await sweepEventMail({ now: when, store, send, baseUrl: 'https://synapsez.example', backend: 'smtp' });
  const everyone = sent.flatMap((m) => m.bcc);
  check('everybody who did not opt out is told', ['va', 'vb', 'vc', 'ea'].every((id) => everyone.includes(`${id}@example.com`)) && first.sent === 4, everyone.join());
  check('  and not the one who did', !everyone.includes('out@example.com'));
  check('  nobody in To or Cc: each address only in Bcc', sent.every((m) => m.to === null && !m.cc));
  check('  in batches no larger than asked', sent.every((m) => m.bcc.length <= 2), sent.map((m) => m.bcc.length).join());
  check('  one language a message', sent.every((m) => (m.bcc.includes('ea@example.com') ? m.bcc.length === 1 && /event theme/i.test(m.subject) : /Theme sự kiện/.test(m.subject))));
  check('  through Gmail when it is set up', sent.every((m) => m.prefer === 'smtp'));
  sent.length = 0;
  await sweepEventMail({ now: when, store, send, baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('told once: the next sweep sends nothing', sent.length === 0);
  await make('late', 'vi');
  let refuse = true;
  const flaky = async (message) => {
    sent.push(message);
    if (refuse) return { ok: false };
    return { ok: true };
  };
  await sweepEventMail({ now: when, store, send: flaky, baseUrl: 'https://synapsez.example', backend: 'smtp' });
  refuse = false;
  sent.length = 0;
  await sweepEventMail({ now: when, store, send: flaky, baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('a batch the provider refused is sent again next time', sent.length === 1 && sent[0].bcc.join() === 'late@example.com', JSON.stringify(sent.map((m) => m.bcc)));

  // An address nobody confirmed may be anybody's (owner, 2026-11-09).
  await store.createUser({ id: 'typed', email: 'typed@example.com', name: 'typed', passwordHash: 'x', role: 'user' });
  sent.length = 0;
  await sweepEventMail({ now: when, store, send, baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('an address that was never confirmed is not written to', !sent.flatMap((m) => m.bcc).includes('typed@example.com'), JSON.stringify(sent.map((m) => m.bcc)));
  await store.markEmailVerified('typed');
  sent.length = 0;
  await sweepEventMail({ now: when, store, send, baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('  and is, once it is', sent.flatMap((m) => m.bcc).includes('typed@example.com'));
}

section('no provider, no send, and nobody marked as told (review, 2026-11-09)');
{
  const asked = [];
  const quiet = await sweepEventMail({ now: new Date('2026-12-29T09:00:00+07:00'), store, send: async (m) => (asked.push(m), { ok: true }), baseUrl: 'https://synapsez.example', backend: 'console' });
  check('with no mail set up, nothing is sent', asked.length === 0 && quiet.sent === 0);
  const later = [];
  await sweepEventMail({ now: new Date('2026-12-29T09:00:00+07:00'), store, send: async (m) => (later.push(m), { ok: true }), baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('  so the fireworks still reach everyone once it is', later.flatMap((m) => m.bcc).length >= 5, String(later.flatMap((m) => m.bcc).length));
}

section('two sweeps at once send each person once (review, 2026-11-09)');
{
  for (const id of ['c1', 'c2', 'c3']) {
    await store.createUser({ id, email: `${id}@example.com`, name: id, passwordHash: 'x', role: 'user' });
    await store.markEmailVerified(id);
  }
  const sent = [];
  const slow = async (m) => {
    sent.push(...m.bcc);
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true };
  };
  const when = new Date('2026-12-30T09:00:00+07:00');
  await Promise.all([1, 2].map(() => sweepEventMail({ now: when, store, send: slow, baseUrl: 'https://synapsez.example', backend: 'smtp' })));
  const counts = ['c1', 'c2', 'c3'].map((id) => sent.filter((a) => a === `${id}@example.com`).length);
  check('nobody gets the same email twice', counts.every((n) => n === 2), counts.join());
}

section('a Vietnamese clock reads Vietnamese before a language is chosen');
{
  await store.createUser({ id: 'clock', email: 'clock@example.com', name: 'clock', passwordHash: 'x', role: 'user' });
  await store.markEmailVerified('clock');
  await setPrefs('clock', { timezone: 'Asia/Ho_Chi_Minh' });
  const got = [];
  await sweepEventMail({ now: new Date('2026-12-30T10:00:00+07:00'), store, send: async (m) => (got.push(m), { ok: true }), baseUrl: 'https://synapsez.example', backend: 'smtp' });
  check('in Vietnamese', got.some((m) => m.bcc.includes('clock@example.com') && /Theme sự kiện/.test(m.subject)), JSON.stringify(got.map((m) => [m.subject, m.bcc])));
}

removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mEvent emails go as they should.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
