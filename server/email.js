import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { log } from './util/trace.js';
import { resetMessage, LOGO_CID } from './mailTemplate.js';

/** The logo emails embed. Under server/, so a Vercel function bundles it. */
const LOGO_FILE = new URL('./assets/email-logo.png', import.meta.url);

/**
 * The logo as an inline attachment, when the message's HTML asks for it.
 * SMTP clients get it by content id; Resend is given the same file with the
 * same id.
 */
function logoAttachment(html) {
  if (!html || !html.includes(`cid:${LOGO_CID}`)) return null;
  try {
    return { filename: 'logo.png', content: fs.readFileSync(LOGO_FILE), cid: LOGO_CID, contentType: 'image/png' };
  } catch (err) {
    log.warn('email logo missing; sending without it', { err: err.message });
    return null;
  }
}

/**
 * Email delivery with three backends, chosen by whichever is configured:
 *
 *   1. Resend  — RESEND_API_KEY. Plain HTTPS, works on Vercel with no SMTP port.
 *   2. SMTP    — SMTP_HOST/PORT/USER/PASS. Any provider. Gmail has a shortcut:
 *                GMAIL_USER + GMAIL_APP_PASSWORD fill in the rest.
 *   3. Console — neither configured: the link is printed to the server log.
 *
 * The console fallback exists so local development and first-run setup are not
 * blocked on picking a mail provider. It is obviously not for production, and
 * `emailBackend()` reports which one is live so the UI can say so.
 */
export function emailBackend() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (smtpSettings()) return 'smtp';
  return 'console';
}

/**
 * The SMTP server to use, or null.
 *
 * Gmail is the common case for a deployment's own mailbox, and its settings are
 * fixed — so two variables (the address and an App Password, which Google issues
 * under Security → 2-Step Verification → App passwords) are enough. Explicit
 * SMTP_* values win when both are present.
 */
function smtpSettings() {
  if (process.env.SMTP_HOST) {
    return {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    };
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return {
      host: 'smtp.gmail.com',
      port: 465,
      user: process.env.GMAIL_USER.trim(),
      // Google shows the App Password in groups of four with spaces.
      pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
    };
  }
  return null;
}

/** The mailbox mail is sent from: EMAIL_FROM, else the SMTP login, else Resend's test sender. */
function senderMailbox() {
  const configured = process.env.EMAIL_FROM || '';
  const inAngles = configured.match(/<([^>]+)>/);
  if (inAngles) return { name: configured.slice(0, configured.indexOf('<')).trim().replace(/^"|"$/g, ''), address: inAngles[1].trim() };
  if (configured.includes('@')) return { name: 'Synapse', address: configured.trim() };
  const login = smtpSettings()?.user;
  if (login && login.includes('@')) return { name: 'Synapse', address: login };
  return { name: 'Synapse', address: 'onboarding@resend.dev' };
}

/**
 * A display name safe to put in a header: no quotes, angle brackets or line
 * breaks, which are what would let a name write a second header or a second
 * address. Capped, because a From line is not the place for a paragraph.
 */
const cleanName = (name) =>
  String(name || '')
    .replace(/[\r\n"<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/**
 * The From header: the deployment's own name and mailbox, and nothing else.
 *
 * It used to read "Lan Nguyen via Synapse" <mailbox@gmail.com>. A display name
 * that names a person the address does not belong to is the pattern spam
 * filters are built to catch — it is what impersonation looks like — and it
 * sent real messages to the spam folder. Who the message is for now lives
 * where filters expect it: Reply-To, and a line at the foot of the message.
 */
function fromHeader() {
  const { name, address } = senderMailbox();
  const shown = cleanName(name);
  return shown ? `"${shown}" <${address}>` : address;
}

/** The deployment's display name, for the footer of a message. */
export function senderName() {
  return cleanName(senderMailbox().name) || 'Synapse';
}

let transport = null;
let transportKey = '';
function smtpTransport() {
  const settings = smtpSettings();
  const key = JSON.stringify(settings);
  // Rebuilt if the settings change, which in practice means between tests.
  if (!transport || key !== transportKey) {
    transportKey = key;
    transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: settings.port === 465,
      auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    });
  }
  return transport;
}

/** Test seam: replace the SMTP transport. */
export const __testing = {
  useTransport(fake) {
    transport = fake;
    transportKey = JSON.stringify(smtpSettings());
  },
  fromHeader,
  smtpSettings,
};

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);

