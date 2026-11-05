/**
 * The skills that ship with the app, held to the rules a user's own skill is held to.
 *
 * Two of those rules come from how a skill is used. The description is in the
 * system prompt on every step of every turn, so a long one is paid for again and
 * again; the instructions are read only when the skill applies, so they can be
 * longer but not without limit. The third is that a skill is text read into a
 * conversation: an invisible character in it can carry words nobody reviewing it
 * would see, which is why `scanSkill` refuses them in an upload and why the ones we
 * ship are held to the same standard.
 *
 * What is pinned beyond that is what goes wrong quietly. A skill that names a tool
 * the app does not have makes the model call something that fails; one that tells
 * it to run a script describes a machine it is not on; one that grows past its
 * budget costs every request. None of those shows up until somebody notices the
 * behaviour.
 *
 *   node test/builtin-skills.test.mjs
 */
import fs from 'node:fs';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { BUILTIN_SKILLS, findBuiltinSkill } = await import('../server/skills/builtin.js');
const { scanSkill } = await import('../server/skillUpload.js');
const { TOOLS } = await import('../server/tools/definitions.js');

// The limit lives in skills.js and is not exported; read it from the source so this
// follows the real number instead of a copy of it.
const limitSource = /const MAX_INSTRUCTIONS = ([\d_]+);/.exec(fs.readFileSync(new URL('../server/skills.js', import.meta.url), 'utf8'));
const MAX_INSTRUCTIONS = Number(String(limitSource?.[1] || '').replace(/_/g, ''));
// What a name may be (skills.js MAX_NAME), what the menu may weigh, what one skill may weigh.
const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const SKILL_BUDGET = 4200;
const MENU_BUDGET = 2750; // 15 skills at about 2,620 when this was written: about 660 tokens a step

const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const toolNames = new Set(TOOLS.map((t) => t.name));

section('every built-in skill is well formed');
{
  check('the instruction limit was read from skills.js', Number.isFinite(MAX_INSTRUCTIONS) && MAX_INSTRUCTIONS >= 1000, String(MAX_INSTRUCTIONS));
  const ids = BUILTIN_SKILLS.map((s) => s.id);
  check('ids are unique and start "builtin:"', new Set(ids).size === ids.length && ids.every((id) => /^builtin:[a-z0-9-]+$/.test(id)), ids.join(', '));
  const names = BUILTIN_SKILLS.map((s) => s.name.toLowerCase());
  check('names are unique', new Set(names).size === names.length);
  for (const skill of BUILTIN_SKILLS) {
    const bad = [];
    if (!skill.name || skill.name !== skill.name.trim() || skill.name.length > MAX_NAME) bad.push('name');
    if (!skill.description || skill.description.length > MAX_DESCRIPTION || /\n/.test(skill.description)) bad.push(`description ${skill.description?.length}`);
    if (!skill.instructions || skill.instructions.length > MAX_INSTRUCTIONS) bad.push(`instructions over ${MAX_INSTRUCTIONS}`);
    if (skill.instructions.length > SKILL_BUDGET) bad.push(`instructions ${skill.instructions.length} over the ${SKILL_BUDGET} we aim for`);
    if (INVISIBLE.test(`${skill.name}${skill.description}${skill.instructions}`)) bad.push('invisible characters');
    if (/\r/.test(skill.instructions)) bad.push('carriage return');
    check(`${skill.id}: name, description (${skill.description.length}), instructions (${skill.instructions.length})`, bad.length === 0, bad.join('; '));
  }
  check('each is found by its name and by the word after "builtin:"', BUILTIN_SKILLS.every((s) => findBuiltinSkill(s.name)?.id === s.id && findBuiltinSkill(s.id.split(':')[1])?.id === s.id));
}

section('the menu is paid for on every step');
{
  const total = BUILTIN_SKILLS.reduce((n, s) => n + s.name.length + s.description.length + 8, 0);
  check(`names and descriptions together stay under ${MENU_BUDGET} characters`, total <= MENU_BUDGET, `${total} characters, about ${Math.round(total / 4)} tokens a step`);
}

