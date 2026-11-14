/**
 * A payment receipt drawn as a PDF (spec B1, Task 8). It is a receipt, not a VAT invoice, and says so in its last line; the
 * invoice, where the seller has the means to issue one, is SePay's (einvoice.js).
 *
 * Drawn with the same native canvas that draws Office files, in Arimo (shipped in server/assets/fonts, covers Vietnamese), so a
 * deployment without system fonts draws the same page as this PC. The canvas is imported when a receipt is drawn, not at start:
 * it is a native module and most cold starts never draw one. The page holds no personal data but the buyer's own details, opened
 * here from the receipt's sealed copy; an account that was deleted has none and the receipt says so.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openSecret } from '../crypto.js';
import { billingProfileContext } from '../secretContexts.js';

const FONT_FILE = fileURLToPath(new URL('../assets/fonts/Arimo-VariableWeight.ttf', import.meta.url));
const FONT = 'Receipt Arimo';

/** Below this the lines of a receipt stop, to leave room for the total, a tax line and the footer. */
const LINES_END = 690;

const lang = (language) => (language === 'vi' ? 'vi' : 'en');

/** "129.000 ₫" in Vietnamese, "129,000 ₫" in English. */
export function money(amount, language = 'en') {
  const n = Math.trunc(Number(amount) || 0);
  const grouped = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, lang(language) === 'vi' ? '.' : ',');
  return `${n < 0 ? '-' : ''}${grouped} ₫`;
}

