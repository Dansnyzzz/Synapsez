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

const widgetCheck = await import('../server/widgetCheck.js');
const { checkDiagram, contrast, colour } = widgetCheck;
// Read through a guard, so before it exists every check below fails rather than the suite.
const checkLines = typeof widgetCheck.checkLines === 'function' ? widgetCheck.checkLines : () => ['checkLines is missing'];

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
  const moved = checkDiagram('<svg viewBox="0 0 100 100"><g transform="rotate(30) translate(500,0)"><text x="0" y="20" font-size="14" fill="#222">Far away but moved</text></g></svg>');
  check('a text inside a rotated group is not judged by where it seems to be', !moved.issues.some((s) => /runs off/.test(s)), moved.issues.join(' | '));
  // Fix round 1: a plain translate is followed, so the text is judged where it lands.
  const shifted = checkDiagram('<svg viewBox="0 0 100 100"><g transform="translate(500,0)"><text x="0" y="20" font-size="14" fill="#222">Far away but moved</text></g></svg>');
  check('  one moved only by a translate is judged where the translate puts it', shifted.issues.some((s) => /Far away but moved.*runs off/.test(s)), shifted.issues.join(' | '));
  check('contrast is WCAG\'s', Math.round(contrast(colour('#000'), colour('#fff'))) === 21 && contrast(colour('#777'), colour('#7a8a88')) < 3);
}

// One arrowhead for the hand-drawn fixtures below, as a model writes it.
const MARKER = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#475569"/></marker></defs>';
const arrow = (d, extra = '') => `<path d="${d}" fill="none" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"${extra}/>`;
// The owner's screenshot (2026-11-17), drawn again by hand: a pipeline whose arrows stop short
// of the boxes they mean, one cutting through a note, and one straight through a box.
const OWNER_FLAWED = `<svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg">${MARKER}
    <rect width="900" height="460" fill="#ffffff"/>
    <text x="450" y="32" text-anchor="middle" font-size="18" font-weight="bold" fill="#111827">Đường đi của một câu hỏi</text>
    <rect x="40" y="60" width="160" height="56" rx="8" fill="#eef2ff" stroke="#6366f1"/>
    <text x="120" y="93" text-anchor="middle" font-size="14" fill="#1e1b4b">Người dùng</text>
    <rect x="260" y="60" width="220" height="90" rx="8" fill="#ecfdf5" stroke="#10b981"/>
    <text x="370" y="84" text-anchor="middle" font-size="14" font-weight="bold" fill="#064e3b">Tầng 1 — Ứng dụng</text>
    <text x="370" y="112" text-anchor="middle" font-size="12.5" fill="#065f46">RAPTOR: cây tóm tắt</text>
    <text x="370" y="132" text-anchor="middle" font-size="12.5" fill="#065f46">MemGPT, Mem0</text>
    <rect x="560" y="60" width="240" height="90" rx="8" fill="#fff7ed" stroke="#f97316"/>
    <text x="680" y="100" text-anchor="middle" font-size="14" font-weight="bold" fill="#7c2d12">Tầng 2 — Nén ngữ cảnh</text>
    <rect x="560" y="260" width="200" height="60" rx="8" fill="#f5f3ff" stroke="#8b5cf6"/>
    <text x="660" y="295" text-anchor="middle" font-size="14" fill="#3b0764">Câu trả lời</text>
    <rect x="40" y="330" width="160" height="56" rx="8" fill="#f8fafc" stroke="#64748b"/>
    <text x="120" y="363" text-anchor="middle" font-size="14" fill="#1f2937">Nhật ký</text>
    <text x="72" y="168" font-size="12" fill="#374151"><tspan x="72" dy="0">Mỗi tầng bớt token</tspan><tspan x="72" dy="18">trước khi gọi mô hình</tspan></text>
    ${arrow('M200 88L258 88')}
    ${arrow('M480 130L530 130')}
    ${arrow('M680 150L680 215')}
    ${arrow('M120 116L120 328')}
    ${arrow('M200 100L558 100')}
  </svg>`;
// The same kinds of drawing done right: arrows ending on the edges of boxes, a diamond, a circle
// and an ellipse; labels beside their arrows; one marker, one arrow headed by a drawn triangle,
// a curve, a dashed arrow, an arrow through its own group's border, and a legend key.
const CLEAN_DRAWN = `<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg">${MARKER}
    <style>.edge{fill:none;stroke:#475569;stroke-width:1.5;marker-end:url(#ah)}.lab{font-size:11px;fill:#475569}</style>
    <rect width="760" height="420" fill="#ffffff"/>
    <rect x="20" y="20" width="420" height="140" rx="10" fill="#eef4ff" stroke="#93b4f5"/>
    <text x="36" y="42" font-size="13" font-weight="bold" fill="#1e3a8a">Phía máy chủ</text>
    <rect x="40" y="60" width="160" height="70" rx="8" fill="#ffffff" stroke="#64748b"/>
    <text x="120" y="100" text-anchor="middle" font-size="14" fill="#1f2937">Cổng API</text>
    <rect x="260" y="60" width="160" height="70" rx="8" fill="#ffffff" stroke="#64748b"/>
    <text x="340" y="100" text-anchor="middle" font-size="14" fill="#1f2937">Bộ định tuyến</text>
    <line class="edge" x1="200" y1="95" x2="258" y2="95"/>
    <text class="lab" x="229" y="87" text-anchor="middle">gọi</text>
    <polygon points="580,40 660,95 580,150 500,95" fill="#fff7e6" stroke="#d97706"/>
    <text x="580" y="100" text-anchor="middle" font-size="13" fill="#78350f">Đủ quyền?</text>
    <line class="edge" x1="420" y1="95" x2="498" y2="95"/>
    <circle cx="580" cy="260" r="40" fill="#ecfdf5" stroke="#059669"/>
    <text x="580" y="265" text-anchor="middle" font-size="13" fill="#065f46">Cho phép</text>
    <line class="edge" x1="580" y1="150" x2="580" y2="218"/>
    <text class="lab" x="588" y="188">có</text>
    <ellipse cx="120" cy="300" rx="80" ry="34" fill="#f8fafc" stroke="#64748b"/>
    <text x="120" y="305" text-anchor="middle" font-size="13" fill="#1f2937">Nhật ký</text>
    <line class="edge" x1="120" y1="130" x2="120" y2="264"/>
    <text class="lab" x="128" y="200">ghi lại</text>
    <polyline points="540,260 360,260 360,300 210,300" fill="none" stroke="#475569" stroke-width="1.5"/>
    <polygon points="200,300 210,295 210,305" fill="#475569"/>
    <text class="lab" x="450" y="252" text-anchor="middle">báo cáo</text>
    <path class="edge" d="M340 60C340 12 580 12 580 38"/>
    <rect x="660" y="230" width="80" height="60" rx="8" fill="#ffffff" stroke="#64748b"/>
    <text x="700" y="265" text-anchor="middle" font-size="13" fill="#1f2937">Lưu</text>
    <line class="edge" x1="620" y1="260" x2="658" y2="260" stroke-dasharray="5 4"/>
    <line x1="40" y1="392" x2="76" y2="392" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
    <text x="84" y="396" font-size="12" fill="#374151">luồng dữ liệu</text>
  </svg>`;