section('a skill passes the same scan as an uploaded one');
{
  for (const skill of BUILTIN_SKILLS) {
    const findings = scanSkill({ name: skill.name, description: skill.description, instructions: skill.instructions });
    check(`${skill.id}: no findings`, findings.length === 0, findings.map((f) => `${f.level}: ${f.text}`).join(' | '));
  }
}

section('only tools that exist are named, and nothing the app cannot do is asked of the model');
{
  // Anything shaped like a tool name: lower-case words joined by underscores. CSS, attributes
  // and HTML in these skills use hyphens, so a snake_case word is a tool or a parameter.
  const PARAMETERS = new Set(['file_id']);
  for (const skill of BUILTIN_SKILLS) {
    const text = `${skill.description}\n${skill.instructions}`;
    const named = new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || []);
    const unknown = [...named].filter((n) => !toolNames.has(n) && !PARAMETERS.has(n));
    check(`${skill.id}: every tool-looking name is a real tool`, unknown.length === 0, unknown.join(', '));
  }
  // The tools these skills lean on must still exist, or the advice is aimed at nothing.
  const relied = ['create_file', 'update_file', 'read_generated_file', 'look_at', 'chart', 'show_widget', 'show_card', 'generate_image', 'edit_image', 'export_pdf', 'ask_options', 'analyze_data', 'send_email', 'web_search', 'image_search', 'sandbox_run', 'browser_look', 'browser_click', 'skill_write'];
  const missing = relied.filter((n) => !toolNames.has(n));
  check('the tools the skills rely on are defined', missing.length === 0, missing.join(', '));
  for (const skill of BUILTIN_SKILLS) {
    const text = `${skill.description}\n${skill.instructions}`;
    const offences = [];
    if (/\b(?:run|execute|invoke)\s+(?:the\s+)?[\w./-]+\.(?:py|sh|js|mjs|ps1)\b/i.test(text)) offences.push('run a script');
    if (/\b(?:python3?|pip install|npm (?:install|run)|npx)\b/i.test(text)) offences.push('python or npm');
    if (/\bclaude code\b|\bplaywright\b/i.test(text)) offences.push('Claude Code or Playwright');
    check(`${skill.id}: no script, Python or Claude Code asked for`, offences.length === 0, offences.join(', '));
  }
}

section('a skill that makes a file ends by telling the model to look at it');
{
  const makesFiles = ['builtin:docx', 'builtin:pptx', 'builtin:pdf', 'builtin:design-direction', 'builtin:data-viz', 'builtin:palettes', 'builtin:html-email', 'builtin:landing-page'];
  for (const id of makesFiles) {
    const skill = BUILTIN_SKILLS.find((s) => s.id === id);
    const tail = (skill?.instructions || '').slice(-220);
    check(`${id}: its last lines say to look_at the result`, /look_at/.test(tail) && /fix what you see/i.test(tail), tail.replace(/\s+/g, ' ').slice(-120));
  }
}

section('the extended skills still say what other suites pin');
{
  const get = (id) => BUILTIN_SKILLS.find((s) => s.id === id)?.instructions || '';
  check('docx still names the page break the converter reads', /\\pagebreak/.test(get('builtin:docx')));
  check('pptx still describes KPI cards and section slides', /KPI cards/.test(get('builtin:pptx')) && /section/.test(get('builtin:pptx')));
  check('pptx tells the model to write notes as a spoken script', /spoken script/.test(get('builtin:pptx')));
  check('pdf still sends invoices through export_pdf', /export_pdf/.test(get('builtin:pdf')));
  check('palettes names every theme the generator accepts', await (async () => {
    const { THEME_NAMES } = await import('../server/office/theme.js');
    return THEME_NAMES.every((name) => new RegExp(`\\b${name}\\b`).test(get('builtin:palettes')));
  })());
}

console.log(
  failures === 0 ? '\n\x1b[32mAll built-in skill checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