/** A moment in Vietnamese time, the way the language writes it. */
function when(value, language) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(+d)) return '';
  const vi = lang(language) === 'vi';
  return d.toLocaleString(vi ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: vi ? '2-digit' : 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * What a receipt line says it is for. A `credit` line is money that bought nothing: it came to the balance, whatever
 * the code it carried named (a transfer that was late or short, Task 5's carry).
 */
export function lineLabel(line, language) {
  const vi = lang(language) === 'vi';
  const plan = line?.plan ? String(line.plan).charAt(0).toUpperCase() + String(line.plan).slice(1) : '';
  const period = line?.period === 'year' ? (vi ? 'năm' : 'year') : (vi ? 'tháng' : 'month');
  switch (line?.kind) {
    case 'plan':
    case 'renewal':
      return vi ? `Gói ${plan} (${period})` : `${plan} plan (${period})`;
    case 'topup':
      return vi ? 'Nạp tiền vào số dư' : 'Balance top-up';
    case 'assign':
      return vi ? 'Tiền được quản trị viên ghi vào số dư' : 'Money added to your balance by an administrator';
    default:
      return vi ? 'Tiền đã chuyển vào số dư (không mua gói)' : 'Money added to your balance (no plan bought)';
  }
}

/** The buyer from the receipt's sealed copy: an object, 'removed' (the account is gone), or null (none was given, or it will not open). */
export function buyerOf(receipt) {
  if (!receipt.buyerSealed) return receipt.userId ? null : 'removed';
  try {
    const parsed = JSON.parse(openSecret(receipt.buyerSealed, billingProfileContext(receipt.userId)).value || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Break a text into lines no wider than `width`, on spaces. */
function wrapText(ctx, text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * The receipt as a PDF (A4, one page).
 *
 * @param {{ number: string, userId: string | null, orderId?: string | null, transferId?: number | null, amountVnd: number, lines: any[], buyerSealed: string | null, issuedAt: Date }} receipt
 * @param {{ language?: string, seller?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<Buffer>}
 */
export async function drawReceipt(receipt, { language = 'en', seller, env = process.env } = {}) {
  const { PDFDocument, GlobalFonts } = await import('@napi-rs/canvas');
  const vi = lang(language) === 'vi';
  const name = seller || env.BILLING_SELLER_NAME || 'Synapsez';
  if (!GlobalFonts.has(FONT)) GlobalFonts.register(fs.readFileSync(FONT_FILE), FONT);

  const title = vi ? 'Biên nhận thanh toán' : 'Payment receipt';
  const doc = new PDFDocument({ title: `${title} ${receipt.number}`, producer: name });
  const ctx = doc.beginPage(595, 842);
  const left = 48;
  const right = 547;
  let y = 64;
  const text = (value, x, size, { color = '#1b1f24', align = 'left' } = {}) => {
    ctx.font = `${size}px "${FONT}"`;
    ctx.fillStyle = color;
    ctx.textAlign = /** @type {CanvasTextAlign} */ (align);
    ctx.fillText(String(value), x, y);
  };
  const row = (label, value) => {
    text(label, left, 11, { color: '#5b6470' });
    text(value, left + 170, 11);
    y += 18;
  };

  text(name, left, 22);
  y += 30;
  text(title, left, 16, { color: '#3a4350' });
  y += 14;
  ctx.fillStyle = '#d5d9df';
  ctx.fillRect(left, y, right - left, 1);
  y += 26;

  row(vi ? 'Số biên nhận' : 'Receipt number', receipt.number);
  row(vi ? 'Ngày giờ (giờ Việt Nam)' : 'Date and time (Vietnam time)', when(receipt.issuedAt, language));
  const reference = receipt.lines?.find((l) => l?.code)?.code || (receipt.transferId ? `#${receipt.transferId}` : '');
  if (reference) row(vi ? 'Mã tham chiếu' : 'Reference', reference);
  row(vi ? 'Hình thức' : 'Payment', vi ? 'Chuyển khoản ngân hàng qua SePay (VietQR)' : 'Bank transfer via SePay (VietQR)');
  y += 14;

  text(vi ? 'Người mua' : 'Buyer', left, 13, { color: '#3a4350' });
  y += 20;
  const buyer = buyerOf(receipt);
  if (buyer === 'removed') {
    text(vi ? 'Người mua đã được xoá (tài khoản đã bị xoá).' : 'The buyer was removed (the account was deleted).', left, 11, { color: '#5b6470' });
    y += 18;
  } else if (buyer) {
    for (const part of [buyer.name, buyer.email, buyer.address, buyer.taxCode ? `${vi ? 'Mã số thuế' : 'Tax code'}: ${buyer.taxCode}` : '']) {
      if (!part) continue;
      ctx.font = `11px "${FONT}"`;
      for (const l of wrapText(ctx, part, right - left)) {
        text(l, left, 11);
        y += 16;
      }
    }
  } else {
    text(vi ? 'Không có thông tin người mua.' : 'No buyer details were given.', left, 11, { color: '#5b6470' });
    y += 18;
  }
  y += 14;

  ctx.fillStyle = '#eef0f3';
  ctx.fillRect(left, y - 14, right - left, 24);
  text(vi ? 'Nội dung' : 'Description', left + 8, 11, { color: '#3a4350' });
  text(vi ? 'Số tiền' : 'Amount', right - 8, 11, { color: '#3a4350', align: 'right' });
  y += 24;
  // The footer is fixed at the page's foot, so the lines stop where the total still fits above it. A receipt has one line today (one
  // transfer, one order); the clamp is for the day it has more, and says how many it left out rather than drawing over the footer.
  const all = receipt.lines || [];
  for (const [index, line] of all.entries()) {
    if (y > LINES_END) {
      text(vi ? `…và ${all.length - index} dòng khác` : `…and ${all.length - index} more`, left + 8, 11, { color: '#5b6470' });
      y += 16;
      break;
    }
    ctx.font = `11px "${FONT}"`;
    const parts = wrapText(ctx, lineLabel(line, language), 340);
    text(parts[0] || '', left + 8, 11);
    text(money(line.amountVnd, language), right - 8, 11, { align: 'right' });
    y += 16;
    for (const more of parts.slice(1)) {
      text(more, left + 8, 11);
      y += 16;
    }
  }
  y += 4;
  ctx.fillStyle = '#d5d9df';
  ctx.fillRect(left, y, right - left, 1);
  y += 22;
  text(vi ? 'Tổng cộng' : 'Total', left + 8, 14);
  text(money(receipt.amountVnd, language), right - 8, 14, { align: 'right' });
  y += 22;

  // A tax line only when the seller says what rate applies; a guess would be a tax statement nobody made.
  const rate = String(env.BILLING_TAX_RATE ?? '').trim() === '' ? NaN : Number(env.BILLING_TAX_RATE);
  // Money added to the balance bought nothing, so no tax is stated on it: tax belongs to the sale of a plan or a top-up's use.
  const sold = (receipt.lines || []).some((l) => l?.kind !== 'credit');
  if (Number.isFinite(rate) && rate >= 0 && sold) {
    const tax = Math.round((Math.trunc(receipt.amountVnd) * rate) / (100 + rate));
    text(vi ? `Trong đó thuế GTGT ${rate}%` : `Of which VAT ${rate}%`, left + 8, 11, { color: '#5b6470' });
    text(money(tax, language), right - 8, 11, { color: '#5b6470', align: 'right' });
    y += 20;
  }

  y = 780;
  ctx.fillStyle = '#d5d9df';
  ctx.fillRect(left, y - 20, right - left, 1);
  text(vi ? 'Biên nhận thanh toán — không phải hoá đơn GTGT.' : 'Payment receipt — not a VAT invoice.', left, 11, { color: '#5b6470' });
  doc.endPage();
  return doc.close();
}
