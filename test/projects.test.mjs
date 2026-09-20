/**
 * Projects: instructions that survive between conversations, and answers held
 * to the documents on the shelf.
 *
 * The failure this suite exists to prevent is the one the feature is for: an
 * assistant that has sources in front of it and answers from somewhere else.
 * That cannot be tested by asking a model — it needs a key, it costs money and
 * it is not deterministic — so what is checked here is everything that decides
 * whether it can: what text reaches the prompt, whether the rules are in it,
 * and whether one account's shelf can ever be read by another.
 *
 *   node test/projects.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'projects-test-encryption-key';
process.env.SESSION_SECRET ||= 'projects-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-projects-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
await initStore();

const PORT = 5206;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

import fs from 'node:fs';
import { createRequire } from 'node:module';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an HTML error page is a fine thing to assert on as text */
      }
      return { status: res.status, body: json, text };
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const alice = jar();
/** A second account, for every "one account cannot touch another's" check. */
const carol2 = jar();
await alice.call('POST', '/api/register', {
  name: 'Alice',
  email: 'alice@projects.test',
  password: 'a-long-enough-password',
});
await carol2.call('POST', '/api/register', {
  name: 'Carol',
  email: 'carol@projects.test',
  password: 'another-long-password',
});

/* ── the shelf ─────────────────────────────────────────────────── */

section('a project is a name, instructions and sources');
let projectId;
{
  const bad = await alice.call('POST', '/api/projects', { name: '   ' });
  check('a project needs a name', bad.status === 400, `${bad.status}`);

  const made = await alice.call('POST', '/api/projects', { name: 'Salesforce exam' });
  projectId = made.body?.project?.id;
  check('creating one works', made.status === 201 && !!projectId, `${made.status}`);
  check('and it is grounded by default', made.body?.project?.grounded === true, 'the point of the feature');

  const listed = await alice.call('GET', '/api/projects');
  check('it appears on the shelf', listed.body?.projects?.length === 1);
  check('with a count of its sources', listed.body?.projects?.[0]?.file_count === 0);

  const saved = await alice.call('PATCH', `/api/projects/${projectId}`, {
    instructions: 'Answer in Vietnamese. Cite the question number.',
    grounded: true,
  });
  check('instructions save', /Vietnamese/.test(saved.body?.project?.instructions || ''));
}

section('what may go on the shelf');
{
  const text = await alice.call('POST', `/api/projects/${projectId}/files`, {
    name: 'notes.md',
    mime: 'text/markdown',
    data: b64('# Chapter one\n\nThe deadline is 14 March.\n'),
  });
  check('a text file is read', text.status === 201, `${text.status}`);
  check('and its length recorded', text.body?.file?.chars > 10, `${text.body?.file?.chars}`);

  /**
   * A picture is taken now, and it is a different kind of source.
   *
   * This used to be refused, on the reasoning that a source is something an
   * answer can cite and there is no text in a photograph to cite. What that
   * missed is that half the library can *see*: a diagram on the shelf is worth
   * more to those models than the paragraph describing it. So it is kept, it
   * carries no text — so it never competes for the passage budget — and it
   * rides on the question as a real picture. A model with no eyes is told
   * plainly that there was one, which is what `toParts` has always done.
   */
  const image = await alice.call('POST', `/api/projects/${projectId}/files`, {
    name: 'diagram.png',
    mime: 'image/png',
    data: b64('not really a png'),
  });
  check('an image is taken', image.status === 201, `${image.status} ${image.body?.error || ''}`);
  check('marked as a picture', image.body?.file?.kind === 'image', image.body?.file?.kind);
  check('with no text to compete for the passage budget', image.body?.file?.chars === 0, `${image.body?.file?.chars}`);
  // The original is kept, which is what makes the shelf openable and
  // downloadable — the bytes used to be read once and dropped.
  check('and the file it came from is kept', !!image.body?.file?.attachment_id, JSON.stringify(image.body?.file));

  const junk = await alice.call('POST', `/api/projects/${projectId}/files`, {
    name: 'archive.zip',
    mime: 'application/zip',
    data: b64('PK'),
  });
  check('and so is a kind nothing can read', junk.status === 400, junk.body?.error);
}

/* ── the part that decides whether answers are grounded ─────────── */

