// What the mask really catches, measured rather than claimed, and what the Settings page says it catches.
//
// Every sample says what is personal in it, and the samples with nothing personal say so
// too: a mask that hides every number looks perfect on recall and ruins the conversation.
// A figure that moves fails here, so the page cannot quietly go stale.
//
// Run with: node test/deidentify-corpus.test.mjs

import { createShield } from '../server/deidentify.js';
import { CORPUS, measureMasking, currentMasking } from '../server/deidentifyQuality.js';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

// The samples and their scoring live with the server now, which measures them when the
// page asks (owner, 2026-11-08); this holds the floors and says what each round gets wrong.
const measured = measureMasking();
const figures = measured.kinds;
const problems = measured.problems;
const clean = measured.clean;

section('what is measured');
check(`${CORPUS.length} samples, ${clean} of them with nothing personal in them`, CORPUS.length >= 90 && clean >= 20);
if (problems.length) console.log(`\n  What this round gets wrong:\n  ${problems.join('\n  ')}\n`);

section('every kind holds its line');
for (const [kind, f] of Object.entries(figures)) {
  // A floor under what is measured, not a target: the hard samples above keep these from reading 100%.
  check(`${kind}: caught ${f.recall}, right ${f.precision} of ${f.samples}`, f.recall >= 0.7 && f.precision >= 0.8);
}

section('the page says what was measured');
check('the page is measured when it is asked, by the shield running now', JSON.stringify(currentMasking().kinds) === JSON.stringify(figures) && Date.now() - Date.parse(currentMasking().measuredAt) < 600_000, JSON.stringify(figures));
check('and how many samples they came from', currentMasking().samples === CORPUS.length && currentMasking().clean === clean, `${CORPUS.length}/${clean}`);

section('the shield only ever counts');
{
  const shield = createShield({ key: 'corpus' });
  shield.maskText('lan@example.com, lan@example.com, binh@example.com, 0912345678, CCCD: 079123456789');
  const counts = shield.counts();
  check('different values, by kind', counts.EMAIL === 2 && counts.PHONE === 1 && counts.ID === 1, JSON.stringify(counts));
  check('and none of the values', !/example|0912345678|079123456789/.test(JSON.stringify(counts)));
}

section('what the model sees is no longer the value, and a split placeholder still comes back');
{
  const shield = createShield({ key: 'corpus' });
  const masked = shield.maskText('Ngày sinh: 12/03/1990, biển số 51F-123.45');
  check('the values are gone', !/12\/03\/1990|51F-123\.45/.test(masked), masked);
  const token = /<BIRTHDATE_[0-9a-f]{8}>/.exec(masked)?.[0];
  check('a longer kind has a token too', !!token, masked);
  const restoring = shield.restorer();
  const out = restoring.push(`sinh ${token.slice(0, 9)}`) + restoring.push(token.slice(9)) + restoring.flush();
  check('split across two deltas, it is put back', out === 'sinh 12/03/1990', out);
}

section('nothing here can be made slow');
{
  const cases = {
    'blank space': ' '.repeat(200_000),
    digits: '1'.repeat(200_000),
    'digits and dots': '1.'.repeat(100_000),
    capitals: 'Nguyễn '.repeat(30_000),
    'labels with nothing after': 'địa chỉ: '.repeat(20_000),
    'colons': 'a:'.repeat(100_000),
    'long word': 'a'.repeat(200_000),
    'plus signs': '+1 '.repeat(60_000),
    'a thousand rows': 'an.tran@cty.vn,Nguyễn Văn An,0912345678,12 Lê Lợi, Quận 1\n'.repeat(1_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const shield = createShield({ key: 'corpus' });
    const started = performance.now();
    shield.maskText(text);
    const ms = Math.round(performance.now() - started);
    check(`${name}: ${ms} ms`, ms < 1_500);
  }
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll deidentify corpus checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
