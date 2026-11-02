/**
 * Create a skill — and edit one — after Claude's (owner, 2026-11-01).
 *
 * The name, when it applies, and the instructions in an editor with line
 * numbers, beside the files the skill carries (a template, a reference list),
 * each a tab. Copy sits in the editor's corner: always while you are in it,
 * on pointing otherwise.
 *
 * **A draft is never lost.** Every change is kept at once in this browser and,
 * a moment later, on the account (`/api/skills/draft`): a tab closed by mistake,
 * a browser that crashes, a computer that dies — the next Create a skill, here
 * or on another device, opens where it was, from whichever copy is newer.
 * Cancel with anything written asks first, as Claude's does, and Discard is
 * the only way a draft goes without being made into a skill.
 *
 * Text only, in nodes and `value`s — never markup: it is the person's own.
 */
import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';
import { toast } from './render.js';

/**
 * This browser's copy of a draft, one per account (PRV-017). It was one key for
 * the whole browser: whoever signed in next and opened Create a skill was shown
 * the last person's draft — and their first keystroke saved it to their own
 * account. The old shared key is dropped on sight; nobody can tell whose it was.
 */
const LOCAL_PREFIX = 'synapsez.skillDraft';
const MAX_FILE_CHARS = 20_000;
const MAX_FILES = 10;

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** Every account's copy on this browser gone — at sign-out, so nothing outlives the session here. */
export function forgetLocalDrafts() {
  try {
    for (const key of Object.keys(localStorage)) if (key === LOCAL_PREFIX || key.startsWith(`${LOCAL_PREFIX}:`)) localStorage.removeItem(key);
  } catch {
    /* storage refused: there is nothing to forget */
  }
}

/**
 * @param {{ onSaved: (skill: any) => void, owner: () => string | undefined }} deps
 *   `owner`: the signed-in account's id, which this browser's copy belongs to
 */
