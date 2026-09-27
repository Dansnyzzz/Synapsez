/**
 * What a sent email looks like — chosen for what the email is.
 *
 * A thank-you note, an invoice, a meeting invitation and an incident alert are
 * different documents, and dressing them all the same is what makes automated
 * mail look automated. So a message has a **kind**. The assistant names it from
 * what the person asked for ("gửi báo giá cho anh Minh" → quotation); when it
 * does not, it is inferred from the subject, the words and the structure. Each
 * kind decides:
 *
 *   - the **shape**: a quiet letter (no banner, no big title — how a person
 *     writes) or a card (a labelled header, the subject as a title);
 *   - the **accent colour** and the small label above the title
 *     ("Hoá đơn", "Thư mời", "Cảnh báo") in the reader's language;
 *   - whether the date sits above the title.
 *
 * The body is Markdown, and a few shapes are recognised because the documents
 * above are made of them:
 *
 *   - `Label: value` lines together → a details card (time, place, amount);
 *   - a table row starting "Tổng"/"Total" → a highlighted total;
 *   - `- [ ]` / `- [x]` → a checklist of action items;
 *   - a paragraph that is only `[label](https://…)` → a button;
 *   - `+2,1%` / `-0,48%` in a table → coloured by direction;
 *   - a line in capitals → a section heading, capitals kept;
 *   - "Nguồn:" / "Sources:" → small, quiet attribution.
 *
 * Email HTML is not web HTML: tables and inline styles on every element, 600px
 * at most, no images, web fonts or scripts, nothing fetched. A `<style>` block
 * adds dark mode and phone spacing for clients that honour it (Apple Mail,
 * Outlook apps); without it the inline design stands on its own (Gmail). All
 * text is escaped before any markup is added, and links are http(s) or mailto
 * only.
 */

const BASE = {
  page: '#f4f3f9',
  card: '#ffffff',
  line: '#e5e9ef',
  text: '#1c2733',
  muted: '#667385',
  faint: '#98a3b3',
  codeBg: '#f1f3f6',
  soft: '#fafbfc',
  up: '#0e8f63',
  down: '#d23f3f',
};
/**
 * The galaxy look: deep indigo into violet into fuchsia.
 *
 * Every gradient is written with a solid `background-color` first. Apple Mail,
 * iOS Mail and most phone apps paint the gradient; a client that drops
 * `background-image` (Outlook for Windows renders with Word) still shows the
 * solid colour, so white text on a header is readable either way.
 */
