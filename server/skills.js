import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { BUILTIN_SKILLS, findBuiltinSkill } from './skills/builtin.js';

/**
 * Skills — procedures somebody taught the assistant once.
 *
 * "How we write a quotation", "how invoices get filed". Without them a repeated
 * job has to be re-explained every conversation, and the explanation drifts.
 *
 * The design decision worth knowing: **only the names and descriptions go into
 * the system prompt**, not the instructions. Twenty skills of full instructions
 * would be thousands of tokens on every single turn, most of it irrelevant. The
 * model sees a menu, and reads the one it needs with `skill_read`. That is also
 * why the description matters more than the title — it is what the model uses
 * to decide.
 */

const MAX_NAME = 60;
// Claude's own limit, so a skill made there and uploaded here fits as it is (owner, 2026-11-01).
const MAX_DESCRIPTION = 1024;
const MAX_INSTRUCTIONS = 20_000;

/**
 * What a skill may carry beside its instructions (schema 34): a few text files
 * — a template, a reference list, a script kept as text — read with it by
 * `readSkill` and never run. Small on purpose: whatever is read goes into the
 * conversation.
 */
export const MAX_SKILL_FILES = 10;
const MAX_FILE_CHARS = 20_000;
const MAX_FILES_CHARS = 60_000;
const FILE_NAME = /^(?!.*\.\.)[\p{L}\p{N} ._()\-/]{1,120}$/u;

/** A skill's files, checked: names a path can hold, nothing twice, nothing too long. Undefined keeps what it has. */
export function cleanSkillFiles(files) {
  if (files == null) return undefined;
  if (!Array.isArray(files)) throw new Error("A skill's files must be a list.");
  if (files.length > MAX_SKILL_FILES) throw new Error(`A skill carries at most ${MAX_SKILL_FILES} files.`);
  const seen = new Set();
  let total = 0;
  return files.map((file) => {
    const name = String(file?.name || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!FILE_NAME.test(name) || name.toLowerCase() === 'skill.md') throw new Error(`"${name || '?'}" is not a file name a skill can carry.`);
    if (seen.has(name.toLowerCase())) throw new Error(`Two files are called "${name}".`);
    seen.add(name.toLowerCase());
    const content = String(file?.content ?? '');
    if (content.length > MAX_FILE_CHARS) throw new Error(`${name} is too long for a skill to carry; keep each file under 20,000 characters.`);
    total += content.length;
    if (total > MAX_FILES_CHARS) throw new Error("A skill's files come to too much text together; keep what it carries short.");
    return { name, content };
  });
}

/**
 * @param {string} userId
 * @param {{ name: string, description: string, instructions: string, files?: { name: string, content: string }[] }} skill
 *   `files` left out keeps the files the skill already carries (`skill_write` refines the words only)
 */
export async function saveSkill(userId, { name, description, instructions, files }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A skill needs a name.');
  if (clean.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME} characters.`);

  const why = String(description || '').trim();
  if (!why) {
    throw new Error(
      'A skill needs a description — it is how the assistant decides when this applies, so say what it is for.',
    );
  }
  if (why.length > MAX_DESCRIPTION) throw new Error(`Keep the description under ${MAX_DESCRIPTION} characters.`);

  const steps = String(instructions || '').trim();
  if (!steps) throw new Error('A skill needs instructions — the actual procedure.');
  if (steps.length > MAX_INSTRUCTIONS) throw new Error('That is too long for one skill; split it up.');

  return getStore().saveSkill(userId, {
    id: crypto.randomUUID(),
    name: clean,
    description: why,
    instructions: steps,
    files: cleanSkillFiles(files),
  });
}

/** A skill's files, as they are read with it — each under its name, fenced so its text stays text. */
function filesSection(files) {
  const list = Array.isArray(files) ? files.filter((f) => f?.name) : [];
  if (!list.length) return '';
  // A fence longer than any run of backticks inside, so a file's own fences cannot close it.
  const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const parts = list.flatMap((f) => {
    const text = String(f.content ?? '');
    const mark = fence(text);
    return ['', `### ${f.name}`, mark, text, mark];
  });
  return ['', '---', '', 'Files with this skill:', ...parts].join('\n');
}

/**
 * The menu that goes into the system prompt.
 *
 * Returns null when there is nothing to offer, so the caller can leave the
 * section out entirely rather than printing an empty heading.
 */
