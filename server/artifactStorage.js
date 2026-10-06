/**
 * Somewhere for a running artifact to keep things.
 *
 * The problem, stated exactly: an artifact runs in a frame with **no
 * `allow-same-origin`**, which is the entire security model — an opaque origin with
 * no route back to the session that made it. Two consequences follow, and the
 * second one is the interesting half:
 *
 *   `localStorage` **throws**. Not "returns null" — a `SecurityError`, on the first
 *   access, which takes the whole page down. So a model writing the obvious code
 *   produces a blank rectangle.
 *
 *   `fetch` cannot help either. `connect-src 'none'` and an opaque origin mean a
 *   request arrives unauthenticated from `null`, so the frame cannot talk to this
 *   API even if it wanted to.
 *
 * What a sandboxed frame *can* still do is `postMessage` to its parent. So the
 * parent is the only route, and the shim below is the frame's half of it: an async
 * `window.storage` that posts a request and waits for the answer. The page never
 * learns which artifact it is — **the parent supplies the id** — because a frame
 * naming its own storage key is a frame that can read another artifact's data.
 *
 * Values live in `user_settings`, keyed by attachment. No schema change, and it
 * disappears with the account like everything else there.
 */
import { getStore } from './store/index.js';

const KEY = 'artifactStorage';

/** Per artifact, not per account: a calculator's state is not a document's. */
const MAX_KEYS = 100;
const MAX_VALUE_BYTES = 64 * 1024;
/**
 * The real ceiling, written as the number it is.
 *
 * This was `512 * 1024` and then compared as `MAX_TOTAL_BYTES * 4`, so the
 * effective limit was four times what the constant said. The behaviour is kept
 * — lowering a live limit would start refusing writes that used to succeed —
 * and the constant is corrected to match it, because a name that lies is worse
 * than a generous ceiling.
 */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

async function readAll(userId) {
  return (await getStore().getUserSetting(userId, KEY)) || {};
}

export async function listArtifactStorage(userId, artifactId) {
  const all = await readAll(userId);
  return all[artifactId] || {};
}

export async function getArtifactValue(userId, artifactId, key) {
  const bucket = await listArtifactStorage(userId, artifactId);
  return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : null;
}

export async function setArtifactValue(userId, artifactId, key, value) {
  const name = String(key || '').slice(0, 200);
  if (!name) throw new Error('A storage key cannot be empty.');

  // Stored as a JSON string so the shape the page put in is the shape it gets
  // back — a number stays a number, an object stays an object.
  const encoded = JSON.stringify(value ?? null);
  if (encoded.length > MAX_VALUE_BYTES) {
    throw new Error(`That value is ${Math.round(encoded.length / 1024)}KB, over the ${MAX_VALUE_BYTES / 1024}KB limit for one key.`);
  }

  const store = getStore();
  const all = await readAll(userId);
  const bucket = { ...(all[artifactId] || {}) };

  if (!Object.prototype.hasOwnProperty.call(bucket, name) && Object.keys(bucket).length >= MAX_KEYS) {
    throw new Error(`This artifact already has ${MAX_KEYS} stored keys, which is the limit.`);
  }
  bucket[name] = encoded;

  // Checked across the whole account, so one runaway artifact cannot fill the
  // row that every other artifact shares. Advisory rather than exact: it is read
  // before the write below, so two writers can each see room and both proceed.
  // Being a few kilobytes over a soft ceiling is not worth a lock.
  const next = { ...all, [artifactId]: bucket };
  if (JSON.stringify(next).length > MAX_TOTAL_BYTES) {
    throw new Error('Artifact storage for this account is full. Clear some values first.');
  }

  /**
   * A nested merge, not a whole-value overwrite.
   *
   * This was read-all, mutate, `setUserSetting` — the read-modify-write that
   * `mergeUserSetting` exists in the store to prevent, and whose doc comment
   * describes the identical bug being fixed for `memory_append`: two writes in
   * one step both read the same object, the second erased the first, and both
   * reported success. The agent runs up to four tool calls at once, and a page
   * saving two values is the ordinary case rather than an unlucky one.
   *
   * `mergeUserSettingIn` composes at the artifact level, so two artifacts
   * writing at once no longer collide at all, and two writes to one artifact
   * collide only when they touch the same key — where one of them has to win.
   */
  await store.mergeUserSettingIn(userId, KEY, artifactId, { [name]: encoded });
  return Object.keys(bucket).length;
}

