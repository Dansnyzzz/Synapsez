#!/usr/bin/env node
/**
 * Record the getting-started guide's clips from the app itself (owner, 2026-10-20).
 *
 *   npm run onboarding:record                      all six steps, vi and en
 *   npm run onboarding:record -- --step=3 --lang=vi
 *
 * A clip is the real interface, never a drawing of it. The app runs here on a
 * throwaway in-process database with one demo account, and headless Chrome
 * records each scene (Playwright `recordVideo`). Settings are operated for real
 * — keys pasted and saved, the model browser opened, the mode menu pointed at.
 * The conversations are drawn by the app's own renderer (`render.js`) from
 * sample turns, so no model is called, nothing is spent, and a scene records the
 * same every time; the guide says so under every clip. Their document is made by
 * the real `create_file`; their chart and shop pages are generated pictures,
 * since there is no cloud computer on the machine doing the recording.
 *
 * Headless Chrome draws no pointer, so the scenes carry one of their own: it
 * moves to what is about to be pressed and pulses as it is pressed. Each clip is
 * cut where its scene begins and re-encoded with the ffmpeg Playwright installs
 * (VP8/WebM, no sound). Its still frame is a screenshot at the scene's best moment.
 *
 * Out: public/onboarding/{vi,en}/step-{1..6}.webm and .jpg.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'public', 'onboarding');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsez-onb-raw-'));
const SIZE = { width: 1280, height: 800 };
/** Each clip must stay under this; the encoder is asked again, harder, until it does. */
const MAX_BYTES = 600 * 1024;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const onlyStep = arg('step') ? Number(arg('step')) : null;
const onlyLang = arg('lang') || null;

