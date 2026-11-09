import { appearsAt, eventStandingFor, THEMES } from './themes.js';
import { layoutEmail, escapeHtml } from './mailTemplate.js';
import { sendEmail, senderName, publicUrl, emailBackend } from './email.js';
import { getStore } from './store/index.js';
import { log } from './util/trace.js';
import { vi as VI } from '../public/js/locales/vi.js';
import { en as EN } from '../public/js/locales/en.js';

/**
 * The email that says an event's theme is out (owner, 2026-11-08): sent when the theme
 * appears on the Theme page, three days before the event, to everyone who has not
 * turned these emails off. A picture of the theme moving for ever at the top, then its
 * description, its mission and how many places there are.
 *
 * Sent through Gmail when it is set up (the owner's choice), in batches with every
 * address in Bcc: one message reaches many people, and nobody sees anybody else's
 * address, which Cc would show to all of them (personal data, Decree 13/2023).
 *
 * Who was told is kept (`event_mail`), so a send cut short by a serverless timeout,
 * or by a day's sending limit, carries on at the next sweep with whoever is left.
 */

/** Gmail takes about 100 addresses a message and 500 a day on a personal account; both leave room. */
const BATCH = () => Math.max(1, Math.min(90, Number(process.env.EVENT_MAIL_BATCH) || 50));
const PER_DAY = () => Math.max(0, Number(process.env.EVENT_MAIL_DAILY) || 400);
/** Batches one sweep may send, so a sweep never runs past a serverless function's time. */
const PER_SWEEP = 4;

const WORDS = {
  vi: {
    subject: (name) => `Theme sự kiện mới: ${name}`,
    preheader: (name, from) => `${name} mở từ ${from}. Số suất có hạn.`,
    badge: 'Sự kiện độc quyền',
    open: 'Mở Synapsez',
    why: 'Bạn nhận được email này vì có tài khoản Synapsez. Tắt email về theme và sự kiện ở Cài đặt → Chung:',
    off: 'tắt tại đây',
  },
  en: {
    subject: (name) => `A new event theme: ${name}`,
    preheader: (name, from) => `${name} opens on ${from}. Places are limited.`,
    badge: 'Exclusive event',
    open: 'Open Synapsez',
    why: 'You are getting this because you have a Synapsez account. Turn off emails about themes and events in Settings → General:',
    off: 'turn them off here',
  },
};

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));
const locale = (lang) => (lang === 'vi' ? 'vi-VN' : 'en-US');
const day = (iso, lang) => new Date(iso).toLocaleDateString(locale(lang), { timeZone: 'Asia/Ho_Chi_Minh' });
const lastDay = (iso, lang) => day(new Date(new Date(iso).getTime() - 1).toISOString(), lang);
const number = (n, lang) => Number(n).toLocaleString(locale(lang));

/**
 * One event's email, in one language.
 *
 * @param {{ themeId: string, event: { from: string, to: string, tokens: number, places: number, left?: number }, language: string, baseUrl: string }} input
 * @returns {{ subject: string, html: string, text: string }}
 */
export function eventEmail({ themeId, event, language, baseUrl }) {
  const lang = language === 'vi' ? 'vi' : 'en';
  const dict = lang === 'vi' ? VI : EN;
  const words = WORDS[lang];
  const name = dict[`theme.${themeId}.name`] || themeId;
  const description = dict[`theme.${themeId}.desc`] || '';
  const mission = fill(dict['facts.useTokensBetween'], { n: number(event.tokens, lang), from: day(event.from, lang), to: lastDay(event.to, lang) });
  const places = fill(dict['facts.places'], { n: number(event.places, lang) });
  const facts = [
    [dict['facts.mission'], mission],
    [dict['facts.quantity'], places],
  ];
  const picture = `${baseUrl}/assets/scenes/${encodeURIComponent(themeId)}.gif`;
  const settings = `${baseUrl}/#settings/general`;
  const contentHtml =
    `<img src="${escapeHtml(picture)}" width="560" alt="${escapeHtml(name)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:12px;margin:0 0 18px">` +
    `<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#7c3aed">${escapeHtml(words.badge)}</p>` +
    `<h2 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:#111827">${escapeHtml(name)}</h2>` +
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151">${escapeHtml(description)}</p>` +
    `<ul style="margin:0 0 20px;padding:0;list-style:none;font-size:15px;line-height:1.7;color:#111827">${facts
      .map(([label, text]) => `<li>- <strong>${escapeHtml(label)}:</strong> ${escapeHtml(text)}</li>`)
      .join('')}</ul>` +
    `<a href="${escapeHtml(baseUrl)}/" style="display:inline-block;padding:11px 20px;border-radius:10px;background:#6d28d9;color:#ffffff;font-weight:700;text-decoration:none">${escapeHtml(words.open)}</a>`;
  const footerHtml = `${escapeHtml(words.why)} <a href="${escapeHtml(settings)}" style="color:#6d28d9">${escapeHtml(words.off)}</a>.`;
  const html = layoutEmail({
    brand: senderName(),
    title: words.subject(name),
    contentHtml,
    kind: 'newsletter',
    preheader: words.preheader(name, day(event.from, lang)),
    footerHtml,
    language: lang,
  });
  const text = [
    words.subject(name),
    '',
    description,
    ...facts.map(([label, value]) => `- ${label}: ${value}`),
    '',
    `${words.open}: ${baseUrl}/`,
    '',
    `${words.why} ${settings}`,
  ].join('\n');
  return { subject: words.subject(name), html, text };
}

