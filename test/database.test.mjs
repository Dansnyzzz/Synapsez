/**
 * Which database driver, and moving from one database to another (2026-10-19).
 *
 * The free Neon project ran out of compute hours and the app moved to Supabase,
 * which is reached through a node-postgres pool rather than Neon's HTTP driver.
 * What this pins: the driver is chosen by host; TLS is always on and verified
 * when given the CA; a pooled transaction is all-or-nothing on one connection;
 * and `db:copy` carries every table across, JSON intact.
 *
 * There is no Supabase here — the pool is a stand-in and the databases are
 * in-process. What talking to a real pooler adds is checked live, not here.
 *
 *   node test/database.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'database-test-key';
process.env.SESSION_SECRET ||= 'database-test-secret';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { isNeonUrl, poolOptions, pgDriver, openDatabase } = await import('../server/store/driver.js');

section('the driver is chosen by where the database is');
{
  check('a Neon host is Neon', isNeonUrl('postgresql://u:p@ep-cool-name-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'));
  check('a Supabase pooler is not', !isNeonUrl('postgresql://postgres.abc:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres'));
  check('nor is a host that merely mentions neon', !isNeonUrl('postgresql://u:p@neon.tech.evil.example/db'));
  const neon = await openDatabase('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb', { env: {} });
  check('  Neon gets its own driver', typeof neon === 'function' && typeof neon.query === 'function');
  const pooled = await openDatabase('postgresql://postgres.abc:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', { env: {} });
  check('  anything else a pool, in the store\'s shape', typeof pooled.query === 'function' && typeof pooled.transaction === 'function');
  await pooled.end();
  const forced = await openDatabase('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb', { env: { DATABASE_DRIVER: 'pg' } });
  check('  and DATABASE_DRIVER settles it by hand', typeof forced.transaction === 'function' && typeof forced !== 'function');
  await forced.end();

  const { createPgStore } = await import('../server/store/pg.js');
  let asked = '';
  const fn = Object.assign(() => {}, { query: async (text) => ((asked = text), []) });
  createPgStore(fn).schemaStamp();
  check('the store takes a driver that is a function, as Neon\'s is', /FROM settings/.test(asked), asked);
}

section('TLS is always on, and verified when the CA is given');
{
  const url = 'postgresql://postgres.abc:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require';
  const plain = poolOptions(url, {});
  check('encrypted without the CA, but not claimed verified', plain.ssl && plain.ssl.rejectUnauthorized === false, JSON.stringify(plain.ssl));
  check('  sslmode is taken out of the string so it cannot overrule that', !/sslmode/.test(plain.connectionString), plain.connectionString);
  check('  one connection per instance, as Supabase asks of serverless', plain.max === 1);
  const pem = '-----BEGIN CERTIFICATE-----\\nMIIBfake\\n-----END CERTIFICATE-----';
  const verified = poolOptions(url, { DATABASE_CA_CERT: pem });
  check('with the CA, the server is verified', verified.ssl.rejectUnauthorized === true && verified.ssl.ca.includes('\nMIIBfake\n'), JSON.stringify(verified.ssl).slice(0, 80));
  check('a database on this machine is plain', poolOptions('postgresql://u:p@localhost:5432/db', {}).ssl === false);
  check('sslmode=disable is honoured', poolOptions('postgresql://u:p@db.example.com/db?sslmode=disable', {}).ssl === false);
}

section('a pooled query waits to be awaited, and a transaction is one connection');
{
  const log = [];
  const client = {
    async query(text, params) {
      log.push(`client:${text}${params?.length ? ` ${JSON.stringify(params)}` : ''}`);
      if (/boom/.test(text)) throw new Error('boom');
      return { rows: [{ text }] };
    },
    release() {
      log.push('release');
    },
  };
  const pool = {
    async query(text) {
      log.push(`pool:${text}`);
      return { rows: [{ ok: 1 }] };
    },
    async connect() {
      log.push('connect');
      return client;
    },
  };
  const db = pgDriver(pool);
  const a = db.query('SELECT 1');
  check('nothing runs until it is awaited', log.length === 0, log.join(' | '));
  const rows = await a;
  check('  then it runs, answering with the rows', rows[0]?.ok === 1 && log[0] === 'pool:SELECT 1', log.join(' | '));
  log.length = 0;
  await db.transaction([db.query('DELETE FROM t WHERE x = $1', [1]), db.query('INSERT INTO t VALUES ($1)', [2])]);
  check(
    'a transaction runs its queries on one connection, between BEGIN and COMMIT, and lets it go',
    log.join(' | ') === 'connect | client:BEGIN | client:DELETE FROM t WHERE x = $1 [1] | client:INSERT INTO t VALUES ($1) [2] | client:COMMIT | release',
    log.join(' | '),
  );
  log.length = 0;
  let failed = '';
  try {
    await db.transaction([db.query('INSERT 1'), db.query('boom'), db.query('INSERT 3')]);
  } catch (err) {
    failed = err.message;
  }
  check(
    'a failure rolls it all back and still lets the connection go',
    failed === 'boom' && log.join(' | ') === 'connect | client:BEGIN | client:INSERT 1 | client:boom | client:ROLLBACK | release',
    log.join(' | '),
  );
}

section('db:copy carries every table across, in an order the foreign keys allow');
{
  const { foreignKeyOrder, copyDatabase } = await import('../scripts/copy-database.js');
  const { order, cycle } = foreignKeyOrder(['messages', 'chats', 'users', 'a', 'b'], [
    { child: 'messages', parent: 'chats' },
    { child: 'chats', parent: 'users' },
    { child: 'a', parent: 'b' },
    { child: 'b', parent: 'a' },
  ]);
  check('parents before children', order.indexOf('users') < order.indexOf('chats') && order.indexOf('chats') < order.indexOf('messages'), order.join(','));
  check('  and a pair that refer to each other is named, not lost', cycle.join(',') === 'a,b' && order.includes('a'), cycle.join(','));

  const { PGlite } = await import('@electric-sql/pglite');
  const driverOf = (db) => ({ query: async (text, params = []) => (await db.query(text, params)).rows });
  const source = new PGlite();
  const target = new PGlite();
  const { createPgStore } = await import('../server/store/pg.js');
  const old = createPgStore(driverOf(source));
  await old.init();
  const user = await old.createUser({ id: 'u-copy', email: 'copy@example.com', name: 'Copy', passwordHash: 'x', role: 'user' });
  await old.createChat(user.id, { id: 'c-copy', title: 'Kept across', model: 'auto' });
  await old.appendMessage(user.id, 'c-copy', {
    id: 'm-copy',
    role: 'assistant',
    text: 'Đây là câu trả lời.',
    toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'figs/Figure_4.png' } }],
  });
  await old.createAttachment(user.id, { id: 'a-copy', name: 'Figure_4.png', mime: 'image/png', kind: 'image', bytes: 3, data: 'AAAA', origin: 'step', chatId: 'c-copy', thumb: null });

  const said = [];
  const copied = await copyDatabase(driverOf(source), driverOf(target), { say: (line) => said.push(line) });
  const moved = createPgStore(driverOf(target));
  const chat = await moved.getChat(user.id, 'c-copy');
  const messages = await moved.listMessages(user.id, 'c-copy');
  const file = await moved.getAttachment(user.id, 'a-copy');
  check('the account, its conversation and its file are all there', chat?.title === 'Kept across' && !!file && (await moved.getUserByEmail('copy@example.com'))?.id === user.id);
  check('  JSON arrives as JSON — a list of tool calls stays a list', Array.isArray(messages[0]?.toolCalls) && messages[0].toolCalls[0]?.input?.path === 'figs/Figure_4.png', JSON.stringify(messages[0]?.toolCalls));
  check('  and text in any language arrives whole', messages[0]?.text === 'Đây là câu trả lời.');
  check('it says how many rows each table took', copied.users === 1 && copied.messages === 1 && said.some((l) => /users: 1/.test(l)), JSON.stringify(copied));
  const again = await copyDatabase(driverOf(source), driverOf(target), { say: () => {} });
  const count = (await target.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
  check('running it again changes nothing — what is there is left as it is, and it says so', count === 1 && again.messages === 0, `${count} ${again.messages}`);
  await source.close();
  await target.close();
}

/**
 * Somebody signed up on the new database before the old one could be copied —
 * the same email, a new account (owner, 2026-10-20). The old account's rows go
 * to the account already there, and what was made since stays.
 */
