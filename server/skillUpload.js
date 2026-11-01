import { openZip, looksLikeZip } from './office/zip.js';
import { redactSecrets } from './redact.js';
import { MAX_SKILL_FILES } from './skills.js';

/**
 * Upload a skill — Settings → Skills → Add → Upload skill (owner, 2026-11-01,
 * after Claude's): a SKILL.md with its name and description in YAML, or a .zip
 * or .skill holding one with the files beside it.
 *
 * Read on the server, and scanned before anything is kept. A skill is read
 * into the conversation whenever it applies, so what it says is said to the
 * model on every one of those turns: a key pasted into it would travel to the
 * provider each time, and a line hidden in invisible characters would be an
 * instruction nobody saw. Those refuse the upload. Words that try to override
 * the assistant's instructions, or send something to an address, are shown as
 * warnings — a real skill may need to post to a webhook — and the person
 * decides. Nothing in a skill is ever run here: a script it carries is text.
 */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_FILE_CHARS = 20_000;
/** An archive's entries looked at, and the most any one may inflate to — a skill keeps little. */
const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 128 * 1024;
const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|py|sh|ps1|bat|sql|toml|ini|cfg|rb|go|rs|java|kt|c|cc|cpp|h|hpp|r|tex)$/i;
const SCRIPT = /\.(sh|ps1|bat|py|js|mjs|cjs|ts|rb)$/i;

/** Characters that draw nothing, and so can carry words nobody reading the skill would see. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const OVERRIDE = /\bignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules)|\bdisregard (?:the |your )?(?:system|previous|prior) (?:prompt|instructions)|\byou are now in (?:developer|god|dan) mode/i;
const SENDS = /\b(?:send|post|upload|forward|exfiltrate|transmit)\b[^.\n]{0,80}?(https?:\/\/[^\s)'"`<>]+)/i;

const unquote = (value) => {
  const v = value.trim();
  return /^(['"]).*\1$/s.test(v) ? v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'") : v;
};

/**
 * A SKILL.md's front matter and body. Only what a skill needs of YAML: `key:
 * value`, quoted values, and folded or literal blocks (`>` / `|`) indented under
 * their key — the shapes skill files are written in.
 */
export function frontMatter(text) {
  const source = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const block = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!block) return { meta: {}, body: source.trim() };
  const meta = {};
  let key = null;
  let style = null;
  for (const line of block[1].split('\n')) {
    const pair = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (pair) {
      key = pair[1].toLowerCase();
      const value = pair[2].trim();
      if (/^[>|][-+]?$/.test(value)) {
        style = value[0];
        meta[key] = '';
      } else {
        style = null;
        meta[key] = unquote(value);
      }
    } else if (key && /^\s+\S/.test(line)) {
      const piece = line.trim();
      meta[key] = meta[key] ? `${meta[key]}${style === '|' ? '\n' : ' '}${piece}` : piece;
    }
  }
  return { meta, body: source.slice(block[0].length).trim() };
}

/**
 * What a skill would say to the model, checked: `block` refuses it, `warn` is
 * shown and left to the person. Every finding names where it was found.
 *
 * @param {{ name: string, description: string, instructions: string, files?: { name: string, content: string }[] }} skill
 * @returns {{ level: 'block' | 'warn' | 'note', text: string }[]}
 */
export function scanSkill(skill) {
  const parts = [
    ['SKILL.md', `${skill.name}\n${skill.description}\n${skill.instructions}`],
    ...(skill.files || []).map((f) => [f.name, f.content]),
  ];
  const findings = [];
  for (const [where, text] of parts) {
    if (redactSecrets(text).found.length) findings.push({ level: 'block', text: `${where} holds what looks like a key, token or password. Take it out, then upload again.` });
    if (INVISIBLE.test(text)) findings.push({ level: 'block', text: `${where} has invisible characters, which can hide instructions. Remove them, then upload again.` });
    if (OVERRIDE.test(text)) findings.push({ level: 'warn', text: `${where} tells the assistant to set aside its other instructions.` });
    const sends = SENDS.exec(text);
    if (sends) {
      let host = sends[1];
      try {
        host = new URL(sends[1]).host;
      } catch {
        /* the address as written */
      }
      findings.push({ level: 'warn', text: `${where} tells the assistant to send something to ${host}.` });
    }
  }
  const scripts = (skill.files || []).filter((f) => SCRIPT.test(f.name)).map((f) => f.name);
  if (scripts.length) findings.push({ level: 'note', text: `Scripts are kept as text and never run here: ${scripts.join(', ')}.` });
  return findings;
}