section('lines and arrows: the owner\'s pipeline, as it went wrong (1.34.0)');
{
  const found = checkLines(OWNER_FLAWED);
  const said = found.join('\n');
  check('an arrow stopping 30 px short of its box points at nothing, at its end', found.some((s) => /^an arrow at \(530, 130\).* points at nothing: end it on the edge of the box it belongs to\.$/.test(s)), said);
  check('  and one stopping 45 px short, too', found.some((s) => /^an arrow at \(680, 215\).* points at nothing/.test(s)), said);
  check('an arrow cut through a note is found, the note named', found.some((s) => /^the arrow from "Người dùng" to "Nhật ký" runs through "Mỗi tầng bớt token"/.test(s)), said);
  check('an arrow straight through a box is found, the box named by its title', found.some((s) => /^the arrow from "Người dùng" to "Tầng 2 — Nén ngữ cảnh" runs through the box "Tầng 1 — Ứng dụng"/.test(s)), said);
  check('  those four and nothing else: the arrow that is right is not blamed', found.length === 4, said);
  const all = checkDiagram(OWNER_FLAWED).issues;
  check('checkDiagram\'s issues include the line check\'s', found.every((s) => all.includes(s)), all.join(' | '));
  check('every one a sentence the model can act on', found.every((s) => s.length > 40 && /: /.test(s)));
}

section('lines and arrows: what is drawn right is left alone');
{
  check('a clean hand-drawn diagram finds nothing: edges, labels beside, a marker, a drawn head, a curve, a key', checkLines(CLEAN_DRAWN).length === 0 && checkDiagram(CLEAN_DRAWN).issues.length === 0, [...checkLines(CLEAN_DRAWN), ...checkDiagram(CLEAN_DRAWN).issues].join(' | '));
  // Swimlanes: an arrow between the first lane and the last crosses the one between, as it must.
  const lanes = `<svg viewBox="0 0 600 330">${MARKER}<rect x="0" y="0" width="600" height="330" fill="#ffffff"/>
    <rect x="10" y="10" width="580" height="100" fill="#f1f5f9" stroke="#cbd5e1"/><text x="20" y="30" font-size="12" font-weight="bold" fill="#0f172a">Khách</text>
    <rect x="10" y="115" width="580" height="100" fill="#ecfeff" stroke="#a5f3fc"/><text x="20" y="135" font-size="12" font-weight="bold" fill="#0f172a">Cửa hàng</text>
    <rect x="10" y="220" width="580" height="100" fill="#f0fdf4" stroke="#bbf7d0"/><text x="20" y="240" font-size="12" font-weight="bold" fill="#0f172a">Kho</text>
    <rect x="100" y="40" width="140" height="50" rx="6" fill="#ffffff" stroke="#64748b"/><text x="170" y="70" text-anchor="middle" font-size="13" fill="#1f2937">Đặt hàng</text>
    <rect x="380" y="145" width="140" height="50" rx="6" fill="#ffffff" stroke="#64748b"/><text x="450" y="175" text-anchor="middle" font-size="13" fill="#1f2937">Xác nhận</text>
    <rect x="100" y="250" width="140" height="50" rx="6" fill="#ffffff" stroke="#64748b"/><text x="170" y="280" text-anchor="middle" font-size="13" fill="#1f2937">Giao hàng</text>
    ${arrow('M170 90L170 248')}${arrow('M240 65L450 65L450 143')}</svg>`;
  check('swimlanes: an arrow may cross a lane between, which holds boxes of its own', checkLines(lanes).length === 0, checkLines(lanes).join(' | '));
  // A label on its line, on a backing drawn after the line, is not run through: the line is under it.
  const backed = `<svg viewBox="0 0 400 120">${MARKER}<rect width="400" height="120" fill="#ffffff"/>
    <rect x="10" y="30" width="100" height="50" fill="#fff" stroke="#333"/><text x="60" y="60" text-anchor="middle" font-size="13" fill="#111">Một</text>
    <rect x="290" y="30" width="100" height="50" fill="#fff" stroke="#333"/><text x="340" y="60" text-anchor="middle" font-size="13" fill="#111">Hai</text>
    ${arrow('M110 55L288 55')}<rect x="150" y="47" width="60" height="16" fill="#ffffff"/><text x="180" y="59" text-anchor="middle" font-size="11" fill="#475569">dữ liệu</text></svg>`;
  check('a label on its line over a backing in the canvas colour is fine', checkLines(backed).length === 0, checkLines(backed).join(' | '));
  check('  but with the backing drawn before the line, the line strikes through it', checkLines(backed.replace(/(<path [^>]*\/>)(<rect x="150"[^>]*\/>)/, '$2$1')).some((s) => /the label "dữ liệu" sits on its own arrow/.test(s)));

  // A dangling arrow is found where it stands, and skipped inside a transformed group.
  const box = '<rect x="10" y="80" width="80" height="40" fill="#fff" stroke="#333"/><text x="50" y="105" text-anchor="middle" font-size="13" fill="#111">Nguồn</text>';
  const dangling = `<svg viewBox="0 0 300 200">${MARKER}${box}<line x1="90" y1="100" x2="150" y2="100" stroke="#333" marker-end="url(#ah)"/></svg>`;
  check('a dangling arrow, as a control', checkLines(dangling).some((s) => /^an arrow at \(150, 100\), from "Nguồn", points at nothing/.test(s)), checkLines(dangling).join(' | '));
  // An arrow points ahead: the label it carries, just behind its head, is not what it points at.
  const pastLabel = dangling.replace('</svg>', '<text x="130" y="94" text-anchor="middle" font-size="11" fill="#475569">gửi</text></svg>');
  check('  and stopping just past its own label, it still points at nothing', checkLines(pastLabel).some((s) => /^an arrow at \(150, 100\).* points at nothing/.test(s)), checkLines(pastLabel).join(' | '));
  const turned = dangling.replace(/(<line [^>]*\/>)/, '<g transform="translate(40,0)">$1</g>');
  check('  inside a transformed <g> it is skipped: where it lands is not known', checkLines(turned).length === 0, checkLines(turned).join(' | '));
  const inDefs = dangling.replace(/(<line [^>]*\/>)/, '<defs>$1</defs>');
  check('  and in <defs>, which is not drawn where it stands', checkLines(inDefs).length === 0, checkLines(inDefs).join(' | '));
  // An arrow known by a small filled triangle at its end, rather than a marker.
  const tipAtEnd = `<svg viewBox="0 0 300 200">${box}<line x1="90" y1="100" x2="150" y2="100" stroke="#333"/><polygon points="150,100 140,95 140,105" fill="#333"/></svg>`;
  check('a triangle whose tip is the line\'s end makes it an arrow', checkLines(tipAtEnd).some((s) => /^an arrow at \(150, 100\).* points at nothing/.test(s)), checkLines(tipAtEnd).join(' | '));
  const baseAtEnd = `<svg viewBox="0 0 300 200">${box}<line x1="90" y1="100" x2="140" y2="100" stroke="#333"/><polygon points="150,100 140,95 140,105" fill="#333"/></svg>`;
  check('  as does one drawn on from the line\'s end, and the tip is where it points', checkLines(baseAtEnd).some((s) => /^an arrow at \(150, 100\).* points at nothing/.test(s)), checkLines(baseAtEnd).join(' | '));
  const apart = `<svg viewBox="0 0 300 200">${box}<line x1="90" y1="100" x2="140" y2="100" stroke="#333"/><polygon points="170,100 160,95 160,105" fill="#333"/></svg>`;
  check('  a triangle 20 px away does not, and a plain line is not an arrow', checkLines(apart).length === 0, checkLines(apart).join(' | '));
  const centred = `<svg viewBox="0 0 400 200">${MARKER}${box}<rect x="250" y="60" width="120" height="80" fill="#fff" stroke="#333"/><text x="310" y="85" text-anchor="middle" font-size="13" fill="#111">Đích</text>${arrow('M90 100L310 100')}</svg>`;
  check('an arrow ending at a box\'s middle is told to end on its edge, where its head shows', checkLines(centred).some((s) => /^an arrow ends at \(310, 100\), inside the box "Đích" rather than on its edge/.test(s)), checkLines(centred).join(' | '));

  // A pill's ends are round, and an arrow may end on the curve (the server's pills do): found by
  // the 80 random layouts, where a loop ended on a tall pill's rounded end at (224, 527).
  const pill = (rx) => `<svg viewBox="0 0 400 600">${MARKER}<rect x="77" y="273" width="171" height="280" rx="${rx}" fill="#fff" stroke="#333"/><text x="162" y="420" text-anchor="middle" font-size="14" fill="#111">Người dùng</text>${arrow('M248 499L409 499L409 527L224 527')}</svg>`;
  check('an arrow ending on a pill\'s rounded end is on its edge', checkLines(pill(85.5)).length === 0, checkLines(pill(85.5)).join(' | '));
  check('  the same point in a box with square corners is inside it', checkLines(pill(0)).some((s) => /^an arrow ends at \(224, 527\), inside the box "Người dùng"/.test(s)), checkLines(pill(0)).join(' | '));

  const overlap = (b) => `<svg viewBox="0 0 400 200"><rect x="20" y="20" width="160" height="80" fill="#eef2ff" stroke="#6366f1"/><text x="100" y="65" text-anchor="middle" font-size="14" fill="#1e1b4b">Máy chủ</text>${b}</svg>`;
  const over = overlap('<rect x="150" y="60" width="160" height="80" fill="#ecfdf5" stroke="#10b981"/><text x="235" y="110" text-anchor="middle" font-size="14" fill="#064e3b">Cơ sở dữ liệu</text>');
  check('two boxes overlapping are found, each named', checkLines(over).some((s) => /^the box "Máy chủ" and the box "Cơ sở dữ liệu" overlap by about 30×40/.test(s)), checkLines(over).join(' | '));
  check('  not one sharing 4 px of an edge, nor one wholly inside the other', checkLines(overlap('<rect x="176" y="20" width="100" height="80" fill="#fff" stroke="#333"/>')).length === 0 && checkLines(overlap('<rect x="40" y="30" width="60" height="20" fill="#fff" stroke="#333"/>')).length === 0);
}