section('db:copy merges an old account into the one with the same email');
{
  const { copyDatabase } = await import('../scripts/copy-database.js');
  const { PGlite } = await import('@electric-sql/pglite');
  const { createPgStore } = await import('../server/store/pg.js');
  const driverOf = (db) => ({ query: async (text, params = []) => (await db.query(text, params)).rows });
  const source = new PGlite();
  const target = new PGlite();
  const old = createPgStore(driverOf(source));
  const now = createPgStore(driverOf(target));
  await old.init();
  await now.init();
  await old.createUser({ id: 'u-neon', email: 'owner@example.com', name: 'Owner', passwordHash: 'x', role: 'admin' });
  await old.createChat('u-neon', { id: 'c-from-neon', title: 'Before the move', model: 'auto' });
  await old.appendMessage('u-neon', 'c-from-neon', { id: 'm-neon', role: 'user', text: 'Ghi chú cũ' });
  await old.setUserSetting('u-neon', 'prefs', { language: 'vi', defaultModel: 'old-model' });
  await old.setUserSetting('u-neon', 'memory_note', { text: 'kept from before' });
  await now.createUser({ id: 'u-supabase', email: 'owner@example.com', name: 'Owner', passwordHash: 'y', role: 'admin', username: 'owner.one' });
  await now.createChat('u-supabase', { id: 'c-since', title: 'Made since', model: 'auto' });
  await now.setUserSetting('u-supabase', 'prefs', { language: 'vi', defaultModel: 'new-model' });

  const said = [];
  await copyDatabase(driverOf(source), driverOf(target), { say: (line) => said.push(line) });
  const users = (await target.query("SELECT id, username FROM users WHERE email = 'owner@example.com'")).rows;
  check('one account, the one already there', users.length === 1 && users[0].id === 'u-supabase' && users[0].username === 'owner.one', JSON.stringify(users));
  const before = await now.getChat('u-supabase', 'c-from-neon');
  const messages = await now.listMessages('u-supabase', 'c-from-neon');
  check('  the old conversations are in it', before?.title === 'Before the move' && messages[0]?.text === 'Ghi chú cũ', JSON.stringify(before));
  check('  beside what was made since', (await now.getChat('u-supabase', 'c-since'))?.title === 'Made since');
  check('  a setting chosen since wins over the old one', (await now.getUserSetting('u-supabase', 'prefs'))?.defaultModel === 'new-model');
  check('  and one only the old account had comes across', (await now.getUserSetting('u-supabase', 'memory_note'))?.text === 'kept from before');
  check('it says which account it merged', said.some((l) => /owner@example\.com/.test(l) && /merged/i.test(l)), said.join(' | '));
  check('  and counts only what went in — the setting the target kept is not counted', said.some((l) => /user_settings: 1$/.test(l)), said.filter((l) => /user_settings/.test(l)).join(''));
  await source.close();
  await target.close();
}

console.log(failures === 0 ? '\n\x1b[32mAll database checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