/** The base name of a path, without its extension — a skill's name when its front matter has none. */
const stem = (path) => String(path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

/**
 * One uploaded file, read into a skill — or why it could not be.
 *
 * @param {{ name: string, data: string }} upload  the file's name and its bytes in base64
 * @returns {{ file: string, skill?: { name: string, description: string, instructions: string, files: { name: string, content: string }[] }, findings: { level: string, text: string }[], error?: string }}
 */
export function readSkillUpload(upload) {
  const file = String(upload?.name || 'skill').slice(0, 200);
  const bytes = Buffer.from(String(upload?.data || ''), 'base64');
  if (!bytes.length) return { file, findings: [], error: 'That file is empty.' };
  if (bytes.length > MAX_UPLOAD_BYTES) return { file, findings: [], error: 'That file is over 2 MB — too large for a skill.' };

  let skillMd = '';
  let base = '';
  const files = [];
  const findings = [];
  if (/\.(zip|skill)$/i.test(file) || looksLikeZip(bytes)) {
    let zip;
    try {
      zip = openZip(bytes);
    } catch {
      return { file, findings: [], error: 'That archive could not be opened. A .zip or .skill holds a SKILL.md.' };
    }
    // The SKILL.md nearest the top, and everything beside or under it.
    const main = zip.names.filter((n) => /(^|\/)skill\.md$/i.test(n) && !/(^|\/)(__macosx|\.)/i.test(n)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!main) return { file, findings: [], error: 'There is no SKILL.md in that archive.' };
    try {
      skillMd = zip.text(main, MAX_ENTRY_BYTES);
    } catch {
      return { file, findings: [], error: 'That SKILL.md is too large for a skill.' };
    }
    base = main.slice(0, main.length - 'SKILL.md'.length);
    // Nothing is inflated past what a skill could keep: a small archive can
    // claim, and hold, far more than it weighs.
    for (const name of zip.names.slice(0, MAX_ENTRIES)) {
      if (name === main || !name.startsWith(base) || /(^|\/)(__macosx|\.)/i.test(name.slice(base.length))) continue;
      const relative = name.slice(base.length);
      if (!TEXT_FILE.test(relative)) {
        findings.push({ level: 'note', text: `Left out ${relative}: only text files are kept with a skill.` });
        continue;
      }
      if (files.length >= MAX_SKILL_FILES) {
        findings.push({ level: 'note', text: `Left out ${relative}: a skill carries at most ${MAX_SKILL_FILES} files.` });
        continue;
      }
      let content;
      try {
        content = zip.text(name, MAX_ENTRY_BYTES);
      } catch {
        content = null;
      }
      if (content == null || content.length > MAX_FILE_CHARS) {
        findings.push({ level: 'note', text: `Left out ${relative}: over 20,000 characters.` });
        continue;
      }
      files.push({ name: relative, content });
    }
  } else if (/\.(md|markdown|txt)$/i.test(file)) {
    skillMd = bytes.toString('utf8');
  } else {
    return { file, findings: [], error: 'Upload a .md file, or a .zip or .skill holding a SKILL.md.' };
  }

  const { meta, body } = frontMatter(skillMd);
  const skill = {
    name: String(meta.name || stem(base.replace(/\/$/, '') || file)).trim().slice(0, 60),
    description: String(meta.description || '').trim(),
    instructions: body,
    files,
  };
  if (!skill.description) return { file, findings, error: 'The SKILL.md has no description in its front matter (description: …).' };
  if (!skill.instructions) return { file, findings, error: 'The SKILL.md has no instructions under its front matter.' };
  return { file, skill, findings: [...findings, ...scanSkill(skill)] };
}