async function sendViaResend({ to, subject, html, text, replyTo, from, logo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: asList(to),
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: asList(replyTo) } : {}),
      ...(logo ? { attachments: [{ filename: logo.filename, content: logo.content.toString('base64'), content_id: logo.cid }] } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Resend returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = await res.json().catch(() => ({}));
  return { messageId: body?.id || null, accepted: asList(to), rejected: [], response: `Resend accepted (id ${body?.id || 'unknown'})` };
}

/**
 * Send one message.
 *
 * @param {object} mail
 * @param {string|string[]} mail.to       one address or several
 * @param {string} mail.subject
 * @param {string} [mail.text]
 * @param {string} [mail.html]
 * @param {string} [mail.replyTo]         where a reply should go — the person the
 *                                        mail was sent for, not the shared mailbox
 */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const backend = emailBackend();
  const from = fromHeader();
  try {
    /*
     * What the provider actually said, kept and returned.
     *
     * An SMTP server can accept the connection and still refuse some of the
     * recipients — nodemailer resolves anyway and lists them in `rejected`. And
     * "accepted" only means the provider took the message: where it lands
     * (inbox, spam, a bounce minutes later) is decided after. The Message-ID and
     * the server's own reply line are what let somebody find the message in the
     * sending mailbox's Sent folder, or match it to a bounce.
     */
    let receipt = null;
    // Without the file the image would show as broken, so it is left out.
    const logo = logoAttachment(html);
    if (html && !logo) html = html.replace(/<img src="cid:brand-logo@mail"[^>]*>/g, '');
    if (backend === 'resend') receipt = await sendViaResend({ to, subject, html, text, replyTo, from, logo });
    else if (backend === 'smtp') {
      const info = await smtpTransport().sendMail({
        from,
        to: asList(to),
        subject,
        html,
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(logo ? { attachments: [logo] } : {}),
      });
      receipt = {
        messageId: info?.messageId || null,
        accepted: (info?.accepted || []).map(String),
        rejected: (info?.rejected || []).map(String),
        response: info?.response || '',
      };
    } else if (process.env.VERCEL) {
      // Deployed with no provider. The body can be a working password-reset
      // link, and a host's logs are read by more people, and kept longer, than
      // a terminal — so only the fact is logged, never the address or the text.
      log.warn('email not sent: no mail provider is configured on this deployment', { backend });
    } else {
      console.log(`\n──────── email (no provider configured) ────────`);
      console.log(`  to:      ${asList(to).join(', ')}`);
      console.log(`  subject: ${subject}\n`);
      console.log(text);
      console.log(`───────────────────────────────────────────────\n`);
    }
    if (receipt && receipt.rejected.length && !receipt.accepted.length) {
      throw new Error(`every recipient was refused (${receipt.rejected.join(', ')}): ${receipt.response}`);
    }
    // The id and the counts, not the addresses: a log is not the place for them.
    if (receipt) {
      log.info(`email via ${backend} accepted`, {
        backend,
        messageId: receipt.messageId,
        accepted: receipt.accepted.length,
        rejected: receipt.rejected.length,
      });
    }
    return { ok: true, backend, ...(receipt || {}) };
  } catch (err) {
    // Never let a mail failure break the request that triggered it — the user
    // can always ask for another link.
    //
    // Through the trace logger so the failure joins the request that caused it.
    // A password reset that silently did not arrive is diagnosed by finding the
    // one request it belonged to, and a bare console line has nothing to join on.
    log.error(`email via ${backend} failed`, err, { backend });
    return { ok: false, backend, error: err.message };
  }
}

/** Absolute base URL for links in emails. */
export function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req?.headers?.['x-forwarded-proto'] || (req?.secure ? 'https' : 'http');
  const host = req?.headers?.host || 'localhost:5173';
  return `${proto}://${host}`;
}

// ── templates ─────────────────────────────────────────────────────────

/**
 * The code comes first and the link second, deliberately: on a phone, typing
 * six digits back into the tab you already have open beats bouncing out to the
 * mail app and back. The look is the shared one in mailTemplate.js.
 */
export function resetEmail(link, code) {
  return {
    subject: `${code} is your ${senderName()} password reset code`,
    html: resetMessage({ brand: senderName(), code, link }),
    text:
      `Your ${senderName()} password reset code is ${code}\n\n` +
      `It expires in one hour and can only be used once. You can also open this link:\n${link}\n\n` +
      'If you did not ask for this, ignore this message — your password has not changed.',
  };
}
