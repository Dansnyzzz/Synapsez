/**
 * One step at a time, and nothing twice (owner, 2026-11-04).
 *
 * The report: a failed `update_file` and a `read_generated_file` of the same file,
 * asked for together, ran together, 453 ms each, twice over: the read handed back a
 * file the write had not changed. And a finished file went out without anybody
 * having looked at it. The rules live in server/stepOrder.js and server/fileLook.js;
 * the last section drives the real loop with a scripted model and a real store.
 *
 *   node test/step-order.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'step-order-test-key';
process.env.SESSION_SECRET ||= 'step-order-test-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-step-order-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const { batchSegments, createStepGuard, skippedAfterFailure } = await import('../server/stepOrder.js');
const { readItAgainNote, withLookedPictures, lookAfterWriting, pictureNote, MAX_LOOKS_PER_TURN } = await import('../server/fileLook.js');
const { calculate } = await import('../server/tools/calc.js');

const call = (name, input = {}, id = name) => ({ id, name, input });

section('reads go side by side, every change goes alone and in order');
{
  const shape = (calls) => batchSegments(calls).map((s) => `${s.alone ? 'A' : 'P'}${s.calls.length}`).join(' ');
  check('three reads are one group', shape([call('web_fetch'), call('web_search'), call('calculate')]) === 'P3');
  check('a write then a read of what it wrote: the read waits', shape([call('update_file'), call('read_generated_file')]) === 'A1 P1');
  check('two writes do not overlap', shape([call('create_file'), call('update_file')]) === 'A1 A1');
  check('reads around a write stay on their side of it', shape([call('web_fetch'), call('web_fetch', {}, 'b'), call('run_command'), call('read_file')]) === 'P2 A1 P1');
  check('pictures still draw side by side: nothing depends on them', shape([call('generate_image'), call('generate_image', {}, 'b')]) === 'P2');
  check('sub-agents still run side by side', shape([call('run_parallel'), call('web_search')]) === 'P2');
  check('a tool from outside the catalogue counts as a change', shape([call('mcp__x__y')]) === 'A1');
  const skipped = skippedAfterFailure(call('read_generated_file'), 'update_file');
  check('a call left unrun says so, and draws no row', skipped.skipped === true && skipped.isError === true && /update_file/.test(skipped.content));
}

section('nothing is called twice when calling it again cannot help');
{
  const guard = createStepGuard();
  const read = call('read_generated_file', { file_id: 'f1' });
  const edit = call('update_file', { file_id: 'f1', edits: [{ find: 'a', replace: 'b' }] });
  check('a first read runs', guard.check(read) === null);
  guard.note(read, { content: 'source' });
  check('a second read of an unchanged file does not', /has not changed/.test(guard.check(read)?.content || ''));

  guard.note(edit, { isError: true, content: 'Edit 1 did not match: its find text is not in the file.' });
  const again = guard.check(edit);
  check('an edit that could not match is not sent again word for word', again?.isError === true && /did not match/.test(again.content), again?.content);
  check('a failed write changed nothing, so the read is still not needed', /has not changed/.test(guard.check(read)?.content || ''));

  const other = call('update_file', { file_id: 'f1', edits: [{ find: 'c', replace: 'd' }] });
  check('a different edit is free to run', guard.check(other) === null);
  guard.note(other, { content: 'Made 1 change', file: { id: 'f1', name: 'a.md', format: 'md' } });
  check('after a real change the file may be read again', guard.check(read) === null);
  check('and the earlier failure may be tried again: the file is different now', guard.check(edit) === null);
  guard.note(other, { content: 'Made 1 change', file: { id: 'f1', name: 'a.md', format: 'md' } });
  const twice = createStepGuard();
  const whole = call('update_file', { file_id: 'f2', content: 'x' });
  twice.note(whole, { content: 'Rewrote', file: { id: 'f2', name: 'b.md', format: 'md' } });
  check('the very same change, made already, is not made again', /already been made/.test(twice.check(whole)?.content || ''));
  const made = call('create_file', { name: 'x', content: 'y' });
  twice.note(made, { content: 'Created', file: { id: 'f3', name: 'x.md', format: 'md' } });
  const madeAgain = twice.check(made)?.content || '';
  check('nor is a file made twice, and the model is told which it already has', /already been made/.test(madeAgain) && /f3/.test(madeAgain), madeAgain);

  const flaky = createStepGuard();
  const fetchIt = call('web_fetch', { url: 'https://example.com/' });
  flaky.note(fetchIt, { isError: true, content: 'timed out' });
  check('a failure that could pass gets one more try', flaky.check(fetchIt) === null);
  flaky.note(fetchIt, { isError: true, content: 'timed out' });
  check('but not a third', /already failed 2 times/.test(flaky.check(fetchIt)?.content || ''));

  const live = createStepGuard();
  const look = call('browser_look');
  live.note(look, { content: 'page' });
  check('a screen may change on its own, so looking again is allowed', live.check(look) === null);
  const cmd = call('run_command', { command: 'npm test' });
  live.note(cmd, { content: 'ok' });
  check('so may a command being waited on', live.check(cmd) === null);

  const world = createStepGuard();
  const listing = call('list_dir', { path: '.' });
  world.note(listing, { content: 'a b' });
  check('an unchanged folder is not listed twice', /already ran/.test(world.check(listing)?.content || ''));
  world.note(call('write_file', { path: 'c' }), { content: 'wrote' });
  check('after a write it may be', world.check(listing) === null);
  const sums = createStepGuard();
  const sum = call('calculate', { expression: '1+1' });
  sums.note(sum, { content: '1+1 = 2' });
  check('nor is the same sum done twice', /already ran/.test(sums.check(sum)?.content || ''));
}

section('a read is only settled while nothing can have changed it');
{
  const guard = createStepGuard();
  const listing = call('list_dir', { path: '.' });
  guard.note(listing, { content: 'a b' });
  const cmd = call('run_command', { command: 'make' });
  guard.note(cmd, { isError: true, content: 'exit 1' });
  check('a command that failed half way may still have changed things', guard.check(listing) === null);
  guard.note(listing, { content: 'a b c' });
  check('and is read as settled again after that', /already ran/.test(guard.check(listing)?.content || ''));
  guard.note(cmd, { isError: true, content: 'exit 1' });
  guard.note(cmd, { isError: true, content: 'exit 1' });
  check('a command failing over and over is still stopped, though it counts as a change', /already failed/.test(guard.check(cmd)?.content || ''), guard.check(cmd)?.content);

  const running = createStepGuard();
  const file = call('read_file', { path: 'log.txt' });
  running.note(file, { content: 'one' });
  running.note(call('run_background', { command: 'watch' }), { content: 'started' });
  running.note(file, { content: 'two' });
  check('with a process left running, a file may change by itself', running.check(file) === null);
  running.note(call('run_background_stop', { id: '1' }), { content: 'stopped' });
  running.note(file, { content: 'three' });
  check('once it is stopped, it is settled again', /already ran/.test(running.check(file)?.content || ''));

  const edit = createStepGuard();
  const read = call('read_generated_file', { file_id: 'f' });
  edit.note(read, { content: 'source' });
  edit.note(call('update_file', { file_id: 'f', edits: [{ find: 'a', replace: 'b' }] }), { isError: true, content: 'Edit 1 did not match' });
  check('a write this app refused changed nothing: the file need not be read again', /has not changed/.test(edit.check(read)?.content || ''));
}

section('a resumed turn remembers, and an earlier turn does not count');
{
  const messages = [
    { role: 'user', id: 'u1', text: 'first' },
    { role: 'assistant', id: 'a1', toolCalls: [call('read_generated_file', { file_id: 'f1' }, 'c1')] },
    { role: 'tool', id: 't1', results: [{ toolCallId: 'c1', name: 'read_generated_file', content: 'source' }] },
    { role: 'user', id: 'u2', text: 'second' },
    { role: 'assistant', id: 'a2', toolCalls: [call('update_file', { file_id: 'f9', content: 'x' }, 'c2')] },
    { role: 'tool', id: 't2', results: [{ toolCallId: 'c2', name: 'update_file', content: 'Rewrote', file: { id: 'f9', name: 'r.docx', format: 'docx' } }] },
  ];
  const guard = createStepGuard(messages);
  check('this turn’s write is known to it', /already been made/.test(guard.check(call('update_file', { file_id: 'f9', content: 'x' }))?.content || ''));
  check('the last turn’s read is not: the person may have changed things since', guard.check(call('read_generated_file', { file_id: 'f1' })) === null);
  check('and that file is owed a look', guard.owed().map((f) => f.id).join() === 'f9');
  const shown = createStepGuard([
    { role: 'user', id: 'u', text: 'x' },
    { role: 'assistant', id: 'a', toolCalls: [call('create_file', { content: 'x' }, 'c')] },
    { role: 'tool', id: 't', results: [{ toolCallId: 'c', name: 'create_file', content: 'Created', looked: true, file: { id: 'f', name: 'r.docx', format: 'docx' } }] },
  ]);
  check('a file the write already showed is not owed one', shown.owed().length === 0);
  const notRun = createStepGuard([
    { role: 'user', id: 'u', text: 'x' },
    { role: 'assistant', id: 'a', toolCalls: [call('update_file', { file_id: 'q', content: 'x' }, 'c')] },
    { role: 'tool', id: 't', results: [{ toolCallId: 'c', name: 'update_file', content: 'Not run', isError: true, skipped: true }] },
  ]);
  check('a call that was not run taught it nothing', notRun.check(call('update_file', { file_id: 'q', content: 'x' })) === null);
}

section('what a model is told about a file it just wrote');
{
  check('a text file is asked to be read again, without being sent back', /read what you wrote once more/.test(readItAgainNote({ format: 'md' })));
  check('a page is told to check its own layout, since it cannot be drawn here', /layout and colours/.test(readItAgainNote({ format: 'html' })));
  const text = await lookAfterWriting({ userId: 'u', file: { id: 'f', name: 'a.md', format: 'md' } });
  check('so a text file costs no drawing', text.looked && !text.pictures.length);
  const masked = await lookAfterWriting({ userId: 'u', file: { id: 'f', name: 'a.docx', format: 'docx' }, masking: true, store: { getAttachment: () => { throw new Error('must not be read'); } } });
  check('with personal details masked no picture of the file goes out: pixels cannot be masked', masked.looked && !masked.pictures.length && /masked/.test(masked.text));
  const late = await lookAfterWriting({ userId: 'u', file: { id: 'f', name: 'a.docx', format: 'docx' }, deadline: Date.now() + 1000, store: { getAttachment: () => { throw new Error('must not be read'); } } });
  check('with no time left in the turn the file is not drawn', late.looked && /no time left/.test(late.text));
  const many = await lookAfterWriting({ userId: 'u', file: { id: 'f', name: 'a.docx', format: 'docx' }, looksSoFar: MAX_LOOKS_PER_TURN, store: { getAttachment: () => { throw new Error('must not be read'); } } });
  check('a file rewritten over and over is not drawn for ever', many.looked && !many.pictures.length);
  const broken = await lookAfterWriting({
    userId: 'u',
    file: { id: 'f', name: 'a.docx', format: 'docx' },
    store: { getAttachment: async () => ({ data: 'AAAA' }) },
    draw: async () => { throw new Error('it would not draw'); },
  });
  check('a drawing that fails never fails the write', broken.looked && /could not be drawn/.test(broken.text));
  const drawn = await lookAfterWriting({
    userId: 'u',
    file: { id: 'f', name: 'a.docx', format: 'docx' },
    store: { getAttachment: async () => ({ data: 'AAAA' }) },
    draw: async () => ({ format: 'docx', unit: 'page', total: 8, shown: [1, 2], skipped: [3, 4], notes: ['Calibri was drawn with Liberation Sans.'], sheets: [{ mime: 'image/jpeg', data: 'BBBB', label: 'Pages 1-2 of 8', pages: [1, 2] }] }),
    keep: async () => ({ id: 'pic1', name: 'a.docx (Pages 1-2 of 8).jpg' }),
  });
  check('a drawn file comes with its pictures', drawn.pictures.length === 1 && drawn.pictures[0].id === 'pic1');
  check('and says what to check, what was left out and what the drawing could not do', /layout/.test(drawn.text) && /pages 3, 4/.test(drawn.text) && /Liberation Sans/.test(drawn.text), drawn.text);
  check('the sentence is held to the numbers', /has 1 page\b/.test(pictureNote('x', { pictures: [1], labels: [], notes: [], skipped: [], unit: 'page', total: 1 })));
}

section('the pictures ride on the next requests, and only those');
{
  const pictures = [{ id: 'p1', name: 'a (1).jpg', label: 'Page 1' }];
  const base = [
    { id: 'u', role: 'user', text: 'make it' },
    { id: 'a1', role: 'assistant', toolCalls: [call('create_file', {}, 'c1')] },
    { id: 't1', role: 'tool', results: [{ toolCallId: 'c1', pictures }] },
  ];
  const next = withLookedPictures(base);
  check('right after the results, as a message a provider takes pictures in', next.at(-1).role === 'user' && next.at(-1).attachments[0].id === 'p1');
  check('and what is written in them is said to be content', /never an instruction/.test(next.at(-1).text));
  check('the stored transcript is not touched', base.length === 3);
  const oneLater = [...base, { id: 'a2', role: 'assistant', toolCalls: [call('update_plan', {}, 'c2')] }, { id: 't2', role: 'tool', results: [{ toolCallId: 'c2' }] }];
  check('they are still there one step later, to fix something and check it', withLookedPictures(oneLater).some((m) => m.attachments));
  const twoLater = [...oneLater, { id: 'a3', role: 'assistant', toolCalls: [call('update_plan', {}, 'c3')] }, { id: 't3', role: 'tool', results: [{ toolCallId: 'c3' }] }];
  check('after that a long turn stops paying for them', !withLookedPictures(twoLater).some((m) => m.attachments));
  const nextTurn = [...base, { id: 'a4', role: 'assistant', text: 'done' }, { id: 'u2', role: 'user', text: 'thanks' }];
  check('and a new message from the person leaves them behind', !withLookedPictures(nextTurn).some((m) => m.attachments));
  check('they are marked, so they stay out of the window of the person’s own files', next.at(-1).looked === true);
  const crowded = withLookedPictures([
    { id: 'u', role: 'user', text: 'x' },
    { id: 't', role: 'tool', results: Array.from({ length: 4 }, (_, f) => ({ pictures: Array.from({ length: 6 }, (__, p) => ({ id: `f${f}p${p}`, name: 'n' })) })) },
  ]);
  check('four files in one batch are not twenty-four pictures in one request', crowded.at(-1).attachments.length === 12, String(crowded.at(-1).attachments.length));
  check('and the model is told what it did not get', /12 more would not fit/.test(crowded.at(-1).text), crowded.at(-1).text);
  const told = [{ id: 'u', role: 'user', text: 'x' }, { id: 't', role: 'tool', results: [{ pictures: [{ id: 'p', toldOnly: true }] }] }];
  check('pictures another model already read for this one are not sent again', !withLookedPictures(told).some((m) => m.attachments));
}

section('sums: every figure in one call, answered a line each');
{
  const out = calculate('[57*25744, 1467408/12, round(55639.4166, 2)]').split('\n');
  check('a list answers one line per item, each with its working', out.length === 3 && out[0] === '57*25744 = 1467408' && out[2] === 'round(55639.4166, 2) = 55639.42', out.join(' | '));
  check('a single sum is still one line', calculate('1 + 1') === '1 + 1 = 2');
}

section('the real loop: a failed write, the read beside it, then a file that gets looked at');
{
  const { initStore } = await import('../server/store/index.js');
  const { runAgent } = await import('../server/agent.js');
  const { hashPassword } = await import('../server/crypto.js');
  const store = await initStore();
  const user = await store.createUser({ id: 'u-step', email: 'step@example.com', name: 'Step', passwordHash: await hashPassword('a-sufficiently-long-password'), role: 'admin' });
  await store.createChat(user.id, { id: 'c-step', title: 'steps' });
  await store.appendMessage(user.id, 'c-step', { id: 'm-step', role: 'user', text: 'make a report' });

  let turn = 0;
  /** @type {any[]} */
  const requests = [];
  let fileId = null;
  const stream = async function* scripted(opts) {
    turn += 1;
    requests.push(opts.messages);
    const done = (toolCalls) => ({ type: 'done', stopReason: toolCalls.length ? 'tool_use' : 'end_turn', toolCalls, usage: { input: 5, output: 5 } });
    if (turn === 1) {
      yield done([{ id: 's1', name: 'create_file', input: { name: 'Bao cao', format: 'docx', content: '# Bao cao\n\nNoi dung dau tien.\n\n| A | B |\n|---|---|\n| 1 | 2 |' } }]);
    } else if (turn === 2) {
      fileId = opts.messages.flatMap((m) => m.results || []).find((r) => r.file?.id)?.file.id;
      // The report: a write that cannot match, and a read of the same file, in one breath.
      yield done([
        { id: 's2', name: 'update_file', input: { file_id: fileId, edits: [{ find: 'NOT IN THE FILE', replace: 'x' }] } },
        { id: 's3', name: 'read_generated_file', input: { file_id: fileId } },
      ]);
    } else if (turn === 3) {
      yield done([{ id: 's4', name: 'update_file', input: { file_id: fileId, edits: [{ find: 'NOT IN THE FILE', replace: 'x' }] } }]);
    } else if (turn === 4) {
      yield done([{ id: 's5', name: 'update_file', input: { file_id: fileId, edits: [{ find: 'Noi dung dau tien', replace: 'Noi dung da sua' }] } }]);
    } else {
      yield { type: 'text', delta: 'Xong.' };
      yield done([]);
    }
  };
  /** @type {{ event: string, data: any }[]} */
  const events = [];
  await runAgent({ userId: user.id, user, chatId: 'c-step', emit: (event, data) => events.push({ event, data }), stream });

  const stored = await store.listMessages(user.id, 'c-step');
  const results = stored.flatMap((m) => m.results || []);
  const byId = new Map(results.map((r) => [r.toolCallId, r]));
  check('the write that failed failed', byId.get('s2')?.isError === true && /did not match/.test(byId.get('s2').content));
  check('the read beside it never ran', byId.get('s3')?.skipped === true && /Not run/.test(byId.get('s3').content), byId.get('s3')?.content);
  const drawnRows = events.filter((e) => e.event === 'tool_call').map((e) => e.data.id);
  check('and no row was drawn for it', !drawnRows.includes('s3'), drawnRows.join());
  check('the same failing write sent again was refused without running', byId.get('s4')?.skipped === true && /already failed/.test(byId.get('s4').content), byId.get('s4')?.content);
  check('and drew no row either', !drawnRows.includes('s4'));
  check('a corrected write worked', !byId.get('s5')?.isError);
  const written = byId.get('s1');
  check('the first write came with pictures of the file', written?.looked === true && written?.pictures?.length >= 1, JSON.stringify(written?.pictures));
  const parts = requests[1].filter((m) => m.role === 'user').flatMap((m) => m.parts || []);
  check('and the very next request showed them to the model', parts.some((p) => p.type === 'image' && p.data), JSON.stringify(parts.map((p) => p.type)));
  check('a corrected file is shown again', byId.get('s5')?.pictures?.length >= 1);
  const row = await store.getAttachment(user.id, byId.get('s5').pictures[0].id);
  check('the pictures are kept off the Files shelf', row?.origin === 'step' && row?.kind === 'image', `${row?.origin} ${row?.kind}`);
  check('the turn still ended with its answer', stored.at(-1)?.text === 'Xong.', stored.at(-1)?.text);
  check('with no second reply asked for: everything was looked at', turn === 5, `${turn} requests`);
}