const GALAXY = {
  hero: 'background-color:#2e1065;background-image:linear-gradient(135deg,#0f0c29 0%,#2e1065 38%,#6d28d9 72%,#c026d3 100%)',
  button: 'background-color:#6d28d9;background-image:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#c026d3 100%)',
  bar: 'background-color:#7c3aed;background-image:linear-gradient(180deg,#6366f1 0%,#a855f7 55%,#d946ef 100%)',
  line: 'background-color:#7c3aed;background-image:linear-gradient(90deg,#4f46e5 0%,#7c3aed 50%,#d946ef 100%)',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/* ── the kinds of email ─────────────────────────────────────────────── */

/**
 * Every kind, with its look and how to recognise it.
 *
 * `shape: 'letter'` is written like a person's email; `'card'` has a labelled
 * header. `soft` is a pale tint of `accent` for callouts and details cards.
 * `words` are matched against the subject and the first lines (Vietnamese with
 * and without diacritics, and English); a kind is only inferred when one of its
 * words is present, so an ordinary note is never mistaken for an invoice.
 */
export const KINDS = {
  letter: {
    shape: 'letter',
    accent: '#6d28d9',
    soft: '#f3efff',
    label: { vi: 'Thư', en: 'Letter' },
    words: [],
  },
  thank_you: {
    shape: 'letter',
    accent: '#9333ea',
    soft: '#f7effe',
    label: { vi: 'Lời cảm ơn', en: 'Thank you' },
    words: ['cảm ơn', 'cam on', 'tri ân', 'thank you', 'thanks for', 'appreciation'],
  },
  apology: {
    shape: 'letter',
    accent: '#5b5bd6',
    soft: '#efeffc',
    label: { vi: 'Lời xin lỗi', en: 'Apology' },
    words: ['xin lỗi', 'xin loi', 'rất tiếc vì', 'apolog', 'we are sorry', "we're sorry"],
  },
  follow_up: {
    shape: 'letter',
    accent: '#6d28d9',
    soft: '#f3efff',
    label: { vi: 'Theo dõi', en: 'Follow-up' },
    words: ['follow up', 'follow-up', 'following up', 'checking in', 'phản hồi giúp', 'chưa nhận được phản hồi'],
  },
  application: {
    shape: 'letter',
    accent: '#4f46e5',
    soft: '#eef0fe',
    label: { vi: 'Thư ứng tuyển', en: 'Application' },
    words: ['ứng tuyển', 'ung tuyen', 'thư xin việc', 'cover letter', 'job application', 'applying for'],
  },
  newsletter: {
    shape: 'card',
    accent: '#6d28d9',
    soft: '#f3efff',
    dated: true,
    label: { vi: 'Bản tin', en: 'Newsletter' },
    words: ['bản tin', 'ban tin', 'điểm tin', 'newsletter', 'digest', 'weekly roundup', 'daily brief'],
  },
  report: {
    shape: 'card',
    accent: '#4f46e5',
    soft: '#eef0fe',
    dated: true,
    label: { vi: 'Báo cáo', en: 'Report' },
    words: ['báo cáo', 'bao cao', 'tổng kết', 'kết quả kinh doanh', 'report', 'summary of results', 'kpi'],
  },
  announcement: {
    shape: 'card',
    accent: '#7c3aed',
    soft: '#f3edfe',
    label: { vi: 'Thông báo', en: 'Announcement' },
    words: ['thông báo', 'thong bao', 'ra mắt', 'announcement', 'announcing', 'we are excited', 'launch'],
  },
  alert: {
    shape: 'card',
    accent: '#be185d',
    soft: '#fdf0f6',
    label: { vi: 'Cảnh báo', en: 'Alert' },
    words: ['cảnh báo', 'canh bao', 'khẩn', 'sự cố', 'gián đoạn', 'alert', 'urgent', 'incident', 'outage', 'security notice'],
  },
  invitation: {
    shape: 'card',
    accent: '#c026d3',
    soft: '#fbeefc',
    label: { vi: 'Thư mời', en: 'Invitation' },
    words: ['thư mời', 'thu moi', 'trân trọng kính mời', 'kính mời', 'mời bạn', 'sự kiện', 'invitation', 'you are invited', "you're invited", 'rsvp', 'event'],
  },
  reminder: {
    shape: 'card',
    accent: '#a21caf',
    soft: '#faeefb',
    label: { vi: 'Nhắc việc', en: 'Reminder' },
    words: ['nhắc nhở', 'nhắc việc', 'nhắc lịch', 'hạn chót', 'đến hạn', 'reminder', 'deadline', 'due date', 'due on'],
  },
  quotation: {
    shape: 'card',
    accent: '#5b21b6',
    soft: '#f1ecfb',
    label: { vi: 'Báo giá', en: 'Quotation' },
    words: ['báo giá', 'bao gia', 'đề xuất', 'chào giá', 'quotation', 'quote for', 'proposal', 'estimate'],
  },
  invoice: {
    shape: 'card',
    accent: '#3730a3',
    soft: '#eeeffb',
    label: { vi: 'Hoá đơn', en: 'Invoice' },
    words: ['hoá đơn', 'hóa đơn', 'hoa don', 'biên nhận', 'biên lai', 'thanh toán', 'invoice', 'receipt', 'payment due', 'amount due'],
  },
  confirmation: {
    shape: 'card',
    accent: '#6d28d9',
    soft: '#f3efff',
    label: { vi: 'Xác nhận', en: 'Confirmation' },
    words: ['xác nhận', 'xac nhan', 'đặt chỗ', 'đặt lịch', 'đơn hàng', 'confirmation', 'confirmed', 'booking', 'order #', 'your order'],
  },
  meeting: {
    shape: 'card',
    accent: '#4338ca',
    soft: '#eeeffc',
    dated: true,
    label: { vi: 'Biên bản họp', en: 'Meeting notes' },
    words: ['biên bản', 'bien ban', 'cuộc họp', 'buổi họp', 'meeting notes', 'minutes', 'meeting recap', 'action items'],
  },
  welcome: {
    shape: 'card',
    accent: '#7c3aed',
    soft: '#f3edfe',
    label: { vi: 'Chào mừng', en: 'Welcome' },
    words: ['chào mừng', 'chao mung', 'welcome', 'getting started', 'onboarding'],
  },
  security: {
    shape: 'card',
    accent: '#6d28d9',
    soft: '#f3efff',
    label: { vi: 'Bảo mật', en: 'Security' },
    words: ['mã xác thực', 'mã otp', 'đặt lại mật khẩu', 'verification code', 'reset your password', 'one-time code'],
  },
};

export const KIND_NAMES = Object.keys(KINDS);

/* ── escaping and inline marks ──────────────────────────────────────── */

export const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// A private-use character, which no message contains, marks a held-out piece.
const MARK = String.fromCharCode(0xe000);
const SLOT = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
const BARE_URL = new RegExp(`(^|[\\s(])(https?:\\/\\/[^\\s<)${MARK}]+)`, 'g');

/**
 * What a bare URL should read as.
 *
 * Everywhere but a source line, the host *and* the path: a link in the middle
 * of a sentence is usually the point of the sentence, and hiding the path makes
 * two different articles from one site look like the same link.
 *
 * In a source line it is the outlet alone — "nhandan.vn" — because that line is
 * a row of four or five attributions and the paths turn it into a wall. What
 * matters there is that the *href* is still the article: the whole purpose of
 * citing a source is being able to go and read the thing the claim came from,
 * and a link that lands on a newspaper's front page has cited nothing.
 */
function labelFor(url, sourceLine) {
  const bare = String(url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  if (!sourceLine) return bare;
  // Up to the first slash, so `nhandan.vn/kinh-te/abc-123.html` reads as
  // `nhandan.vn` while still pointing at the article.
  return bare.split('/')[0];
}

function inline(text, theme, { sourceLine = false } = {}) {
  const slots = [];
  const hold = (html) => `${MARK}${slots.push(html) - 1}${MARK}`;
  let out = String(text)
    .replace(/`([^`]+)`/g, (whole, code) =>
      hold(
        `<code style="font-family:${MONO};font-size:13px;background:${BASE.codeBg};border-radius:4px;padding:1px 5px;color:${BASE.text}">${escapeHtml(code)}</code>`,
      ),
    )
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (whole, label, url) =>
      hold(link(escapeHtml(url), escapeHtml(label), theme)),
    );
  out = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="font-weight:600;color:${BASE.text}">$1</strong>`)
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>')
    // A bare link reads as its site rather than as a URL. See `labelFor`.
    // Punctuation after a link is the sentence's, not the URL's: "a.html, b.html"
    // lost its comma, and two sources ran together as one.
    .replace(BARE_URL, (whole, lead, raw) => {
      const tail = raw.match(/[.,;:!?]+$/)?.[0] || '';
      const url = tail ? raw.slice(0, -tail.length) : raw;
      return `${lead}${link(url, labelFor(url, sourceLine), theme)}${tail}`;
    });
  return out.replace(SLOT, (whole, i) => slots[Number(i)] ?? '');
}