/** Playwright's own ffmpeg — the one `recordVideo` uses — unless FFMPEG names another. */
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const home =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'ms-playwright')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright'));
  for (const dir of fs.existsSync(home) ? fs.readdirSync(home) : []) {
    if (!dir.startsWith('ffmpeg')) continue;
    for (const name of ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac']) {
      const candidate = path.join(home, dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('No ffmpeg found. Run `npx playwright-core install ffmpeg`, or set FFMPEG.');
}
const FFMPEG = findFfmpeg();

// ── the app, on a database of its own ────────────────────────────────
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsez-onb-data-'));
process.env.WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsez-onb-ws-'));
process.env.ENCRYPTION_KEY ||= 'onboarding-recording-key';
process.env.SESSION_SECRET ||= 'onboarding-recording-secret';
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL']) delete process.env[name];

const { initStore } = await import('../server/store/index.js');
await initStore();
const { createApp } = await import('../server/app.js');
const { executeTool } = await import('../server/tools/execute.js');
const { DEFAULT_PREFS } = await import('../server/settings.js');
const { LEGAL } = await import('../server/legal.js');
const server = (await createApp()).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

const registered = await fetch(`${base}/api/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  // Agreed as the sign-up tick agrees, so no "please agree" banner stands over the scenes.
  body: JSON.stringify({ email: 'lan@example.com', password: 'mot-mat-khau-du-dai', name: 'Lan', username: 'lan', consent: LEGAL.notice, terms: LEGAL.terms, usage: LEGAL.usage }),
});
if (registered.status !== 201) throw new Error(`could not make the demo account: ${await registered.text()}`);
const { user } = await registered.json();
const cookies = registered.headers.getSetCookie().map((line) => {
  const pair = line.split(';')[0];
  return { name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1) };
});
const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
};

const { chromium } = await import('playwright-core');
let browser;
for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
  try {
    browser = await chromium.launch({ ...options, headless: true });
    break;
  } catch {
    /* the next one */
  }
}
if (!browser) throw new Error('No Chrome, Edge or bundled Chromium to record with.');

// ── the sample turns ─────────────────────────────────────────────────
const REVENUE = [412, 386, 455, 480, 512, 498, 540, 575, 562, 610, 688, 645];

const COPY = {
  vi: {
    ask1: 'Tìm 3 xu hướng thương mại điện tử nổi bật năm 2026 và viết thành báo cáo Word ngắn',
    results1: [
      ['Xu hướng thương mại điện tử 2026 — báo cáo ngành', 'https://example.com/bao-cao-tmdt-2026'],
      ['Mua sắm qua video ngắn tiếp tục tăng', 'https://example.org/video-commerce'],
      ['Thanh toán một chạm và ví điện tử', 'https://example.net/thanh-toan-2026'],
    ],
    answer1:
      'Mình tìm được 3 xu hướng chính: **mua sắm qua video ngắn** ([example.org](https://example.org/video-commerce)), ' +
      '**thanh toán một chạm** ([example.net](https://example.net/thanh-toan-2026)) và **trợ lý AI chăm sóc khách hàng** ([example.com](https://example.com/bao-cao-tmdt-2026)). ' +
      'Báo cáo Word ở ngay dưới — bấm để xem trước hoặc tải về.',
    doc: 'Bao cao xu huong TMDT 2026',
    docBody:
      '# Ba xu hướng thương mại điện tử 2026\n\n## 1. Mua sắm qua video ngắn\nNgười mua xem và đặt hàng ngay trong video.\n\n' +
      '## 2. Thanh toán một chạm\nVí điện tử và mã QR thay cho nhập thẻ.\n\n## 3. Trợ lý AI chăm sóc khách hàng\nTrả lời cả ngày, chuyển cho người thật khi cần.',
    ask4: 'Tạo dữ liệu bán hàng mẫu 12 tháng, vẽ biểu đồ doanh thu, rồi mở cửa hàng mẫu và thêm tai nghe Pulse Mini vào giỏ',
    title4: 'Tạo dữ liệu mẫu và vẽ biểu đồ doanh thu',
    python4:
      'import pandas as pd, matplotlib.pyplot as plt\n' +
      `df = pd.DataFrame({"thang": range(1, 13), "doanh_thu": [${REVENUE.join(', ')}]})\n` +
      'print("Tổng doanh thu:", df.doanh_thu.sum(), "triệu đồng")\n' +
      'print("Tháng cao nhất: T%d (%d triệu)" % (df.thang[df.doanh_thu.idxmax()], df.doanh_thu.max()))\n' +
      'df.plot.bar(x="thang", y="doanh_thu", title="Doanh thu theo tháng — 2026", legend=False)\nplt.show()',
    printed4: 'Tổng doanh thu: 6363 triệu đồng\nTháng cao nhất: T11 (688 triệu)',
    between4: 'Cả năm đạt **6.363 triệu đồng**, cao nhất vào **tháng 11** (688 triệu). Giờ mình mở cửa hàng mẫu trên trình duyệt của máy cloud.',
    after4: 'Xong — **Pulse Mini** (1.250.000₫) đã nằm trong giỏ hàng của cửa hàng mẫu.',
    chartTitle: 'Doanh thu theo tháng — 2026 (triệu đồng)',
    months: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12'],
    shop: { name: 'Cửa hàng Mẫu', search: 'Tìm: tai nghe không dây', price: 'Giá', cart: 'Thêm vào giỏ', results: '3 kết quả', added: 'Đã thêm vào giỏ' },
    results6: [
      ['Mô hình AI mới lập kỷ lục về suy luận', 'https://example.com/ai-ky-luc'],
      ['AI giúp bác sĩ đọc phim X-quang', 'https://example.org/ai-y-te'],
      ['Quy định mới về dữ liệu huấn luyện AI', 'https://example.net/quy-dinh-ai'],
      ['Trợ lý viết code mã nguồn mở ra bản mới', 'https://example.com/tro-ly-code'],
      ['Doanh nghiệp nhỏ dùng AI chăm sóc khách hàng', 'https://example.org/ai-doanh-nghiep'],
    ],
    answer6:
      '**1. Mô hình AI mới lập kỷ lục về suy luận** — Một mô hình vượt các bài kiểm tra toán và lập trình. Nhà phát triển nói chi phí chạy giảm một nửa ([example.com](https://example.com/ai-ky-luc)).\n\n' +
      '**2. AI giúp bác sĩ đọc phim X-quang** — Bệnh viện thử AI đánh dấu vùng nghi ngờ. Bác sĩ vẫn là người kết luận ([example.org](https://example.org/ai-y-te)).\n\n' +
      '**3. Quy định mới về dữ liệu huấn luyện** — Nhà làm luật yêu cầu công khai nguồn dữ liệu. Quy định áp dụng từ năm sau ([example.net](https://example.net/quy-dinh-ai)).\n\n' +
      '**4. Trợ lý viết code mã nguồn mở ra bản mới** — Bản mới đọc được cả dự án lớn. Cộng đồng gửi hơn nghìn bản sửa ([example.com](https://example.com/tro-ly-code)).\n\n' +
      '**5. Doanh nghiệp nhỏ dùng AI chăm sóc khách hàng** — Nhiều cửa hàng trả lời tin nhắn bằng AI. Người thật xử lý ca khó ([example.org](https://example.org/ai-doanh-nghiep)).',
  },
  en: {
    ask1: 'Find 3 standout e-commerce trends for 2026 and write them up as a short Word report',
    results1: [
      ['E-commerce trends 2026 — industry report', 'https://example.com/ecommerce-2026'],
      ['Short-video shopping keeps growing', 'https://example.org/video-commerce'],
      ['One-tap payments and e-wallets', 'https://example.net/payments-2026'],
    ],
    answer1:
      'I found three main trends: **short-video shopping** ([example.org](https://example.org/video-commerce)), ' +
      '**one-tap payments** ([example.net](https://example.net/payments-2026)) and **AI customer assistants** ([example.com](https://example.com/ecommerce-2026)). ' +
      'The Word report is just below — press it to preview or download.',
    doc: 'Ecommerce trends 2026',
    docBody:
      '# Three e-commerce trends for 2026\n\n## 1. Short-video shopping\nBuyers watch and order inside the video.\n\n' +
      '## 2. One-tap payments\nE-wallets and QR codes instead of typing a card.\n\n## 3. AI customer assistants\nAnswers all day, a person when it matters.',
    ask4: 'Generate 12 months of sample sales data and chart the revenue, then open the demo shop and add the Pulse Mini earbuds to the cart',
    title4: 'Generating sample data and charting revenue',
    python4:
      'import pandas as pd, matplotlib.pyplot as plt\n' +
      `df = pd.DataFrame({"month": range(1, 13), "revenue": [${REVENUE.join(', ')}]})\n` +
      'print("Total revenue:", df.revenue.sum(), "million VND")\n' +
      'print("Best month: %d (%d million)" % (df.month[df.revenue.idxmax()], df.revenue.max()))\n' +
      'df.plot.bar(x="month", y="revenue", title="Revenue by month — 2026", legend=False)\nplt.show()',
    printed4: 'Total revenue: 6363 million VND\nBest month: 11 (688 million)',
    between4: "The year comes to **6,363 million VND**, best in **November** (688 million). Now I will open the demo shop in the cloud computer's browser.",
    after4: "Done — the **Pulse Mini** (1,250,000₫) is in the demo shop's cart.",
    chartTitle: 'Revenue by month — 2026 (million VND)',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    shop: { name: 'Demo Shop', search: 'Search: wireless earbuds', price: 'Price', cart: 'Add to cart', results: '3 results', added: 'Added to cart' },
    results6: [
      ['A new AI model sets a reasoning record', 'https://example.com/ai-record'],
      ['AI helps doctors read X-rays', 'https://example.org/ai-health'],
      ['New rules on AI training data', 'https://example.net/ai-rules'],
      ['An open-source coding assistant ships a new version', 'https://example.com/code-assistant'],
      ['Small businesses answer customers with AI', 'https://example.org/ai-small-business'],
    ],
    answer6:
      '**1. A new AI model sets a reasoning record** — It beats the maths and coding benchmarks. Its makers say it costs half as much to run ([example.com](https://example.com/ai-record)).\n\n' +
      '**2. AI helps doctors read X-rays** — Hospitals are trialling AI that marks suspicious areas. Doctors still make the call ([example.org](https://example.org/ai-health)).\n\n' +
      '**3. New rules on training data** — Lawmakers want the sources of training data disclosed. The rules apply from next year ([example.net](https://example.net/ai-rules)).\n\n' +
      '**4. An open-source coding assistant ships a new version** — It now reads whole large projects. The community sent over a thousand fixes ([example.com](https://example.com/code-assistant)).\n\n' +
      '**5. Small businesses answer customers with AI** — Many shops reply to messages with AI. People handle the hard cases ([example.org](https://example.org/ai-small-business)).',
  },
};

/** A search's result as `web_search` writes it: numbered titles, each address under its title. */
const searchResult = (rows) => rows.map(([title, url], i) => `${i + 1}. ${title}\n   ${url}`).join('\n');

/** What `sandbox_run` says after a Python cell that drew a figure (see `pythonReport`). */
const pythonResult = (printed, figure) =>
  [
    '[Python: a new session — nothing from earlier calls is defined (the cloud computer had rested, or the session was reset). Load what you need again.]',
    `output:\n${printed}`,
    `Showed the user the figure in the conversation: ${figure.name} (id ${figure.id}).`,
    "(This account's own cloud computer: it keeps its files and installs between conversations. Full internet access; as_root: true for system packages. " +
      'The Python session keeps its variables while the computer is awake — about fifteen idle minutes.)',
  ].join('\n');

// ── pictures the scenes need ─────────────────────────────────────────
/**
 * The bar chart the sample cell draws, in matplotlib's default look. Drawn by
 * Chrome rather than a bare canvas, whose fonts have no Vietnamese accents.
 */
async function chart(lang) {
  const words = COPY[lang];
  const [w, h, left, right, top, bottom, max] = [1000, 620, 90, 960, 80, 550, 700];
  const span = (right - left) / REVENUE.length;
  const y = (v) => bottom - ((bottom - top) * v) / max;
  const ticks = Array.from({ length: max / 100 + 1 }, (_, i) => i * 100)
    .map((v) => `<line x1="${left - 5}" x2="${left}" y1="${y(v)}" y2="${y(v)}" stroke="#222"/><text x="${left - 10}" y="${y(v) + 5}" text-anchor="end">${v}</text>`)
    .join('');
  const bars = REVENUE.map((v, i) => {
    const x = left + i * span + span * 0.15;
    return `<rect x="${x}" y="${y(v)}" width="${span * 0.7}" height="${bottom - y(v)}" fill="#1f77b4"/><text x="${x + span * 0.35}" y="${bottom + 24}" text-anchor="middle">${words.months[i]}</text>`;
  }).join('');
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
    <svg width="${w}" height="${h}" font-family="DejaVu Sans, Segoe UI, Arial, sans-serif" font-size="16" fill="#222">
      <text x="${w / 2}" y="44" text-anchor="middle" font-size="24">${words.chartTitle}</text>
      ${bars}${ticks}
      <rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="none" stroke="#222" stroke-width="1.2"/>
    </svg></body></html>`);
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  await page.close();
  return png;
}

/** A page of the made-up shop the browser steps visit — a demo, never a real one. */
async function shopShot(lang, added) {
  const words = COPY[lang].shop;
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const items = [
    ['Aero Buds', '890.000₫'],
    ['Pulse Mini', '1.250.000₫'],
    ['Echo Pro', '1.990.000₫'],
  ];
  await page.setContent(`<!doctype html><html><body style="margin:0;font-family:system-ui,sans-serif;background:#f5f6fa">
    <header style="background:#2b3a67;color:#fff;padding:18px 28px;font-size:22px;font-weight:700">${words.name} <span style="float:right;font-weight:400;font-size:16px">🛒 ${added ? 1 : 0}</span></header>
    <div style="padding:22px 28px">
      <div style="background:#fff;border:1px solid #d9dce5;border-radius:10px;padding:12px 16px;font-size:18px;color:#333">${words.search}</div>
      <p style="color:#666;margin:16px 0 8px">${words.results}</p>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
        ${items
          .map(([name, price], i) => {
            const done = added && i === 1;
            return `<div style="background:#fff;border:1px solid ${done ? '#7c5cff' : '#e2e5ee'};border-radius:12px;padding:14px">
              <div style="height:150px;border-radius:8px;background:linear-gradient(135deg,#dfe6ff,#f4e8ff)"></div>
              <div style="font-weight:700;margin:10px 0 4px">${name}</div><div style="color:#2b3a67">${words.price}: ${price}</div>
              <div style="margin-top:10px;background:${done ? '#7c5cff' : '#2b3a67'};color:#fff;text-align:center;border-radius:8px;padding:8px">${done ? `✓ ${words.added}` : words.cart}</div></div>`;
          })
          .join('')}
      </div></div></body></html>`);
  const shot = (await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64');
  await page.close();
  return shot;
}

async function upload(name, mime, data) {
  const { attachment } = await call('POST', '/api/attachments', { name, mime, data });
  return { id: attachment.id, name: attachment.name, mime: attachment.mime, kind: attachment.kind, bytes: attachment.bytes };
}

// ── the pointer ──────────────────────────────────────────────────────
const POINTER = `
#rec-cursor{position:fixed;inset:auto;left:0;top:0;width:26px;height:26px;margin:0;padding:0;border:0;background:none;overflow:visible;
  pointer-events:none;transform:translate(640px,700px);transition:transform .7s cubic-bezier(.3,.7,.2,1)}
#rec-cursor svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}
#rec-cursor.is-down::after{content:'';position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;
  background:rgba(124,92,255,.45);animation:rec-pulse .5s ease-out forwards}
@keyframes rec-pulse{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}`;
const ARROW =
  '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2l17 12.5-7.6 1.3 4.4 8.2-3.4 1.7-4.4-8.3L2 22z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';

async function addPointer(page) {
  await page.addStyleTag({ content: POINTER });
  await page.evaluate((arrow) => {
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    // A popover is in the top layer, so it can be raised above an open dialog.
    c.setAttribute('popover', 'manual');
    c.innerHTML = arrow;
    document.body.append(c);
    c.showPopover();
  }, ARROW);
}
/** Back on top, after a dialog has opened above it. */
const raise = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('rec-cursor');
    c?.hidePopover();
    c?.showPopover();
  });
