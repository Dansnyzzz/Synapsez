/**
 * Translation coverage, and the two ways it rots silently.
 *
 * **A key on one side and not the other.** The failure mode is not a crash — it
 * is a screen that is 90% Vietnamese with three English labels in it, shipped for
 * a year because nobody with Vietnamese as their language was the one reading the
 * diff. So the two dictionaries have to hold exactly the same key set, and this
 * fails the build when they do not.
 *
 * **A `data-i18n` attribute pointing at nothing.** The markup asks for a string
 * that was never written, `t()` returns the key, and the interface shows
 * `nav.projects` to a customer. Every attribute in the page is checked against
 * both dictionaries here.
 *
 *   node test/i18n.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { vi } = await import('../public/js/locales/vi.js');
const { en } = await import('../public/js/locales/en.js');

section('the two dictionaries describe the same interface');
{
  const viKeys = Object.keys(vi).sort();
  const enKeys = Object.keys(en).sort();

  const missingInVi = enKeys.filter((k) => !(k in vi));
  const missingInEn = viKeys.filter((k) => !(k in en));

  check('every English key has a Vietnamese string', missingInVi.length === 0, missingInVi.join(', '));
  check('and every Vietnamese key has an English one', missingInEn.length === 0, missingInEn.join(', '));
  check('both hold the same number of strings', viKeys.length === enKeys.length, `${viKeys.length} vs ${enKeys.length}`);

  // An empty string is worse than a missing one: it renders as nothing at all,
  // so a button loses its label rather than showing an obviously wrong one.
  const blank = [...viKeys, ...enKeys].filter((k) => !String(vi[k] ?? '').trim() || !String(en[k] ?? '').trim());
  check('no string is empty', blank.length === 0, [...new Set(blank)].join(', '));

  // `{name}` placeholders have to match, or one language silently drops the value.
  const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const mismatched = viKeys.filter((k) => k in en && holes(vi[k]) !== holes(en[k]));
  check(
    'placeholders match on both sides',
    mismatched.length === 0,
    mismatched.map((k) => `${k}: "${holes(vi[k])}" vs "${holes(en[k])}"`).join(' | '),
  );
}

section('every string the markup asks for exists');
{
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  const asked = [
    ...html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label|-alt)?="([^"]+)"/g),
  ].map((m) => m[1]);

  check('the page asks for some strings at all', asked.length > 0, `${asked.length} attributes`);

  const unknown = [...new Set(asked)].filter((key) => !(key in vi) || !(key in en));
  check('and every one of them is defined', unknown.length === 0, unknown.join(', '));

  // The failure the key-set checks cannot see: a label that never got a key.
  const { untranslatedMarkup } = await import('./lib/untranslated.mjs');
  const bare = untranslatedMarkup(html);
  check('no visible text in the page is left without a translation', bare.length === 0, bare.slice(0, 20).join(' | '));
}

section('the product is called Synapse everywhere a person reads its name');
{
  /*
   * The app was renamed from "AI Remote". A rename that misses one screen, one
   * email or one error message leaves two products in front of the same person.
   *
   * Only these may still say it, because an existing install depends on the
   * old spelling: the scheduled-task name the worker autostart registered (an
   * uninstall has to find it), and the folder downloaded files already live in.
   * And schema.sql, whose first-line comment is part of the fingerprint that
   * decides whether every database migrates: renaming a comment is not worth a
   * schema version, and nobody reads it but a developer.
   */
  const ALLOWED = new Set([
    'scripts/autostart.js',
    'worker/tools.js',
    'server/store/schema.sql',
    'test/attachments.test.mjs',
    'test/i18n.test.mjs',
  ]);
  const root = path.join(import.meta.dirname, '..');
  const walk = (dir) =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'vendor' ? [] : walk(rel);
      return /\.(js|mjs|html|css|sql|ps1|sh|json)$/.test(entry.name) ? [rel] : [];
    });
  const offenders = ['public', 'server', 'worker', 'scripts', 'api', 'test']
    .flatMap(walk)
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => fs.readFileSync(path.join(root, rel), 'utf8').includes('AI Remote'));
  check('no user-facing file still says "AI Remote"', offenders.length === 0, offenders.join(', '));
  const { en: english } = await import('../public/js/locales/en.js');
  check('the app name is Synapse', english['app.name'] === 'Synapse' && vi['app.name'] === 'Synapse');
}