section('lines and arrows: where a translate puts things, and where nothing can be known (fix round 1)');
{
  const box = '<rect x="10" y="80" width="80" height="40" fill="#fff" stroke="#333"/><text x="50" y="105" text-anchor="middle" font-size="13" fill="#111">Nguồn</text>';
  const dangling = (extra) => `<svg viewBox="0 0 300 200">${MARKER}${box}<line x1="90" y1="100" x2="150" y2="100" stroke="#333" marker-end="url(#ah)"/>${extra}</svg>`;
  check('a dangling arrow, as a control', checkLines(dangling('')).some((s) => /points at nothing/.test(s)));
  // A plain translate moves what it holds, and is followed: the commonest wrapper a model writes.
  const inner = OWNER_FLAWED.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const wrapped = (open, close) => `<svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg">${open}${inner}${close}</svg>`;
  const bare = checkLines(OWNER_FLAWED);
  check('the owner\'s flawed drawing in translate(0,0) finds what it finds bare', JSON.stringify(checkLines(wrapped('<g transform="translate(0,0)">', '</g>'))) === JSON.stringify(bare) && bare.length === 4, checkLines(wrapped('<g transform="translate(0,0)">', '</g>')).join(' | '));
  check('  and inside two translates that cancel', JSON.stringify(checkLines(wrapped('<g transform="translate(10,10)"><g transform="translate(-10 -10)">', '</g></g>'))) === JSON.stringify(bare));
  const moved = checkLines(wrapped('<g style="transform: translate(20px, 20px)">', '</g>'));
  check('  moved 20 px each way by a translate in its style, each finding is where it is drawn', moved.length === 4 && moved.some((s) => s.startsWith('an arrow at (550, 150)')) && checkDiagram(wrapped('<g transform="translate(20 20)">', '</g>')).issues.length === checkDiagram(OWNER_FLAWED).issues.length, moved.join(' | '));
  // Each box drawn at its own origin and moved into place; the arrows in plain numbers.
  const perNode = `<svg viewBox="0 0 760 200">${MARKER}<rect width="760" height="200" fill="#fff"/>${[['Người dùng', 40], ['Máy chủ', 300], ['CSDL', 560]].map(([t, x]) => `<g transform="translate(${x},60)"><rect width="160" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5"/><text x="80" y="33" text-anchor="middle" font-size="14" fill="#1e1b4b">${t}</text></g>`).join('')}${arrow('M200 88L298 88')}${arrow('M460 88L558 88')}</svg>`;
  check('boxes each moved into place by their own translate, arrows in plain numbers: nothing found', checkLines(perNode).length === 0 && checkDiagram(perNode).issues.length === 0, [...checkLines(perNode), ...checkDiagram(perNode).issues].join(' | '));
  // Rotated, scaled or reused: where it lands is not known, so no arrow is blamed for missing it.
  const diamond = `<svg viewBox="0 0 400 400">${MARKER}<rect width="400" height="400" fill="#fff"/>
    <rect x="140" y="20" width="120" height="44" rx="6" fill="#fff" stroke="#333"/><text x="200" y="47" text-anchor="middle" font-size="14" fill="#111">Bước 1</text>
    <rect x="160" y="130" width="80" height="80" fill="#fef3c7" stroke="#d97706" transform="rotate(45 200 170)"/><text x="200" y="175" text-anchor="middle" font-size="13" fill="#111">OK?</text>
    ${arrow('M200 64L200 113')}${arrow('M200 227L200 300')}<rect x="140" y="300" width="120" height="44" rx="6" fill="#fff" stroke="#333"/><text x="200" y="327" text-anchor="middle" font-size="14" fill="#111">Bước 2</text></svg>`;
  check('a decision drawn as a rotated rect: no arrow said to point at nothing', !checkLines(diamond).some((s) => /nothing|ends /.test(s)), checkLines(diamond).join(' | '));
  const used = `<svg viewBox="0 0 500 200">${MARKER}<defs><rect id="n" width="120" height="50" rx="6" fill="#fff" stroke="#333"/></defs><rect width="500" height="200" fill="#fff"/>
    <use href="#n" x="20" y="70"/><text x="80" y="100" text-anchor="middle" font-size="14" fill="#111">A</text><use href="#n" x="300" y="70"/><text x="360" y="100" text-anchor="middle" font-size="14" fill="#111">B</text>${arrow('M140 95L298 95')}</svg>`;
  check('  nor boxes drawn by <use>', !checkLines(used).some((s) => /nothing|ends /.test(s)), checkLines(used).join(' | '));
  check('  nor beside an <image> or a <foreignObject>', checkLines(dangling(`<image href="data:," x="140" y="80" width="40" height="40"/>`)).length === 0 && checkLines(dangling('<foreignObject x="140" y="80" width="40" height="40"><div>x</div></foreignObject>')).length === 0);
  // But what stands where it is known is still crossed-checked.
  check('  an arrow through a known box is still found beside a rotated one', checkLines(diamond.replace(arrow('M200 227L200 300'), arrow('M200 227L200 360'))).some((s) => /runs through the box "Bước 2"/.test(s)));

  // Fix round 2: a scale, or a matrix with no turn in it, is followed as a translate is, composed
  // in order through every group, so a scaled drawing is judged where it is drawn.
  const scaled = wrapped('<g transform="translate(450 230) scale(0.5) translate(-450 -230)">', '</g>');
  const halfway = checkLines(scaled);
  check('the owner\'s flawed drawing scaled by half about its middle: the same four, where they are drawn', halfway.length === 4 && halfway.some((s) => s.startsWith('an arrow at (490, 180)')) && halfway.some((s) => s.startsWith('an arrow at (565, 223)')), halfway.join(' | '));
  check('  and through matrix(1,0,0,1,0,0) and scale(1), as bare', JSON.stringify(checkLines(wrapped('<g transform="matrix(1,0,0,1,0,0)"><g transform="scale(1)">', '</g></g>'))) === JSON.stringify(bare));
  const nodesScaled = perNode.replace(/<g transform="translate\((\d+),60\)">/g, '<g transform="matrix(2,0,0,2,$1,60)"><g transform="scale(0.5)">').replace(/<\/text><\/g>/g, '</text></g></g>');
  check('  boxes placed by matrix() and scale(), arrows in plain numbers: nothing found', checkLines(nodesScaled).length === 0 && checkDiagram(nodesScaled).issues.length === 0, [...checkLines(nodesScaled), ...checkDiagram(nodesScaled).issues].join(' | '));
  const doubled = `<svg viewBox="0 0 600 400"><g transform="scale(2)">${dangling('').replace(/^<svg[^>]*>/, '').replace('</svg>', '')}</g></svg>`;
  check('  a dangling arrow in a group scaled by 2 is found at twice its numbers', checkLines(doubled).some((s) => s.startsWith('an arrow at (300, 200), from "Nguồn", points at nothing')), checkLines(doubled).join(' | '));

  // A turned text — an axis label — is no target, and spares only the arrow ends near it: one
  // pointing at it is not blamed, and a fault elsewhere in the drawing is still found.
  const axisLabel = '<text x="30" y="240" text-anchor="middle" font-size="13" fill="#111" transform="rotate(-90 30 240)">Tác động</text>';
  const chart = (extra) => `<svg viewBox="0 0 500 500">${MARKER}<rect width="500" height="500" fill="#fff"/>
    <line x1="60" y1="440" x2="460" y2="440" stroke="#333" stroke-width="2" marker-end="url(#ah)"/><line x1="60" y1="440" x2="60" y2="40" stroke="#333" stroke-width="2" marker-end="url(#ah)"/>${axisLabel}
    ${[['Làm ngay', 80, 60], ['Lên kế hoạch', 270, 60], ['Giao việc', 80, 250], ['Bỏ qua', 270, 250]].map(([t, x, y]) => `<rect x="${x}" y="${y}" width="170" height="170" fill="#f8fafc" stroke="#64748b"/><text x="${x + 85}" y="${y + 90}" text-anchor="middle" font-size="14" fill="#111">${t}</text>`).join('')}${extra}</svg>`;
  check('a chart with a turned axis label finds nothing of its own', checkLines(chart('')).length === 0, checkLines(chart('')).join(' | '));
  const elsewhere = checkLines(chart(arrow('M440 335L485 335')));
  check('  and a dangling arrow elsewhere in it is still found', elsewhere.some((s) => /^an arrow at \(485, 335\), from "Bỏ qua", points at nothing/.test(s)), elsewhere.join(' | '));
  const atLabel = checkLines(chart('<line x1="80" y1="200" x2="44" y2="200" stroke="#333" marker-end="url(#ah)"/>'));
  check('  but an arrow pointing at the turned label is not blamed', atLabel.length === 0, atLabel.join(' | '));

  // Arrows meant to end in open space: an axis, a timeline's spine. A free end is told only when
  // the arrow's other end is on a shape or at a text.
  const matrix = `<svg viewBox="0 0 500 500">${MARKER}<rect width="500" height="500" fill="#fff"/>
    <line x1="60" y1="440" x2="460" y2="440" stroke="#333" stroke-width="2" marker-end="url(#ah)"/><line x1="60" y1="440" x2="60" y2="40" stroke="#333" stroke-width="2" marker-end="url(#ah)"/>
    <text x="260" y="475" text-anchor="middle" font-size="13" fill="#111">Công sức</text>
    ${[['Làm ngay', 80, 60], ['Lên kế hoạch', 270, 60], ['Giao việc', 80, 250], ['Bỏ qua', 270, 250]].map(([t, x, y]) => `<rect x="${x}" y="${y}" width="170" height="170" fill="#f8fafc" stroke="#64748b"/><text x="${x + 85}" y="${y + 90}" text-anchor="middle" font-size="14" fill="#111">${t}</text>`).join('')}</svg>`;
  check('a 2×2 matrix with its axis arrows finds nothing', checkLines(matrix).length === 0 && checkDiagram(matrix).issues.length === 0, [...checkLines(matrix), ...checkDiagram(matrix).issues].join(' | '));
  const timeline = `<svg viewBox="0 0 700 200">${MARKER}<rect width="700" height="200" fill="#fff"/><line x1="40" y1="100" x2="660" y2="100" stroke="#334155" stroke-width="3" marker-end="url(#ah)"/>${[100, 250, 400, 550].map((x, i) => `<circle cx="${x}" cy="100" r="8" fill="#0284c7"/><text x="${x}" y="${i % 2 ? 140 : 75}" text-anchor="middle" font-size="13" fill="#111">${2020 + i}</text>`).join('')}</svg>`;
  check('a timeline\'s spine through its dots, ending in an arrow, finds nothing', checkLines(timeline).length === 0, checkLines(timeline).join(' | '));
  check('  but a box on the spine is still run through', checkLines(timeline.replace('<circle cx="250" cy="100" r="8" fill="#0284c7"/>', '<circle cx="250" cy="100" r="20" fill="#0284c7"/>')).some((s) => /runs through the circle at \(250, 100\)/.test(s)));

  // A shape with no text is named by what it is, and where the model put it.
  const untitled = `<svg viewBox="0 0 500 200">${MARKER}${box}<circle cx="250" cy="100" r="30" fill="#fff" stroke="#333"/><polygon points="400,60 440,100 400,140 360,100" fill="#fff" stroke="#333"/>${arrow('M90 100L400 100')}</svg>`;
  const named = checkLines(untitled);
  check('an unnamed circle and diamond are called so, at their middles', named.some((s) => /runs through the circle at \(250, 100\)/.test(s)) && named.some((s) => /inside the diamond at \(400, 100\)/.test(s)), named.join(' | '));

  // Fix round 3: an arrow floating between two boxes, free at both ends, is still the owner's
  // fault: its head is told when a shape or a text lies straight ahead of it within 42 px.
  const pair = '<rect x="10" y="80" width="80" height="40" fill="#fff" stroke="#333"/><text x="50" y="105" text-anchor="middle" font-size="13" fill="#111">Một</text><rect x="250" y="80" width="80" height="40" fill="#fff" stroke="#333"/><text x="290" y="105" text-anchor="middle" font-size="13" fill="#111">Hai</text>';
  const floating = (x1, x2) => checkLines(`<svg viewBox="0 0 400 200">${MARKER}<rect width="400" height="200" fill="#fff"/>${pair}<line x1="${x1}" y1="100" x2="${x2}" y2="100" stroke="#333" marker-end="url(#ah)"/></svg>`);
  check('an arrow floating 25 px clear of both boxes points at nothing, short of the one ahead', floating(115, 225).some((s) => /^an arrow at \(225, 100\), stopping short of "Hai", points at nothing/.test(s)), floating(115, 225).join(' | '));
  check('  and 40 px clear of both', floating(130, 210).some((s) => /^an arrow at \(210, 100\), stopping short of "Hai", points at nothing/.test(s)), floating(130, 210).join(' | '));
  check('  but with nothing ahead of their heads, the matrix\'s axes and the timeline\'s spine stay clean', checkLines(matrix).length === 0 && checkLines(timeline).length === 0 && checkLines(chart('')).length === 0);

  // Fix round 4: only shapes count as what a free head stops short of, never a text, and a free
  // tail is told only when the head is on a shape: an arrow pointing at its own words is drawn so.
  const open = (b) => `<svg viewBox="0 0 600 300">${MARKER}<rect width="600" height="300" fill="#fff"/>${b}</svg>`;
  const words = (gap) => [
    [`an axis with its label ${gap} px past the tip`, open(`<line x1="40" y1="250" x2="460" y2="250" stroke="#333" marker-end="url(#ah)"/><text x="${460 + gap}" y="254" font-size="13" fill="#111">Thời gian</text>`)],
    [`a legend key with its words ${gap} px after the head`, open(`<line x1="40" y1="280" x2="76" y2="280" stroke="#333" marker-end="url(#ah)"/><text x="${76 + gap}" y="284" font-size="12" fill="#111">luồng dữ liệu</text>`)],
    [`a trend arrow ${gap} px under a KPI number`, open(`<text x="300" y="100" text-anchor="middle" font-size="28" font-weight="bold" fill="#111">+12%</text><line x1="300" y1="${150 + gap}" x2="300" y2="${110 + gap}" stroke="#16a34a" stroke-width="3" marker-end="url(#ah)"/>`)],
  ];
  for (const gap of [10, 20, 30]) for (const [what, svg] of words(gap)) check(`${what}: finds nothing`, checkLines(svg).length === 0, checkLines(svg).join(' | '));
  check('  but an arrow from a box to nothing still has its head told', floating(90, 200).some((s) => /^an arrow at \(200, 100\), from "Một", points at nothing/.test(s)), floating(90, 200).join(' | '));

  // Fix round 3: a transform-origin or transform-box moves where a scale pivots, which is not read:
  // there only a plain translate is followed, and a scale leaves the position unknown.
  const pivoted = (g) => `<svg viewBox="0 0 400 200">${MARKER}<rect width="400" height="200" fill="#fff"/><rect x="10" y="80" width="80" height="40" fill="#fff" stroke="#333"/><text x="50" y="105" text-anchor="middle" font-size="13" fill="#111">Một</text>${g}<rect x="200" y="80" width="100" height="40" fill="#fff" stroke="#333"/><text x="250" y="105" text-anchor="middle" font-size="13" fill="#111">Hai</text></g><line x1="90" y1="100" x2="173" y2="100" stroke="#333" marker-end="url(#ah)"/></svg>`;
  check('a box scaled by 1.5 about transform-origin="250 100", the arrow on its true edge: not blamed', checkLines(pivoted('<g transform="scale(1.5)" transform-origin="250 100">')).length === 0, checkLines(pivoted('<g transform="scale(1.5)" transform-origin="250 100">')).join(' | '));
  check('  nor with transform-box: fill-box and transform-origin: center in its style', checkLines(pivoted('<g style="transform: scale(1.5); transform-box: fill-box; transform-origin: center">')).length === 0);
  check('  while a translate with an origin is still followed, and the same scale with none is judged', checkLines(pivoted('<g transform="translate(-25 0)" transform-origin="250 100">')).length === 0 && checkLines(pivoted('<g transform="scale(1.5)">')).some((s) => /^an arrow at \(173, 100\), from "Một", points at nothing/.test(s)));
}

