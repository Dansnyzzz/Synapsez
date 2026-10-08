/**
 * The names models reach for, read as the ones the tools take.
 *
 * Free models in particular spell the same intent a dozen ways — `fill` for
 * `type`, `goto` for `open`, `commands: [...]` for `command` — and each one was
 * refused with a red card and a retry that cost a whole step (owner, 2026-10-07:
 * `cloud_browser` refused `fill`, `sandbox_run` refused `commands`). Where the
 * meaning is plain, it is taken as meant.
 *
 * One module for both sides, the way `schedule-grammar.js` is: the server reads
 * a call through this before it grades the risk and before it runs it
 * (`readArguments` in server/tools/validate.js — the same reader on both sides
 * of that decision, SEC-039), and the transcript labels a step through it. A
 * step drawn as "fill" and run as "type", or graded as an empty command and run
 * as `rm -rf`, cannot happen when both read the call here.
 *
 * Only plain synonyms. Anything that would need a guess about what was meant is
 * left alone, and the validator says what the tool takes.
 */

const loose = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/** `cloud_browser` actions under the names models give them. */
const BROWSER_ACTIONS = {
  fill: 'type',
  fill_in: 'type',
  input: 'type',
  type_text: 'type',
  enter_text: 'type',
  write: 'type',
  goto: 'open',
  go_to: 'open',
  navigate: 'open',
  visit: 'open',
  load: 'open',
  open_url: 'open',
  go: 'open',
  screenshot: 'look',
  snapshot: 'look',
  observe: 'look',
  view: 'look',
  inspect: 'look',
  get_page: 'look',
  read_page: 'read',
  get_text: 'read',
  extract_text: 'read',
  tap: 'click',
  click_element: 'click',
  press_key: 'press',
  keypress: 'press',
  key: 'press',
  hotkey: 'press',
  refresh: 'reload',
  go_back: 'back',
  go_forward: 'forward',
  select_option: 'select',
  choose: 'select',
  new_page: 'new_tab',
  open_tab: 'new_tab',
  list_tabs: 'tabs',
  wait_for: 'wait',
  sleep: 'wait',
  save_pdf: 'pdf',
  print: 'pdf',
  quit: 'close',
  exit: 'close',
};

/** `scroll_down` and friends: the direction is in the name. */
const SCROLL_NAMED = /^scroll_(up|down|left|right)$/;

/** Fields an element number arrives under, for the actions that take one. */
const REF_FIELDS = ['element', 'element_id', 'elementId', 'ref_id', 'target', 'id', 'number'];
const TAKES_REF = new Set(['click', 'type', 'select']);