section('the strings the script builds are defined too');
{
  // `t('key')` calls in the modules. A literal argument can be checked; anything
  // computed cannot, and is skipped rather than guessed at.
  // Every module that imports `t`, not just the two big ones. `render.js` was
  // missing here, so a key used only by the transcript renderer could go
  // undefined and this suite would still pass.
  // Every module, not a hand-kept list: a key used only by the model browser
  // or the viewer could go undefined while a list of three still passed.
  const roots = fs
    .readdirSync(path.join(import.meta.dirname, '..', 'public', 'js'))
    .filter((name) => name.endsWith('.js'));
  const asked = new Set();
  for (const name of roots) {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', name), 'utf8');
    for (const m of source.matchAll(/\bt\(\s*'([^']+)'/g)) asked.add(m[1]);
  }

  check('the script asks for strings', asked.size > 0, `${asked.size} keys`);
  const unknown = [...asked].filter((key) => !(key in vi) || !(key in en));
  check('and every one of them is defined', unknown.length === 0, unknown.join(', '));
}

/**
 * Every browser and desktop action has a sentence.
 *
 * These are drawn as a run of steps in the transcript, and a tool with no entry
 * falls back to its raw name — so one added later reads as `browser_hover` in
 * the middle of a list of plain sentences. Nothing else would catch that: the
 * fallback is deliberate, so it does not throw, and it looks fine to whoever
 * added the tool because they know what it means.
 */
section('every step reads as a sentence');
{
  const render = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', 'render.js'), 'utf8');
  const definitions = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'server', 'tools', 'definitions.js'),
    'utf8',
  );

  const described = new Set([...render.matchAll(/^ {2}(\w+): '(step\.[\w.]+)',$/gm)].map((m) => m[1]));
  const tools = [...definitions.matchAll(/^ {4}name: '(\w+)',$/gm)].map((m) => m[1]);

  check('the tools were found at all', tools.length > 50, `${tools.length} tools`);

  /**
   * Every tool, not only the browser and desktop families this began with.
   *
   * A tool with no verb falls back to its own function name, so the transcript
   * shows `skill_read {"name":"…"}` where the rest of the turn is in words. It
   * does not throw, it looks fine to whoever added the tool because they know
   * what it means, and nobody notices until a screenshot of it arrives.
   */
  const undescribed = tools.filter((name) => !described.has(name));
  check('every one of them has a verb', undescribed.length === 0, undescribed.join(', '));

  // And the verbs themselves are real strings in both languages. Covered by the
  // sweep above too, but named here so a failure says which half is missing.
  const keys = [...render.matchAll(/'(step\.[\w.]+)'/g)].map((m) => m[1]);
  const untranslated = [...new Set(keys)].filter((k) => !(k in vi) || !(k in en));
  check('and a translation on both sides', untranslated.length === 0, untranslated.join(', '));

  for (const key of ['steps.browser', 'steps.desktop', 'steps.count', 'step.output', 'step.seconds']) {
    check(`the run itself is labelled: ${key}`, !!vi[key] && !!en[key]);
  }
  // The count and the wait both interpolate a number; a dropped placeholder
  // renders as "{n} steps" to a reader.
  check('the step count names its number', /\{n\}/.test(vi['steps.count']) && /\{n\}/.test(en['steps.count']));
  check('and so does the wait', /\{n\}/.test(vi['step.seconds']) && /\{n\}/.test(en['step.seconds']));
}

section('the onboarding steps are all present');
{
  // Five steps, and each one has a title. A step that renders an empty panel is
  // the kind of thing only a real reader notices.
  for (let step = 1; step <= 5; step += 1) {
    check(`step ${step} has a title in both languages`, !!vi[`onb.${step}.title`] && !!en[`onb.${step}.title`]);
  }
  check('the step counter names both numbers', /\{n\}/.test(vi['onb.step']) && /\{total\}/.test(vi['onb.step']), vi['onb.step']);
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll i18n checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
