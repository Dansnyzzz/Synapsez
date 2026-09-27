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
const { formatValue, PALETTE } = __testing;

const scores = { labels: ['ADA', 'FIL', 'WLD', 'ENA'], series: [{ name: 'Tổng điểm', values: [36, 26, 27, 34] }] };
/** The heights of the drawn bars, in document order. */
const barHeights = (svg) => [...svg.matchAll(/<rect[^>]*class="bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));

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

console.log(
  failures === 0 ? '\n\x1b[32mAll chart checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
