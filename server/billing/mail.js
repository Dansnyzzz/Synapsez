/**
 * The billing emails (spec B1, Task 7; owner, 2026-11-13). Nine kinds, each in Vietnamese and in English, built with the
 * shared letter layout: a solid-coloured button and dark text on white, never white text over a gradient (Gmail's
 * translate view drops the gradient and leaves white on white, memory `mail-rendering-rules`). A receipt is linked by its
 * URL, never attached: the link needs a session, the attachment would sit in a mailbox for good.
 *
 * Mail is a courtesy and never part of a money step: `sendBillingMail` does not throw, and with no mail provider set up it
 * sends nothing (and says so) instead of printing a person's address and balance to a console.
 */
import { layoutEmail, escapeHtml } from '../mailTemplate.js';
import { sendEmail, senderName, publicUrl, emailBackend } from '../email.js';
import { mailLanguage } from '../auth.js';
import { log } from '../util/trace.js';
import { getStore } from '../store/index.js';
import { decryptSecret } from '../crypto.js';
import { billingProfileContext } from '../secretContexts.js';
import { GRACE_DAYS } from './plans.js';

export const BILLING_MAIL_KINDS = Object.freeze(['paid', 'plan-changed', 'renewal-soon', 'renewed', 'grace', 'ended', 'low-balance', 'expiring', 'late-money']);

const lang = (language) => (language === 'vi' ? 'vi' : 'en');

/** Whole đồng the way the language writes it: "129.000đ" in Vietnamese, "129,000₫" in English. */
export function formatVnd(amount, language = 'en') {
  const n = Math.max(0, Math.round(Number(amount) || 0));
  const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, language === 'vi' ? '.' : ',');
  return language === 'vi' ? `${grouped}đ` : `${grouped}₫`;
}

/** A date in Vietnamese time, written for the language; '' for anything that is not a date. */
function dayOf(value, language) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(+d)) return '';
  return d.toLocaleDateString(language === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: 'numeric', month: 'long', year: 'numeric' });
}

const PLAN_NAME = { plus: 'Plus', pro: 'Pro', max: 'Max' };
const planName = (plan) => PLAN_NAME[plan] || '';
const periodName = (period, language) => (period === 'year' ? (language === 'vi' ? 'năm' : 'year') : period === 'month' ? (language === 'vi' ? 'tháng' : 'month') : '');
/** "Pro (month)" - the name alone when the period is not known. */
const planWithPeriod = (plan, period, language) => {
  const name = planName(plan);
  const per = periodName(period, language);
  return name && per ? `${name} (${per})` : name;
};

/**
 * What one mail says, as plain pieces: `lead` is the sentence under the title, `facts` the label/value rows (an empty value
 * is left out), `action` the button. Both languages are written out in full rather than assembled from fragments, because
 * Vietnamese word order is not English's.
 */