async function pointAt(page, selector, { wait = 750 } = {}) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const box = await target.boundingBox();
  if (!box) throw new Error(`nothing to point at: ${selector}`);
  await page.evaluate(
    ([x, y]) => {
      document.getElementById('rec-cursor').style.transform = `translate(${x}px, ${y}px)`;
    },
    [box.x + Math.min(box.width / 2, 60), box.y + box.height / 2],
  );
  await page.waitForTimeout(wait);
}
async function press(page, selector, { click = true } = {}) {
  await pointAt(page, selector);
  await page.evaluate(() => {
    const c = document.getElementById('rec-cursor');
    c.classList.remove('is-down');
    void c.offsetWidth;
    c.classList.add('is-down');
  });
  await page.waitForTimeout(160);
  if (click) await page.locator(selector).first().click();
}

// ── conversations drawn by the app's own renderer ───────────────────
/** Put the stage helpers in the page: hide the empty home, hand back the renderer. */
const STAGE = () => {
  const w = /** @type {any} */ (window);
  w.__stage = async () => {
    document.getElementById('empty-state').hidden = true;
    document.getElementById('app').classList.remove('is-fresh');
    // The transcript follows what is written at its end, as it does live.
    const thread = document.getElementById('thread');
    new w.MutationObserver(() => {
      thread.scrollTop = thread.scrollHeight;
    }).observe(document.getElementById('messages'), { childList: true, subtree: true, characterData: true });
    return import('/js/render.js');
  };
  /** A new block of the reply — one per model step. */
  w.__block = (render) => {
    const turn = render.assistantMessage();
    document.getElementById('messages').append(turn.node);
    return turn;
  };
  w.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  w.__stream = async (turn, text, every = 40) => {
    for (const word of text.split(/(?<= )/)) {
      turn.appendText(word);
      await w.__sleep(every);
    }
  };
};

