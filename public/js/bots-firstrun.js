import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { NAME_MAX } from './bot-mentions.js';

/*
 * The first run (spec B.7, after DS Bot's onboarding): Chief's chat is empty and Chief is
 * alone, so instead of a blank box the page offers four goals and, for each one picked, a
 * bot to make — its name, role and instructions there to change first. Create makes them
 * (and a group with Chief when there is more than one). No model is asked anything.
 */

export const GOALS = Object.freeze(['write', 'research', 'code', 'personal']);

/** The bot a goal suggests, in the person's language. @param {string} goal */
export function suggestedBot(goal) {
  return { name: t(`bots.first.${goal}.name`), role: t(`bots.first.${goal}.role`), instructions: t(`bots.first.${goal}.instructions`) };
}

/**
 * The card. `drafts` holds what the person has changed, by goal, so ticking another goal
 * keeps what was typed.
 *
 * @param {Set<string>} picked @param {Map<string, { name: string, role: string, instructions: string }>} drafts
 */
export function firstRunHtml(picked, drafts) {
  const goals = GOALS.map(
    (g) => `<label class="botfirst__goal"><input type="checkbox" data-goal="${g}"${picked.has(g) ? ' checked' : ''} /><span>${escapeHtml(t(`bots.first.${g}.goal`))}</span></label>`,
  ).join('');
  const bots = GOALS.filter((g) => picked.has(g))
    .map((g) => {
      const d = drafts.get(g) || suggestedBot(g);
      const label = (field) => escapeHtml(`${t(`bots.first.field.${field}`)} — ${t(`bots.first.${g}.goal`)}`);
      return `<li class="botfirst__bot" data-draft="${g}">
        <div class="botfirst__row">
          <input type="text" maxlength="${NAME_MAX}" data-field="name" value="${escapeHtml(d.name)}" aria-label="${label('name')}" />
          <input type="text" maxlength="40" data-field="role" value="${escapeHtml(d.role)}" aria-label="${label('role')}" />
        </div>
        <textarea rows="3" maxlength="4000" data-field="instructions" aria-label="${label('instructions')}">${escapeHtml(d.instructions)}</textarea>
      </li>`;
    })
    .join('');
  return `<section class="botfirst" aria-labelledby="botfirst-title">
    <h2 class="botfirst__title" id="botfirst-title">${escapeHtml(t('bots.first.title'))}</h2>
    <p class="hint">${escapeHtml(t('bots.first.hint'))}</p>
    <fieldset class="botfirst__goals"><legend class="sr-only">${escapeHtml(t('bots.first.goals'))}</legend>${goals}</fieldset>
    ${bots ? `<ul class="botfirst__bots">${bots}</ul>` : ''}
    ${picked.size > 1 ? `<p class="hint">${escapeHtml(t('bots.first.group'))}</p>` : ''}
    <div class="botfirst__acts">
      <button class="btn btn--primary" type="button" data-act="first-create"${picked.size ? '' : ' disabled'}>${escapeHtml(t('bots.first.create', { n: picked.size }))}</button>
      <button class="btn" type="button" data-act="first-skip">${escapeHtml(t('bots.first.skip'))}</button>
    </div>
  </section>`;
}

/**
 * Make what the card says: each bot, then — more than one — a group of them with Chief as
 * its admin. A bot that cannot be made is said and the rest still are.
 *
 * @param {{ picked: Set<string>, drafts: Map<string, any>, chiefId: string, api: any }} options
 * @returns {Promise<{ made: any[], failed: string[], group: any | null }>}
 */
export async function createFromFirstRun({ picked, drafts, chiefId, api }) {
  const made = [];
  const failed = [];
  for (const g of GOALS.filter((x) => picked.has(x))) {
    const d = drafts.get(g) || suggestedBot(g);
    try {
      const { bot } = await api.createBot({ name: String(d.name).trim(), role: String(d.role).trim(), instructions: String(d.instructions).trim() });
      made.push(bot);
    } catch (err) {
      failed.push(`${d.name}: ${err.message}`);
    }
  }
  let group = null;
  if (made.length > 1) {
    try {
      group = (await api.createGroup({ name: t('bots.first.groupName'), members: [chiefId, ...made.map((b) => b.id)], admin: chiefId })).group;
    } catch (err) {
      failed.push(`${t('bots.first.groupName')}: ${err.message}`);
    }
  }
  return { made, failed, group };
}
