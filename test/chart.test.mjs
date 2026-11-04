/**
 * Charts drawn from data rather than by hand.
 *
 * The failure this replaces: the model drew its own SVG, so a chart's quality
 * was whatever the model managed that turn — a free model produced crooked bars,
 * missing axes and unreadable labels. Handing it the numbers and drawing them in
 * code makes every chart identical in quality regardless of which model asked.
 *
 * What is pinned here is the arithmetic and the anatomy — bar heights in
 * proportion, every label present, a legend exactly when there is more than one
 * series, values direct-labelled — not the aesthetics, which no test can judge.
 *
 *   node test/chart.test.mjs
 */
let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { renderChart, __testing } = await import('../server/tools/chart.js');
const { formatValue, PALETTE, axisTicks } = __testing;

section('an axis for very small numbers ends (PERF-015)');
{
  // A step under 0.0005 used to round back onto the same tick for ever.
  const tiny = axisTicks(0.0000121);
  check('a coin priced at 0.000012 gets a handful of ticks', tiny.length >= 2 && tiny.length <= 6, JSON.stringify(tiny));
  check('  rising, and reaching the largest value', tiny.every((t, i) => i === 0 || t > tiny[i - 1]) && tiny[tiny.length - 1] >= 0.0000121, JSON.stringify(tiny));
  check('round numbers are kept round', JSON.stringify(axisTicks(1750)) === '[0,500,1000,1500,2000]', JSON.stringify(axisTicks(1750)));
  check('and a decimal step has no float noise', JSON.stringify(axisTicks(0.7)) === '[0,0.2,0.4,0.6,0.8]', JSON.stringify(axisTicks(0.7)));
  for (const type of ['bar', 'hbar', 'line', 'stacked']) {
    const svg = renderChart({ type, title: 'SHIB', data: { labels: ['Mon', 'Tue', 'Wed'], series: [{ name: 'USD', values: [0.0000121, 0.0000118, 0.0000125] }] } });
    check(`a ${type} chart of them is drawn rather than hanging`, typeof svg === 'string' && svg.includes('<svg'));
  }
}

