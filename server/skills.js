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
const MAX_DESCRIPTION = 300;
const MAX_INSTRUCTIONS = 20_000;

export async function saveSkill(userId, { name, description, instructions }) {
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
  });
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
  return [`# ${found.name}`, '', found.description, '', '---', '', found.instructions].join('\n');
}

/**
 * The built-in skills as the composer's + menu lists them: what each is called
 * and when it applies — never its instructions, which are read when used.
 */
export const builtinSkillCards = () => BUILTIN_SKILLS.map(({ id, name, description }) => ({ id, name, description, builtin: true }));

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
