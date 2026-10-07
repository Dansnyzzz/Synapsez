/**
 * Check a tool call's arguments against the tool's own schema before it runs.
 *
 * This is what OpenAI's `strict: true` would give, done on the server so it holds
 * on every provider. Anthropic enforces its schema before a call is emitted; the
 * OpenAI-compatible adapter and Gemini do not, and turning strict on there is not
 * a one-line change — measured, 0 of the 93 tool schemas meet OpenAI's strict
 * subset, and behaviour through OpenRouter and OrcaRouter depends on the upstream
 * model (GAP-004). What strict mode is *for* is simpler and checkable here: a
 * tool should not run with a required argument missing, or with a value the
 * schema says cannot be there.
 *
 * The missing-argument case is the one with teeth in this codebase. A tool that
 * destructures an absent `path` gets `undefined`, and tool defaults turn that
 * into something wide — `resolveInWorkspace(undefined)` is the workspace root.
 * AUTO-005 closed the version of this where the arguments failed to parse; a
 * model that simply omits a required field produced the same widening and
 * nothing stopped it.
 *
 * Deliberately not a general JSON Schema implementation. The catalogue uses
 * exactly six keywords — `type`, `description`, `properties`, `required`,
 * `enum`, `items` — and no combinators, so this covers those six completely
 * rather than a larger set approximately. A tool that starts using another
 * keyword is covered by the test that asserts the catalogue still only uses
 * these, so the gap cannot open silently.
 *
 * Strict where the harm is, lenient where models are merely sloppy:
 *
 *   - a missing required field is refused;
 *   - a value outside an `enum` is refused, with the allowed values named —
 *     after a case- and spacing-blind match (`"Thank you"` is `thank_you`);
 *   - …unless the field is optional, in which case it is **dropped** and the
 *     tool's own default applies, with a note saying so. An optional enum is a
 *     hint the tool can do without (`send_email`'s `kind` is inferred when
 *     absent), and refusing a whole email over `kind: "email"` cost a step and
 *     left a red card on a job that went on to succeed;
 *   - an object or array of the wrong kind is refused;
 *   - `"5"` for a number and `"true"` for a boolean are **coerced**, because
 *     models send them constantly and refusing would turn a working call into
 *     a retry that costs a full step;
 *   - a number or boolean where a string is wanted becomes that string.
 *
 * Returns `{ ok: true, input, notes }` with the coerced input and anything that
 * was set aside, or `{ ok: false, error }` with a sentence written for the
 * model to act on.
 */

import { canonicalInput } from '../../public/js/tool-aliases.js';

export const SUPPORTED_KEYWORDS = new Set(['type', 'description', 'properties', 'required', 'enum', 'items']);

const kindOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

function coerce(value, type) {
  if (type === 'integer' || type === 'number') {
    if (typeof value === 'number') {
      return type === 'integer' && !Number.isInteger(value) ? { ok: false } : { ok: true, value };
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const n = Number(value);
      return type === 'integer' && !Number.isInteger(n) ? { ok: false } : { ok: true, value: n };
    }
    return { ok: false };
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
    return { ok: false };
  }
  if (type === 'string') {
    if (typeof value === 'string') return { ok: true, value };
    if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
    return { ok: false };
  }
  if (type === 'array') return Array.isArray(value) ? { ok: true, value } : { ok: false };
  if (type === 'object') {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  }
  // A type this validator does not know about is not a reason to refuse a call.
  return { ok: true, value };
}

/** `"Thank you"` → `thank_you`, so a near miss is read as what it plainly meant. */
const loose = (v) => String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');

/** The names a model gives the one piece of text when it wraps a string in an object. */
const TEXT_KEYS = ['task', 'text', 'prompt', 'question', 'query', 'content', 'description', 'value', 'instruction', 'message'];

/**
 * The string inside `{ "task": "…" }`, when a string was wanted.
 *
 * Models wrap list items this way constantly — `run_parallel` was sent
 * `tasks: [{ task: "…" }, …]` and refused six times running, because the
 * refusal named the type and never the shape, so the model sent the same
 * thing again. When the object plainly carries one piece of text, that text is
 * what was meant. When it does not — two strings and no telling which — it is
 * still refused, with the right shape shown.
 */
