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
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
