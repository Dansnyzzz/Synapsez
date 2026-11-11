import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/*
 * The team to and from a file (spec B.5), in one dialog: download the team; bring one in
 * from a file or from text pasted out of another assistant — what it would add is shown
 * first, and Add adds it; and the ready prompt to paste into that other assistant, which
 * answers in this app's own format.
 */

/** Save `data` as a JSON file named `name`, from the page. */
export function downloadJson(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Only one bot of a team file, or one group with its members — the row menu's Export.
 *
 * @param {any} file  a synapsez-bots/1 export @param {'bot' | 'group'} kind @param {string} name
 */
export function sliceTeamFile(file, kind, name) {
  const lower = String(name).toLowerCase();
  if (kind === 'bot') return { ...file, bots: file.bots.filter((b) => b.name.toLowerCase() === lower).map(({ main: _main, ...b }) => b), groups: [] };
  const groups = file.groups.filter((g) => g.name.toLowerCase() === lower);
  const keys = new Set(groups.flatMap((g) => g.members));
  return { ...file, bots: file.bots.filter((b) => keys.has(b.key)), groups };
}

/** Download the whole team, or one of it. @param {any} api @param {{ kind?: 'bot' | 'group', name?: string }} [only] */
export async function exportTeam(api, only = {}) {
  const file = await api.exportBots();
  const out = only.kind && only.name ? sliceTeamFile(file, only.kind, only.name) : file;
  const slug = only.name ? `-${String(only.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}` : '';
  downloadJson(out, `synapsez-bots${slug}-${today()}.json`);
}

/** What an import would add, or added, one line each. */
function planHtml(items, applied) {
  return `<ul class="botport__plan">${items
    .map((i) => {
      const what = i.kind === 'chief' ? t('bots.port.chief', { name: i.as }) : t(i.kind === 'group' ? 'bots.port.group' : 'bots.port.bot', { name: i.as });
      const renamed = i.kind !== 'chief' && i.as !== i.name ? ` <span class="hint">${escapeHtml(t('bots.port.renamed', { name: i.name }))}</span>` : '';
      const extra = [i.memory ? t('bots.port.memory', { n: i.memory }) : '', i.tasks ? t('bots.port.tasks', { n: i.tasks }) : ''].filter(Boolean).join(' · ');
      const state = applied ? (i.added ? `<span class="botport__ok">${escapeHtml(t('bots.port.added'))}</span>` : `<span class="botport__no">${escapeHtml(i.error || t('bots.port.notAdded'))}</span>`) : '';
      const refused = (i.refused || []).map((r) => `<li class="botport__refused">${escapeHtml(r)}</li>`).join('');
      return `<li><span>${escapeHtml(what)}</span>${renamed}${extra ? ` <span class="hint">${escapeHtml(extra)}</span>` : ''} ${state}${refused ? `<ul>${refused}</ul>` : ''}</li>`;
    })
    .join('')}</ul>`;
}

/**
 * The dialog. `onImported` runs after anything was added, to read the team again.
 *
 * @param {{ api: any, toast: (text: string, kind?: string) => void, onImported: () => any }} deps
 */
export function openTeamFiles({ api, toast, onImported }) {
  const box = document.createElement('dialog');
  box.className = 'botport';
  box.setAttribute('aria-labelledby', 'botport-title');
  /** What was read, waiting for Add. */
  let pending = /** @type {unknown} */ (null);
  box.innerHTML = `<form method="dialog" class="botport__form" data-port-form>
    <header class="botport__head"><h2 id="botport-title">${escapeHtml(t('bots.port.title'))}</h2>
      <button class="icon-btn" type="submit" value="close" aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button></header>
    <section class="botport__sec"><h3>${escapeHtml(t('bots.port.exportTitle'))}</h3>
      <p class="hint">${escapeHtml(t('bots.port.exportHint'))}</p>
      <button class="btn" type="button" data-port="export">${escapeHtml(t('bots.port.export'))}</button></section>
    <section class="botport__sec"><h3>${escapeHtml(t('bots.port.importTitle'))}</h3>
      <p class="hint">${escapeHtml(t('bots.port.importHint'))}</p>
      <label class="btn btn--small botport__file">${escapeHtml(t('bots.port.pickFile'))}<input type="file" accept=".json,application/json" data-port-file hidden /></label>
      <textarea rows="5" data-port-text aria-label="${escapeHtml(t('bots.port.paste'))}" placeholder="${escapeHtml(t('bots.port.paste'))}"></textarea>
      <div class="botport__acts"><button class="btn" type="button" data-port="check">${escapeHtml(t('bots.port.check'))}</button>
        <button class="btn btn--primary" type="button" data-port="add" disabled>${escapeHtml(t('bots.port.add'))}</button></div>
      <div data-port-plan aria-live="polite"></div></section>
    <details class="botport__sec botport__migrate"><summary>${escapeHtml(t('bots.port.migrateTitle'))}</summary>
      <p class="hint">${escapeHtml(t('bots.port.migrateHint'))}</p>
      <textarea rows="8" readonly data-port-prompt aria-label="${escapeHtml(t('bots.port.migrateTitle'))}">${escapeHtml(t('bots.port.migratePrompt'))}</textarea>
      <button class="btn btn--small" type="button" data-port="copy">${escapeHtml(t('bots.port.copy'))}</button></details>
  </form>`;
  document.body.append(box);
  const planBox = /** @type {HTMLElement} */ (box.querySelector('[data-port-plan]'));
  const text = /** @type {HTMLTextAreaElement} */ (box.querySelector('[data-port-text]'));
  const add = /** @type {HTMLButtonElement} */ (box.querySelector('[data-port="add"]'));

  const read = () => {
    const raw = text.value.trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // Not plain JSON — an answer with words or a ``` fence round it: the server finds the file in it.
      return raw;
    }
  };
  const check = async () => {
    const data = read();
    if (!data) return toast(t('bots.port.nothing'));
    add.disabled = true;
    pending = null;
    try {
      const { items } = await api.importBots(data, { dry: true });
      planBox.innerHTML = `<p>${escapeHtml(t('bots.port.willAdd'))}</p>${planHtml(items, false)}`;
      pending = data;
      add.disabled = false;
      add.focus();
    } catch (err) {
      planBox.innerHTML = `<p class="botport__no" role="alert">${escapeHtml(err.message)}</p>`;
    }
  };

  box.addEventListener('click', async (event) => {
    const button = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-port]'));
    if (!button) return;
    const what = button.dataset.port;
    if (what === 'export') {
      await exportTeam(api).then(() => toast(t('bots.port.exported'), 'ok'), (err) => toast(err.message, 'error'));
    } else if (what === 'check') await check();
    else if (what === 'add' && pending) {
      add.disabled = true;
      try {
        const { items } = await api.importBots(pending);
        pending = null;
        planBox.innerHTML = `<p>${escapeHtml(t('bots.port.done'))}</p>${planHtml(items, true)}`;
        if (items.some((i) => i.added)) await onImported();
      } catch (err) {
        add.disabled = false;
        toast(err.message, 'error');
      }
    } else if (what === 'copy') {
      const prompt = /** @type {HTMLTextAreaElement} */ (box.querySelector('[data-port-prompt]')).value;
      navigator.clipboard?.writeText(prompt).then(() => toast(t('viewer.copied'), 'ok'), () => {});
    }
  });
  box.addEventListener('change', async (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    if (!input.matches('[data-port-file]') || !input.files?.[0]) return;
    const file = input.files[0];
    if (file.size > 2_000_000) return toast(t('bots.port.tooBig'), 'error');
    text.value = await file.text();
    await check();
  });
  text.addEventListener('input', () => {
    pending = null;
    add.disabled = true;
  });
  box.addEventListener('close', () => box.remove(), { once: true });
  box.showModal();
  /** @type {HTMLElement | null} */ (box.querySelector('[data-port="export"]'))?.focus();
  return box;
}