section('looking at a file does not push the person’s own files out of view');
{
  const { getStore } = await import('../server/store/index.js');
  const { loadForTranscript, saveGenerated } = await import('../server/attachments.js');
  const store = getStore();
  const user = await store.getUserById('u-step');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC';
  const make = async (name) => (await saveGenerated(user.id, { name, mime: 'image/png', kind: 'image', data: png, origin: 'step' })).id;
  const uploads = [];
  for (let i = 0; i < 8; i += 1) uploads.push(await make(`upload-${i}.png`));
  const pictures = [];
  for (let i = 0; i < 6; i += 1) pictures.push(await make(`sheet-${i}.png`));
  const loaded = await loadForTranscript(user.id, [
    { role: 'user', attachments: uploads.map((id) => ({ id, name: 'u', kind: 'image' })) },
    { role: 'user', looked: true, attachments: pictures.map((id) => ({ id, name: 's', kind: 'image' })) },
  ]);
  check('every upload is still there beside six pictures of a file', uploads.every((id) => loaded.has(id)), `${loaded.size} loaded`);
  check('and so are the pictures', pictures.every((id) => loaded.has(id)));

  const { setPrefs } = await import('../server/settings.js');
  const { executeTool } = await import('../server/tools/execute.js');
  const { createDocument } = await import('../server/office/index.js');
  await store.createUser({ id: 'u-masked', email: 'masked@example.com', name: 'M', passwordHash: 'x', role: 'user' });
  const masked = await store.getUserById('u-masked');
  await setPrefs(masked.id, { maskPersonal: true });
  const built = createDocument({ format: 'docx', name: 'x', content: '# Nguyễn Văn A' });
  const secret = await saveGenerated(masked.id, { name: built.name, mime: built.mime, data: built.buffer.toString('base64'), source: '# x' });
  const refused = await executeTool({ user: masked, name: 'look_at', input: { file_id: secret.id }, chatId: null, canSee: false });
  check('with personal details masked, look_at will not draw a file for a model', refused.isError === true && /masked/.test(refused.content), refused.content);
}