section('what actually reaches the prompt');
{
  const { selectSources, renderProject } = await import('../server/projects.js');

  const files = [
    { name: 'rules.md', text: 'The pass mark is 5.0. Late work loses one point per day.' },
    { name: 'syllabus.md', text: 'Week one covers objects. Week two covers SOQL.' },
  ];

  const small = selectSources(files, 'what is the pass mark');
  check('a small shelf is sent whole', small.whole && small.sources.length === 2);
  check('nothing is cut', small.sources[0].text === files[0].text);

  // Over the budget, only the passages that answer the question travel — and
  // the gaps are marked, because a model shown a jump cut without one reads
  // straight across it.
  const long = [
    { name: 'big.md', text: `${'filler about unrelated matters. '.repeat(400)}\n\nThe pass mark is 5.0.\n\n${'more filler. '.repeat(400)}` },
  ];
  const picked = selectSources(long, 'what is the pass mark', 800);
  check('a long shelf is searched instead', !picked.whole);
  check('and the answer is in what was picked', /pass mark is 5\.0/.test(picked.sources[0].text), picked.sources[0].text.slice(0, 80));
  check('with the cuts marked', picked.sources[0].text.includes('[…]'));
  check('and it respects the budget', picked.sources[0].text.length < 1400, `${picked.sources[0].text.length}`);

  // The passage index is reused between turns, so the cases that matter are the
  // ones where reuse would be wrong. Cutting the shelf into passages and
  // counting words in each was being redone on every turn of every project
  // conversation — a shelf can be 100 files of 400,000 characters — to answer a
  // question that had not changed. Measured on a 2.4M-character shelf: 70.7ms
  // per turn before, 0.6ms after.
  {
    const { __testing } = await import('../server/projects.js');
    __testing.INDEX_CACHE.clear();

    const shelf = [{ id: 'a', name: 'a.md', text: `${'alpha beta gamma. '.repeat(300)}\n\nThe deposit is 20%.\n\n${'delta epsilon. '.repeat(300)}` }];

    const before = selectSources(shelf, 'what is the deposit', 800);
    check('the deposit passage is found', /deposit is 20%/.test(before.sources[0].text));
    check('and the shelf was indexed once', __testing.INDEX_CACHE.size === 1, `${__testing.INDEX_CACHE.size}`);

    // Same shelf, different question: the index is reused but the scoring is not.
    const other = selectSources(shelf, 'alpha beta gamma', 800);
    check('a second question reuses the index', __testing.INDEX_CACHE.size === 1, `${__testing.INDEX_CACHE.size}`);
    check(
      'but is scored on its own terms',
      other.sources[0].text !== before.sources[0].text,
      'the same passages came back for a different question',
    );

    // An edited shelf must never be answered from the old index.
    const edited = [{ ...shelf[0], text: `${shelf[0].text}\n\nThe deposit is now 35%.` }];
    const after = selectSources(edited, 'what is the deposit', 800);
    check('editing a file builds a new index', __testing.INDEX_CACHE.size === 2, `${__testing.INDEX_CACHE.size}`);
    check('and the new text is reachable', /35%/.test(after.sources[0].text) || /20%/.test(after.sources[0].text));

    // Bounded, or a long-lived server would hold every shelf it ever saw.
    for (let i = 0; i < 20; i += 1) {
      selectSources([{ id: `f${i}`, name: 'x.md', text: shelf[0].text + ' '.repeat(i + 1) }], 'deposit', 800);
    }
    check('the index cache stays bounded', __testing.INDEX_CACHE.size <= 8, `${__testing.INDEX_CACHE.size}`);
  }

  const { briefing, passages } = renderProject({
    project: { name: 'Exam', instructions: 'Answer in Vietnamese.', grounded: true },
    names: files.map((f) => f.name),
    ...small,
  });
  check('the project is named', /# Project: Exam/.test(briefing));
  check('its instructions are carried', /Answer in Vietnamese\./.test(briefing));
  check('the sources are listed by name', /rules\.md, syllabus\.md/.test(briefing));
  check('the text itself is there', /pass mark is 5\.0/.test(passages));

  // The four rules that make grounding mean something.
  check('claims must name their file', /name the file it came from/.test(briefing));
  check('not covered is a correct answer', /do not cover/.test(briefing));
  check('gaps must not be filled from memory', /Do not fill gaps from general knowledge/.test(briefing));
  check('disagreement is reported, not resolved silently', /If two sources disagree/.test(briefing));

  /*
   * The split, which is the whole reason this returns two strings.
   *
   * The briefing is identical on every turn of a conversation; the passages are
   * chosen from the question being asked. They used to be one string in the
   * system prompt, which carries the cache breakpoint — so the cached prefix
   * changed every turn, and because caching is a prefix match over tools, then
   * system, then messages, it took the whole transcript's cache with it. Every
   * project conversation paid full price for its entire prefix, on every step.
   *
   * Pinning it here because it is invisible: nothing about the output looks
   * wrong when the passages leak back into the briefing, it just silently costs
   * several times more.
   */
  check('the question-selected text is NOT in the briefing', !/pass mark is 5\.0/.test(briefing));
  check('  which is what keeps the cached prefix identical between turns', !/### /.test(briefing));

  /*
   * Two different questions over the same shelf, including one short enough to
   * fit whole and one that has to be searched — which is the case that caught
   * the last invalidator. The "some sources are too long" note used to sit in
   * the briefing, so whether the shelf happened to fit changed the supposedly
   * stable prefix and no turn could ever be a cache hit.
   */
  const sameShelf = (question, budget) =>
    renderProject({
      project: { name: 'Exam', instructions: 'Answer in Vietnamese.', grounded: true },
      names: files.map((f) => f.name),
      ...selectSources(long, question, budget),
    }).briefing;

  check(
    'a different question produces the same briefing byte for byte',
    sameShelf('what is the pass mark', 800) === sameShelf('something else entirely', 800),
    'if this ever differs, prompt caching is dead for every project chat',
  );
  check(
    '  and so does one that fits the shelf whole',
    sameShelf('what is the pass mark', 800) === sameShelf('what is the pass mark', 500_000),
  );

  const loose = renderProject({
    project: { name: 'Exam', instructions: '', grounded: false },
    names: ['rules.md'],
    ...small,
  }).briefing;
  check('the unrestricted mode says so instead', /general knowledge as well/.test(loose));
  check('and still asks for filenames', /name the file/.test(loose));

  const empty = renderProject({
    project: { name: 'Exam', instructions: '', grounded: true },
    names: [],
    sources: [],
    whole: true,
    truncated: false,
  });
  check('a project with no sources admits it', /no sources yet/.test(empty.briefing), empty.briefing.slice(-90));
  check('  and has no passages to carry', empty.passages === '');
}

// ── the passages ride on the question, not on the system prompt ─────
section('project sources attach to the turn that selected them');
{
  const { withProjectSources } = await import('../server/agent.js');

  const transcript = [
    { id: 'm1', role: 'user', text: 'first question' },
    { id: 'm2', role: 'assistant', text: 'an answer' },
    { id: 'm3', role: 'user', text: 'what is the pass mark' },
  ];
  const out = withProjectSources(transcript, '### rules.md\nThe pass mark is 5.0');

  check('the sources land on the last user turn', /pass mark is 5\.0/.test(out[2].text));
  check('  along with what was actually asked', /what is the pass mark/.test(out[2].text));
  check('earlier turns are untouched', out[0].text === 'first question' && out[1].text === 'an answer');
  check(
    'and the stored message is not mutated',
    transcript[2].text === 'what is the pass mark',
    'this is a wire detail — writing it into the transcript would resend it next turn with stale passages',
  );
  check('nothing to attach means nothing changes', withProjectSources(transcript, '') === transcript);

  // A turn that ends in a tool result still has a user message further back, and
  // that is where the question lives.
  const midRun = [
    { id: 'm1', role: 'user', text: 'the question' },
    { id: 'm2', role: 'assistant', text: '', toolCalls: [{ id: 't', name: 'x', input: {} }] },
    { id: 'm3', role: 'tool', results: [{ toolCallId: 't', name: 'x', content: 'ok' }] },
  ];
  const resumed = withProjectSources(midRun, '### rules.md\nbody');
  check('mid-run, it still finds the question', /body/.test(resumed[0].text));
  check('  and leaves the tool result alone', resumed[2] === midRun[2]);
}

section('a conversation inherits its project');
{
  const made = await alice.call('POST', '/api/chats', { projectId });
  const chatId = made.body?.chat?.id;
  check('a chat can be filed under one', made.status === 201 && !!chatId);

  const opened = await alice.call('GET', `/api/chats/${chatId}`);
  check('and says so when opened', opened.body?.project?.id === projectId);
  // Two: the text file and the diagram. A picture is a source on the shelf even
  // though it carries no text, which is what the header is counting.
  check('with its source count, for the header', opened.body?.project?.files === 2, `${opened.body?.project?.files}`);

  // Blank until somebody speaks: the same rule as the sidebar, so a project
  // does not accumulate a list of conversations that never happened.
  const empty = await alice.call('GET', `/api/projects/${projectId}`);
  check('a conversation nobody spoke in is not listed', empty.body?.chats?.length === 0, `${empty.body?.chats?.length}`);

  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'first question' });
  const listed = await alice.call('GET', `/api/projects/${projectId}`);
  check('the project lists its conversations', listed.body?.chats?.length === 1, `${listed.body?.chats?.length}`);

  const nonsense = await alice.call('POST', '/api/chats', { projectId: 'not-a-real-project' });
  check('an unknown project is refused', nonsense.status === 404, `${nonsense.status}`);

  // The conversations are a record of work; the folder going away must not take
  // them with it.
  const throwaway = await alice.call('POST', '/api/projects', { name: 'Temporary' });
  const inside = await alice.call('POST', '/api/chats', { projectId: throwaway.body.project.id });
  await alice.call('DELETE', `/api/projects/${throwaway.body.project.id}`);
  const survivor = await alice.call('GET', `/api/chats/${inside.body.chat.id}`);
  check('deleting a project keeps its conversations', survivor.status === 200);
  check('they simply stop belonging to one', survivor.body?.project === null);
}

