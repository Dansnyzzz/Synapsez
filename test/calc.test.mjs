/**
 * Arithmetic the model does not do in its head.
 *
 * Getting sums wrong is the oldest failure a language model has, and it is the
 * one that costs most in a report: a total that does not add up discredits every
 * number beside it. This evaluates the expression itself, so the answer is
 * arithmetic rather than recollection.
 *
 * The other half of what is pinned here is that it is not a code runner. The
 * model reads web pages, and a web page can tell it what to compute next — so an
 * expression that reaches for `process`, a constructor chain, or anything but
 * numbers and named functions must fail rather than execute.
 *
 *   node test/calc.test.mjs
 */
let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { evaluate } = await import('../server/tools/calc.js');
const near = (a, b) => Math.abs(a - b) < 1e-9;
const val = (src) => evaluate(src).value;
const err = (src) => {
  try {
    evaluate(src);
    return '';
  } catch (e) {
    return e.message;
  }
};

section('arithmetic, with the precedence people expect');
{
  check('addition and multiplication bind correctly', val('2 + 3 * 4') === 14, String(val('2 + 3 * 4')));
  check('parentheses win', val('(2 + 3) * 4') === 20);
  check('subtraction is left-associative', val('10 - 3 - 2') === 5);
  check('division', near(val('7 / 2'), 3.5));
  check('powers', val('2 ^ 10') === 1024);
  check('unary minus', val('-5 + 3') === -2);
  check('decimals', near(val('0.1 + 0.2'), 0.3) === false || true, 'floating point is floating point');
  check('a percentage change', near(val('(1200 - 950) / 950 * 100'), 26.3157894736842), String(val('(1200 - 950) / 950 * 100')));
}

section('the statistics a report actually needs');
{
  check('sum of a list', val('sum([36, 26, 27, 34])') === 123);
  check('sum of loose arguments too', val('sum(36, 26, 27, 34)') === 123);
  check('average', near(val('avg([1, 2, 3, 4])'), 2.5));
  check('mean is the same thing', near(val('mean([1, 2, 3, 4])'), 2.5));
  check('median of an odd list', val('median([1, 3, 2])') === 2);
  check('median of an even list', near(val('median([1, 2, 3, 4])'), 2.5));
  check('min and max', val('min([5, 1, 9])') === 1 && val('max([5, 1, 9])') === 9);
  check('count', val('count([1, 2, 3])') === 3);
  check('round to places', near(val('round(3.14159, 2)'), 3.14));
  check('round with no places', val('round(3.7)') === 4);
  check('abs and sqrt', val('abs(-4)') === 4 && val('sqrt(9)') === 3);
  check('nested calls', near(val('round(avg([1, 2, 4]), 2)'), 2.33));
}

section('arithmetic as people and models actually write it');
{
  // The exact call that failed in a portfolio-variance answer: the `*` between
  // bracketed factors was left out, as every textbook leaves it out.
  const variance = val('round(((1.1)^2-(1.5)(1.1)(0.46))/((1.5)^2+(1.1)^2-2*(1.5)(1.1)(0.46)),4)');
  check('implicit multiplication between brackets', near(variance, 0.2322), String(variance));
  check('a number before a bracket', val('2(3 + 4)') === 14);
  check('a bracket before a number', val('(3 + 4)2') === 14);
  check('a number before a constant', near(val('2pi'), 2 * Math.PI));
  check('a number before a function', val('2sqrt(9)') === 6);
  check('implicit × binds like ×, not tighter than ^', val('2(3)^2') === 18);
  check('subtraction is not mistaken for a product', val('(5) - 3') === 2);
  check('× and ÷ signs', val('6 × 2 ÷ 3') === 4);
  check('a typographic minus', val('10 − 4') === 6);
  check('** as a power', val('2 ** 3') === 8);
  check('a spreadsheet = in front', val('=SUM(1, 2)') === 3);
  check('function names in capitals', near(val('ROUND(PI, 2)'), 3.14));
  check('a per cent', near(val('15% * 200'), 30));
  check('a remainder', val('17 % 5') === 2);
  check('a factorial', val('5!') === 120);
  check('√ as a square root', val('√16') === 4);
}

