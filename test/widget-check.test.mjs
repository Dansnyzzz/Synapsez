/**
 * What a reader would see wrong in a diagram, found before it is shown (owner,
 * 2026-11-11: a dark title on the dark theme, a legend off its box, labels over each
 * other, a Chinese word in Vietnamese), and a clean one kept as a file of the
 * conversation.
 *
 *   node test/widget-check.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'widget-check-test-encryption-key';
process.env.SESSION_SECRET ||= 'widget-check-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-widget-check-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { checkDiagram, contrast, colour } = await import('../server/widgetCheck.js');

section('the owner\'s diagram, as it went wrong');
{
  const broken = `<svg viewBox="0 0 1200 700" xmlns="http://www.w3.org/2000/svg">
    <text x="600" y="40" text-anchor="middle" font-size="22" fill="#333">Sơ đồ mối quan hệ các chủ thể – Luật thương mại quốc tế</text>
    <rect x="40" y="80" width="200" height="70" rx="8" fill="#e3f2fd" stroke="#2196f3"/>
    <text x="140" y="110" text-anchor="middle" font-size="14" font-weight="bold" fill="#1a237e">CLN Co.,Ltd</text>
    <text x="140" y="132" text-anchor="middle" font-size="12" fill="#555">Người vận chuyển / Hãng tàu</text>
    <rect x="260" y="80" width="220" height="90" rx="8" fill="#fff3e0" stroke="#ff9800"/>
    <text x="370" y="110" text-anchor="middle" font-size="14" fill="#333">CP Tập đoàn Ix</text>
    <text x="400" y="125" font-size="13" fill="#333">Hợp đồng bán gạo CIF</text>
    <text x="398" y="128" font-size="13" fill="#333">Người gửi hàng</text>
    <rect x="300" y="520" width="600" height="120" fill="#ffffff"/>
    <text x="600" y="560" text-anchor="middle" font-size="14" fill="#222">• Vụ án 2023: Hãng tàu (CLN) cấp Vận đơn cho người thuê tàu (Đ D), vì hợp đồng của Người bán (Ix) với Người mua (AP) → hàng giao cho Người nhận (Sta.Cruz).</text>
    <text x="600" y="600" font-size="12" fill="#eeeeee">Mô hình vẽ minh họa từ nội dung bản án</text>
    <text x="100" y="660" font-size="12" fill="#444">Có một lỗi文字 trong nhãn năm</text>
    <text x="1000" y="690" font-size="13" fill="#444">Tàu Amnifed Sun: Sài Gòn → Havana, Nuevitas (Cuba)</text>
  </svg>`;
  const { issues, canvas } = checkDiagram(broken);
  const said = issues.join('\n');
  check('it was drawn for paper: dark text, so a light canvas', canvas === 'light', canvas);
  check('a legend line wider than its box is found', /Vụ án 2023.*wider than its box|Vụ án 2023.*runs off/.test(said), said);
  check('  and one running off the drawing', /runs off the side/.test(said));
  check('labels drawn on top of each other are found', /on top of each other/.test(said));
  check('pale text on a white box is found', /hard to read/.test(said));
  check('Chinese characters in Vietnamese text are found', /Chinese characters/.test(said));
  check('at most eight, each a sentence the model can act on', issues.length <= 8 && issues.every((s) => s.length > 20));
}

section('a clean diagram has nothing to fix');
{
  const clean = `<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg">
    <style>.box{font-size:14px;fill:#1d2733}.t{font-size:18px;font-weight:bold;fill:#111}</style>
    <text class="t" x="320" y="30" text-anchor="middle">Luồng đặt hàng</text>
    <rect x="20" y="60" width="180" height="60" fill="#e8f0fe"/>
    <text class="box" x="110" y="95" text-anchor="middle">Bạn đặt yêu cầu</text>
    <rect x="240" y="60" width="180" height="60" fill="#e6f4ea"/>
    <text class="box" x="330" y="88" text-anchor="middle"><tspan x="330" dy="0">Kho xác nhận</tspan><tspan x="330" dy="1.3em">trong 2 giờ</tspan></text>
    <rect x="460" y="60" width="160" height="60" fill="#fef7e0"/>
    <text class="box" x="540" y="95" text-anchor="middle">Giao hàng</text>
  </svg>`;
  const { issues, canvas } = checkDiagram(clean);
  check('no problems found', issues.length === 0, issues.join(' | '));
  check('  classes in <style> are read for size and colour', canvas === 'light');
  const dark = checkDiagram('<svg viewBox="0 0 300 100"><rect x="0" y="0" width="300" height="100" fill="#111827"/><text x="20" y="50" font-size="16" fill="#f8fafc">Night mode</text></svg>');
  check('one drawn on its own dark background is a dark canvas, and fine', dark.canvas === 'dark' && dark.issues.length === 0, JSON.stringify(dark));
  // A drawing that scopes its rules under its own id (as Ephapse's diagrams do) is read the same.
  const scoped = checkDiagram('<svg id="d7" viewBox="0 0 300 100"><style>#d7 .t{font-size:14px;fill:#f2f2f2}</style><rect x="0" y="0" width="300" height="100" fill="#ffffff"/><text class="t" x="20" y="50">Pale on white</text></svg>');
  check('rules scoped under the drawing\'s own id are read: a pale class on white is found', scoped.issues.some((s) => /Pale on white.*hard to read/.test(s)), scoped.issues.join(' | '));
  const moved = checkDiagram('<svg viewBox="0 0 100 100"><g transform="translate(500,0)"><text x="0" y="20" font-size="14" fill="#222">Far away but moved</text></g></svg>');
  check('a text inside a transformed group is not judged by where it seems to be', !moved.issues.some((s) => /runs off/.test(s)), moved.issues.join(' | '));
  check('contrast is WCAG\'s', Math.round(contrast(colour('#000'), colour('#fff'))) === 21 && contrast(colour('#777'), colour('#7a8a88')) < 3);
}

section('show_widget says what is wrong, and keeps a clean diagram as a file');
{
  const { PGlite } = await import('@electric-sql/pglite');
  const { initStore } = await import('../server/store/index.js');
  const db = await PGlite.create();
  const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
  const store = await initStore({ driver: sql });
  const user = await store.createUser({ id: crypto.randomUUID(), role: 'user', name: 'W', email: 'w@widget.test', passwordHash: 'x' });
  const chatId = crypto.randomUUID();
  await store.createChat(user.id, { id: chatId, title: 'Diagram' });
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const bad = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Sơ đồ', svg: '<svg viewBox="0 0 200 100"><rect x="10" y="10" width="60" height="30" fill="#fff"/><text x="12" y="30" font-size="14" fill="#222">Một nhãn rất dài không vừa hộp</text></svg>' }, { userId: user.id, chatId });
  check('a diagram with problems is drawn, and the model is told to draw it again', /will see these problems/.test(bad.content) && /show_widget/.test(bad.content) && bad.widget?.markup, bad.content.slice(0, 160));
  check('  and it is not kept as a file yet', (await store.listGeneratedFiles(user.id, chatId)).length === 0);
  const good = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Luồng: đặt / giao', svg: '<svg viewBox="0 0 200 100"><rect x="10" y="10" width="180" height="40" fill="#e8f0fe"/><text x="100" y="35" text-anchor="middle" font-size="14" fill="#1d2733">Đặt hàng</text></svg>' }, { userId: user.id, chatId });
  const files = await store.listGeneratedFiles(user.id, chatId);
  check('a clean one is kept as a file of the conversation, for its panel', files.length === 1 && files[0].name === 'Luồng đặt giao.svg' && /kept it as a file/.test(good.content), JSON.stringify(files.map((f) => f.name)));
  check('  and the page is told its canvas', good.widget?.canvas === 'light');

  section('show_widget draws a `diagram` it lays out itself (1.34.0)');
  const { validateDiagram, ICON_NAMES } = await import('../server/diagram/validate.js');
  const { TOOLS_BY_NAME } = await import('../server/tools/definitions.js');
  const pipeline = {
    groups: [{ id: 'client', title: 'Phía người dùng' }, { id: 'server', title: 'Máy chủ Ephapse' }],
    nodes: [
      { id: 'user', title: 'Người dùng', kind: 'pill', icon: 'user' },
      { id: 'app', title: 'Tầng 1 — Ứng dụng', lines: ['RAPTOR: cây tóm tắt', 'MemGPT, Mem0'], group: 'client' },
      { id: 'gw', title: 'Tầng 2 — Cổng API', lines: ['Nén prompt'], group: 'server', icon: 'server' },
      { id: 'db', title: 'Cơ sở dữ liệu', group: 'server', icon: 'database' },
      { id: 'done', title: 'Trả lời', kind: 'pill' },
    ],
    edges: [
      { from: 'user', to: 'app', label: 'câu hỏi' },
      { from: 'app', to: 'gw', label: 'prompt đã nén' },
      { from: 'gw', to: 'db', style: 'dashed' },
      { from: 'gw', to: 'done' },
    ],
  };
  const before = (await store.listGeneratedFiles(user.id, chatId)).length;
  const drawn = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Đường đi của một câu hỏi', diagram: pipeline }, { userId: user.id, chatId });
  check('a diagram comes back as an SVG widget for a light canvas', drawn.widget?.kind === 'svg' && drawn.widget.canvas === 'light' && /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(drawn.widget.markup), JSON.stringify(drawn.widget || {}).slice(0, 120));
  check('  with nothing for the drawing check to find', checkDiagram(drawn.widget.markup).issues.length === 0, checkDiagram(drawn.widget.markup).issues.join(' | '));
  const after = await store.listGeneratedFiles(user.id, chatId);
  check('  kept as a file of the conversation, named from its title', after.length === before + 1 && after.some((f) => f.name === 'Đường đi của một câu hỏi.svg') && /kept it as a file/.test(drawn.content), JSON.stringify(after.map((f) => f.name)));
  check('  and the model is told which way it was laid out, not to redraw it', /laid out (left to right|top to bottom)/.test(drawn.content) && !/draw it again|problems/i.test(drawn.content), drawn.content);
  const dark = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Tối', diagram: { ...pipeline, theme: 'dark' } }, { userId: user.id, chatId });
  check('a dark diagram is for a dark canvas, and the check reads it so', dark.widget.canvas === 'dark' && checkDiagram(dark.widget.markup).canvas === 'dark' && checkDiagram(dark.widget.markup).issues.length === 0);
  const unsaved = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Không lưu', diagram: pipeline }, {});
  check('with no account it is drawn and not kept', unsaved.widget?.markup?.startsWith('<svg') && !/kept it as a file/.test(unsaved.content));

  const broken = { nodes: [{ id: 'app', title: 'App' }], edges: [{ from: 'app', to: 'gw' }] };
  const said = validateDiagram(broken).error;
  const failed = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Hỏng', diagram: broken }, { userId: user.id, chatId }).then(() => null, (err) => err.message);
  check('a bad diagram fails with the validation message as the tool\'s error', failed === said && /"gw"/.test(said), failed);
  check('  and nothing is kept', (await store.listGeneratedFiles(user.id, chatId)).length === before + 2);
  const two = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Hai', diagram: pipeline, svg: '<svg></svg>' }, {}).then(() => null, (err) => err.message);
  check('a diagram with an svg as well is refused: one picture at a time', /one of `diagram`, `svg` or `html`/.test(two || ''), two);
  const none = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Trống' }, {}).then(() => null, (err) => err.message);
  check('  and nothing at all names all three', /`diagram`, `svg` or `html`/.test(none || ''), none);
  const wall = 'Định tuyến mô hình theo chi phí và độ trễ cho từng yêu cầu của người dùng cuối nhé'.slice(0, 80);
  const icons = ['user', 'server', 'database', 'cloud', 'cache', 'gear', 'document', 'chat', 'lock', 'chart', 'search', 'bolt'];
  const huge = {
    groups: Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, title: wall.slice(0, 60) })),
    nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: wall.slice(0, 60), lines: Array.from({ length: 6 }, () => wall), icon: icons[i % 12], ...(i < 16 ? { group: `g${i % 8}` } : {}) })),
    edges: Array.from({ length: 80 }, (_, k) => ({ from: `n${k % 40}`, to: `n${(k * 7 + 3) % 40}`, label: wall.slice(0, 60) })),
  };
  const tooBig = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Quá lớn', diagram: huge }, {}).then(() => null, (err) => err.message);
  check('every limit at its ceiling draws past the widget size, and the model is told how to shrink it', /KB drawn, over the 96KB/.test(tooBig || '') && /split it into two/.test(tooBig || ''), tooBig);

  // The way a model's call really arrives: the schema first, then the tool.
  const { executeTool } = await import('../server/tools/execute.js');
  const run = (input) => executeTool({ user, name: 'show_widget', input, chatId });
  const viaTool = await run({ title: 'Qua công cụ', diagram: pipeline });
  check('through executeTool: the schema lets a diagram through, and it is drawn', viaTool.isError === false && viaTool.widget?.kind === 'svg', viaTool.content?.slice(0, 160));
  const refusedVia = await run({ title: 'Hỏng', diagram: broken });
  check('  a bad one comes back as an error the model reads, never a throw', refusedVia.isError === true && refusedVia.content.includes(said), refusedVia.content);
  // Fix round 3: in the conversation a diagram the server laid out is never shrunk so far its
  // titles fall under 11 px; a hand-drawn drawing keeps the 72 % height cap it always had. The
  // page sizes both with public/js/drawing-fit.js, checked here over many shapes and windows.
  const { drawingHeightCap, readableWidth, DRAWING_FIT } = await import('../public/js/drawing-fit.js');
  const { READABLE_SCALE, TEXT } = await import('../server/diagram/measure.js');
  check('a diagram\'s widget carries its readable scale, set by the server: 11 px over a 14 px title', drawn.widget.readableScale === READABLE_SCALE && Math.abs(READABLE_SCALE * TEXT.titleSize - 11) < 1e-9);
  check('  a hand-drawn svg\'s never does', good.widget.readableScale === undefined && !('readableScale' in good.widget));
  const capWrong = [];
  for (const windowHeight of [500, 800, 1080]) {
    const base = Math.max(240, windowHeight * 0.72);
    for (const [viewWidth, viewHeight] of [[300, 200], [640, 1240], [725, 1027], [1200, 400], [500, 3000]]) {
      for (const shownWidth of [360, 760, 1280]) {
        const hand = drawingHeightCap({ windowHeight, viewWidth, viewHeight, shownWidth });
        if (hand !== base) capWrong.push(`hand-drawn ${viewWidth}×${viewHeight} at ${shownWidth}: ${hand} for ${base}`);
        const cap = drawingHeightCap({ windowHeight, viewWidth, viewHeight, shownWidth, readableScale: READABLE_SCALE });
        const across = shownWidth / viewWidth;
        const title = TEXT.titleSize * Math.min(across, cap / viewHeight);
        // Never under 11 px, unless the width alone holds it there; never taller than its own size.
        if (across >= READABLE_SCALE - 1e-9 ? title < 11 - 1e-9 : title < TEXT.titleSize * across - 1e-9) capWrong.push(`diagram ${viewWidth}×${viewHeight} at ${shownWidth} in ${windowHeight}: titles ${title.toFixed(1)} px`);
        if (cap < base - 1e-9 || cap > Math.max(base, viewHeight * across) + 1e-9) capWrong.push(`diagram ${viewWidth}×${viewHeight} at ${shownWidth}: cap ${cap}`);
      }
    }
  }
  check('a hand-drawn drawing keeps 72 % of the window; a laid-out diagram\'s titles never shrink under 11 px for the height', capWrong.length === 0, capWrong.slice(0, 3).join(' | '));
  const bogus = [0, -1, 2, NaN, Infinity, '0.8', null].map((readableScale) => drawingHeightCap({ windowHeight: 800, viewWidth: 640, viewHeight: 3000, shownWidth: 640, readableScale }));
  check('  any other readable scale is ignored: the 72 % cap stands', bogus.every((cap) => cap === 576), bogus.join(','));
  check('  the page\'s numbers are the ones the server lays out for', DRAWING_FIT.window === 800 && DRAWING_FIT.heightShare === 0.72 && DRAWING_FIT.readablePx === 11);
  // Its frame grows with it (the CSS caps a widget's frame at 70vh, which cut it off with no
  // bar to show the rest); every other widget's frame keeps that cap. Read from the page code.
  const page = (await import('node:fs')).readFileSync(new URL('../public/js/render.js', import.meta.url), 'utf8');
  check('  its frame grows with it, and only its: every other widget keeps the 70vh frame', /const readable = isReadableScale\(widget\.readableScale\);\s+if \(readable\) frame\.style\.maxHeight = 'none';/.test(page) && (page.match(/frame\.style\.maxHeight/g) || []).length === 1 && /fitDrawing\(drawing, widget\.readableScale\)/.test(page));
  // Fix round 4: the column the server lays out for is the page's own, derived here from the CSS
  // and the frame's padding, so a style change cannot silently drift from it. It was 760, about
  // 50 px wider than a drawing is ever shown.
  const css = (await import('node:fs')).readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  const prop = (block, name) => (block.match(new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`)) || [])[1] || '';
  const msgWidth = parseFloat(prop(rule('.msg'), 'max-width'));
  const msgPad = prop(rule('.msg'), 'padding').trim().split(/\s+/);
  const msgSide = parseFloat(msgPad[1] ?? msgPad[0]);
  const border = parseFloat((prop(rule('.widget'), 'border').match(/([\d.]+)px/) || [])[1]);
  const bodyPad = parseFloat((page.match(/'body\{padding:([\d.]+)px\}/) || [])[1]);
  const borderBox = /\* \{\s*box-sizing: border-box;/.test(css);
  const column = msgWidth - 2 * msgSide - 2 * border - 2 * bodyPad;
  check(`the column a drawing is laid out for is the page's: .msg ${msgWidth} − 2×${msgSide} − 2×${border} border − 2×${bodyPad} frame padding = ${column}`, borderBox && Number.isFinite(column) && DRAWING_FIT.column === column, `DRAWING_FIT.column ${DRAWING_FIT.column}`);
  check('  and a narrow drawing grows by the shared factor, not a number of its own', page.includes('Math.round(natural * DRAWING_FIT.widen)') && !/natural \* 2\b/.test(page));
  // Fix round 4: too wide for the column at 11 px, a laid-out diagram is shown at 11 px and its
  // frame scrolls sideways; a hand-drawn one keeps shrinking. The page's rule, over many shapes.
  const wideWrong = [];
  for (const viewWidth of [300, 710, 980, 1400, 2160, 3000]) {
    for (const shownWidth of [320, 710, 1100]) {
      const at = Math.min(shownWidth, viewWidth * 2);
      const need = readableWidth({ viewWidth, shownWidth: at, readableScale: READABLE_SCALE });
      const title = (TEXT.titleSize * (need || at)) / viewWidth;
      if (title < 11 - 1e-6) wideWrong.push(`${viewWidth} at ${shownWidth}: ${title.toFixed(1)} px`);
      if (need && at / viewWidth >= READABLE_SCALE) wideWrong.push(`${viewWidth} at ${shownWidth}: widened though it read`);
      if (readableWidth({ viewWidth, shownWidth: at })) wideWrong.push(`${viewWidth}: a hand-drawn one widened`);
    }
  }
  check('a laid-out diagram too wide for the column is shown at 11 px, to scroll sideways; a hand-drawn one never is', wideWrong.length === 0, wideWrong.slice(0, 3).join(' | '));
  check(
    '  the scroller is the page\'s, focusable with a name while it scrolls, observed for width; the drawing is not padded again',
    page.includes('scroller.tabIndex = 0;') && page.includes('const pad = isReadableScale(readableScale) ? 0 :') && page.includes("scroller.setAttribute('aria-label', t('chat.diagramScroll'") && page.includes('.observe(scroller || frame)') && /\.widget__scroll \{\s*overflow-x: auto;/.test(css),
  );

  // The limits are in words in the schema (Anthropic's strict mode refuses maxItems and
  // maxLength), so validate.js is what turns these away, with its own sentence.
  const schema = TOOLS_BY_NAME.show_widget.parameters;
  const keywords = new Set();
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    Object.keys(s).forEach((k) => keywords.add(k));
    Object.values(s.properties || {}).forEach(walk);
    if (s.items) walk(s.items);
  };
  walk(schema);
  check('  the schema carries no maxItems or maxLength, and says the limits in words', !keywords.has('maxItems') && !keywords.has('maxLength') && /40/.test(schema.properties.diagram.properties.nodes.description) && /60/.test(schema.properties.diagram.properties.nodes.items.properties.title.description), [...keywords].join(','));
  const tooMany = await run({ title: 'Nhiều', diagram: { nodes: Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, title: 'x' })) } });
  check('  41 boxes are turned away by the diagram\'s own check, naming 40', tooMany.isError === true && /at most 40 nodes, and this one has 41/.test(tooMany.content), tooMany.content);
  const longTitle = await run({ title: 'Dài', diagram: { nodes: [{ id: 'a', title: 'x'.repeat(61) }] } });
  check('  a 61-character title, naming 60', longTitle.isError === true && /has 61 characters: keep it to 60/.test(longTitle.content), longTitle.content);
  // Review item 4: a 95-character text with a line break is two short lines, not one long one.
  const twoLines = `${'Định tuyến mô hình theo chi phí '.repeat(2).trim()}\n${'và độ trễ của từng nhà cung cấp'.repeat(1)}`;
  const split = await run({ title: 'Hai dòng', diagram: { nodes: [{ id: 'a', title: 'Cổng', lines: [twoLines] }] } });
  check('  a two-line text over 80 characters in all passes, and is drawn as its lines', [...twoLines].length > 80 && split.isError === false && split.widget?.markup.includes('và độ trễ của từng nhà cung cấp'), `${[...twoLines].length}: ${split.content.slice(0, 120)}`);
  // An unknown optional choice is left out, and the note lists what it takes (spec amended).
  const unknown = await run({ title: 'Lạ', diagram: { direction: 'up', theme: 'sepia', nodes: [{ id: 'a', title: 'A', icon: 'robot', kind: 'circle' }, { id: 'b', title: 'B' }], edges: [{ from: 'a', to: 'b', style: 'dotted' }] } });
  const lists = [['icon', ICON_NAMES], ['kind', ['box', 'pill', 'note']], ['direction', ['auto', 'right', 'down']], ['theme', ['light', 'dark']], ['style', ['solid', 'dashed']]];
  const missing = lists.filter(([field, values]) => !new RegExp(`${field} "[^"]+" is not one it knows[^\\]]*It takes ${values.map((v) => `"${v}"`).join(', ')}\\.`).test(unknown.content)).map(([field]) => field);
  check('  an unknown icon, kind, direction, theme or style is left out, the note listing every value', unknown.isError === false && unknown.widget?.kind === 'svg' && missing.length === 0, `missing: ${missing.join(',')} — ${unknown.content.slice(-400)}`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