/* ── pinning and archiving ─────────────────────────────────────── */

section('a shelf can be ordered and thinned out');
{
  // Three, made in order, so "last updated" has something to say.
  const names = ['Alpha', 'Beta', 'Gamma'];
  const made = [];
  for (const name of names) {
    const res = await alice.call('POST', '/api/projects', { name });
    made.push(res.body.project.id);
  }

  const fresh = await alice.call('GET', '/api/projects');
  check('a new project starts unpinned', fresh.body.projects.every((p) => !p.pinned));
  check('and un-archived', fresh.body.projects.every((p) => !p.archived_at));

  // Alpha was the oldest of the three, so a pin has to beat recency for this
  // to prove anything.
  const pinned = await alice.call('PATCH', `/api/projects/${made[0]}`, { pinned: true });
  check('a project can be pinned', pinned.body?.project?.pinned === true);

  const ordered = await alice.call('GET', '/api/projects');
  check('and it comes first', ordered.body.projects[0].id === made[0], ordered.body.projects[0].name);

  const archived = await alice.call('PATCH', `/api/projects/${made[1]}`, { archived: true });
  check('a project can be archived', !!archived.body?.project?.archived_at);

  const shelf = await alice.call('GET', '/api/projects');
  check('and leaves the shelf', !shelf.body.projects.some((p) => p.id === made[1]));

  const box = await alice.call('GET', '/api/projects?archived=1');
  check('for the archived one', box.body.projects.length === 1, `${box.body.projects.length}`);
  check('which is the one archived', box.body.projects[0]?.id === made[1]);

  // Archiving must not be a quiet delete: everything on it is still there.
  const intact = await alice.call('GET', `/api/projects/${made[1]}`);
  check('an archived project still opens', intact.status === 200, `${intact.status}`);

  const restored = await alice.call('PATCH', `/api/projects/${made[1]}`, { archived: false });
  check('and it can come back', restored.body?.project?.archived_at === null, `${restored.body?.project?.archived_at}`);
  const back = await alice.call('GET', '/api/projects');
  check('to the shelf it left', back.body.projects.some((p) => p.id === made[1]));

  // A patch that says nothing about pinning must not quietly unpin. The old
  // COALESCE-everything shape got this right by accident; the CASE for
  // `archived_at` is where it would have gone wrong.
  await alice.call('PATCH', `/api/projects/${made[0]}`, { name: 'Alpha renamed' });
  const still = await alice.call('GET', '/api/projects');
  check('renaming leaves a pin alone', still.body.projects[0].id === made[0], still.body.projects[0].name);
  check('and leaves the archive flag alone', !still.body.projects[0].archived_at);

  for (const id of made) await alice.call('DELETE', `/api/projects/${id}`);
}