// ── the scenes ───────────────────────────────────────────────────────
/**
 * Each scene: what comes before `begin()` is set-up and is cut from the clip;
 * `still()` takes the poster at the scene's best moment.
 */
const SCENES = {
  /** What it does: a search with sources, an answer, and a Word file made by create_file. */
  async 1({ page, lang, begin, still, assets }) {
    await page.evaluate(STAGE);
    await begin();
    await page.evaluate(
      async ({ ask, results, answer, made }) => {
        const w = /** @type {any} */ (window);
        const r = await w.__stage();
        const messages = document.getElementById('messages');
        messages.append(r.userMessage(ask, [], null, new Date()));
        await w.__sleep(700);
        // A block per model step, as a live turn draws them.
        const search = w.__block(r).startTool({ id: 's1', name: 'web_search', input: { query: ask } });
        await w.__sleep(1500);
        search.complete({ content: results, ms: 1400 });
        await w.__sleep(500);
        const turn = w.__block(r);
        await w.__stream(turn, answer);
        const file = turn.startTool({ id: 'f1', name: 'create_file', input: { name: made.file.name, format: 'docx', content: '…' } });
        await w.__sleep(900);
        file.complete({ content: made.content, ms: 900, file: made.file });
        turn.finish(new Date());
      },
      { ask: COPY[lang].ask1, results: searchResult(COPY[lang].results1), answer: COPY[lang].answer1, made: assets.doc },
    );
    await page.waitForTimeout(600);
    // The search folds itself when it is done; opened, it lists what was found.
    await press(page, '#messages .block.web > summary');
    await page.waitForTimeout(900);
    await still();
    await page.waitForTimeout(1300);
  },

  /** A key pasted and saved, then a second one: the list numbers them in the order they are tried. */
  async 2({ page, begin, still }) {
    // Settings is a row of the account menu at the foot of the sidebar (2026-10-26).
    await page.locator('#account-button').click();
    await page.waitForTimeout(300);
    await page.locator('.plusmenu--account [data-row="settings"]').click();
    await page.waitForTimeout(500);
    await page.locator('.tab[data-tab="providers"]').click();
    await page.locator('[data-key="openrouter"]').scrollIntoViewIfNeeded();
    await raise(page);
    await begin();
    // Made-up keys, plainly: the box hides what is typed, and the list shows the last four.
    for (const key of ['demo-key-not-real-7a41', 'demo-key-not-real-c93e']) {
      await press(page, '[data-key="openrouter"]');
      await page.keyboard.type(key, { delay: 30 });
      await press(page, '[data-save-key="openrouter"]');
      await page.waitForTimeout(1100);
      await page.locator('[data-key="openrouter"]').scrollIntoViewIfNeeded();
      await raise(page);
    }
    await pointAt(page, '.provider:has([data-key="openrouter"]) .keyrow:nth-child(2) .keyrow__no', { wait: 1000 });
    await still();
    await page.waitForTimeout(900);
  },

  /** From a new account's model to Auto, the free one, in the model browser. */
  async 3({ page, begin, still }) {
    await begin();
    await pointAt(page, '#model-chip', { wait: 600 });
    await press(page, '#model-chip');
    await page.waitForTimeout(900);
    await raise(page);
    const others = page.locator('#models [data-model]:not([data-model="auto"])');
    if ((await others.count()) > 1) {
      await pointAt(page, '#models [data-model]:not([data-model="auto"]) >> nth=0', { wait: 800 });
      await pointAt(page, '#models [data-model]:not([data-model="auto"]) >> nth=1', { wait: 800 });
    }
    await pointAt(page, '#models [data-model="auto"]', { wait: 1000 });
    await still();
    await press(page, '#models [data-model="auto"]');
    await page.waitForTimeout(700);
    await pointAt(page, '#model-chip', { wait: 1600 });
  },

  /** The cloud computer: Python draws a chart, then its browser visits a shop. */
  async 4({ page, lang, begin, still, assets }) {
    await page.evaluate(STAGE);
    await begin();
    const words = COPY[lang];
    await page.evaluate(
      async ({ ask, title, python, result, between, after, chart, shots }) => {
        const w = /** @type {any} */ (window);
        const r = await w.__stage();
        const messages = document.getElementById('messages');
        messages.append(r.userMessage(ask, [], null, new Date()));
        await w.__sleep(600);
        // A block per model step, as a live turn draws them: the cell, then a
        // sentence and the first browser step, the next step, the last words.
        const run = w.__block(r).startTool({ id: 'p1', name: 'sandbox_run', input: { title, python } });
        await w.__sleep(2600);
        run.complete({ content: result, ms: 2400, file: chart });
        await w.__sleep(600);
        const said = w.__block(r);
        await w.__stream(said, between, 35);
        const steps = [
          [said, { action: 'open', url: 'https://shop.example.com/?q=tai-nghe' }, shots[0]],
          [w.__block(r), { action: 'click', ref: 12 }, shots[1]],
        ];
        for (const [i, [turn, input, shot]] of steps.entries()) {
          const step = turn.startTool({ id: `b${i}`, name: 'cloud_browser', input });
          await w.__sleep(1200);
          step.complete({ content: 'ok', ms: 1100, shot: { id: shot } });
          await w.__sleep(300);
        }
        const last = w.__block(r);
        await w.__stream(last, after, 35);
        last.finish(new Date());
      },
      { ask: words.ask4, title: words.title4, python: words.python4, result: pythonResult(words.printed4, assets.chart), between: words.between4, after: words.after4, chart: assets.chart, shots: assets.shots },
    );
    await page.waitForTimeout(800);
    await still();
    await page.waitForTimeout(1300);
  },

  /** The mode button, and its five levels. */
  async 5({ page, begin, still }) {
    await begin();
    await press(page, '#policy-chip');
    await page.waitForTimeout(500);
    const count = await page.locator('#policy-menu .menu__item').count();
    for (let i = 0; i < count; i += 1) await pointAt(page, `#policy-menu .menu__item >> nth=${i}`, { wait: 750 });
    await pointAt(page, '#policy-menu .menu__item >> nth=0', { wait: 600 });
    await still();
    await page.waitForTimeout(600);
  },

  /** A suggestion goes into the box; sending it starts the work. */
  async 6({ page, lang, begin, still }) {
    await page.evaluate(STAGE);
    await page.evaluate(() => document.getElementById('open-onboarding').click());
    await page.waitForTimeout(400);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
    // The guide's own clip stays out of this one: a clip inside itself would
    // show whatever the last recording happened to be.
    await page.evaluate(() => {
      /** @type {HTMLVideoElement} */ (document.getElementById('onb-video')).pause();
      document.getElementById('onb-media').hidden = true;
    });
    await page.waitForTimeout(300);
    await raise(page);
    await begin();
    await pointAt(page, '#onb-body .onb__try >> nth=1', { wait: 600 });
    await press(page, '#onb-body .onb__try >> nth=0');
    await page.waitForTimeout(900);
    await press(page, '#send', { click: false });
    await page.evaluate(
      async ({ results, answer }) => {
        const w = /** @type {any} */ (window);
        const r = await w.__stage();
        const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
        // Exactly what the suggestion put in the box, as sending it would.
        const ask = input.value;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const messages = document.getElementById('messages');
        messages.append(r.userMessage(ask, [], null, new Date()));
        await w.__sleep(600);
        const search = w.__block(r).startTool({ id: 's6', name: 'web_search', input: { query: ask } });
        await w.__sleep(1400);
        search.complete({ content: results, ms: 1300 });
        await w.__sleep(400);
        const turn = w.__block(r);
        await w.__stream(turn, answer, 22);
        turn.finish(new Date());
      },
      { results: searchResult(COPY[lang].results6), answer: COPY[lang].answer6 },
    );
    await page.waitForTimeout(700);
    await still();
    await page.waitForTimeout(1300);
  },
};