/** Both arguments arrive escaped; only http(s) and mailto URLs are ever matched into one. */
function link(href, label, theme) {
  return `<a href="${href}" style="color:${theme.accent};text-decoration:underline;text-underline-offset:2px">${label}</a>`;
}

/* ── blocks ─────────────────────────────────────────────────────────── */

// overflow-wrap so a long URL or a run of digits wraps on a phone instead of
// forcing the whole message wider than the screen.
const WRAP = 'overflow-wrap:anywhere;word-break:break-word';
const P = `margin:0 0 16px;font-size:15px;line-height:1.7;color:${BASE.text};${WRAP}`;

/** A line in capitals is a section heading ("CHỨNG KHOÁN VIỆT NAM"). */
function isCapsHeading(line) {
  const text = String(line).trim();
  if (text.length < 3 || text.length > 80 || /[.!?,;:]$/.test(text) || /^\s*([-*•+>|]|\d+[.)])/.test(text)) return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toLocaleUpperCase('vi') && letters !== letters.toLocaleLowerCase('vi');
}

function heading(text, level, theme) {
  const bar = (size, extra = '') =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 12px">` +
    `<tr><td width="4" style="${GALAXY.bar};border-radius:2px">&nbsp;</td>` +
    `<td style="padding-left:12px;font-size:${size}px;line-height:1.4;font-weight:700;color:${BASE.text};${extra}">${inline(text, theme)}</td></tr></table>`;
  if (level === 'caps') return bar(14, 'letter-spacing:0.05em');
  if (level === 1) {
    return `<h2 style="margin:26px 0 12px;font-size:20px;line-height:1.35;font-weight:700;color:${BASE.text}">${inline(text, theme)}</h2>`;
  }
  return bar(level === 2 ? 17 : 15);
}

/** "Nguồn: …" / "Sources: …" — attribution, set small and quiet. */
const SOURCE_LINE = /^(nguồn|nguồn tham khảo|source|sources)\s*:/i;

/**
 * `Label: value` — a fact. The label is short and ends at the first colon; a
 * sentence that merely contains a colon does not qualify. Bold labels
 * ("**Thời gian:** 9:00") are the common model spelling and count too.
 */