/* ── the boundary ──────────────────────────────────────────────── */

section('one account cannot read another account\'s shelf');
{
  const bob = jar();
  await bob.call('POST', '/api/register', {
    name: 'Bob',
    email: 'bob@projects.test',
    password: 'another-long-password',
  });

  const seen = await bob.call('GET', `/api/projects/${projectId}`);
  check('not by id', seen.status === 404, `${seen.status}`);

  const listed = await bob.call('GET', '/api/projects');
  check('not in a listing', listed.body?.projects?.length === 0, `${listed.body?.projects?.length}`);

  const written = await bob.call('POST', `/api/projects/${projectId}/files`, {
    name: 'sneaky.md',
    mime: 'text/markdown',
    data: b64('hello'),
  });
  check('and nothing can be put on it', written.status === 404, `${written.status}`);

  const edited = await bob.call('PATCH', `/api/projects/${projectId}`, { name: 'mine now' });
  check('nor renamed', edited.status === 404, `${edited.status}`);

  const filed = await bob.call('POST', '/api/chats', { projectId });
  check('nor filed against', filed.status === 404, `${filed.status}`);

  const anonymous = await fetch(`${base}/api/projects`);
  check('and signed out reaches nothing at all', anonymous.status === 401, `${anonymous.status}`);
}