function pieces(kind, language, data, links) {
  const vi = language === 'vi';
  const money = (n) => formatVnd(n, language);
  const date = (v) => dayOf(v, language);
  const plan = planName(data.plan);
  const open = { label: vi ? 'Mở Thanh toán' : 'Open Billing', url: links.billing };
  switch (kind) {
    case 'paid': {
      const what = data.what || {};
      const named = planWithPeriod(what.plan, what.period, language);
      const lead = what.kind === 'topup'
        ? (vi ? 'Số dư của bạn đã được nạp thêm.' : 'Your balance has been topped up.')
        : what.kind === 'renewal'
          ? (vi ? `Gói ${named} của bạn đã được gia hạn.` : `Your ${named} plan has been renewed.`)
          : (vi ? `Gói ${named} của bạn đã được kích hoạt.` : `Your ${named} plan is now active.`);
      return {
        subject: vi ? `Synapsez đã nhận ${money(data.amountVnd)}` : `Synapsez received ${money(data.amountVnd)}`,
        title: vi ? 'Đã nhận thanh toán' : 'Payment received',
        lead,
        facts: [
          [vi ? 'Số tiền' : 'Amount', money(data.amountVnd)],
          [vi ? 'Số dư hiện có' : 'Balance now', data.balanceVnd == null ? '' : money(data.balanceVnd)],
          [vi ? 'Biên lai' : 'Receipt', data.receiptNumber || ''],
        ],
        action: data.receiptNumber ? { label: vi ? 'Tải biên lai (PDF)' : 'Download the receipt (PDF)', url: links.receipt(data.receiptNumber) } : open,
      };
    }
    case 'plan-changed': {
      const named = planWithPeriod(data.plan, data.period, language);
      const later = data.change === 'scheduled';
      return {
        subject: later ? (vi ? `Gói của bạn sẽ đổi sang ${named}` : `Your plan will change to ${named}`) : (vi ? `Gói của bạn giờ là ${named}` : `Your plan is now ${named}`),
        title: later ? (vi ? 'Đã lên lịch đổi gói' : 'Plan change scheduled') : (vi ? 'Gói của bạn đã đổi' : 'Your plan has changed'),
        lead: later
          ? (vi ? `Gói ${named} sẽ bắt đầu khi kỳ hiện tại kết thúc. Đến lúc đó bạn không phải làm gì thêm.` : `${named} starts when the current period ends. You do not need to do anything until then.`)
          : (vi ? `Gói ${named} đã có hiệu lực.` : `${named} is in effect now.`),
        facts: [[later ? (vi ? 'Có hiệu lực từ' : 'Starts on') : '', later ? date(data.effectiveAt) : '']],
        action: open,
      };
    }
    case 'renewal-soon': {
      const qr = data.qr || null;
      return {
        subject: vi ? `Gói ${plan} của bạn gia hạn vào ${date(data.endsAt)}` : `Your ${plan} plan renews on ${date(data.endsAt)}`,
        title: vi ? 'Sắp đến kỳ gia hạn' : 'Your renewal is coming up',
        lead: vi
          ? `Số dư hiện tại chưa đủ ${money(data.amountVnd)} để gia hạn. Hãy chuyển khoản hoặc nạp thêm trước ngày đó để giữ gói của bạn.`
          : `Your balance does not cover the ${money(data.amountVnd)} renewal. Pay by transfer or top up before then to keep your plan.`,
        facts: [
          [vi ? 'Gia hạn vào' : 'Renews on', date(data.endsAt)],
          [vi ? 'Số tiền gia hạn' : 'Renewal price', money(data.amountVnd)],
          [vi ? 'Số dư hiện có' : 'Balance now', data.balanceVnd == null ? '' : money(data.balanceVnd)],
          [vi ? 'Nội dung chuyển khoản' : 'Transfer content', data.code || qr?.content || ''],
          [vi ? 'Ngân hàng' : 'Bank', qr ? `${qr.bank || ''} ${qr.account || ''}`.trim() : ''],
          [vi ? 'Chủ tài khoản' : 'Account holder', qr?.holder || ''],
        ],
        picture: qr?.image ? { url: qr.image, alt: vi ? 'Mã QR chuyển khoản' : 'Transfer QR code' } : null,
        action: open,
      };
    }
    case 'renewed':
      return {
        subject: vi ? `Gói ${plan} của bạn đã được gia hạn` : `Your ${plan} plan was renewed`,
        title: vi ? 'Đã gia hạn' : 'Renewed',
        lead: vi ? `Gói ${plan} đã được gia hạn từ số dư của bạn.` : `Your ${plan} plan was renewed from your balance.`,
        facts: [
          [vi ? 'Đã trừ' : 'Charged', data.amountVnd == null ? '' : money(data.amountVnd)],
          [vi ? 'Kỳ này kết thúc' : 'This period ends', date(data.endsAt)],
        ],
        action: open,
      };
    case 'grace':
      return {
        subject: vi ? `Gói ${plan} của bạn đã hết kỳ - còn ${GRACE_DAYS} ngày để gia hạn` : `Your ${plan} plan period is over - ${GRACE_DAYS} days to renew`,
        title: vi ? 'Gói đã hết kỳ' : 'Your plan period is over',
        lead: vi
          ? `Gói của bạn vẫn dùng được thêm ${GRACE_DAYS} ngày. Nếu bạn gia hạn trong thời gian này, các ngày đó nằm trong kỳ mới; nếu không, chúng không bị tính tiền. Hãy gia hạn trước khi hết hạn để không bị gián đoạn.`
          : `Your plan keeps working for ${GRACE_DAYS} more days. If you renew in that time those days are covered by the renewed period; if you do not, they are not charged. Renew before then to avoid a break.`,
        facts: [
          [vi ? 'Gia hạn trước' : 'Renew by', date(data.endsAt)],
          [vi ? 'Số tiền gia hạn' : 'Renewal price', data.amountVnd == null ? '' : money(data.amountVnd)],
        ],
        action: open,
      };
    case 'ended':
      return {
        subject: vi ? `Gói ${plan} của bạn đã kết thúc` : `Your ${plan} plan has ended`,
        title: vi ? 'Gói đã kết thúc' : 'Plan ended',
        lead: vi ? 'Tài khoản của bạn đã trở về gói miễn phí. Bạn có thể chọn lại một gói bất cứ lúc nào.' : 'Your account is back on the free plan. You can choose a plan again at any time.',
        facts: [],
        action: open,
      };
    case 'low-balance': {
      const qr = data.qr || null;
      return {
        subject: vi ? 'Số dư của bạn đang thấp' : 'Your balance is low',
        title: vi ? 'Số dư thấp' : 'Low balance',
        lead: (vi ? `Số dư của bạn đã xuống dưới mức bạn đặt (${money(data.thresholdVnd)}). Nạp thêm để không bị gián đoạn.` : `Your balance has fallen below the level you set (${money(data.thresholdVnd)}). Top up to avoid a break.`)
          + (qr ? (vi ? ' Quét mã QR để nạp số tiền nhỏ nhất; tiền chuyển sau khi mã hết hạn vẫn được cộng vào số dư.' : ' Scan the QR code to add the smallest top-up; money sent after the code has expired still lands in your balance.') : ''),
        facts: [
          [vi ? 'Số dư hiện có' : 'Balance now', money(data.balanceVnd)],
          [vi ? 'Số tiền nạp' : 'Top-up amount', qr && data.topupVnd ? money(data.topupVnd) : ''],
          [vi ? 'Nội dung chuyển khoản' : 'Transfer content', data.code || qr?.content || ''],
          [vi ? 'Ngân hàng' : 'Bank', qr ? `${qr.bank || ''} ${qr.account || ''}`.trim() : ''],
          [vi ? 'Chủ tài khoản' : 'Account holder', qr?.holder || ''],
        ],
        picture: qr?.image ? { url: qr.image, alt: vi ? 'Mã QR chuyển khoản' : 'Transfer QR code' } : null,
        action: { label: vi ? 'Nạp thêm' : 'Add credits', url: links.billing },
      };
    }
    case 'expiring':
      return {
        subject: vi ? `Số dư của bạn hết hạn vào ${date(data.expiresAt)}` : `Your balance expires on ${date(data.expiresAt)}`,
        title: vi ? 'Số dư sắp hết hạn' : 'Your balance is about to expire',
        lead: vi ? 'Số dư hết hạn sau 12 tháng kể từ lần nạp gần nhất. Một lần nạp mới sẽ tính lại 12 tháng.' : 'A balance expires 12 months after the last top-up. A new top-up starts the 12 months again.',
        facts: [
          [vi ? 'Số dư' : 'Balance', money(data.balanceVnd)],
          [vi ? 'Hết hạn vào' : 'Expires on', date(data.expiresAt)],
        ],
        action: { label: vi ? 'Nạp thêm' : 'Add credits', url: links.billing },
      };
    default: // late-money
      return {
        subject: vi ? `Đã nhận ${money(data.amountVnd)} sau khi đơn hàng đóng` : `We received ${money(data.amountVnd)} after the order had closed`,
        title: vi ? 'Tiền đến muộn' : 'Money that arrived late',
        lead: vi
          ? 'Khoản chuyển khoản này đến sau khi đơn hàng đã đóng. Tiền không mất: nó đã được cộng vào số dư của bạn, nhưng đơn hàng đó không được thực hiện.'
          : 'This transfer arrived after its order had closed. The money is not lost: it was added to your balance, but that order was not carried out.',
        facts: [
          [vi ? 'Số tiền' : 'Amount', money(data.amountVnd)],
          [vi ? 'Mã chuyển khoản' : 'Transfer code', data.code || ''],
        ],
        action: open,
      };
  }
}

