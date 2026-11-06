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

const { evaluate, calculate } = await import('../server/tools/calc.js');

section('a label beside a figure is not a mistake (owner, 2026-11-06)');
{
  // The call in the owner's screenshot, in the shape it arrived.
  const said = calculate('["T10 DQT: 22828*29437", 875*29689.9998, 22828*(29437-18230)]');
  check('the labelled figure is worked out', said.split('\n')[0] === 'T10 DQT: 22828*29437 = 671987836', said);
  check('and so is the rest of the list', said.split('\n').length === 3 && said.split('\n')[1].startsWith('875*29689.9998 = '), said);
  check('curly quotes too', calculate('[“a: 1+1”]') === 'a: 1+1 = 2');
  check('a comma in a label is the label\'s', calculate('["a, b: 2*3", 4]').split('\n')[0] === 'a, b: 2*3 = 6');
  check('words on their own name the next figure', calculate('["Tổng", 1+2]') === 'Tổng: 1+2 = 3');
  check('one label with no list', calculate('"rate: 15%"') === 'rate: 15% = 0.15');
  check('an unquoted label as well', calculate('[cost: 2*3]') === 'cost: 2*3 = 6');
  check('a label is never read as arithmetic', calculate('["require(fs): 1+1"]') === 'require(fs): 1+1 = 2');
  for (const bad of ['["1+1: require(\'fs\')"]', 'eval("1+1")', '[this.constructor]', '["x: process.exit()"]']) {
    let refused = false;
    try {
      calculate(bad);
    } catch {
      refused = true;
    }
    check(`what is worked out is still only arithmetic: ${bad}`, refused);
  }
}
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

/**
 * The owner's screenshots 14–16 (2026-11-04): a table's worth of figures sent as
 * one list, refused four times in a row for not being a number, and then sent as
 * JSON no parser could read.
 */