/** @param {Record<string, any>} step */
function browserStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  const out = { ...step };
  if (out.action !== undefined && out.action !== null) {
    const raw = loose(out.action);
    const scroll = SCROLL_NAMED.exec(raw);
    if (scroll) {
      out.action = 'scroll';
      out.direction ??= scroll[1];
    } else if (BROWSER_ACTIONS[raw]) {
      out.action = BROWSER_ACTIONS[raw];
    }
  }
  const action = typeof out.action === 'string' ? out.action : '';
  if (TAKES_REF.has(action) && (out.ref === undefined || out.ref === null || out.ref === '')) {
    // `index` is a tab number for switch_tab — here it can only be an element.
    const field = [...REF_FIELDS, 'index'].find((k) => /^\d+$/.test(String(out[k] ?? '').replace(/^#|\[|\]/g, '')));
    if (field) {
      out.ref = Number(String(out[field]).replace(/^#|\[|\]/g, ''));
      delete out[field];
    }
  }
  // `{ action: 'type', text: 'hello' }` with nothing else: the text is what to
  // type, since there is nothing else it could be.
  if (action === 'type' && out.value === undefined) {
    const said = ['content', 'input_text', 'keys'].find((k) => typeof out[k] === 'string');
    if (said) {
      out.value = out[said];
      delete out[said];
    } else if (typeof out.text === 'string' && out.ref !== undefined) {
      out.value = out.text;
      delete out.text;
    }
  }
  if (action === 'open' && out.url === undefined) {
    const said = ['href', 'link', 'address', 'website'].find((k) => typeof out[k] === 'string');
    if (said) {
      out.url = out[said];
      delete out[said];
    }
  }
  if (action === 'press' && out.key === undefined && typeof out.keys === 'string') {
    out.key = out.keys;
    delete out.keys;
  }
  if (typeof out.direction === 'string') out.direction = loose(out.direction);
  return out;
}

/** What a model writes Python in, when it means Python. */
// An assignment counts only with spaces round the `=`: `FOO=1 make` is the shell's.
const PYTHONISH = /^\s*(?:import\s+\w|from\s+[\w.]+\s+import\b|def\s+\w+\s*\(|class\s+\w+|print\s*\(|[A-Za-z_]\w*\s+=\s+\S|for\s+\w+\s+in\s+.+:\s*$|with\s+open\()/m;

/** @param {Record<string, any>} input */
function sandboxInput(input) {
  const out = { ...input };
  if (out.command === undefined || out.command === null || out.command === '') {
    if (Array.isArray(out.commands)) {
      const lines = out.commands.map((c) => (typeof c === 'string' ? c : c?.command ?? c?.cmd ?? '')).filter((c) => String(c).trim());
      if (lines.length) out.command = lines.join('\n');
      delete out.commands;
    } else if (typeof out.commands === 'string') {
      out.command = out.commands;
      delete out.commands;
    } else {
      const said = ['cmd', 'script', 'shell', 'bash', 'run'].find((k) => typeof out[k] === 'string' && out[k].trim());
      if (said) {
        out.command = out[said];
        delete out[said];
      }
    }
  }
  // `code`, unlabelled: Python when it reads as Python or says so, otherwise bash.
  if (typeof out.code === 'string' && out.code.trim() && out.python === undefined) {
    const language = loose(out.language || out.lang || '');
    const python = /^py/.test(language) || (!language && PYTHONISH.test(out.code));
    if (python) out.python = out.code;
    else if (out.command === undefined) out.command = out.code;
    else return out;
    delete out.code;
    delete out.language;
    delete out.lang;
  }
  return out;
}

/** `place_lookup` ops under the names models give them. */
const PLACE_OPS = {
  search: 'find',
  lookup: 'find',
  geocode: 'find',
  locate: 'find',
  where: 'find',
  address: 'find',
  nearby: 'nearby',
  near: 'nearby',
  around: 'nearby',
  search_nearby: 'nearby',
  nearby_search: 'nearby',
  places: 'nearby',
  poi: 'nearby',
  explore: 'nearby',
  route: 'distance',
  directions: 'distance',
  direction: 'distance',
  travel: 'distance',
  distance: 'distance',
  find: 'find',
};

/** Words that name a kind of place rather than one place. */
const KIND_OF_PLACE = /quán|nhà hàng|ăn uống|đồ ăn|món|restaurant|food|eat|cafe|café|cà phê|coffee|bar\b|pub\b|atm|ngân hàng|bank|khách sạn|hotel|homestay|bệnh viện|hospital|phòng khám|clinic|nhà thuốc|pharmacy|siêu thị|supermarket|cửa hàng|shop|chợ|market|cây xăng|gas station|parking|gửi xe/i;

/** Text that means "where the person is", not a place to look up. */
const HERE = /^(?:me|here|my (?:location|place|area)|current location|near me|nearby|gần (?:tôi|đây|mình)|chỗ (?:tôi|mình)|ở đây|vị trí (?:của )?(?:tôi|mình|hiện tại))$/i;

/**
 * `place_lookup`, read as meant (owner, 2026-10-07): models sent
 * `{ location, query }` with no op, `op: "search"`, and `query` where the
 * tool wanted `place` — four refusals in a row before an answer.
 *
 * @param {Record<string, any>} input
 */
function placeInput(input) {
  const out = { ...input };
  const take = (to, ...names) => {
    if (out[to] !== undefined && out[to] !== null && out[to] !== '') return;
    const name = names.find((k) => typeof out[k] === 'string' && out[k].trim());
    if (name) {
      out[to] = out[name];
      delete out[name];
    }
  };
  // A search phrased as "restaurants near me" is a search near somewhere.
  const words = String(out.query ?? out.what ?? out.category ?? out.type ?? out.kind ?? '');
  if (typeof out.op === 'string') {
    const op = loose(out.op);
    // "search" for a kind of place ("quán ăn ngon Quận 1") is a search nearby;
    // for a name, it is finding that place.
    out.op = op === 'search' && KIND_OF_PLACE.test(`${words} ${out.place ?? ''}`) ? 'nearby' : PLACE_OPS[op] || out.op;
  }
  if (!out.op) {
    if (out.from && out.to) out.op = 'distance';
    else if (out.what || out.category || out.type || out.kind || out.amenity || /\bnear\b|gần|quanh|xung quanh|nearby|around/i.test(words)) out.op = 'nearby';
    else out.op = 'find';
  }
  if (out.op === 'find' && /\bnear me\b|gần (?:tôi|đây)|quanh đây/i.test(words) && !out.place) out.op = 'nearby';
  if (out.op === 'nearby') {
    take('what', 'query', 'category', 'type', 'kind', 'amenity', 'keyword', 'search', 'q');
    take('near', 'location', 'around', 'center', 'centre', 'area', 'place', 'address', 'city');
    if (typeof out.near === 'string' && HERE.test(out.near.trim())) delete out.near;
  } else if (out.op === 'find') {
    take('place', 'query', 'name', 'address', 'location', 'q', 'search');
    // `{ query: "Bếp Mẹ Ỉn", location: "Ho Chi Minh City" }`: the place, in the city named.
    if (typeof out.location === 'string' && out.location.trim() && typeof out.place === 'string' && !out.place.includes(out.location)) {
      out.place = `${out.place}, ${out.location}`;
      delete out.location;
    }
  } else if (out.op === 'distance') {
    take('from', 'origin', 'start', 'source');
    take('to', 'destination', 'end', 'target');
    if (typeof out.mode === 'string') {
      const mode = loose(out.mode);
      out.mode = /^(walk|walking|foot|đi_bộ|di_bo)$/.test(mode) ? 'walking' : /^(bike|bicycle|cycling|cycle|xe_đạp|xe_dap)$/.test(mode) ? 'cycling' : 'driving';
    }
  }
  return out;
}

/**
 * The call as the tool will read it. Never throws, never drops a field it does
 * not recognise — the validator is the one that refuses.
 *
 * @param {string} name
 * @param {unknown} input
 * @returns {any}
 */
export function canonicalInput(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (name === 'cloud_browser') {
    const out = browserStep(/** @type {Record<string, any>} */ (input));
    if (Array.isArray(out.steps)) out.steps = out.steps.map(browserStep);
    // A batch with no action of its own is a batch.
    if ((out.action === undefined || out.action === null) && Array.isArray(out.steps) && out.steps.length) out.action = 'steps';
    return out;
  }
  if (name === 'sandbox_run') return sandboxInput(/** @type {Record<string, any>} */ (input));
  if (name === 'place_lookup') return placeInput(/** @type {Record<string, any>} */ (input));
  return input;
}

export const __testing = { BROWSER_ACTIONS, PYTHONISH };