section('a job’s pictures go with its conversation');
{
  const { getStore } = await import('../server/store/index.js');
  const store = getStore();
  await store.createChat('u-step', { id: 'c-job', title: 'job' });
  await store.enqueueJob('u-step', { id: 'job-1', chatId: 'c-job', tool: 'read_file', input: {}, deviceId: null });
  const job = await store.getJob('u-step', 'job-1');
  check('a job says which conversation it belongs to', job?.chat_id === 'c-job', JSON.stringify(job));
}

section('a file written in parts is looked over at the end');
{
  const { getStore } = await import('../server/store/index.js');
  const { runAgent } = await import('../server/agent.js');
  const store = getStore();
  const user = await store.getUserById('u-step');
  await store.createChat(user.id, { id: 'c-parts', title: 'parts' });
  await store.appendMessage(user.id, 'c-parts', { id: 'm-parts', role: 'user', text: 'make a long report' });
  let turn = 0;
  /** @type {any[]} */
  const seen = [];
  const stream = async function* scripted(opts) {
    turn += 1;
    seen.push(opts.messages);
    const done = (toolCalls) => ({ type: 'done', stopReason: toolCalls.length ? 'tool_use' : 'end_turn', toolCalls, usage: { input: 5, output: 5 } });
    if (turn === 1) yield done([{ id: 'p1', name: 'create_file', input: { name: 'Dai', format: 'md', content: '# Dai\n\nPhan mot.' } }]);
    else if (turn === 2) {
      const id = opts.messages.flatMap((m) => m.results || []).find((r) => r.file?.id)?.file.id;
      yield done([{ id: 'p2', name: 'update_file', input: { file_id: id, content: '\n\nPhan hai.', append: true } }]);
    } else {
      yield { type: 'text', delta: `Xong ${turn}.` };
      yield done([]);
    }
  };
  await runAgent({ userId: user.id, user, chatId: 'c-parts', emit: () => {}, stream });
  check('it gets one more request', turn === 4, `${turn} requests`);
  check('whose note asks for a look at the finished file', /not final yet/.test(seen[3].at(-1)?.text || ''), seen[3].at(-1)?.text);
  check('only once: the turn then ends', (await store.listMessages(user.id, 'c-parts')).at(-1)?.text === 'Xong 4.');
}