/**
 * One billing email, in one language. Pure: nothing is read or sent here.
 *
 * @param {string} kind one of BILLING_MAIL_KINDS
 * @param {{ language?: string, data?: Record<string, any>, baseUrl?: string }} [input]
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildBillingMail(kind, { language = 'en', data = {}, baseUrl = publicUrl(null) } = {}) {
  const l = lang(language);
  const root = String(baseUrl || '').replace(/\/$/, '');
  const links = { billing: `${root}/#settings/billing`, receipt: (number) => `${root}/api/billing/receipts/${encodeURIComponent(number)}.pdf` };
  const p = pieces(BILLING_MAIL_KINDS.includes(kind) ? kind : 'late-money', l, data || {}, links);
  const facts = p.facts.filter(([label, value]) => label && value);
  const brand = senderName();
  const why = l === 'vi' ? 'Bạn nhận được email này vì tài khoản Synapsez của bạn có thanh toán hoặc gói. Xem tất cả ở Cài đặt → Thanh toán:' : 'You are getting this because your Synapsez account has billing or a plan. See everything in Settings → Billing:';
  const contentHtml =
    `<h2 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827">${escapeHtml(p.title)}</h2>` +
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151">${escapeHtml(p.lead)}</p>` +
    (facts.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#111827">${facts
        .map(([label, value]) => `<tr><td style="padding:0 16px 0 0;color:#6b7280">${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`)
        .join('')}</table>`
      : '') +
    (p.picture ? `<p style="margin:0 0 18px"><img src="${escapeHtml(p.picture.url)}" width="220" alt="${escapeHtml(p.picture.alt)}" style="display:block;width:220px;max-width:100%;height:auto;border:0"></p>` : '') +
    `<a href="${escapeHtml(p.action.url)}" style="display:inline-block;padding:11px 20px;border-radius:10px;background-color:#6d28d9;color:#ffffff;font-weight:700;text-decoration:none">${escapeHtml(p.action.label)}</a>`;
  const html = layoutEmail({
    brand, title: p.subject, contentHtml, kind: 'letter', preheader: p.lead.slice(0, 120),
    footerHtml: `${escapeHtml(why)} <a href="${escapeHtml(links.billing)}" style="color:#6d28d9">${escapeHtml(links.billing)}</a>`,
    language: l,
  });
  const text = [
    p.subject, '', p.lead, '',
    ...facts.map(([label, value]) => `- ${label}: ${value}`),
    ...(p.picture ? [`- ${p.picture.alt}: ${p.picture.url}`] : []),
    '', `${p.action.label}: ${p.action.url}`, '', `${why} ${links.billing}`,
  ].join('\n');
  return { subject: p.subject, html, text };
}

/** A step that is waited for at most `ms`: after that the caller goes on and the work finishes (or fails) by itself. */
export function within(ms, work) {
  let timer;
  return Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

/** The address a receipt goes to: the billing information's, when the account gave one, else the account's own. Never logged. */
async function receiptAddress(user) {
  try {
    const sealed = (await getStore().getBillingProfile(String(user.id)))?.sealed;
    const given = sealed ? JSON.parse(decryptSecret(sealed, billingProfileContext(String(user.id))) || 'null')?.email : null;
    return typeof given === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(given) ? given : user.email;
  } catch {
    return user.email;
  }
}

/**
 * Tell an account something about its billing. Never throws; the answer says what happened:
 * `{ ok: true }` sent, `{ ok: false, skipped: true }` no mail provider (or no address) so nothing was sent,
 * `{ ok: false }` the provider refused.
 *
 * @param {string} kind
 * @param {{ id?: string, email?: string, name?: string } | null} user
 * @param {Record<string, any>} [data]
 * @param {{ send?: typeof sendEmail, baseUrl?: string, backend?: string }} [options]
 */
export async function sendBillingMail(kind, user, data = {}, { send = sendEmail, baseUrl = publicUrl(null), backend = emailBackend() } = {}) {
  try {
    if (!BILLING_MAIL_KINDS.includes(kind) || !user?.email) return { ok: false, skipped: true };
    // With no provider the mail would only be printed with the person's address and balance in it: nothing is sent, and nothing is marked as told.
    if (backend === 'console') return { ok: false, skipped: true };
    const language = await mailLanguage(/** @type {any} */ (user), undefined);
    const mail = buildBillingMail(kind, { language, data, baseUrl });
    const to = kind === 'paid' && user.id ? await receiptAddress(user) : user.email;
    const result = await send({ to, subject: mail.subject, html: mail.html, text: mail.text });
    return { ok: !!result?.ok, skipped: false };
  } catch (err) {
    log.warn('a billing email could not be sent', { kind, error: String(err?.message || err).slice(0, 160) });
    return { ok: false, skipped: false };
  }
}