section('lines and arrows: a server-drawn diagram finds nothing, and no markup breaks the reader');
{
  const { validateDiagram } = await import('../server/diagram/validate.js');
  const { layoutDiagram } = await import('../server/diagram/layout.js');
  const { renderDiagram } = await import('../server/diagram/render.js');
  const drawn = [];
  const base = {
    groups: [{ id: 'g1', title: 'Phía máy chủ' }, { id: 'g2', title: 'Lưu trữ' }],
    nodes: [
      { id: 'u', title: 'Người dùng', kind: 'pill', icon: 'user' },
      { id: 'a', title: 'Cổng API', lines: ['xác thực, giới hạn'], group: 'g1', icon: 'server' },
      { id: 'b', title: 'Bộ định tuyến', group: 'g1' },
      { id: 'c', title: 'CSDL', group: 'g2', icon: 'database' },
      { id: 'd', title: 'Bộ nhớ đệm', group: 'g2', icon: 'cache' },
      { id: 'n', title: 'Ghi chú', kind: 'note' },
    ],
    edges: [
      { from: 'u', to: 'a', label: 'yêu cầu' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', label: 'truy vấn', style: 'dashed' },
      { from: 'b', to: 'd' },
      { from: 'd', to: 'b', label: 'trúng' },
      { from: 'c', to: 'n' },
      { from: 'u', to: 'n', label: 'nhật ký' },
    ],
  };
  for (const theme of ['light', 'dark']) {
    for (const direction of ['auto', 'right', 'down']) {
      const checked = validateDiagram({ ...base, theme, direction });
      const svg = renderDiagram(layoutDiagram(checked.diagram), { theme: checked.diagram.theme, title: 'Thử' });
      const found = checkLines(svg);
      if (found.length) drawn.push(`${theme} ${direction}: ${found[0]}`);
    }
  }
  check('a diagram Ephapse lays out — marker in <defs>, label backings, a canvas, groups arrows enter, scoped rules — finds nothing', drawn.length === 0, drawn.slice(0, 2).join(' | '));
  // Nothing found is only worth something if its arrows are seen: cut each arrow of a laid-out
  // diagram back along its last stretch, to where it is clear of every box, group and label by
  // 20 px, and each is found pointing at nothing — the labelled ones too, whose head then stops
  // just past their own label. (Cut back less, an arrow may stop on a group's border, which is
  // a place an arrow may point.)
  // With its icons: each a `translate(…) scale(…)` group, which is followed (fix round 2), so a
  // server drawing with icons has its ends judged too.
  const missed = [];
  let cutCount = 0;
  check('  (its boxes carry icons, drawn through translate and scale)', base.nodes.filter((n) => n.icon).length === 4 && /<g transform="translate\([^)]*\) scale\(/.test(renderDiagram(layoutDiagram(validateDiagram(base).diagram))));
  for (const direction of ['down', 'right']) {
    const laid = layoutDiagram(validateDiagram({ ...base, direction }).diagram);
    const solids = [...laid.nodes, ...laid.groups, ...laid.edges.filter((e) => e.labelBox).map((e) => e.labelBox)];
    const clearance = ([x, y]) => Math.min(...solids.map((r) => {
      const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      const out = Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
      return inside ? Math.min(x - r.x, r.x + r.w - x, y - r.y, r.y + r.h - y) : out;
    }));
    laid.edges.forEach((e, k) => {
      const [a, b] = e.points.slice(-2);
      const spot = [0.5, 0.4, 0.6, 0.3, 0.7].map((f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]).find((p) => clearance(p) >= 20);
      if (e.from === e.to || !spot) return;
      const cut = structuredClone(laid);
      cut.edges[k].points[cut.edges[k].points.length - 1] = spot;
      cutCount += 1;
      const found = checkLines(renderDiagram(cut, { title: 'Cắt' }));
      if (!found.some((s) => s.startsWith(`an arrow at (${Math.round(spot[0])}, ${Math.round(spot[1])})`) && /points at nothing/.test(s))) missed.push(`${direction} ${e.from}→${e.to}${e.label ? ` (${e.label})` : ''}: ${found.join(' | ') || 'nothing found'}`);
    });
  }
  check(`  and it sees them: each of ${cutCount} arrows cut short, clear of everything, is found pointing at nothing`, cutCount >= 4 && missed.length === 0, missed.join(' || '));

  // The reader takes any markup without throwing: malformed paths, NaN, numbers past any
  // drawing, deep nesting, half-written tags, and things that are not text at all.
  const odd = [
    '', '<svg', '<svg><path d="M"/></svg>', '<svg><path d="M10 10 L NaN 5 Z"/></svg>', '<svg><path d="M1e999 0L5 5" marker-end="url(#a)"/></svg>',
    '<svg><path d="M0 0 C 1 1" marker-end="url(#a)"/></svg>', '<svg><path d="m0 0 a 5 5 0 01 10 10 z h-5 v5 q 1 2 3 4 t 5 5 s 1 1 2 2" marker-start="url(#a)"/></svg>',
    '<svg><polygon points="1,2,3"/><polyline points="x y" marker-end="url(#a)"/><line x1="a" marker-end="url(#a)"/></svg>',
    `<svg>${'<g>'.repeat(5000)}<line x1="0" y1="0" x2="5" y2="5" marker-end="url(#a)"/>${'</g>'.repeat(5000)}</svg>`,
    `<svg>${'<g transform="scale(2)">'.repeat(300)}<text>deep</text></svg>`, '<svg><text>open<tspan>half', '<svg><style>.a{marker-end:url(#a)<rect class="a"/>',
    '<svg><rect x="-1e308" y="1e308" width="1e400" height="-5"/><circle r="-1"/><ellipse rx="0" ry="NaN"/></svg>', '<svg><!-- <line x1="0" marker-end="url(#a)"/>',
    `<svg>${'<rect '.repeat(4000)}</svg>`, `<svg><rect ${'a'.repeat(50000)}="1"/></svg>`, `<svg><style>${'x'.repeat(50000)}</style></svg>`,
    `<svg>${'<style>'.repeat(4000)}</svg>`, `<svg><text>${'<tspan>'.repeat(4000)}</text></svg>`, '<svg><rect class="__proto__ constructor" __proto__="1"/><style>__proto__{fill:red}</style></svg>',
  ];
  const thrown = [];
  for (const markup of [...odd, null, undefined, 42, {}, ['<svg/>']]) {
    for (const fn of [checkLines, checkDiagram]) {
      try {
        const out = fn(markup);
        if (fn === checkLines ? !Array.isArray(out) : !Array.isArray(out?.issues)) thrown.push(`${String(markup).slice(0, 30)}: not a list`);
      } catch (err) {
        thrown.push(`${String(markup).slice(0, 30)}: ${err.message}`);
      }
    }
  }
  check('no markup makes either check throw, and each answers a list', thrown.length === 0, thrown.slice(0, 3).join(' | '));
  // Past its limits the reader stops; an arrow is then never blamed for what was not read.
  const target = '<rect x="150" y="80" width="80" height="40" fill="#fff" stroke="#333"/>';
  const early = `<svg viewBox="0 0 300 200">${MARKER}<rect x="10" y="80" width="80" height="40" fill="#fff" stroke="#333"/><line x1="90" y1="100" x2="148" y2="100" stroke="#333" marker-end="url(#ah)"/>`;
  check('  read in part, an arrow whose box comes after the limit is not said to point at nothing', checkLines(`${early}${target}</svg>`).length === 0 && checkLines(`${early}${'<g/>'.repeat(3000)}${target}</svg>`).length === 0);
  // A path longer than the reader takes: its last point read is in mid-air, not where it ends.
  const zigzag = (n) => `<svg viewBox="0 0 300 200">${MARKER}<rect x="10" y="80" width="80" height="40" fill="#fff" stroke="#333"/>${target}<path d="M90 100L120 100${' L120 140 L120 100'.repeat(n)} L148 100" fill="none" stroke="#333" marker-end="url(#ah)"/></svg>`;
  check('  nor a path cut short by the reader, whose end was never read', checkLines(zigzag(3)).length === 0 && checkLines(zigzag(600)).length === 0, checkLines(zigzag(600)).join(' | '));
  // A random sweep over fragments of drawings, glued at random.
  const bits = ['<svg viewBox="0 0 300 200">', '<g>', '</g>', '<g transform="x">', '<rect x="10" y="10" width="50" height="30"/>', '<line x1="0" y1="0" x2="80" y2="40" marker-end="url(#a)"/>', '<path d="M0 0L', '5 5', 'Z', '"/>', '<text x="5" y="9">a', '</text>', '<tspan dy="1em">b</tspan>', '<polygon points="0,0 9,4 0,9"/>', '<circle cx="5" cy="5" r="3"/>', '<style>.e{marker-end:url(#a)}</style>', '<defs>', '</defs>', '"', '>', '<', 'NaN', '-', 'e', '.'];
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  let sweepFailed = '';
  for (let i = 0; i < 400 && !sweepFailed; i += 1) {
    const markup = Array.from({ length: 5 + rand(40) }, () => bits[rand(bits.length)]).join('');
    try {
      checkDiagram(markup);
    } catch (err) {
      sweepFailed = `${markup}: ${err.message}`;
    }
  }
  check('  nor 400 drawings glued from random pieces', !sweepFailed, sweepFailed.slice(0, 200));

  // The largest a widget may be (96 KB), drawn as densely as markup allows, read in bounded time.
  const dense = [];
  for (let i = 0, size = 0; size < 96 * 1024 - 800; i += 1) {
    const x = (i * 37) % 1100;
    const y = (i * 53) % 700;
    dense.push(`<rect x="${x}" y="${y}" width="60" height="30" fill="#fff" stroke="#333"/><text x="${x + 30}" y="${y + 20}" text-anchor="middle" font-size="12">Hộp ${i}</text><path d="M${x + 60} ${y + 15}L${x + 140} ${y + 15}L${x + 140} ${y + 70}" marker-end="url(#ah)" fill="none" stroke="#333"/>`);
    size += dense.at(-1).length;
  }
  const huge = `<svg viewBox="0 0 1200 800">${MARKER}${dense.join('')}</svg>`;
  const longPath = `<svg viewBox="0 0 1200 800">${MARKER}<path d="M0 0${' L5 5 L600 400'.repeat(6000)}" marker-end="url(#ah)"/>${'<text x="600" y="400">chữ</text>'.repeat(200)}</svg>`;
  // The review's input (fix round 1): 20 paths running back and forth over 770 texts, 1,940
  // stretches in all, under a backing and 770 more rects — 93 KB, and 5.3 s before the fix.
  const crowd = `<svg viewBox="0 0 1200 300">${MARKER}<rect width="1200" height="300" fill="#fff"/><line x1="0" y1="0" x2="0" y2="300" stroke="#333"/><line x1="1200" y1="0" x2="1200" y2="300" stroke="#333"/>${`<path d="M0 100${' L1200 100 L0 100'.repeat(48)} L1200 100" fill="none" stroke="#333" marker-end="url(#ah)"/>`.repeat(20)}${Array.from({ length: 770 }, (_, i) => `<text x="${10 + ((i * 2) % 1180)}" y="104" font-size="11">ab</text>`).join('')}${Array.from({ length: 770 }, (_, i) => `<rect x="${i}" y="0" width="1" height="1" fill="#fff"/>`).join('')}<rect x="0" y="80" width="1200" height="40" fill="#fff"/></svg>`;
  const timings = [];
  for (const [name, markup, most] of [['96 KB of boxes, labels and elbow arrows', huge, 250], ['one 12,000-segment path under 200 texts', longPath, 250], ['the review\'s crossings under backings', crowd, 200]]) {
    let best = Infinity;
    for (let k = 0; k < 5; k += 1) {
      const t0 = performance.now();
      checkDiagram(markup);
      best = Math.min(best, performance.now() - t0);
    }
    timings.push({ name, kb: Math.round(markup.length / 1024), ms: Math.round(best), most });
  }
  console.log(`      timings (quickest of 5): ${timings.map((t) => `${t.name} (${t.kb} KB): ${t.ms} ms`).join('; ')}`);
  check('the largest widget, at its densest, is checked in under 250 ms; the review\'s 93 KB of crossings in under 200', timings.every((t) => t.ms < t.most) && timings[2].kb >= 90, JSON.stringify(timings));
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
  // With no conversation (an automation, a bot's run) there is nobody to keep a count for, so a
  // drawing with problems is drawn at once, as before, and the model is asked for a better one.
  const bad = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Sơ đồ', svg: '<svg viewBox="0 0 200 100"><rect x="10" y="10" width="60" height="30" fill="#fff"/><text x="12" y="30" font-size="14" fill="#222">Một nhãn rất dài không vừa hộp</text></svg>' }, { userId: user.id });
  check('with no conversation, a diagram with problems is drawn at once, and the model is told to draw it again', /will see these problems/.test(bad.content) && /show_widget/.test(bad.content) && bad.widget?.markup, bad.content.slice(0, 160));
  check('  and it is not kept as a file', (await store.listGeneratedFiles(user.id, chatId)).length === 0);
  const flawedAway = await CLOUD_IMPLEMENTATIONS.show_widget({ title: 'Đường đi', svg: OWNER_FLAWED }, {});
  check('  the owner\'s flawed pipeline too, with no chat: shown at once, its arrows named', flawedAway.widget?.markup === OWNER_FLAWED.trim() && /points at nothing/.test(flawedAway.content));

  section('a flawed drawing is redrawn once, before anyone sees it (1.34.0)');
  {
    // A conversation of its own, so the files kept here are counted apart from the ones below.
    const chat2 = crypto.randomUUID();
    await store.createChat(user.id, { id: chat2, title: 'Redraw' });
    // Fix round 1: kept by conversation and turn, not by title (a renamed redraw was held back
    // again; a later turn's new drawing under an old title never was).
    const counter = (turn) => `widget:redraw:${chat2}${turn ? `:${turn}` : ''}`;
    const show = (input, turnId) => CLOUD_IMPLEMENTATIONS.show_widget(input, { userId: user.id, chatId: chat2, turnId });
    const kept = async () => (await store.listGeneratedFiles(user.id, chat2)).length;
    const [turn1, turn2, turn3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const first = await show({ title: 'Đường đi của một câu hỏi', svg: OWNER_FLAWED }, turn1);
    check('a flawed first svg in a turn comes back with no widget', first.widget === undefined && !('widget' in first), Object.keys(first).join(','));
    check('  and nothing kept', (await kept()) === 0);
    check('  the model is told what is wrong, that the user has not seen it, and to draw it again', /has not seen it/.test(first.content) && /points at nothing/.test(first.content) && /runs through the box "Tầng 1 — Ứng dụng"/.test(first.content) && /Draw it again now with show_widget, fixed/.test(first.content) && /next try is shown whatever/.test(first.content), first.content);
    check('  and pointed to `diagram` for boxes and arrows', /`diagram`/.test(first.content) && /instead of `svg`/.test(first.content), first.content);
    check('  counted under the conversation and the turn', (await store.readCounter(counter(turn1))) === 1);
    const laidOut = await show({ title: 'Đường đi của một câu hỏi', diagram: { nodes: [{ id: 'a', title: 'Người dùng' }, { id: 'b', title: 'Câu trả lời' }], edges: [{ from: 'a', to: 'b' }] } }, turn1);
    check('a `diagram` is never held back, and counts nothing', laidOut.widget?.kind === 'svg' && (await store.readCounter(counter(turn1))) === 1, laidOut.content);
    const before = await kept();
    const second = await show({ title: 'Một tên khác hẳn', svg: OWNER_FLAWED.replace('M480 130L530 130', 'M480 130L558 130') }, turn1);
    check('the redraw is shown, though it was given another title', second.widget?.kind === 'svg' && second.widget.markup.includes('M480 130L558 130'), Object.keys(second).join(','));
    check('  and kept, whatever the check still finds', (await kept()) === before + 1 && /kept it as a file/.test(second.content));
    // Fix round 3: worded to be true of the redraw and of a different drawing later in the turn.
    check('  its content lists what is still wrong, and asks for no third try', /This drawing is shown as it is; a check finds these problems/.test(second.content) && !/redraw|still/.test(second.content) && /points at nothing/.test(second.content) && !/530, 130/.test(second.content) && /Do not draw it again/.test(second.content), second.content);
    const third = await show({ title: 'Một hình khác nữa', svg: OWNER_FLAWED }, turn1);
    check('  only one try a turn is ever held back: a third flawed drawing in it is shown, and the words fit it too', third.widget?.kind === 'svg' && /This drawing is shown as it is; a check finds these problems/.test(third.content) && !/redraw|still/.test(third.content));
    const nextTurn = await show({ title: 'Đường đi của một câu hỏi', svg: OWNER_FLAWED }, turn2);
    check('a later turn\'s flawed drawing gets its own check, under any title', nextTurn.widget === undefined && (await store.readCounter(counter(turn2))) === 1);
    const cleanFirst = await show({ title: 'Sạch', svg: CLEAN_DRAWN }, turn3);
    check('a clean first svg is shown and kept at once, and counts nothing', cleanFirst.widget?.kind === 'svg' && /kept it as a file/.test(cleanFirst.content) && (await store.readCounter(counter(turn3))) === 0);
    const noTurn = await show({ title: 'Không lượt', svg: OWNER_FLAWED });
    check('  with no turn to name, the conversation alone is counted', noTurn.widget === undefined && (await store.readCounter(counter(null))) === 1);
    // With the count unkept — the store failing — the drawing is shown at once, as before the
    // redraw existed, rather than the call failing; nothing flawed is kept.
    const realAdd = store.addToCounter;
    store.addToCounter = async () => {
      throw new Error('the counters are down');
    };
    try {
      const keptBefore = await kept();
      const failing = await show({ title: 'Kho đếm lỗi', svg: OWNER_FLAWED }, crypto.randomUUID());
      check('with the store failing, a flawed drawing is shown at once, the model told to draw it again, and nothing kept', failing.widget?.markup === OWNER_FLAWED.trim() && /will see these problems/.test(failing.content) && (await kept()) === keptBefore, failing.content.slice(0, 120));
    } finally {
      store.addToCounter = realAdd;
    }

    // What the person sees (fix round 1): "Đang kiểm tra hình vẽ…" while it runs; done, "Đã kiểm
    // tra hình vẽ", or "… — vẽ lại" for the try held back. A saved turn is drawn through the
    // same start and complete, so a reload says the same.
    const { drawingStep, describeStep } = await import('../public/js/render.js');
    const fsMod = await import('node:fs');
    const page = fsMod.readFileSync(new URL('../public/js/render.js', import.meta.url), 'utf8');
    const { vi: viWords } = await import('../public/js/locales/vi.js');
    const { en: enWords } = await import('../public/js/locales/en.js');
    const svgIn = { title: 'x', svg: OWNER_FLAWED };
    check(
      'a hand-drawn picture\'s step: checking while it runs, checked once shown, checked and redrawing when held back',
      drawingStep(svgIn) === 'step.show_widget.checking' && drawingStep(svgIn, second) === 'step.show_widget.checked' && drawingStep(svgIn, first) === 'step.show_widget.redrawing' && drawingStep(svgIn, { content: 'x', isError: true }) === null,
    );
    check('  a `diagram` or `html` step keeps its own words', drawingStep({ title: 'x', diagram: {} }, laidOut) === null && drawingStep({ title: 'x', html: '<p>a</p>' }, { widget: {} }) === null && describeStep('show_widget', { title: 'x', html: '<p/>' }).verb === enWords['step.show_widget']);
    check('  the running step says so', describeStep('show_widget', svgIn).verb === enWords['step.show_widget.checking']);
    check('  the finished step, live or reloaded, is chosen by it in the one place both pass through', /else if \(call\.name === 'show_widget' && drawingStep\(call\.input, result\)\) verb = t\(drawingStep\(call\.input, result\)\);/.test(page) && /if \(result\) handle\.complete\(result\);/.test(page));
    check(
      '  in both languages, the finished ones in the past',
      viWords['step.show_widget.checking'] === 'Đang kiểm tra hình vẽ…' && enWords['step.show_widget.checking'] === 'Checking the drawing…' &&
        viWords['step.show_widget.checked'] === 'Đã kiểm tra hình vẽ' && enWords['step.show_widget.checked'] === 'Checked the drawing' &&
        viWords['step.show_widget.redrawing'] === 'Đã kiểm tra hình vẽ — vẽ lại' && enWords['step.show_widget.redrawing'] === 'Checked the drawing — redrawing',
    );
  }
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
  // Fix round 5: every rule that reaches the reply's column at desktop width is read, in cascade
  // order: top-level rules, and those in a media query that holds in a 1280 px window (any query
  // not about width counts as holding). Padding or a border later given to .msg__body, .widget or
  // the scroller, or a desktop override of .msg, changes the column and fails this.
  const cssBlocks = [];
  const flatCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const holds = (query) => {
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    return (!min || +min[1] <= 1280) && (!max || +max[1] >= 1280);
  };
  const walkCss = (text, applies) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walkCss(body, applies && holds(head));
      else if (!head.startsWith('@')) cssBlocks.push({ selectors: head.split(',').map((x) => x.trim()), body, applies });
      i = j;
    }
  };
  walkCss(flatCss, true);
  const cssDecl = (selectors, name) => {
    let value = '';
    for (const b of cssBlocks) {
      if (!b.applies || !b.selectors.some((x) => selectors.includes(x))) continue;
      for (const m of b.body.matchAll(new RegExp(`(?:^|[;\\s])(${name}(?:-left|-right)?):\\s*([^;]+);?`, 'g'))) value = `${value}|${m[1]}=${m[2].trim()}`;
    }
    return value;
  };
  // The horizontal room a declaration list takes on each side (padding or border, shorthand or not).
  const across = (list) => {
    let left = 0;
    let right = 0;
    for (const item of list.split('|').filter(Boolean)) {
      const [name, value] = item.split('=');
      const px = (v) => parseFloat((/([\d.]+)px/.exec(v) || [0, 0])[1]) || 0;
      if (/^border(-width)?$/.test(name) || name === 'border') {
        left = right = px(value);
      } else if (name.endsWith('-left')) left = px(value);
      else if (name.endsWith('-right')) right = px(value);
      else {
        const parts = value.split(/\s+/);
        left = px(parts[3] ?? parts[1] ?? parts[0]);
        right = px(parts[1] ?? parts[0]);
      }
    }
    return left + right;
  };
  const MSG = ['.msg'];
  const BODY = ['.msg__body', '.msg--assistant .msg__body', '.msg .msg__body', '.msg > .msg__body'];
  const WIDGET = ['.widget'];
  const SCROLL = ['.widget__scroll'];
  const widths = cssDecl(MSG, 'max-width').split('|').filter(Boolean);
  const msgWidth = parseFloat((widths.at(-1) || '').split('=')[1]);
  const msgPad = across(cssDecl(MSG, 'padding'));
  const bodyRoom = across(cssDecl(BODY, 'padding')) + across(cssDecl(BODY, 'border'));
  const widgetRoom = across(cssDecl(WIDGET, 'padding')) + across(cssDecl(WIDGET, 'border'));
  const scrollRoom = across(cssDecl(SCROLL, 'padding')) + across(cssDecl(SCROLL, 'border'));
  const bodyPad = parseFloat((page.match(/'body\{padding:([\d.]+)px\}/) || [])[1]);
  const borderBox = /\* \{\s*box-sizing: border-box;/.test(css);
  const column = msgWidth - msgPad - bodyRoom - widgetRoom - scrollRoom - 2 * bodyPad;
  check(`the column a drawing is laid out for is the page's: .msg ${msgWidth} − ${msgPad} padding − .msg__body ${bodyRoom} − .widget ${widgetRoom} − scroller ${scrollRoom} − 2×${bodyPad} frame padding = ${column}`, borderBox && Number.isFinite(column) && DRAWING_FIT.column === column, `DRAWING_FIT.column ${DRAWING_FIT.column}`);
  // The reader itself, on what it must catch: padding on the reply's body, a thicker widget
  // border, and a desktop media query narrowing .msg; a phone-only query is not read.
  const sample = (extra) => {
    const saved = cssBlocks.splice(0);
    walkCss(`${flatCss}\n${extra}`, true);
    const out = cssDecl(BODY, 'padding') + cssDecl(WIDGET, 'border') + cssDecl(MSG, 'max-width');
    cssBlocks.splice(0, cssBlocks.length, ...saved);
    return out;
  };
  check(
    '  and it reads padding on .msg__body, a .widget border, and a desktop override of .msg — but not a phone-only one',
    across(sample('.msg__body { padding: 0 6px; }').split('|').filter((x) => x.startsWith('padding')).join('|')) === 12 &&
      sample('@media (min-width: 1000px) { .msg { max-width: 700px; } }').endsWith('max-width=700px') &&
      !sample('@media (max-width: 860px) { .msg { max-width: 600px; } }').endsWith('max-width=600px') &&
      sample('.widget { border: 2px solid red; }').includes('border=2px solid red'),
  );
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
  // Fix round 5: where scrollbars overlay, the side with drawing still beyond it fades out, set
  // by the scroll position (no animation), and only on a laid-out diagram's scroller.
  check(
    'a sideways-scrolling diagram fades out on the side that goes on, and not once scrolled to its end',
    page.includes("scroller.addEventListener('scroll', edges, { passive: true });") &&
      page.includes("scroller.classList.toggle('widget__scroll--after', rest > 1 && scroller.scrollLeft < rest - 1);") &&
      page.includes("scroller.classList.toggle('widget__scroll--before', rest > 1 && scroller.scrollLeft > 1);") &&
      /\.widget__scroll--after \{[^}]*mask-image: linear-gradient\(to right/.test(css) &&
      /\.widget__scroll--before \{[^}]*mask-image: linear-gradient\(to left/.test(css) &&
      !/\.widget__scroll[^{]*\{[^}]*(transition|animation)/.test(css),
  );
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