/*
 * Harness audit, 2026-11-12: an identical message or post that already went out this turn is
 * not sent again — only file writes and settled reads were guarded, so a model that lost track
 * sent the same Slack post or POST once a step.
 */
section('a message that went out this turn is not sent again');
{
  const guard = createStepGuard();
  const post = { name: 'slack_post', input: { channel: '#team', text: 'Build passed.' } };
  check('the first send runs', guard.check(post) === null);
  guard.note(post, { content: 'Posted.' });
  const again = guard.check(post);
  check('  the identical one later in the turn is not sent, and the model is told to treat it as sent', again && again.isError === false && /Not sent again/.test(again.content), again?.content);
  check('  a different message still goes', guard.check({ name: 'slack_post', input: { channel: '#team', text: 'Deploy done.' } }) === null);
  const mail = { name: 'gmail', input: { action: 'send', to: 'a@example.com', subject: 'Hi', body: 'x' } };
  guard.note(mail, { content: 'Sent.' });
  check('a Gmail send, the same', /Not sent again/.test(guard.check(mail)?.content || ''));
  const draft = { name: 'gmail', input: { action: 'draft', to: 'a@example.com', subject: 'Hi', body: 'x' } };
  guard.note(draft, { content: 'Saved.' });
  check('  but a draft is not a send', guard.check(draft) === null || !/Not sent again/.test(guard.check(draft)?.content || ''));
  const post2 = { name: 'http_request', input: { method: 'POST', url: 'https://hooks.example/x', body: '{}' } };
  const get = { name: 'http_request', input: { method: 'GET', url: 'https://example.com/status' } };
  guard.note(post2, { content: '200' });
  guard.note(get, { content: '200' });
  check('a POST is not repeated', /Not sent again/.test(guard.check(post2)?.content || ''));
  check('  a GET may be asked again', !/Not sent again/.test(guard.check(get)?.content || ''));
  const failedSend = { name: 'telegram_send', input: { chat_id: '1', text: 'x' } };
  guard.note(failedSend, { isError: true, content: 'Telegram did not take it' });
  check('a send that failed may be tried again', !/Not sent again/.test(guard.check(failedSend)?.content || ''));
}

removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mOne step at a time, and nothing twice.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