section('a project can have work that runs on its own');
{
  /*
   * A task made inside a project runs inside it: same standing instructions,
   * same shelf. Without that, "summarise this week's filings" answered from
   * nothing at all — which is worse than failing, because it looks like it
   * worked.
   */
  const made = await alice.call('POST', `/api/tasks`, {
    title: 'Weekly digest',
    prompt: 'Summarise what changed.',
    frequency: 'manual',
    policy: 'ask',
    projectId,
    tz: 'Asia/Ho_Chi_Minh',
  });
  check('a task can be filed under a project', made.status === 201, `${made.status} ${made.body?.error || ''}`);
  check('and says which one', made.body?.task?.project_id === projectId, made.body?.task?.project_id);
  check('carrying what it may do unwatched', made.body?.task?.policy === 'ask', made.body?.task?.policy);
  /*
   * Manual is a real option rather than a repeat scheduled so far ahead it
   * never fires: no cron, no next run, and the due query — `enabled AND
   * next_run_at <= now()` — matches neither.
   */
  check('a manual task has no schedule at all', made.body?.task?.cron === null, made.body?.task?.cron);
  check('and is never due', made.body?.task?.next_run_at === null, String(made.body?.task?.next_run_at));

  const repeating = await alice.call('POST', '/api/tasks', {
    title: 'Every weekday',
    prompt: 'Check the queue.',
    frequency: 'weekdays',
    projectId,
    tz: 'Asia/Ho_Chi_Minh',
  });
  check('a repeating one gets a real recurrence', /^weekdays \d\d:\d\d$/.test(repeating.body?.task?.cron || ''), repeating.body?.task?.cron);
  check('and a time it will next run', !!repeating.body?.task?.next_run_at, String(repeating.body?.task?.next_run_at));

  const onProject = await alice.call('GET', `/api/projects/${projectId}`);
  check('the project lists them', (onProject.body?.tasks || []).length === 2, `${(onProject.body?.tasks || []).length}`);

  const one = await alice.call('GET', `/api/tasks/${made.body.task.id}`);
  check('one can be opened on its own', one.status === 200 && one.body?.task?.title === 'Weekly digest', one.body?.task?.title);
  // By name, because the page shows which shelf it answers from and an id
  // tells nobody that.
  check('and names the project it answers from', one.body?.project?.id === projectId, JSON.stringify(one.body?.project));

  const strange = await alice.call('POST', '/api/tasks', {
    title: 'Nope',
    prompt: 'x',
    frequency: 'fortnightly',
  });
  check('a frequency nobody offers is refused', strange.status === 400, `${strange.status}`);
  check('and says what the choices are', /manual/.test(strange.body?.error || ''), strange.body?.error);

  // A project id from another account must not attach a run to a shelf it does
  // not own — the task would then read somebody else's sources on every run.
  const carol = carol2;
  const stolen = await carol.call('POST', '/api/tasks', {
    title: 'Theirs',
    prompt: 'x',
    frequency: 'manual',
    projectId,
  });
  check("another account cannot file a task in someone else's project", stolen.status === 404, `${stolen.status}`);
}