/** The events whose theme is out and whose event has not ended: the ones to tell people about. */
export function eventsToAnnounce(now = new Date()) {
  return THEMES.filter((theme) => {
    if (!theme.event) return false;
    const out = appearsAt(theme, theme.badge);
    return out && out <= now && now < new Date(theme.event.to);
  });
}

/**
 * Tell whoever is left about every event that is out. Never throws: a sweep has other
 * work, and whoever was not told is told next time.
 *
 * @param {{ now?: Date, store?: any, send?: typeof sendEmail, baseUrl?: string, backend?: string }} [options]
 *   `backend`: how mail goes out; with none set up (`console`) nothing is claimed or sent
 * @returns {Promise<{ sent: number, batches: number }>}
 */
export async function sweepEventMail({ now = new Date(), store = getStore(), send = sendEmail, baseUrl = publicUrl(null), backend = emailBackend() } = {}) {
  const due = eventsToAnnounce(now);
  let sent = 0;
  let batches = 0;
  // With no mail set up nothing goes, and nobody is marked as told: the email waits for a
  // provider instead of being lost for everyone (review, 2026-11-09).
  if (!due.length || backend === 'console') return { sent, batches };
  try {
    let allowance = PER_DAY() - (await store.eventMailSentSince(new Date(now.getTime() - 24 * 3_600_000)));
    for (const theme of due) {
      if (allowance <= 0 || batches >= PER_SWEEP) break;
      const people = await store.eventMailRecipients(theme.event.id);
      const byLanguage = new Map();
      for (const person of people) {
        if (person.prefs?.eventMail === false) continue;
        // A Vietnamese clock with no language chosen yet reads Vietnamese, as the search does.
        const lang = person.prefs?.language === 'vi' || (!person.prefs?.language && /^Asia\/(Ho_Chi_Minh|Saigon)$/.test(String(person.prefs?.timezone || ''))) ? 'vi' : 'en';
        if (!byLanguage.has(lang)) byLanguage.set(lang, []);
        byLanguage.get(lang).push(person);
      }
      const standing = await eventStandingFor(theme.event, store, now);
      for (const [lang, group] of byLanguage) {
        for (let i = 0; i < group.length && allowance > 0 && batches < PER_SWEEP; i += BATCH()) {
          const offered = group.slice(i, i + Math.min(BATCH(), allowance));
          // Claimed before it is sent: two sweeps at once each get whom the other did not.
          const mine = new Set(await store.claimEventMail(theme.event.id, offered.map((p) => p.id)));
          const batch = offered.filter((p) => mine.has(p.id));
          if (!batch.length) continue;
          const mail = eventEmail({ themeId: theme.id, event: { ...theme.event, ...standing }, language: lang, baseUrl });
          // To the sender, everyone else in Bcc: nobody sees another person's address.
          const result = await send({ to: null, bcc: batch.map((p) => p.email), ...mail, prefer: 'smtp' }).catch(() => null);
          batches += 1;
          if (!result?.ok) {
            await store.releaseEventMail(theme.event.id, batch.map((p) => p.id));
            log.warn('event email batch not sent', { event: theme.event.id, size: batch.length });
            return { sent, batches };
          }
          await store.markEventMail(theme.event.id, batch.map((p) => p.id));
          sent += batch.length;
          allowance -= batch.length;
        }
      }
    }
  } catch (err) {
    log.error('event emails not sent', err);
  }
  return { sent, batches };
}