const scores = { labels: ['ADA', 'FIL', 'WLD', 'ENA'], series: [{ name: 'Tổng điểm', values: [36, 26, 27, 34] }] };
/** The heights of the drawn bars, in document order. */
const barHeights = (svg) => [...svg.matchAll(/<rect[^>]*class="bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));

/**
 * The owner's screenshot 10 (2026-11-04): the fourth legend entry cut to "D" at
 * the right edge and "$100,000" cut to "$100.00". Everything drawn stays inside
 * the picture, whatever it is given. The real check of this, with a real font, is
 * in test/ui-round.test.mjs; this one is every form and every kind of bad day.
 */
section('everything drawn stays inside the picture');
{
  const { textWidth, fitText } = __testing;
  /** Each piece of text and where it reaches, by the same reckoning the layout uses. */
  const overflow = (svg) => {
    const [, W, H] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const out = [];
    const legend = /<g class="legend" transform="translate\(([\d.]+),([\d.]+)\)">/.exec(svg);
    for (const m of svg.matchAll(/(<g class="legend-item"[^>]*transform="translate\(([\d.]+),([\d.]+)\)">[\s\S]*?)?<text ([^>]*)>([^<]*)<\/text>/g)) {
      const attrs = m[4];
      if (/rotate/.test(attrs)) continue;
      const size = Number(/font-size="([\d.]+)"/.exec(attrs)?.[1] || 11);
      const text = m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const inLegend = m[1] && legend;
      const x = Number(/\bx="([\d.-]+)"/.exec(attrs)?.[1] || 0) + (inLegend ? Number(legend[1]) + Number(m[2]) : 0);
      const y = Number(/\by="([\d.-]+)"/.exec(attrs)?.[1] || 0) + (inLegend ? Number(legend[2]) + Number(m[3]) : 0);
      const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] || 'start';
      const width = textWidth(text, size);
      const from = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
      if (from < -0.5 || from + width > Number(W) + 0.5 || y < 0 || y > Number(H)) out.push(`"${text}" ${from.toFixed(0)}..${(from + width).toFixed(0)} at y ${y} in ${W}x${H}`);
    }
    return out;
  };
  const long = 'Doanh thu ròng của nền tảng trên mỗi khách hàng mỗi tháng theo từng mô hình kinh doanh khác nhau';
  const manyNames = ['A. 5,5% thuần (OpenRouter Standard)', 'B. Hybrid đúng: $99 + 3%', 'C. Thuê bao thuần (OrcaRouter $499)', 'D. Hybrid đề xuất: $99 + 1,1%', 'E. Một mô hình nữa với cái tên rất dài để xem nó có xuống dòng không', 'F. Thêm một cái'];
  const dollars = ['$200', '$1.000', '$5.000', '$20.000', '$100.000'];
  const cases = {
    'the owner\'s chart': { labels: dollars, series: manyNames.slice(0, 4).map((name, i) => ({ name, values: [10 + i, 40, 120, 500 * (i + 1), 2600 / (i + 1)] })) },
    'six long series': { labels: dollars, series: manyNames.map((name, i) => ({ name, values: [1, 2, 3, 4, 5 + i] })) },
    'a name longer than the picture': { labels: ['A', 'B'], series: [{ name: long.repeat(3), values: [1, 2] }, { name: 'Ngắn', values: [3, 4] }] },
    'long labels': { labels: [long, `${long} 2`, `${long} 3`], series: [{ name: 'x', values: [1, 2, 3] }] },
    'many labels': { labels: Array.from({ length: 60 }, (_, i) => `Tháng ${i + 1}`), series: [{ name: 'x', values: Array.from({ length: 60 }, (_, i) => i * 3) }, { name: 'y', values: Array.from({ length: 60 }, (_, i) => 200 - i) }] },
    'huge figures': { labels: ['A', 'B', 'C'], series: [{ name: 'x', values: [1_234_567_890, 987_654_321, 5_000_000_000] }, { name: 'y', values: [1, 2, 3] }] },
    'below zero': { labels: ['A', 'B', 'C'], series: [{ name: 'x', values: [-500, 200, -50] }, { name: 'y', values: [10, -900, 30] }] },
    'one point': { labels: [long], series: [{ name: 'x', values: [7] }] },
  };
  for (const [name, data] of Object.entries(cases)) {
    for (const type of ['bar', 'hbar', 'line', 'stacked', 'pie']) {
      for (const format of ['number', 'currency']) {
        const svg = renderChart({ type, title: long, data, format });
        const out = overflow(svg);
        check(`${type} · ${name} · ${format}`, out.length === 0, out.slice(0, 3).join(' | '));
      }
    }
  }
  const scatter = renderChart({ type: 'scatter', title: long, xLabel: long, yLabel: 'y', data: { series: manyNames.map((name, i) => ({ name, points: [[-1000000 * i, 2000000], [5_000_000, -3 * i]] })) }, format: 'currency' });
  check('scatter · long names and huge figures', overflow(scatter).length === 0, overflow(scatter).slice(0, 3).join(' | '));

  const ownersLegend = renderChart({ type: 'line', title: 'T', data: cases['the owner\'s chart'] });
  for (const name of cases['the owner\'s chart'].series.map((s) => s.name)) check(`  the legend names "${name.slice(0, 12)}…" whole`, ownersLegend.includes(`>${name.replace(/&/g, '&amp;')}<`));
  check('  over more than one row', new Set([...ownersLegend.matchAll(/class="legend-item"[^>]*translate\([\d.]+,(\d+)\)/g)].map((m) => m[1])).size > 1);
  check('  every label on the axis is there whole', dollars.every((label) => ownersLegend.includes(`>${label}<`)));

  const ends = [...renderChart({ type: 'line', title: 'T', data: { labels: ['a', 'b'], series: [{ name: 'x', values: [1, 100] }, { name: 'y', values: [1, 99] }, { name: 'z', values: [1, 98] }] } }).matchAll(/<text data-s="\d" [^>]*y="([\d.]+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  check('figures at the end of close lines do not sit on each other', ends.length === 3 && ends[1] - ends[0] >= 12 && ends[2] - ends[1] >= 12, ends.join(','));

  const below = renderChart({ type: 'line', title: 'T', data: cases['below zero'] });
  const dots = [...below.matchAll(/class="dot"[^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));
  const baseline = Math.max(...[...below.matchAll(/<line [^>]*y1="([\d.]+)"/g)].map((m) => Number(m[1])));
  check('a value below zero is on the plot, not over its labels', Math.max(...dots) <= baseline + 0.5, `${Math.max(...dots)} vs ${baseline}`);
  check('text is cut with an ellipsis, and only when it must be', fitText('short', 11, 500) === 'short' && fitText(long, 11, 100).endsWith('…') && textWidth(fitText(long, 11, 100), 11) <= 100);
  check('a tag cut in half by the ellipsis still cannot become markup', !renderChart({ type: 'bar', title: `<script>${long}`, data: { labels: [`<img src=x onerror=1>${long}`], series: [{ name: 'a', values: [1] }, { name: `<b>${long}${long}`, values: [2] }] } }).match(/<(script|img|b)\b/));
}

/*
 * Found by the security review of 2026-11-04: two points so large that a step is
 * lost in rounding never finished, and took the process down.
 */
section('numbers past what a step can move ends too');
{
  const { rangeTicks } = __testing;
  const big = rangeTicks(1e16, 10000000000000002);
  check('the axis comes to an end', big.length >= 1 && big.length <= 51, String(big.length));
  const svg = renderChart({ type: 'scatter', title: 'Big', data: { series: [{ name: 'a', points: [[1e16, 1], [10000000000000002, 2]] }] } });
  check('  and the chart is drawn', svg.startsWith('<svg'));
  check('the widest there are do not overflow into nothing', rangeTicks(-1.7e308, 1.7e308).length >= 1);
  check('small ones keep their steps', new Set(rangeTicks(0.00000012, 0.00000099)).size >= 3, JSON.stringify(rangeTicks(0.00000012, 0.00000099)));
  const long = 'x'.repeat(5_000_000);
  const started = Date.now();
  renderChart({ type: 'bar', title: long, data: { labels: [long, long], series: [{ name: long, values: [1, 2] }, { name: long, values: [3, 4] }] } });
  check('a label of millions of characters costs next to nothing', Date.now() - started < 2000, `${Date.now() - started} ms`);
}

section('a bar chart is drawn in proportion');
{
  const svg = renderChart({ type: 'bar', title: 'So sánh', data: scores });
  check('it is an svg element', /^<svg[\s>]/.test(svg), svg.slice(0, 40));
  check('every label appears', ['ADA', 'FIL', 'WLD', 'ENA'].every((l) => svg.includes(l)));
  check('every value is direct-labelled', ['36', '26', '27', '34'].every((v) => svg.includes(`>${v}<`)), 'values on the marks');

  const heights = barHeights(svg);
  check('one bar per data point', heights.length === 4, `${heights.length}`);
  // 36 is the tallest, 26 the shortest — the drawing must say the same thing
  // the numbers do, which is the whole point of drawing it in code.
  check('the largest value is the tallest bar', Math.max(...heights) === heights[0], heights.join(','));
  check('the smallest value is the shortest bar', Math.min(...heights) === heights[1], heights.join(','));
  check('heights are proportional', Math.abs(heights[0] / heights[1] - 36 / 26) < 0.02, `${heights[0]}/${heights[1]}`);
}

section('a legend appears exactly when identity needs one');
{
  const one = renderChart({ type: 'bar', title: 'T', data: scores });
  check('one series needs no legend — the title names it', !one.includes('class="legend"'));

  const two = renderChart({
    type: 'bar',
    title: 'T',
    data: { labels: ['A', 'B'], series: [{ name: 'Trước', values: [1, 2] }, { name: 'Sau', values: [3, 4] }] },
  });
  check('two series get a legend', two.includes('class="legend"'));
  check('and both names are in it', two.includes('Trước') && two.includes('Sau'));
  check('with a colour per series, in fixed order', two.includes(PALETTE[0]) && two.includes(PALETTE[1]));
}

section('every form draws something valid');
{
  for (const type of ['bar', 'hbar', 'line', 'pie', 'stacked']) {
    const svg = renderChart({ type, title: `T ${type}`, data: scores });
    check(`${type} renders an svg`, /^<svg[\s>]/.test(svg) && svg.endsWith('</svg>'), `${svg.length} chars`);
    check(`${type} keeps the labels`, svg.includes('ADA'), '');
  }
  const donut = renderChart({ type: 'pie', title: 'T', data: scores });
  check('a pie shows the total in the middle', donut.includes('123'), 'sum of 36+26+27+34');
}

section('numbers are formatted the way the question was asked');
{
  check('plain numbers get thousands separators', formatValue(1234567, 'number') === '1,234,567');
  check('percent gets a sign', formatValue(12.34, 'percent') === '12.3%');
  check('currency gets a symbol', formatValue(1234, 'currency') === '$1,234');
  check('a chart carries the format through', renderChart({ type: 'bar', title: 'T', data: { labels: ['A'], series: [{ name: 's', values: [50] }] }, format: 'percent' }).includes('50%'));
}

section('bad input is refused with a reason, not drawn wrong');
{
  const bad = (args) => {
    try {
      renderChart(args);
      return '';
    } catch (err) {
      return err.message;
    }
  };
  check('an unknown type says which are available', /bar|line|pie/.test(bad({ type: 'radar', title: 'T', data: scores })));
  check('no labels is refused', bad({ type: 'bar', title: 'T', data: { labels: [], series: [{ name: 's', values: [] }] } }).length > 0);
  check('no series is refused', bad({ type: 'bar', title: 'T', data: { labels: ['A'] } }).length > 0);
  check(
    'a series whose length does not match the labels is refused',
    /label/i.test(bad({ type: 'bar', title: 'T', data: { labels: ['A', 'B'], series: [{ name: 's', values: [1] }] } })),
  );
}

section('text from the model cannot become markup');
{
  const svg = renderChart({
    type: 'bar',
    title: 'T',
    data: { labels: ['<script>x</script>', 'a & b'], series: [{ name: 's', values: [1, 2] }] },
  });
  check('a tag in a label is escaped', !svg.includes('<script>'), 'no raw script tag');
  check('and an ampersand too', svg.includes('&amp;'), 'a &amp; b');

  // A series name only reaches the drawing through the legend, so escape it there too.
  const two = renderChart({
    type: 'bar',
    title: 'T',
    data: { labels: ['A'], series: [{ name: '<b>x</b>', values: [1] }, { name: 'y & z', values: [2] }] },
  });
  check('a tag in a series name is escaped', !two.includes('<b>'), 'legend is escaped');
  check('and an ampersand in a series name', two.includes('y &amp; z'));
}

section('the axis always reaches the tallest value');
{
  const { axisTicks } = __testing;
  for (const max of [1750, 1500, 1, 7, 99, 2024, 0.37, 262144]) {
    const ticks = axisTicks(max);
    check(`an axis for ${max} tops out at or above it`, ticks[ticks.length - 1] >= max, ticks.join(','));
    check(`  and not a whole step beyond`, ticks.length < 2 || ticks[ticks.length - 2] < max, ticks.join(','));
  }
  // The screenshot: VNBank at 1,750 drawn through the title.
  const svg = renderChart({
    type: 'bar',
    title: 'T',
    data: { labels: ['VNBank', 'Viettel'], series: [{ name: 'Doanh thu', values: [1750, 1620] }] },
  });
  const tops = [...svg.matchAll(/class="bar"[^>]*? y="([\d.]+)"/g)].map((m) => Number(m[1]));
  check('no bar is drawn above the plot', tops.every((y) => y >= 46 - 0.5), tops.join(','));
}

section('every mark says which point it is, so the browser can read it on hover');
{
  const data = { labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [3, 2, 1] }] };
  for (const type of ['bar', 'hbar', 'line', 'stacked']) {
    const svg = renderChart({ type, title: 'T', data });
    const hits = svg.match(/class="hit hit--(col|row)" data-i="\d+"/g) || [];
    check(`${type}: one hover target per label`, hits.length === 3, String(hits.length));
    check(`${type}: marks carry label and series`, /data-i="2" data-s="1"/.test(svg));
    check(`${type}: the legend names its series`, /class="legend-item" data-s="1"/.test(svg));
  }
  const pie = renderChart({ type: 'pie', title: 'T', data: { labels: ['a', 'b'], series: [{ name: 's', values: [1, 3] }] } });
  check('pie: each slice is its own hover target', (pie.match(/class="slice hit" data-i=/g) || []).length === 2);
}

section('a scatter chart plots pairs, negative ones included');
{
  const { scatterSpec } = await import('../server/tools/chart.js');
  const data = {
    series: [
      { name: 'Hà Nội', points: [[1, 10], [2, 20], [3, -5]] },
      { name: 'HCM', points: [{ x: 4, y: 40, label: 'Q4' }] },
    ],
  };
  const svg = renderChart({ type: 'scatter', title: 'T', data, xLabel: 'Tháng', yLabel: 'Doanh thu' });
  const dots = [...svg.matchAll(/class="dot" data-i="(\d+)" data-s="(\d)" cx="([\d.]+)" cy="([\d.]+)"/g)];
  check('one dot per point', dots.length === 4, String(dots.length));
  check('one hover target per point', (svg.match(/class="hit hit--pt"/g) || []).length === 4);
  check('a larger x sits further right', Number(dots[1][3]) > Number(dots[0][3]));
  check('a larger y sits higher', Number(dots[1][4]) < Number(dots[0][4]));
  check('a negative y sits lowest', Number(dots[2][4]) > Number(dots[0][4]));
  check('the axes are named', svg.includes('Tháng') && svg.includes('Doanh thu'));
  check('the legend names both series', /class="legend-item" data-s="1"/.test(svg));
  const spec = scatterSpec({ data, xLabel: 'Tháng', yLabel: 'Doanh thu' });
  check('the spec has a label per point', spec.labels.length === 4 && spec.labels[3] === 'Q4', spec.labels.join('|'));
  check('the spec knows each point’s series', spec.group.join('') === '0001');
  check('x and y travel as the two series', spec.series[0].values.join() === '1,2,3,4' && spec.series[1].name === 'Doanh thu');
  let threw = '';
  try {
    renderChart({ type: 'scatter', title: 'T', data: { series: [{ name: 's', points: [[1, 'a']] }] } });
  } catch (e) {
    threw = e.message;
  }
  check('a point that is not two numbers is refused', /not two numbers/.test(threw), threw);
  const flat = renderChart({ type: 'scatter', title: 'T', data: { series: [{ name: 's', points: [[5, 5], [5, 5]] }] } });
  check('all points equal still draws', !/NaN/.test(flat));
}

console.log(
  failures === 0 ? '\n\x1b[32mAll chart checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