function unwrapText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const named = TEXT_KEYS.find((k) => typeof value[k] === 'string' && value[k].trim());
  if (named) return value[named];
  const strings = Object.values(value).filter((v) => typeof v === 'string' && v.trim());
  return strings.length === 1 ? strings[0] : null;
}

/**
 * Keys a list arrives wrapped in when a model writes its call as XML and the
 * provider turns that into JSON: `<questions><item>…</item></questions>` comes
 * out as `{ "questions": { "item": [ … ] } }`. One item comes out as an object
 * rather than a one-element list, which is why the singular names wrap.
 */
const LIST_WRAPPERS = new Set(['item', 'items', 'element', 'elements', 'li', 'entry', 'entries', 'list', 'array', 'value', 'values']);
const SINGULAR = new Set(['item', 'element', 'li', 'entry', 'value']);

/**
 * The list a value plainly is, or null when it is not one.
 *
 * `show_card` was refused with every question present, because they arrived as
 * `{ item: [...] }`; the error said "needs questions", the model sent the same
 * shape again, and the card was never drawn. The shapes read here each mean
 * exactly one list, so reading them is not a guess:
 *
 *   - `{ item: [...] }` or `{ item: {...} }` — the XML wrapper above;
 *   - `{ "0": a, "1": b }` — an array that went through an object on the way;
 *   - `"[1, 2]"` — the list sent as its own JSON text.
 */