section('a conversation can be filed, archived, grouped');
{
  const made = await alice.call('POST', '/api/chats', {});
  const chatId = made.body?.chat?.id;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hello' });

  const filed = await alice.call('PATCH', `/api/chats/${chatId}`, { projectId });
  check('it can be moved into a project', filed.body?.chat?.project_id === projectId, filed.body?.chat?.project_id);

  // `null` is meaningful here — it is "Remove from project" — so the route has
  // to check for presence rather than truthiness.
  const out = await alice.call('PATCH', `/api/chats/${chatId}`, { projectId: null });
  check('and back out again', out.body?.chat?.project_id === null, String(out.body?.chat?.project_id));

  const stolen = await carol2.call('PATCH', `/api/chats/${chatId}`, { projectId });
  check("another account cannot touch it at all", stolen.status === 404, `${stolen.status}`);

  const grouped = await alice.call('PATCH', `/api/chats/${chatId}`, { group: '  Reading  ' });
  check('a group name is trimmed', grouped.body?.chat?.chat_group === 'Reading', grouped.body?.chat?.chat_group);

  const listed = await alice.call('GET', '/api/chats');
  check('and offered back as a group to move into', (listed.body?.groups || []).includes('Reading'), JSON.stringify(listed.body?.groups));
  check('the list carries the projects the sidebar needs', Array.isArray(listed.body?.projects) && listed.body.projects.length > 0);

  const ungrouped = await alice.call('PATCH', `/api/chats/${chatId}`, { group: '' });
  check('an empty name takes it out of the group', ungrouped.body?.chat?.chat_group === null, String(ungrouped.body?.chat?.chat_group));

  const unread = await alice.call('PATCH', `/api/chats/${chatId}`, { unread: true });
  check('it can be marked unread', unread.body?.chat?.unread === true, String(unread.body?.chat?.unread));

  /*
   * Archiving is not deleting, and the pair sit together in the same menu — so
   * the difference has to be real. It leaves the list and the row survives.
   */
  const archived = await alice.call('PATCH', `/api/chats/${chatId}`, { archived: true });
  check('archiving stamps a time rather than destroying it', !!archived.body?.chat?.archived_at, String(archived.body?.chat?.archived_at));
  const after = await alice.call('GET', '/api/chats');
  check('and it leaves the list', !(after.body?.chats || []).some((c) => c.id === chatId));
  const back = await alice.call('PATCH', `/api/chats/${chatId}`, { archived: false });
  check('un-archiving brings it back', back.body?.chat?.archived_at === null, String(back.body?.chat?.archived_at));
  const restored = await alice.call('GET', '/api/chats');
  check('to the list it left', (restored.body?.chats || []).some((c) => c.id === chatId));
}

removeTemp(process.env.DATA_DIR);
section('the vendored pdf.js is the installed one');
{
  /*
   * The browser draws a PDF's first page so the shelf has something to show,
   * and it does that with a copy of pdfjs under `public/vendor` — the page has
   * no build step, a CSP of `script-src 'self'`, and on Vercel `node_modules`
   * is not served at all. A copy is a thing that goes stale silently: the
   * package is upgraded, the copy is not, and the two drift until something
   * fails in a browser nobody is watching.
   */
  const require = createRequire(import.meta.url);
  const installed = JSON.parse(fs.readFileSync(require.resolve('pdfjs-dist/package.json'), 'utf8')).version;
  const root = path.join(import.meta.dirname, '..', 'public', 'vendor', 'pdfjs');
  const vendored = fs.existsSync(path.join(root, 'VERSION'))
    ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
    : '';
  check(
    'public/vendor/pdfjs matches package.json — run scripts/vendor-pdfjs.js after an upgrade',
    vendored === installed,
    `${vendored} vs ${installed}`,
  );
  // The worker especially: pdfjs fetches it by path at runtime, so a missing
  // one is a failure in the browser rather than a failure here.
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    check(`${file} is there`, fs.existsSync(path.join(root, file)));
  }
}

console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll project checks passed.\x1b[0m\n',
);
server.close();
process.exit(failures ? 1 : 0);