// ── recording ────────────────────────────────────────────────────────
function encode(raw, cut, out) {
  for (const rate of ['520k', '360k', '240k']) {
    const run = spawnSync(
      FFMPEG,
      ['-y', '-ss', cut.toFixed(2), '-i', raw, '-an', '-c:v', 'libvpx', '-b:v', rate, '-maxrate', rate, '-bufsize', '1000k', '-qmin', '4', '-qmax', '50', '-deadline', 'good', '-cpu-used', '1', out],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${String(run.stderr).slice(-600)}`);
    if (fs.statSync(out).size <= MAX_BYTES) return;
  }
  throw new Error(`${out} is still over ${MAX_BYTES} bytes at the lowest rate`);
}

async function record(lang, step, assets) {
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: RAW, size: SIZE }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await context.addCookies(cookies.map((c) => ({ ...c, url: base })));
  await context.addInitScript((language) => localStorage.setItem('ai-remote-language', language), lang);
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`));
  // Video time runs from the page's creation, so the cut is measured from here.
  const opened = Date.now();
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForSelector('#model-chip', { state: 'visible' });
  await page.waitForTimeout(1000);
  await addPointer(page);
  let cut = 0;
  const dir = path.join(OUT, lang);
  fs.mkdirSync(dir, { recursive: true });
  await SCENES[step]({
    page,
    lang,
    assets,
    still: () => page.screenshot({ path: path.join(dir, `step-${step}.jpg`), type: 'jpeg', quality: 78 }),
    begin: async () => {
      cut = (Date.now() - opened) / 1000;
    },
  });
  const video = page.video();
  await context.close();
  const out = path.join(dir, `step-${step}.webm`);
  encode(await video.path(), cut, out);
  console.log(`  ${lang}/step-${step}.webm  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

try {
  for (const lang of onlyLang ? [onlyLang] : ['vi', 'en']) {
    // The account's own language, so the app does not switch back as it boots.
    await call('PUT', '/api/prefs', { language: lang, onboarded: true });
    const made = await executeTool({ user, name: 'create_file', input: { name: COPY[lang].doc, format: 'docx', content: COPY[lang].docBody }, chatId: null });
    if (made.isError || !made.file?.id) throw new Error(`create_file made nothing: ${made.content}`);
    const assets = {
      doc: { content: made.content, file: made.file },
      chart: await upload('figure-1.png', 'image/png', await chart(lang)),
      shots: [(await upload('shop-1.jpg', 'image/jpeg', await shopShot(lang, false))).id, (await upload('shop-2.jpg', 'image/jpeg', await shopShot(lang, true))).id],
    };
    for (const step of [1, 2, 3, 4, 5, 6]) {
      if (onlyStep && step !== onlyStep) continue;
      // Step 2 starts from an account with no key; the rest from one with a key.
      await call('PUT', '/api/providers/openrouter/key', { apiKey: step === 2 ? '' : 'demo-key-not-real-0000' });
      // Step 3 starts on the model a new account is given and moves to Auto;
      // the others are on Auto already, as somebody who followed step 3 is.
      await call('PUT', '/api/prefs', { defaultModel: step === 3 ? DEFAULT_PREFS.defaultModel : 'auto' });
      // A new model's announcement is somebody else's moment, and which one is
      // due depends on the model in use: answered "not now" until none is.
      for (let i = 0; i < 5; i += 1) {
        const { model: news } = await call('GET', '/api/models/news?tz=Asia%2FHo_Chi_Minh');
        if (!news) break;
        await call('POST', '/api/models/news', { id: news.id, action: 'decline' });
      }
      await record(lang, step, assets);
    }
  }
} finally {
  await browser.close();
  server.close();
  fs.rmSync(RAW, { recursive: true, force: true });
}
process.exit(0);