export function createSkillEditor({ onSaved, owner }) {
  /** This account's key, or null when there is no account to tie a copy to. */
  const localKey = () => {
    const id = owner();
    return id ? `${LOCAL_PREFIX}:${id}` : null;
  };
  const dialog = /** @type {HTMLDialogElement} */ ($('skill-create'));
  const confirm = /** @type {HTMLDialogElement} */ ($('skc-discard'));
  const nameBox = /** @type {HTMLInputElement} */ ($('skc-name'));
  const descBox = /** @type {HTMLTextAreaElement} */ ($('skc-desc'));
  const text = /** @type {HTMLTextAreaElement} */ ($('skc-text'));
  const lines = $('skc-lines');
  const tabs = $('skc-tabs');
  const pill = $('skc-draft');
  const fileInput = /** @type {HTMLInputElement} */ ($('skc-file-input'));

  /** What is being written: SKILL.md first, then the files, the one on screen at `current`. */
  let docs = [{ name: 'SKILL.md', content: '' }];
  let current = 0;
  /** An existing skill being changed — no draft for that, its saved self is the copy. */
  let editing = null;
  let saveTimer = 0;

  const draftOf = () => ({
    name: nameBox.value,
    description: descBox.value,
    instructions: docs[0].content,
    files: docs.slice(1),
    savedAt: new Date().toISOString(),
  });
  const hasContent = () => !!(nameBox.value.trim() || descBox.value.trim() || docs.some((d) => d.content.trim()) || docs.length > 1);
  const time = (iso) => new Date(iso).toLocaleTimeString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' });

  function setPill(key, at) {
    pill.textContent = t(key);
    pill.title = at ? t('skills.draftAt', { time: time(at) }) : '';
  }

  /* ── the editor ──────────────────────────────────────────────────── */

  function paintLines() {
    const n = Math.max(1, text.value.split('\n').length);
    lines.textContent = Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');
    lines.scrollTop = text.scrollTop;
  }

  function paintTabs() {
    tabs.replaceChildren();
    docs.forEach((doc, i) => {
      const tab = document.createElement('span');
      tab.className = `skedit__tab${i === current ? ' is-on' : ''}`;
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.setAttribute('role', 'tab');
      pick.setAttribute('aria-selected', String(i === current));
      pick.textContent = doc.name;
      pick.addEventListener('click', () => show(i));
      tab.append(pick);
      if (i > 0) {
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'skedit__untab';
        drop.textContent = '×';
        drop.setAttribute('aria-label', t('skills.removeFile', { name: doc.name }));
        drop.addEventListener('click', () => {
          docs.splice(i, 1);
          show(Math.min(current, docs.length - 1));
          changed();
        });
        tab.append(drop);
      }
      tabs.append(tab);
    });
  }

  function show(i) {
    docs[current].content = text.value;
    current = i;
    text.value = docs[current].content;
    text.setAttribute('aria-label', docs[current].name);
    paintTabs();
    paintLines();
  }

  function paintSavedAs() {
    const saved = $('skc-saved');
    const name = nameBox.value.trim();
    saved.hidden = !name;
    saved.textContent = name ? t('skills.savedAs', { name }) : '';
  }

  /* ── the draft ──────────────────────────────────────────────────── */

  function changed() {
    paintSavedAs();
    if (editing) return;
    docs[current].content = text.value;
    const draft = draftOf();
    try {
      const key = localKey();
      if (key) localStorage.setItem(key, JSON.stringify(draft));
    } catch {
      /* the account's copy is the one that matters */
    }
    setPill('skills.draftSaving');
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => keepOnAccount(draft), 900);
  }

  async function keepOnAccount(draft = draftOf()) {
    try {
      const { savedAt } = await api.saveSkillDraft(draft);
      setPill('skills.draftSaved', savedAt);
    } catch {
      setPill('skills.draftLocal', draft.savedAt);
    }
  }

  function forgetDraft() {
    clearTimeout(saveTimer);
    try {
      const key = localKey();
      if (key) localStorage.removeItem(key);
    } catch {
      /* nothing kept here */
    }
    return api.deleteSkillDraft().catch(() => {});
  }

  /** The newer of this browser's copy and the account's, or null. */
  async function lastDraft() {
    let local = null;
    try {
      localStorage.removeItem(LOCAL_PREFIX);
      const key = localKey();
      local = key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
    } catch {
      local = null;
    }
    const remote = await api.skillDraft().then((r) => r.draft).catch(() => null);
    const pick = [local, remote].filter((d) => d && (d.name || d.description || d.instructions || d.files?.length)).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0];
    return pick || null;
  }

  /* ── opening and closing ────────────────────────────────────────── */

  function fill({ name = '', description = '', instructions = '', files = [] } = {}) {
    nameBox.value = name;
    descBox.value = description;
    docs = [{ name: 'SKILL.md', content: instructions }, ...files.map((f) => ({ name: f.name, content: f.content ?? '' }))];
    current = 0;
    text.value = docs[0].content;
    paintTabs();
    paintLines();
    paintSavedAs();
  }

  /** Open it: a new skill (picking up a draft), or `skill` to change one. */
  async function open(skill = null) {
    editing = skill;
    $('skc-title').textContent = t(skill ? 'skills.editTitle' : 'skills.createTitle');
    $('skc-create').textContent = t(skill ? 'skills.saveChanges' : 'skills.create');
    $('skc-status').textContent = '';
    nameBox.readOnly = !!skill;
    pill.hidden = !!skill;
    if (skill) {
      fill({ name: skill.name, description: skill.description, instructions: skill.instructions, files: skill.files || [] });
    } else {
      fill();
      setPill('skills.draft');
      const draft = await lastDraft();
      if (draft) {
        fill(draft);
        setPill('skills.draftRestored', draft.savedAt);
      }
    }
    if (!dialog.open) dialog.showModal();
    (skill ? descBox : nameBox).focus();
  }

  const close = () => {
    clearTimeout(saveTimer);
    if (confirm.open) confirm.close();
    dialog.close();
  };

  /** Cancel, ✕ or Escape: with something written, ask first. */
  function leave() {
    if (!editing && hasContent()) {
      confirm.showModal();
      $('skc-keep').focus();
      return;
    }
    close();
  }

  $('skc-close').addEventListener('click', leave);
  $('skc-cancel').addEventListener('click', leave);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    leave();
  });
  $('skc-keep').addEventListener('click', () => {
    confirm.close();
    text.focus();
  });
  confirm.addEventListener('cancel', (event) => {
    event.preventDefault();
    confirm.close();
    text.focus();
  });
  $('skc-discard-yes').addEventListener('click', async () => {
    await forgetDraft();
    close();
  });
  pill.addEventListener('click', () => {
    if (!editing) keepOnAccount();
  });

  $('skc-create').addEventListener('click', async () => {
    docs[current].content = text.value;
    const button = /** @type {HTMLButtonElement} */ ($('skc-create'));
    button.disabled = true;
    try {
      const { skill } = await api.saveSkill({ name: nameBox.value, description: descBox.value, instructions: docs[0].content, files: docs.slice(1) });
      if (!editing) await forgetDraft();
      close();
      toast(t('skills.savedNamed', { name: skill.name }), 'ok');
      onSaved(skill);
    } catch (err) {
      $('skc-status').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  /* ── typing, files, copying ─────────────────────────────────────── */

  for (const box of [nameBox, descBox]) box.addEventListener('input', changed);
  text.addEventListener('input', () => {
    paintLines();
    changed();
  });
  text.addEventListener('scroll', () => {
    lines.scrollTop = text.scrollTop;
  });
  // A tab in the editor indents, as it does in any editor; Escape still leaves.
  text.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const { selectionStart: from, selectionEnd: to, value } = text;
    text.value = `${value.slice(0, from)}  ${value.slice(to)}`;
    text.selectionStart = text.selectionEnd = from + 2;
    paintLines();
    changed();
  });

  $('skc-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      toast(t('skills.copied', { name: docs[current].name }), 'ok');
    } catch {
      text.select();
    }
  });

  $('skc-add-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const file of [...(fileInput.files || [])]) {
      if (docs.length > MAX_FILES) {
        toast(t('skills.tooManyFiles', { n: MAX_FILES }), 'error');
        break;
      }
      const content = await file.text();
      if (content.length > MAX_FILE_CHARS) {
        toast(t('skills.fileTooLong', { name: file.name }), 'error');
        continue;
      }
      const at = docs.findIndex((d, i) => i > 0 && d.name.toLowerCase() === file.name.toLowerCase());
      if (at > 0) docs[at].content = content;
      else docs.push({ name: file.name, content });
      show(at > 0 ? at : docs.length - 1);
    }
    fileInput.value = '';
    changed();
  });

  return { open };
}