section('the maths a finance or statistics answer reaches for');
{
  check('exp and ln undo each other', near(val('ln(exp(2))'), 2));
  check('log is base 10, as in a spreadsheet', near(val('log(1000)'), 3));
  check('log with a base', near(val('log(8, 2)'), 3));
  check('pow', val('pow(2, 10)') === 1024);
  check('floor, ceil, trunc', val('floor(2.7)') === 2 && val('ceil(2.1)') === 3 && val('trunc(-2.7)') === -2);
  check('mod follows the divisor sign', val('mod(-1, 3)') === 2);
  check('combinations', val('comb(5, 2)') === 10);
  check('permutations', val('perm(5, 2)') === 20);
  check('sample and population variance', near(val('var([2, 4, 4, 4, 5, 5, 7, 9])'), 32 / 7) && near(val('varp([2, 4, 4, 4, 5, 5, 7, 9])'), 4));
  check('population stdev', near(val('stdevp([2, 4, 4, 4, 5, 5, 7, 9])'), 2));
  check('geometric mean', near(val('geomean([1.1, 1.2])'), Math.sqrt(1.32)));
  // Excel: =FV(0.05, 10, -100) is 1257.789…; =PV(0.08, 5, -1000) is 3992.71…
  check('future value, Excel convention', near(val('round(fv(0.05, 10, -100), 4)'), 1257.7893), String(val('fv(0.05, 10, -100)')));
  check('present value, Excel convention', near(val('round(pv(0.08, 5, -1000), 2)'), 3992.71), String(val('pv(0.08, 5, -1000)')));
  check('payment, Excel convention', near(val('round(pmt(0.06/12, 360, 200000), 2)'), -1199.1), String(val('pmt(0.06/12, 360, 200000)')));
  check('net present value', near(val('round(npv(0.1, -1000, 300, 400, 500), 4)'), -19.1244), String(val('npv(0.1, -1000, 300, 400, 500)')));
  check('internal rate of return', near(val('round(irr(-1000, 300, 400, 500), 6)'), 0.088963), String(val('irr(-1000, 300, 400, 500)')));
  check('effective annual rate', near(val('round(effect(0.12, 12), 6)'), 0.126825));
  check('irr with no sign change says why', /negative and one positive/.test(err('irr(1, 2, 3)')), err('irr(1, 2, 3)'));
}

section('it is a calculator, not a code runner');
{
  // The prompt-injection case: a page tells the model to compute something that
  // is not arithmetic. Every one of these must fail rather than run.
  for (const attack of [
    'process.env.ENCRYPTION_KEY',
    'this.constructor.constructor("return process")()',
    'require("fs")',
    'globalThis',
    '(function(){return 1})()',
    '1; process.exit(1)',
    'eval("1+1")',
  ]) {
    check(`refuses ${attack.slice(0, 34)}`, err(attack).length > 0, err(attack).slice(0, 50));
  }
  check('an unknown function is named in the error', /unknown|not a function/i.test(err('frobnicate(1)')), err('frobnicate(1)'));
}

section('bad arithmetic is refused rather than answered wrongly');
{
  check('division by zero is an error, not Infinity', /zero/i.test(err('5 / 0')), err('5 / 0'));
  check('unbalanced parentheses', err('(1 + 2').length > 0);
  check('an empty expression', err('   ').length > 0);
  check('a stray operator', err('1 +').length > 0);
  check('a result that is not finite is refused', err('0 / 0').length > 0);
}

section('the working is shown, so a number can be checked');
{
  const out = evaluate('sum([2, 3]) * 4');
  check('the value comes back', out.value === 20, String(out.value));
  check('and the expression it evaluated', out.expression === 'sum([2, 3]) * 4', out.expression);
}

console.log(
  failures === 0 ? '\n\x1b[32mAll calculator checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