export function asList(value, { loose = true } = {}) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const wrapper = keys.length === 1 && LIST_WRAPPERS.has(keys[0].toLowerCase());
    // Without a schema saying a list belongs here, `{ value: … }` and `{ list: … }`
    // are as likely to be real data as wrappers; only the XML item names count.
    if (wrapper && (loose || /^(item|items|element|elements|li|entry|entries)$/i.test(keys[0]))) {
      const inner = value[keys[0]];
      if (Array.isArray(inner)) return inner;
      if (SINGULAR.has(keys[0].toLowerCase()) && inner !== undefined && inner !== null) return [inner];
      return null;
    }
    if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => value[k]);
    /*
     * Options keyed by their labels — `{ "A": "…", "B": "…" }` — where the
     * schema wants a list of them. Only when the schema says a list belongs
     * here (`loose`), and only when every value is a plain string or number,
     * so a real object that happens to land here is not flattened into one.
     */
    if (loose && keys.length >= 2 && keys.every((k) => /^(?:[a-z]|\d{1,2}|option[ _-]?\w{1,3}|choice[ _-]?\w{1,3})[.)]?$/i.test(k))) {
      const values = keys.map((k) => value[k]);
      if (values.every((v) => typeof v === 'string' || typeof v === 'number')) return values;
    }
    // `{}` for a list with nothing in it — a free-text question's "options".
    if (loose && keys.length === 0) return [];
    // `{ "First option": true, "Second option": true }` — the names are the list.
    if (loose && keys.length && keys.every((k) => value[k] === true)) return keys;
    return null;
  }
  if (typeof value === 'string' && /^\s*\[[\s\S]*\]\s*$/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Every wrapped list inside a free-form object, unwrapped.
 *
 * A parameter declared only as `type: object` — `show_card`'s `card` — has no
 * schema below it to say where a list belongs, so the wrapper is recognised by
 * its own shape at any depth. The object handed in keeps its own keys; only
 * the values beneath are read.
 */
export function unwrapLists(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => unwrapLists(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const list = v && typeof v === 'object' && !Array.isArray(v) ? asList(v, { loose: false }) : null;
    out[k] = unwrapLists(list ?? v, depth + 1);
  }
  return out;
}

function check(value, schema, where, notes = []) {
  if (!schema || typeof schema !== 'object') return { ok: true, value };

  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.includes('array') && !Array.isArray(value) && value !== undefined && value !== null) {
    const list = asList(value);
    const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    const itemType = schema.items?.type;
    if (list) {
      const note = `${where.replace(/\[\d+\]/g, '[…]')} was sent wrapped; it was read as a list. Send a plain JSON array next time.`;
      if (!notes.includes(note)) notes.push(note);
      value = list;
    } else if (scalar && !types.includes(typeof value) && (itemType === 'string' || itemType === 'number' || itemType === 'integer')) {
      // One value where a list of them was wanted is a list of one.
      value = [value];
    }
  }
  // A free-form object: nothing below says where a list goes, so read wrappers by shape.
  if (types.includes('object') && !schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    value = unwrapLists(value);
  }

  const wantsString = schema.type === 'string' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'string');
  if (wantsString && value && typeof value === 'object' && !Array.isArray(value)) {
    const text = unwrapText(value);
    if (text !== null) {
      // One note for the whole list, not one per item.
      const field = where.replace(/\[\d+\]$/, '[…]');
      const note = `${field} was an object; its text was used. Send plain strings here next time.`;
      if (!notes.includes(note)) notes.push(note);
      value = text;
    } else {
      return {
        ok: false,
        error: `${where} should be a plain string, but got an object. Send the text itself, e.g. "…", not { "task": "…" }.`,
      };
    }
  }

  if (types.length) {
    let coerced = null;
    for (const type of types) {
      const attempt = coerce(value, type);
      if (attempt.ok) {
        coerced = attempt;
        break;
      }
    }
    if (!coerced) {
      return { ok: false, error: `${where} should be ${types.join(' or ')}, but got ${kindOf(value)}.` };
    }
    value = coerced.value;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    const near = typeof value === 'string' ? schema.enum.find((e) => loose(e) === loose(value)) : undefined;
    if (near !== undefined) return { ok: true, value: near };
    return {
      enumMiss: true,
      ok: false,
      error: `${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, but got ${JSON.stringify(value)}.`,
    };
  }

  if (Array.isArray(value) && schema.items) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = check(value[i], schema.items, `${where}[${i}]`, notes);
      if (!item.ok) return item;
      out.push(item.value);
    }
    value = out;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) {
        return { ok: false, error: `${where === 'arguments' ? '' : `${where}.`}${key} is required and was not given.` };
      }
    }
    if (schema.properties) {
      const out = { ...value };
      for (const [key, sub] of Object.entries(schema.properties)) {
        // Absent optional fields stay absent, so the tool's own default applies —
        // and a `null` is removed rather than passed on, because destructuring
        // defaults fire for `undefined` only. `{ cwd = '.' }` given `null` keeps
        // `null`, which is not what either the model or the tool meant.
        if (value[key] === undefined) continue;
        if (value[key] === null) {
          delete out[key];
          continue;
        }
        const name = where === 'arguments' ? key : `${where}.${key}`;
        const field = check(value[key], sub, name, notes);
        if (!field.ok && field.enumMiss && !(schema.required || []).includes(key)) {
          delete out[key];
          notes.push(`${name} ${JSON.stringify(value[key])} is not one it knows, so it was left out and the default used.`);
          continue;
        }
        if (!field.ok) return field;
        out[key] = field.value;
      }
      value = out;
    }
  }

  return { ok: true, value };
}

/**
 * @param {object} schema  a tool's `parameters`
 * @param {unknown} input  the arguments the model sent
 */
export function validateArguments(schema, input) {
  const notes = [];
  const result = check(input ?? {}, schema, 'arguments', notes);
  return result.ok ? { ok: true, input: result.value, notes } : { ok: false, error: result.error };
}

/**
 * A catalogue tool's arguments as it will run them: its plain synonyms read as
 * meant (`fill` is `type`, `commands` is `command` — see tool-aliases.js), then
 * checked against its schema.
 *
 * The one reader for both sides of the approval decision. `executeTool` runs
 * what this returns and `assessRisk` grades what this returns, so a call cannot
 * be graded under one spelling and run under another (SEC-039): an `rm -rf`
 * sent as `commands: [...]` is graded as the command it becomes.
 *
 * @param {string} name
 * @param {object} schema
 * @param {unknown} input
 */
export function readArguments(name, schema, input) {
  return validateArguments(schema, canonicalInput(name, input));
}