/**
 * Removed in place, never read-all-then-written (CODE-042): the same lost update
 * `setArtifactValue` was fixed for. A page clearing one key while saving
 * another — `removeItem` and `setItem` are fire-and-forget, so in parallel is
 * the ordinary case — used to erase the save.
 */
export async function deleteArtifactValue(userId, artifactId, key) {
  const store = getStore();
  if (key == null) {
    await store.removeUserSettingKey(userId, KEY, artifactId);
    return 0;
  }
  const value = await store.removeUserSettingKeyIn(userId, KEY, artifactId, String(key));
  return Object.keys(value?.[artifactId] || {}).length;
}

/**
 * The frame's half of the bridge, injected ahead of the artifact's own markup.
 *
 * Deliberately plain and deliberately small. It runs before anything the model
 * wrote, so `window.storage` exists by the time that code looks for it.
 *
 * `localStorage` is replaced rather than left to throw. A model reaching for it out
 * of habit is the likeliest single failure here, and a working shim beats a
 * `SecurityError` that takes the page down — with a console note so the reason is
 * discoverable rather than mysterious. It is synchronous where `localStorage` is,
 * backed by whatever has already been read, which is the honest approximation:
 * good enough for `getItem` after `setItem`, and never silently lossy because
 * `window.storage` is there for anything that matters.
 */
const SHIM = `<script>
(function () {
  var waiting = {}, next = 1;
  function ask(op, key, value) {
    return new Promise(function (resolve, reject) {
      var id = 'as' + (next++);
      waiting[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __artifactStorage: true, id: id, op: op, key: key, value: value }, '*');
      setTimeout(function () {
        if (waiting[id]) { delete waiting[id]; reject(new Error('storage timed out')); }
      }, 10000);
    });
  }
  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.__artifactStorageReply || !waiting[d.id]) return;
    var w = waiting[d.id];
    delete waiting[d.id];
    if (d.error) w.reject(new Error(d.error)); else w.resolve(d.value);
  });
  window.storage = {
    get: function (k) { return ask('get', String(k)); },
    set: function (k, v) { return ask('set', String(k), v); },
    delete: function (k) { return ask('delete', String(k)); },
    list: function () { return ask('list'); },
    clear: function () { return ask('clear'); }
  };
  // localStorage throws in an opaque origin. A shim that works beats a page that
  // dies on line one; window.storage is the one that actually persists.
  try { localStorage.getItem('x'); } catch (err) {
    var mem = {};
    var shim = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, String(k)) ? mem[String(k)] : null; },
      setItem: function (k, v) { mem[String(k)] = String(v); window.storage.set(String(k), String(v)); },
      removeItem: function (k) { delete mem[String(k)]; window.storage.delete(String(k)); },
      clear: function () { mem = {}; window.storage.clear(); },
      key: function (i) { return Object.keys(mem)[i] || null; }
    };
    Object.defineProperty(shim, 'length', { get: function () { return Object.keys(mem).length; } });
    try {
      Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
      console.info('[Synapsez] localStorage is not available in a sandboxed artifact. ' +
        'It has been replaced with an in-memory shim; use await window.storage.get/set for anything that must persist.');
    } catch (ignored) { /* frozen; nothing more to try */ }
    window.storage.list().then(function (all) {
      for (var k in all) mem[k] = typeof all[k] === 'string' ? all[k] : JSON.stringify(all[k]);
    }).catch(function (err) {
      // Starting empty is the right behaviour — an artifact must still run when
      // its stored values cannot be read. Saying nothing was not: the page then
      // looks like a first visit, and whoever wrote it has no way to tell that
      // apart from storage being broken.
      console.warn('[Synapsez] Could not read stored values; this artifact is starting empty.', err);
    });
  }
})();
</script>`;

/**
 * Put the shim in front of the page.
 *
 * Before `<head>` where there is one, so it runs first; otherwise at the very
 * start, which the parser handles the same way. Not injected into a page that has
 * already got it, so a re-render is not cumulative.
 */
export function withStorageShim(html) {
  const text = String(html ?? '');
  if (text.includes('__artifactStorage')) return text;

  const head = text.match(/<head[^>]*>/i);
  if (head) return text.replace(head[0], `${head[0]}${SHIM}`);

  const doctype = text.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return text.replace(doctype[0], `${doctype[0]}${SHIM}`);

  return SHIM + text;
}

export const __testing = { SHIM, MAX_VALUE_BYTES, MAX_KEYS };