export async function skillMenu(userId) {
  const skills = await getStore().listSkills(userId, true);

  /**
   * The built-in procedures come first, and they are always there.
   *
   * `create_file` can write Word, Excel and PowerPoint, and its description says
   * so — but the *conventions* were nowhere. A description long enough to carry
   * them would be thousands of tokens on every request, so the model knew it could
   * make a spreadsheet and did not know that a heading above a table starts a new
   * sheet. That is precisely the problem skills already solve: a cheap menu, and
   * the instructions read only when they apply.
   */
  const lines = [
    ...BUILTIN_SKILLS.map((s) => `- **${s.name}** — ${s.description}`),
    ...skills.map((s) => `- **${s.name}** — ${s.description}`),
  ];

  return [
    'Procedures you can read with `skill_read` before starting a job of that kind. Read the',
    'relevant one **first**: it carries conventions you cannot infer, and the ones the user',
    'wrote are how they want the job done.',
    '',
    ...lines,
  ].join('\n');
}

export async function readSkill(userId, name) {
  const wanted = String(name || '').trim().toLowerCase();

  // Built-ins are checked first and are not recorded as used: the counter exists
  // to tell somebody which of *their* skills is earning its keep.
  const builtin = findBuiltinSkill(wanted);
  if (builtin) {
    return [`# ${builtin.name}`, '', builtin.description, '', '---', '', builtin.instructions].join('\n');
  }

  const skills = await getStore().listSkills(userId, true);
  const found = skills.find((s) => s.name.toLowerCase() === wanted);

  if (!found) {
    const available = [...BUILTIN_SKILLS.map((s) => s.name), ...skills.map((s) => s.name)].join(', ');
    throw new Error(`No skill called "${name}". Available: ${available}`);
  }

  await getStore().noteSkillUsed(userId, found.name);
  return [`# ${found.name}`, '', found.description, '', '---', '', found.instructions].join('\n') + filesSection(found.files);
}

/**
 * The built-in skills as the composer's + menu lists them: what each is called
 * and when it applies — never its instructions, which are read when used.
 */
export const builtinSkillCards = () => BUILTIN_SKILLS.map(({ id, name, description, plugin }) => ({ id, name, description, builtin: true, plugin: plugin || null }));

/** How many skills one message may carry. Each is its whole instructions, in that turn. */
export const MAX_PICKED_SKILLS = 5;

/**
 * The skills somebody picked for one message in the + menu (owner,
 * 2026-10-14), by the name the account knows each by — or nothing.
 *
 * Checked against what exists rather than trusted: the names come from the
 * browser, and a name that matches no skill is dropped instead of being sent
 * on to the model as though it were one. A switched-off skill of their own is
 * not offered either.
 *
 * @param {unknown} names
 * @returns {Promise<string[]>}
 */
export async function chosenSkills(userId, names) {
  if (!Array.isArray(names)) return [];
  // Cut to size before any work: the list is the browser's, and a body can be
  // megabytes of names (security review, 2026-10-14).
  const wanted = [
    ...new Set(
      names
        .slice(0, MAX_PICKED_SKILLS * 4)
        .filter((n) => typeof n === 'string')
        .map((n) => n.trim().slice(0, MAX_NAME))
        .filter(Boolean),
    ),
  ];
  if (!wanted.length) return [];
  const own = await getStore().listSkills(userId, true);
  const found = wanted.map((n) => findBuiltinSkill(n.toLowerCase())?.name || own.find((s) => s.name.toLowerCase() === n.toLowerCase())?.name);
  return [...new Set(found.filter(Boolean))].slice(0, MAX_PICKED_SKILLS);
}

/**
 * What the picked skills say, for the turn they were picked in.
 *
 * Read the way `skill_read` reads them, so a picked skill and one the model
 * chose to read arrive identically; one that has gone since (deleted between
 * sending and running) is left out rather than failing the turn.
 */
export async function skillNotes(userId, names) {
  const texts = [];
  for (const name of Array.isArray(names) ? names.slice(0, MAX_PICKED_SKILLS) : []) {
    try {
      texts.push(await readSkill(userId, name));
    } catch {
      /* gone since it was picked */
    }
  }
  return texts.join('\n\n---\n\n');
}