function factOf(line) {
  const text = String(line).trim().replace(/^\s*[-*•+]\s+/, '');
  const match = text.match(/^\*{0,2}([^:*|#>`]{2,28}?)\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/);
  if (!match || SOURCE_LINE.test(text) || /^https?$/i.test(match[1].trim())) return null;
  const label = match[1].trim();
  if (label.split(/\s+/).length > 4 || /[.!?]$/.test(label)) return null;
  return { label, value: match[2].replace(/\*\*$/, '').trim() };
}

/**
 * A details card: label on the left, value on the right.
 *
 * A short value — a figure, a date — is bold, the way a form reads. A long one
 * is a sentence, and a paragraph set in bold is hard to read, so it stays at
 * normal weight. A `html` value is already rendered: the Sources row.
 */
function factsCard(facts, theme) {
  return (
    `<table class="sx-facts" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:${theme.soft};border-radius:10px">` +
    facts
      .map(
        ({ label, value, html }, i) =>
          `<tr><td style="padding:${i ? 6 : 14}px 16px ${i === facts.length - 1 ? 14 : 6}px;width:34%;vertical-align:top;font-size:13px;line-height:1.5;color:${BASE.muted}">${inline(label, theme)}</td>` +
          `<td style="padding:${i ? 6 : 14}px 16px ${i === facts.length - 1 ? 14 : 6}px 0;vertical-align:top;font-size:15px;line-height:1.5;font-weight:${html || String(value).length > 48 ? 400 : 600};color:${BASE.text};${WRAP}">${html || inline(value, theme)}</td></tr>`,
      )
      .join('') +
    '</table>'
  );
}

/** A change figure: "+2,1%", "-0,48%", "▲ 12". Coloured by direction in a table. */
const RISE = /^(\+|▲)\s?\d[\d.,]*\s?(%|đ|₫|usd|vnd|pts|điểm)?$/i;
const FALL = /^(-|−|▼)\s?\d[\d.,]*\s?(%|đ|₫|usd|vnd|pts|điểm)?$/i;
/** The row of a table that is its total. */
const TOTAL_ROW = /^\**\s*(tổng|tổng cộng|thành tiền|total|grand total|amount due|subtotal|tạm tính)\b/i;

function tableHtml(head, rows, theme) {
  /** @param {string} content @param {{ isHead?: boolean, zebra?: boolean, total?: boolean }} how */
  const cell = (content, { isHead = false, zebra = false, total = false }) => {
    const rise = !isHead && RISE.test(content);
    const fall = !isHead && FALL.test(content);
    const classes = [isHead && 'sx-th', zebra && 'sx-zebra', total && 'sx-total', rise && 'sx-up', fall && 'sx-down'].filter(Boolean).join(' ');
    const colour = isHead ? BASE.muted : rise ? BASE.up : fall ? BASE.down : BASE.text;
    const background = isHead ? BASE.codeBg : total ? theme.soft : zebra ? BASE.soft : '';
    return (
      `<td${classes ? ` class="${classes}"` : ''} style="padding:9px 12px;border-bottom:1px solid ${BASE.line};font-size:14px;line-height:1.5;${WRAP};` +
      `color:${colour};${isHead || total || rise || fall ? 'font-weight:600;' : ''}${background ? `background:${background};` : ''}` +
      `${total ? `border-top:2px solid ${theme.accent};` : ''}">${inline(content, theme)}</td>`
    );
  };
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border:1px solid ${BASE.line};border-radius:8px;border-collapse:separate;overflow:hidden">` +
    `<tr>${head.map((h) => cell(h, { isHead: true })).join('')}</tr>` +
    rows
      .map((row, r) => {
        const total = TOTAL_ROW.test(row[0] || '');
        return `<tr>${head.map((_, c) => cell(row[c] ?? '', { zebra: !total && r % 2 === 1, total })).join('')}</tr>`;
      })
      .join('') +
    '</table>'
  );
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

/** A paragraph that is only a link — "[Xác nhận tham dự](https://…)" — is a button. */
const LONE_LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/;

function button(url, label, theme) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px"><tr>` +
    `<td style="${GALAXY.button};border-radius:9px">` +
    `<a class="sx-btn" href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

const BULLET = /^\s*[-*•+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const CHECK = /^\s*[-*]\s+\[( |x|X)\]\s+/;

/**
 * The body of a message, Markdown in, email-safe HTML out.
 *
 * @param {string} markdown
 * @param {{ accent: string, soft: string }} [theme]  the kind's colours
 */
export function renderEmailBody(markdown, theme = KINDS.letter) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      out.push(
        `<pre style="margin:0 0 16px;padding:14px 16px;background:${BASE.codeBg};border-radius:8px;font-family:${MONO};font-size:13px;line-height:1.55;color:${BASE.text};white-space:pre-wrap;${WRAP}">${escapeHtml(body.join('\n'))}</pre>`,
      );
      continue;
    }

    const hashes = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hashes) {
      out.push(heading(hashes[2], Math.min(hashes[1].length, 3), theme));
      i += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      out.push(`<hr style="border:0;border-top:1px solid ${BASE.line};margin:24px 0">`);
      i += 1;
      continue;
    }

    if (trimmed.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(tableHtml(head, rows, theme));
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(
        `<div class="sx-callout" style="margin:0 0 16px;padding:12px 16px;background:${theme.soft};border-left:3px solid ${theme.accent};border-radius:0 8px 8px 0;font-size:15px;line-height:1.65;color:${BASE.text};${WRAP}">${quote.map((q) => inline(q, theme)).join('<br>')}</div>`,
      );
      continue;
    }

    // Two or more facts together are a details card.
    if (factOf(line) && factOf(lines[i + 1] || '')) {
      const facts = [];
      while (i < lines.length && lines[i].trim() && factOf(lines[i])) facts.push(factOf(lines[i++]));
      // A "Sources:" line straight after the card is the card's last row, so a
      // section's facts and where they came from stay in one box.
      const cited = (lines[i] || '').trim().replace(/^\s*[-*•+]\s+/, '');
      if (SOURCE_LINE.test(cited)) {
        const [label, ...rest] = cited.split(':');
        const links = inline(rest.join(':').trim(), theme, { sourceLine: true });
        facts.push({ label: label.replace(/\*/g, '').trim(), value: '', html: links });
        i += 1;
      }
      out.push(factsCard(facts, theme));
      continue;
    }

    if (CHECK.test(line)) {
      const items = [];
      while (i < lines.length && CHECK.test(lines[i])) {
        const done = /\[(x|X)\]/.test(lines[i]);
        const label = lines[i].replace(CHECK, '');
        items.push(
          `<tr><td width="24" style="vertical-align:top;padding:2px 0 8px;font-size:16px;line-height:1.5;color:${done ? theme.accent : BASE.faint}">${done ? '☑' : '☐'}</td>` +
            `<td style="vertical-align:top;padding:2px 0 8px;font-size:15px;line-height:1.6;color:${done ? BASE.muted : BASE.text};${done ? 'text-decoration:line-through;' : ''}${WRAP}">${inline(label, theme)}</td></tr>`,
        );
        i += 1;
      }
      out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px">${items.join('')}</table>`);
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items = [];
      while (i < lines.length && re.test(lines[i]) && !CHECK.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i += 1;
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
          item += ` ${lines[i++].trim()}`;
        }
        items.push(`<li style="margin:0 0 8px;padding-left:4px;${WRAP}">${inline(item, theme)}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} style="margin:0 0 16px;padding-left:22px;font-size:15px;line-height:1.65;color:${BASE.text}">${items.join('')}</${tag}>`);
      continue;
    }

    if (isCapsHeading(line)) {
      out.push(heading(trimmed, 'caps', theme));
      i += 1;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,4}\s|>|[-*•+]\s|\d+[.)]\s)/.test(lines[i]) &&
      !(para.length && (isCapsHeading(lines[i]) || (factOf(lines[i]) && factOf(lines[i + 1] || ''))))
    ) {
      para.push(lines[i++].trim());
    }
    const text = para.join('\n');
    if (SOURCE_LINE.test(text)) {
      out.push(
        `<p class="sx-quiet" style="margin:-6px 0 16px;font-size:12.5px;line-height:1.6;color:${BASE.faint};${WRAP}">` +
          `${inline(text, theme, { sourceLine: true }).replace(/\n/g, '<br>')}</p>`,
      );
    } else if (LONE_LINK.test(text)) {
      const [, label, url] = text.match(LONE_LINK);
      out.push(button(url, label, theme));
    } else {
      out.push(`<p style="${P}">${inline(text, theme).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** The same message as plain text: Markdown marks removed, links spelled out. */
export function plainTextFrom(markdown) {
  return String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,4}\s+(.*)$/gm, (whole, text) => text.toLocaleUpperCase('vi'))
    .replace(/^(\s*)[-*]\s+\[(x|X)\]\s+/gm, '$1[x] ')
    .replace(/^(\s*)[-*]\s+\[ \]\s+/gm, '$1[ ] ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── choosing the kind, the language, the date ──────────────────────── */

/**
 * Which language a message is written in, from the message itself. The footer
 * and the date are read by the recipient, so they follow the body. A body too
 * short to tell falls back to the account's language.
 */
export function detectLanguage(markdown, fallback = 'en') {
  const text = String(markdown ?? '');
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return 'vi';
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  return letters >= 20 ? 'en' : fallback === 'vi' ? 'vi' : 'en';
}

/** A whole word or phrase, not a piece of a longer one ("event" is not in "prevent"). */
const wordPattern = new Map();
function mentions(text, word) {
  if (!wordPattern.has(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    wordPattern.set(word, new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u'));
  }
  return wordPattern.get(word).test(text);
}

/**
 * The kind, when the assistant did not name one.
 *
 * A word in the subject counts three, one in the opening of the body counts
 * one, and it takes two to decide — so "Hoá đơn tháng 9" as a subject is an
 * invoice, while a newsletter that mentions a payment once is still a
 * newsletter. A longer phrase is worth more than a single word, because it is
 * more specific: "you are invited to our launch" is an invitation. With no signal, structure decides: a structured or long message
 * is a newsletter, anything else a letter.
 */
export function detectKind(subject, markdown) {
  const head = String(subject ?? '').toLocaleLowerCase('vi');
  const body = String(markdown ?? '').slice(0, 700).toLocaleLowerCase('vi');
  let best = null;
  let bestScore = 1;
  for (const [name, kind] of Object.entries(KINDS)) {
    if (name === 'security') continue; // only ever chosen by the system itself
    let score = 0;
    for (const word of kind.words) {
      const extra = word.trim().split(/\s+/).length - 1;
      if (mentions(head, word)) score += 3 + extra;
      if (mentions(body, word)) score += 1 + extra;
    }
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  if (best) return best;

  const lines = String(markdown ?? '').split(/\r?\n/);
  const structured =
    lines.some((l) => /^\s*#{1,4}\s/.test(l)) ||
    lines.some((l, i) => l.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) ||
    lines.filter((l) => /^\s*([-*•+]|\d+[.)])\s+/.test(l)).length >= 3 ||
    lines.some((l) => isCapsHeading(l));
  return structured || String(markdown ?? '').length > 1200 ? 'newsletter' : 'letter';
}

function dateLine(language, now, timeZone) {
  const format = (zone) =>
    new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: zone,
    }).format(now);
  try {
    return format(timeZone || (language === 'vi' ? 'Asia/Ho_Chi_Minh' : 'UTC'));
  } catch {
    // An unrecognised zone is not worth losing the date over.
    return format('UTC');
  }
}

/* ── the page ───────────────────────────────────────────────────────── */

const WORDS = {
  en: { sentBy: 'Sent by', reply: 'Reply to this email and we will get back to you.' },
  vi: { sentBy: 'Người gửi', reply: 'Trả lời email này, chúng tôi sẽ phản hồi bạn.' },
};

/**
 * Dark mode and phone spacing, for the clients that honour a `<style>` block.
 * The galaxy header is already dark and is left alone; the white card and its
 * contents turn to night colours. Descendant selectors rather than a class on
 * every element, so the body renderer does not have to know about it.
 */
function adaptiveCss() {
  return [
    ':root{color-scheme:light dark;supported-color-schemes:light dark}',
    // Gmail's apps: see `keepWhite`. `u + .body` matches only inside Gmail.
    'u + .body .gx-s{background:#000;mix-blend-mode:screen}u + .body .gx-d{background:#000;mix-blend-mode:difference}',
    '@media (max-width:520px){.sx-outer{padding:14px 6px!important}.sx-pad{padding-left:20px!important;padding-right:20px!important}.sx-h1{font-size:22px!important}}',
    '@media (prefers-color-scheme:dark){' +
      '.sx-page{background:#0b0a14!important}' +
      '.sx-card{background:#15131f!important;border-color:#2b2740!important}' +
      '.sx-body p,.sx-body li,.sx-body h2,.sx-body td,.sx-body strong,.sx-body div,.sx-brand{color:#ece9f6!important}' +
      '.sx-body a{color:#c4b5fd!important}.sx-card a.sx-btn{color:#ffffff!important}' +
      '.sx-body code,.sx-body pre,.sx-body .sx-th{background:#221f31!important}' +
      '.sx-body .sx-zebra{background:#1b1828!important}' +
      '.sx-body .sx-callout,.sx-body .sx-facts,.sx-body .sx-total{background:#211d33!important}' +
      '.sx-body .sx-quiet,.sx-body .sx-th{color:#9a93b3!important}' +
      '.sx-body .sx-up{color:#3fcf8e!important}.sx-body .sx-down{color:#ff7b9c!important}' +
      '.sx-foot{background:#110f1a!important;border-color:#2b2740!important}.sx-foot,.sx-foot *{color:#9a93b3!important}' +
      '.sx-under{color:#6f6989!important}' +
      '}',
  ].join('');
}

/**
 * The logo, embedded in the message itself.
 *
 * Referenced as `cid:` and attached by server/email.js, so it shows without
 * the "display images" prompt a remote image gets, and nothing is fetched from
 * the web when the email is opened. The file is the web app's own logo scaled
 * for mail — see scripts/email-logo.js.
 */
export const LOGO_CID = 'brand-logo@mail';

/**
 * White text on the galaxy header that stays white in Gmail's dark mode.
 *
 * The Gmail apps darken a message by inverting its colours but leave a
 * gradient background as it is, so the header's white title became black on
 * purple and could not be read. Two nested layers on black — `screen`, then
 * `difference` — change nothing anywhere else, and in Gmail's dark mode turn
 * the inverted text back. The rules are in `adaptiveCss`, scoped to Gmail.
 */
const keepWhite = (html) => `<span class="gx-s"><span class="gx-d">${html}</span></span>`;

/** The brand mark: the logo, or the first letter on the galaxy gradient when there is none. */
function brandMark(brand, size, logo) {
  if (logo) {
    return (
      `<td width="${size}" height="${size}" valign="middle">` +
      `<img src="cid:${LOGO_CID}" width="${size}" height="${size}" alt="${escapeHtml(brand)}" style="display:block;width:${size}px;height:${size}px;border:0;outline:none"></td>`
    );
  }
  return (
    `<td width="${size}" height="${size}" align="center" valign="middle" style="${GALAXY.button};border-radius:${Math.round(size / 3.6)}px;` +
    `color:#ffffff;font-size:${Math.round(size * 0.55)}px;font-weight:700;line-height:${size}px;font-family:${FONT}">${escapeHtml(brand.charAt(0).toUpperCase())}</td>`
  );
}