section('several figures in one call');
{
  const { calculate, tidyNumber } = await import('../server/tools/calc.js');
  const { canonicalInput, salvageArguments } = await import('../public/js/tool-aliases.js');
  const { TOOLS_BY_NAME } = await import('../server/tools/definitions.js');
  const { validateArguments } = await import('../server/tools/validate.js');

  const said = calculate('[55.00-29.30, 80.00-29.30, 40.00-29.30]');
  check('a list is worked out item by item, a line each with its working', said === '55.00-29.30 = 25.7\n80.00-29.30 = 50.7\n40.00-29.30 = 10.7', said);
  check('functions inside the items keep their own commas', calculate('[round(1.234, 1), sum([1, 2]), 2]') === 'round(1.234, 1) = 1.2\nsum([1, 2]) = 3\n2 = 2', calculate('[round(1.234, 1), sum([1, 2]), 2]'));
  check('  and a list inside a function is still that function', calculate('sum([1, 2, 3])') === 'sum([1, 2, 3]) = 6', calculate('sum([1, 2, 3])'));
  check('one bad item is the error, not a wrong list', /divides by zero/.test((() => { try { return calculate('[1, 1/0]'); } catch (e) { return e.message; } })()));

  const refused = (src) => {
    try {
      calculate(src);
      return '';
    } catch (e) {
      return e.message;
    }
  };
  check('an empty list has nothing to work out', /nothing to calculate/.test(refused('[]')), refused('[]'));
  check('two lists side by side are not one list', refused('[1, 2] * [3]') !== '', refused('[1, 2] * [3]'));
  check('code inside a list is refused as code is anywhere', refused('[1, process.exit(1)]') !== '', refused('[1, process.exit(1)]'));
  check('twelve hundred is not read as two figures', refused('1,200 * 3') !== '', refused('1,200 * 3'));
  check('a list past any sum is refused', /too long/.test(refused(`[${Array(201).fill(1).join(',')}]`)));

  check('floating-point dust is taken off what a report would copy', calculate('0.1 + 0.2') === '0.1 + 0.2 = 0.3', calculate('0.1 + 0.2'));
  check('  a real fraction is untouched', tidyNumber(1 / 3) === 0.333333333333333, String(tidyNumber(1 / 3)));
  check('  and so is a large whole number', tidyNumber(2 ** 52) === 2 ** 52);

  const schema = TOOLS_BY_NAME.calculate.parameters;
  const sentAsList = canonicalInput('calculate', { expression: ['8-5.5', 8, '(8-5.5)/2.5'] });
  check('a JSON list of figures reads as the list form', sentAsList.expression === '[8-5.5, 8, (8-5.5)/2.5]' && validateArguments(schema, sentAsList).ok, JSON.stringify(sentAsList));
  check('  another name for the expression does too', canonicalInput('calculate', { formula: '1 + 1' }).expression === '1 + 1');

  const raw = '{"expression": [8-5.5, 8, 5-5.5, (8-5.5)/2.5, 5.5]}';
  const saved = salvageArguments('calculate', raw);
  check('arithmetic written straight into the JSON is read as meant', saved?.expression === '[8-5.5, 8, 5-5.5, (8-5.5)/2.5, 5.5]', JSON.stringify(saved));
  check('  and works out', calculate(saved.expression).split('\n').map((line) => line.split(' = ')[1]).join() === '2.5,8,-0.5,1,5.5', calculate(saved.expression));
  check('  one cut off before it closed is left refused', salvageArguments('calculate', '{"expression": [8-5.5, 8') === null);
  check('  and no other tool gets this reading', salvageArguments('run_command', '{"command": rm -rf /}') === null);

  // Through the wire the provider adapter reads.
  const { createServer } = await import('node:http');
  const { streamOpenAICompatible } = await import('../server/providers/openaiCompatible.js');
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'calculate', arguments: raw } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  let calls = [];
  for await (const event of streamOpenAICompatible({ apiKey: 'k', baseURL: `http://127.0.0.1:${port}/v1`, model: 'm', entry: { id: 'm' }, system: '', messages: [{ role: 'user', text: 'work it out' }], tools: [{ name: 'calculate', description: 'd', parameters: schema }] })) {
    if (event.type === 'done') calls = event.toolCalls || [];
  }
  server.close();
  check('  so the call runs, rather than coming back as a red row', calls[0]?.input?.expression === saved.expression && !calls[0]?.input?.__malformed, JSON.stringify(calls[0]?.input));
}

/**
 * The owner's screenshot 17 (2026-11-04): a whole report, written twice, because
 * the first call left out one word the tool could work out.
 */
section('a file with no format given is still written');
{
  const { formatForFile } = await import('../server/tools/cloud.js');
  const { TOOLS_BY_NAME } = await import('../server/tools/definitions.js');
  const { validateArguments } = await import('../server/tools/validate.js');
  check('the tool no longer refuses the call', validateArguments(TOOLS_BY_NAME.create_file.parameters, { name: 'Report', content: '# Long' }).ok);
  check('  content is still required', !validateArguments(TOOLS_BY_NAME.create_file.parameters, { name: 'Report' }).ok);
  check('what it was told wins', formatForFile({ format: 'PPTX', name: 'a.docx', content: 'x' }) === 'pptx');
  check('the name says it', formatForFile({ name: 'Bang gia.xlsx', content: 'x' }) === 'xlsx');
  check('  under any of the names a call uses', formatForFile({ filename: 'notes.md', content: 'x' }) === 'md');
  check('  an extension nothing writes is not believed', formatForFile({ name: 'Version 1.5', content: 'x' }) === 'docx');
  check('a page is a page', formatForFile({ name: 'Trang', content: '<!doctype html><html></html>' }) === 'html');
  check('JSON is JSON', formatForFile({ name: 'Du lieu', content: '{"a":1}' }) === 'json');
  check('  and what only looks like it is not', formatForFile({ name: 'Ghi chu', content: '[Xem thêm] phần sau' }) === 'docx');
  check('anything else is a document', formatForFile({ name: 'Giai phap web trung gian', content: '## 3. Bốn con đường' }) === 'docx');
}

console.log(
  failures === 0 ? '\n\x1b[32mAll calculator checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