/**
 * The whole message around a body.
 *
 * A card opens with the galaxy header — brand, the kind's label and date, and
 * the title in white. A letter keeps a person's email's quiet: the brand above
 * a plain card with a thin gradient line along its top.
 *
 * @param {object} options
 * @param {string} options.brand         the business's name — header and foot
 * @param {string} options.title         a card's heading — usually the subject
 * @param {string} options.contentHtml   already rendered and escaped
 * @param {string} [options.kind]        one of KIND_NAMES; decides shape, colour and label
 * @param {string} [options.preheader]   the preview line an inbox shows beside the subject
 * @param {string} [options.footerHtml]  already escaped
 * @param {string} [options.language]    'vi' or 'en'
 * @param {Date} [options.now]           the date shown on a dated card
 * @param {string} [options.timeZone]    the zone that date is read in
 * @param {boolean} [options.logo]       show the embedded logo (the sender attaches it)
 */
export function layoutEmail({ brand, title, contentHtml, kind = 'newsletter', preheader = '', footerHtml = '', language = 'en', now = new Date(), timeZone = '', logo = true }) {
  const theme = KINDS[kind] || KINDS.newsletter;
  const lang = language === 'vi' ? 'vi' : 'en';
  const card = theme.shape === 'card';
  const date = card && theme.dated ? dateLine(lang, now, timeZone) : '';

  const above = card
    ? ''
    : `<tr><td style="padding:0 8px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${brandMark(brand, 26, logo)}
        <td class="sx-brand" style="padding-left:10px;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:${BASE.text};font-family:${FONT}">${escapeHtml(brand)}</td>
      </tr></table>
    </td></tr>`;

  const top = card
    ? `<tr><td class="sx-hero sx-pad" style="${GALAXY.hero};padding:22px 28px 26px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr>
            <td width="36" height="36" align="center" valign="middle" style="background-color:#ffffff;border-radius:10px;${logo ? '' : `color:#4c1d95;font-size:15px;font-weight:700;line-height:36px`}">${
              // On the dark gradient the logo sits on a white tile, so its own deep blues do not sink into the background.
              logo
                ? `<img src="cid:${LOGO_CID}" width="26" height="26" alt="${escapeHtml(brand)}" style="display:block;margin:5px;width:26px;height:26px;border:0;outline:none">`
                : escapeHtml(brand.charAt(0).toUpperCase())
            }</td>
            <td style="padding-left:11px;font-size:15px;font-weight:700;letter-spacing:0.01em;color:#ffffff">${keepWhite(escapeHtml(brand))}</td>
          </tr></table>
          <div style="margin:0 0 10px">
            <span style="display:inline-block;padding:3px 10px;border-radius:999px;background-color:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.28);font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#ffffff">${keepWhite(escapeHtml(theme.label[lang]))}</span>
            ${date ? `<span style="padding-left:8px;font-size:12px;color:#ddd6fe">${keepWhite(escapeHtml(date))}</span>` : ''}
          </div>
          <h1 class="sx-h1" style="margin:0;font-size:26px;line-height:1.28;font-weight:700;letter-spacing:-0.015em;color:#ffffff">${keepWhite(escapeHtml(title))}</h1>
        </td></tr>`
    : `<tr><td height="3" style="${GALAXY.line};font-size:0;line-height:0">&nbsp;</td></tr>`;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${adaptiveCss()}</style>
</head>
<body class="sx-page body" style="margin:0;padding:0;background:${BASE.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escapeHtml(preheader)}</div>
<table class="sx-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BASE.page}">
<tr><td class="sx-outer" align="center" style="padding:${card ? '28px 12px' : '24px 12px'}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT}">
    ${above}
    <tr><td class="sx-card" style="background:${BASE.card};border:1px solid ${BASE.line};border-radius:16px;overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${top}
        <tr><td class="sx-body sx-pad" style="padding:${card ? '26px 28px 8px' : '26px 28px 12px'}">
          ${contentHtml}
        </td></tr>
        ${
          footerHtml
            ? `<tr><td class="sx-foot sx-pad" style="padding:16px 28px 22px;border-top:1px solid ${BASE.line};background:${BASE.soft};font-size:13px;line-height:1.6;color:${BASE.muted}">${footerHtml}</td></tr>`
            : ''
        }
      </table>
    </td></tr>
    <tr><td class="sx-under" align="center" style="padding:16px 8px 0;font-size:12px;line-height:1.6;color:${BASE.faint}">
      ${escapeHtml(brand)}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** Letters and digits only, lower-cased: for "is this line just the subject again". */
const comparable = (text) =>
  String(text ?? '')
    .toLocaleLowerCase('vi')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The preview an inbox shows beside the subject: the first line that says
 * something — not a heading, not a fact label, not a repeat of the subject.
 */
function previewLine(markdown, subject) {
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(#{1,4}\s|\||>|```|\[)/.test(line) || /^\s*:?-{2,}/.test(line)) continue;
    if (isCapsHeading(line) || line.length < 25 || comparable(line) === comparable(subject)) continue;
    return plainTextFrom(line.replace(/^\s*([-*•+]|\d+[.)])\s+/, '')).replace(/\s+/g, ' ').slice(0, 140);
  }
  return '';
}

/**
 * A message the assistant sends for somebody, laid out for what it is.
 *
 * @param {object} options
 * @param {string} options.brand
 * @param {string} options.subject
 * @param {string} options.markdown
 * @param {{ name?: string } | null} [options.sender]   named in the footer; an address is never shown
 * @param {string} [options.kind]       one of KIND_NAMES, or 'auto'
 * @param {string} [options.language]   the account's language, used only when the body cannot tell
 * @param {string} [options.timeZone]   the account's zone, for a dated card
 * @param {Date} [options.now]
 * @returns {{ html: string, text: string, kind: string, language: 'vi'|'en' }}
 */
export function composeMessage({ brand, subject, markdown, sender, kind = 'auto', language = 'en', timeZone = '', now = new Date() }) {
  // A first line that only repeats the subject is dropped: on a card the
  // subject is already the title, and saying it twice is the surest sign of a
  // template.
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first !== -1 && comparable(lines[first].replace(/^#{1,4}\s+/, '')) === comparable(subject)) lines.splice(first, 1);
  const body = lines.join('\n');

  const chosen = KINDS[kind] ? kind : detectKind(subject, body);
  const theme = KINDS[chosen];
  const lang = detectLanguage(body, language);
  const words = WORDS[lang];
  const text = plainTextFrom(body);

  /*
   * The person is named, never their address. The message goes out as the
   * business — its name, its mailbox, replies to it — and an employee's own
   * email printed in the footer is exactly what it must not reveal.
   */
  const name = String(sender?.name || '').trim();
  const footerHtml =
    (name ? `${escapeHtml(words.sentBy)} <strong style="color:${BASE.text};font-weight:600">${escapeHtml(name)}</strong> · ${escapeHtml(brand)}<br>` : '') +
    escapeHtml(words.reply);
  const footerText = `${name ? `${words.sentBy} ${name} · ${brand}. ` : ''}${words.reply}`;

  return {
    html: layoutEmail({
      brand,
      title: subject,
      contentHtml: renderEmailBody(body, theme),
      kind: chosen,
      preheader: previewLine(body, subject),
      footerHtml,
      language: lang,
      now,
      timeZone,
    }),
    text: footerText ? `${text}\n\n—\n${footerText}` : text,
    kind: chosen,
    language: lang,
  };
}

/**
 * The password-reset message: a security card, the code large and first, then
 * a button, then the raw link for a client that will not show buttons.
 */
export function resetMessage({ brand, code, link }) {
  const theme = KINDS.security;
  const content =
    `<p style="${P}">Type this code into the app to choose a new password. It is good for one hour and works once.</p>` +
    `<table class="sx-facts" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;background:${theme.soft};border-radius:12px"><tr>` +
    `<td align="center" style="padding:20px">` +
    `<div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${BASE.muted};margin:0 0 8px">Your code</div>` +
    `<div style="font-family:${MONO};font-size:34px;font-weight:700;letter-spacing:0.3em;color:${theme.accent}">${escapeHtml(code)}</div>` +
    `</td></tr></table>` +
    `<p style="margin:0 0 12px;font-size:14px;color:${BASE.muted}">Or open the link instead:</p>` +
    button(link, 'Choose a new password', theme) +
    `<p class="sx-quiet" style="margin:0;font-size:12px;line-height:1.6;color:${BASE.faint};word-break:break-all">If the button does not work, paste this into your browser:<br>${escapeHtml(link)}</p>`;
  return layoutEmail({
    brand,
    title: 'Reset your password',
    contentHtml: content,
    kind: 'security',
    preheader: `${code} is your ${brand} reset code`,
    footerHtml: escapeHtml('If you did not ask for this, ignore this message — your password has not changed.'),
  });
}
