# Image reads and the run gallery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A picture the assistant reads (`read_file` on an image, `look_at` by file id, url or cloud path) is stored, read by a vision model in the same step, and shown in the commands card as a thumbnail — a strip when folded, a thumbnail per row when open, a hover preview and a lightbox — with the commands card restyled 1:1 after Claude's.

**Architecture:** Pictures travel on the existing `shot` channel (`{ id, name }` on the tool result), stored as `origin: 'step'` attachments with a thumbnail. A shared `server/util/picture.js` shrinks pictures with `@napi-rs/canvas` on both the worker and the server. The browser gets a new `public/js/gallery.js` (preview + lightbox) that `render.js` feeds through a `WeakMap` from card node to its pictures.

**Tech Stack:** Node ESM, Express 5, `@napi-rs/canvas`, vanilla browser JS, hand-rolled test harness (`section`/`check`), Playwright-driven `test/ui.test.mjs`.

Spec: `docs/superpowers/specs/2026-10-19-image-reads-and-run-gallery-design.md`.

## Global Constraints

- View copy: longest edge ≤ 1600px; stored ≤ 2.5MB (`MAX_SEEN_BYTES`); thumbnail longest edge 420px, JPEG quality 72, stored in `thumb`.
- A picture already ≤1600px, ≤1MB and PNG/JPEG/WebP is kept byte for byte.
- PNG when the picture may be transparent (`mayBeTransparent`), otherwise JPEG quality 85 on white.
- Worker without canvas: post the original only if ≤ 2.5MB; otherwise a clear error.
- No new result field: pictures ride on `shot`. No schema change.
- Every user-facing string through `t()` with keys in both `public/js/locales/en.js` and `vi.js`; every new server sentence in `server/i18n/vi.js`.
- `prefers-reduced-motion`: no slide, no fade.
- Keep: the model's title never hides the command (row keeps the faint command); the run clock; auto-open running rows / fold on success.
- Work in branch `feat/2026-10-19-image-reads-gallery`; gate (`npm run gate`) green before merging to `main` and pushing.

---

### Task 1: `server/util/picture.js` — know a picture, make a view copy

**Files:**
- Create: `server/util/picture.js`
- Test: `test/attachments.test.mjs` (new section near the existing thumbnail section)

**Interfaces:**
- Produces: `sniffPicture(bytes: Buffer): string|null` (mime), `PICTURE_EXTENSIONS: RegExp`, `viewCopy(bytes: Buffer): Promise<{ data: Buffer, mime: string, width: number, height: number, thumb: string|null } | null>`, constants `VIEW_EDGE = 1600`, `THUMB_EDGE = 420`.

- [ ] **Step 1: Failing test** — append to `test/attachments.test.mjs` before the summary line:

```js
section('a picture a step read: known by its bytes, shrunk to look at, with a thumbnail');
{
  const { sniffPicture, viewCopy } = await import('../server/util/picture.js');
  const { createCanvas } = await import('@napi-rs/canvas');
  const big = createCanvas(3200, 1600);
  const paint = big.getContext('2d');
  paint.fillStyle = '#336699';
  paint.fillRect(0, 0, 3200, 1600);
  const png = await big.encode('png');
  check('a PNG is known by its bytes', sniffPicture(png) === 'image/png');
  check('and text is not a picture', sniffPicture(Buffer.from('hello world')) === null);
  const copy = await viewCopy(png);
  check('a large picture is shrunk to 1600px on its long edge', copy?.width === 3200 && copy?.height === 1600 && copy?.mime === 'image/jpeg', JSON.stringify({ w: copy?.width, mime: copy?.mime }));
  const { loadImage } = await import('@napi-rs/canvas');
  const shrunk = await loadImage(copy.data);
  check('  the copy really is 1600 wide', shrunk.width === 1600 && shrunk.height === 800, `${shrunk.width}x${shrunk.height}`);
  check('  with a JPEG thumbnail small enough for the row', /^data:image\/jpeg;base64,/.test(copy.thumb || '') && copy.thumb.length < 200_000);
  const small = Buffer.from(PNG, 'base64');
  const kept = await viewCopy(small);
  check('a small PNG is kept byte for byte', kept && kept.data.equals(small) && kept.mime === 'image/png');
  check('bytes that are not a picture get no copy', (await viewCopy(Buffer.from('not a picture'))) === null);
}
```

- [ ] **Step 2: Run** `node test/attachments.test.mjs` — expect FAIL (module not found).

- [ ] **Step 3: Implement** `server/util/picture.js`:

```js
import { mayBeTransparent } from '../imageGround.js';

/**
 * A picture a step read, made into something to look at (owner, 2026-10-19).
 *
 * Shared by the worker and the server. The worker shrinks a picture before it
 * posts it, because a request over 4.5MB never reaches a serverless function
 * and a 6MB figure is ordinary; the server keeps the copy and a thumbnail for
 * the strip. Best-effort on both sides: `@napi-rs/canvas` is a native module,
 * and where it will not load the picture goes as it was.
 */

/** The long edge a picture is kept at — sharp in a lightbox, small in the database. */
export const VIEW_EDGE = 1600;
/** The long edge of its thumbnail — the strip, a row, the hover preview. */
export const THUMB_EDGE = 420;
/** A picture this small, in a format every browser draws, is kept byte for byte. */
const KEEP_BYTES = 1024 * 1024;
const SHOWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The extensions `read_file` treats as pictures before it looks at the bytes. */
export const PICTURE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;

let canvasApi;
async function canvas() {
  if (canvasApi === undefined) {
    try {
      canvasApi = await import('@napi-rs/canvas');
    } catch {
      canvasApi = null;
    }
  }
  return canvasApi;
}

/**
 * What kind of picture these bytes are, from their first bytes — never from a
 * name, which is only a claim.
 *
 * @param {Buffer} bytes
 * @returns {string|null}
 */
export function sniffPicture(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * A copy to look at and a thumbnail.
 *
 * @param {Buffer} bytes
 * @returns {Promise<{ data: Buffer, mime: string, width: number, height: number, thumb: string|null } | null>}
 *   null when the bytes are not a picture at all.
 */
export async function viewCopy(bytes) {
  const mime = sniffPicture(bytes);
  if (!mime) return null;
  const asItIs = { data: bytes, mime, width: 0, height: 0, thumb: null };
  const api = await canvas();
  if (!api) return asItIs;
  let picture;
  try {
    picture = await api.loadImage(bytes);
  } catch {
    return asItIs;
  }
  const { width, height } = picture;
  if (!width || !height) return asItIs;
  const draw = async (edge, as, quality) => {
    const k = Math.min(1, edge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const surface = api.createCanvas(w, h);
    const paint = surface.getContext('2d');
    // JPEG has no transparency: what was see-through would come out black.
    if (as === 'jpeg') {
      paint.fillStyle = '#ffffff';
      paint.fillRect(0, 0, w, h);
    }
    paint.drawImage(picture, 0, 0, w, h);
    return as === 'png' ? surface.encode('png') : surface.encode('jpeg', quality);
  };
  try {
    const keep = SHOWABLE.has(mime) && Math.max(width, height) <= VIEW_EDGE && bytes.length <= KEEP_BYTES;
    const as = mayBeTransparent(bytes) ? 'png' : 'jpeg';
    const data = keep ? bytes : await draw(VIEW_EDGE, as, 85);
    const thumb = await draw(THUMB_EDGE, 'jpeg', 72);
    return { data, mime: keep ? mime : `image/${as}`, width, height, thumb: `data:image/jpeg;base64,${thumb.toString('base64')}` };
  } catch {
    return { ...asItIs, width, height };
  }
}
```

- [ ] **Step 4: Run** `node test/attachments.test.mjs` — expect PASS for the new section and every old one.
- [ ] **Step 5: Commit** `feat(server): know a picture by its bytes, and make a copy to look at`.

---

### Task 2: Keep a picture a step read (`keepStepShot`) and pass trusted ids through

**Files:**
- Modify: `server/attachments.js` (`saveGenerated` gains `thumb`; `keepStepShot` gains the read-picture path)
- Modify: `server/tools/execute.js` (`runViaWorker` keeps `null`; cloud branch passes a trusted `shot.id`)
- Test: `test/attachments.test.mjs`

**Interfaces:**
- Consumes: `viewCopy` (Task 1).
- Produces: `keepStepShot(userId, shot: { data, mime?, name? }, { chatId })` → `{ id }` (screenshot) or `{ id, name }` (a picture a step read) or `null`. `MAX_SEEN_BYTES` exported. `shot: null` from the worker branch means "there was a picture and it could not be kept".

- [ ] **Step 1: Failing test** (in `test/attachments.test.mjs`, after Task 1's section, using `store` and a user from that file — the file's own `alice` is an HTTP jar, so read the id the way the file's other store-level sections do, or create a user with `store.createUser`):

```js
section('a picture a step read is kept with its name and a thumbnail');
{
  const { keepStepShot } = await import('../server/attachments.js');
  const { createCanvas } = await import('@napi-rs/canvas');
  const owner = await store.createUser({ id: 'u-seen', email: 'seen@example.com', name: 'Seen', passwordHash: 'x' });
  const surface = createCanvas(2400, 1200);
  surface.getContext('2d').fillRect(0, 0, 2400, 1200);
  const data = (await surface.encode('png')).toString('base64');
  const kept = await keepStepShot(owner.id, { data, mime: 'image/png', name: 'C:\\figs\\Figure_4.png' }, { chatId: null });
  check('it is kept, named by the file alone', !!kept?.id && kept.name === 'Figure_4.png', JSON.stringify(kept));
  const row = await store.getAttachment(owner.id, kept.id);
  check('  as a step picture, off the Files shelf', row?.origin === 'step' && row.kind === 'image');
  check('  with a thumbnail for the strip', /^data:image\/jpeg;base64,/.test((await store.getAttachmentThumb(owner.id, kept.id)) || ''));
  const shot = await keepStepShot(owner.id, { data: PNG, mime: 'image/png' }, { chatId: null });
  check('a screenshot is still kept the old way, without a name', !!shot?.id && !('name' in shot));
  check('an id offered in place of bytes is not taken on trust', (await keepStepShot(owner.id, { id: 'someone-elses' })) === null);
}
```

- [ ] **Step 2: Run** `node test/attachments.test.mjs` — FAIL (no `name`, no thumb).

- [ ] **Step 3: Implement** in `server/attachments.js`:
  - `import { viewCopy } from './util/picture.js';`
  - `saveGenerated(userId, { name, mime, kind, data, source, chatId, origin = 'generated', thumb = null })` and pass `thumb: cleanThumb(thumb)` to `createAttachment`.
  - In `keepStepShot`, before the 80KB check:

```js
  // A picture a step read — a figure, a photo — is the thing being looked at,
  // not an illustration of a screen: its own limit, its name, a thumbnail.
  const name = typeof shot?.name === 'string' ? fileLabel(shot.name) : '';
  if (name) return keepSeenPicture(userId, data, name, chatId);
```

  and after `keepStepShot`:

```js
/** What a picture a step read may weigh, kept — a 1600px chart is a few hundred KB. */
export const MAX_SEEN_BYTES = 2560 * 1024;

/** The last part of a path, as the name the transcript shows. */
const fileLabel = (raw) =>
  String(raw)
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 200);

async function keepSeenPicture(userId, data, name, chatId) {
  try {
    const copy = await viewCopy(Buffer.from(data, 'base64'));
    if (!copy || copy.data.length > MAX_SEEN_BYTES) return null;
    const row = await saveGenerated(userId, {
      name,
      mime: copy.mime,
      kind: 'image',
      data: copy.data.toString('base64'),
      source: null,
      chatId,
      origin: 'step',
      thumb: copy.thumb,
    });
    return { id: row.id, name };
  } catch {
    return null;
  }
}
```

  - In `server/tools/execute.js` `runViaWorker`, both returns: `shot: result.shot === null ? null : result.shot || undefined` (and the same for `late.result`).
  - In the cloud branch of `runTool`:

```js
          // A picture the tool already holds (look_at on a file of this
          // account) is referenced, not copied. Only cloud tools — this
          // server's own code — may hand over an id; a worker's is bytes.
          shot: result.shot?.id
            ? { id: String(result.shot.id), ...(result.shot.name ? { name: String(result.shot.name) } : {}) }
            : result.shot
              ? await keepStepShot(userId, result.shot, { chatId })
              : undefined,
```

- [ ] **Step 4: Run** `node test/attachments.test.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(server): keep a picture a step read, named, with a thumbnail`.

---

### Task 3: `read_file` on a picture (worker)

**Files:**
- Modify: `worker/tools.js` (`readFile`, new `readPicture`)
- Modify: `server/tools/definitions.js` (`read_file` description)
- Test: `test/workspace.test.mjs`

**Interfaces:**
- Consumes: `sniffPicture`, `viewCopy`, `PICTURE_EXTENSIONS` (Task 1).
- Produces: `read_file` on a picture returns `{ text, shot: { data: base64, mime, name } }`; `text` is `"<rel path> is a picture (PNG, 1600×800, 240 KB)."`.

- [ ] **Step 1: Failing test** in `test/workspace.test.mjs` (after the workspace is set, before the summary):

```js
section('read_file on a picture hands over the picture, not its bytes as text');
{
  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');
  const { createCanvas } = await import('@napi-rs/canvas');
  const surface = createCanvas(2000, 1000);
  surface.getContext('2d').fillRect(0, 0, 2000, 1000);
  fs.writeFileSync(path.join(process.env.WORKSPACE, 'Figure_4.png'), await surface.encode('png'));
  const out = await LOCAL_IMPLEMENTATIONS.read_file({ path: 'Figure_4.png' });
  check('it answers with a picture', typeof out === 'object' && !!out.shot?.data && out.shot.name === 'Figure_4.png', typeof out);
  check('  shrunk to 1600px before it travels', /1600|2000×1000/.test(out.text) && out.shot.data.length < 4 * 1024 * 1024, out.text);
  check('  and a sentence that says what it is', /is a picture \(PNG, 2000×1000/.test(out.text), out.text);
  const text = await LOCAL_IMPLEMENTATIONS.read_file({ path: 'readme.md' });
  check('a text file still reads as numbered lines', typeof text === 'string' && /Xin chào/.test(text));
  const fake = await LOCAL_IMPLEMENTATIONS.read_file({ path: 'photo.bin' });
  check('a file that is not a picture is read as before', typeof fake === 'string');
}
```

- [ ] **Step 2: Run** `node test/workspace.test.mjs` — FAIL (string returned).

- [ ] **Step 3: Implement** in `worker/tools.js`:

```js
import { sniffPicture, viewCopy, PICTURE_EXTENSIONS } from '../server/util/picture.js';

/** Past this a picture is not opened at all — the same ceiling as edit_image. */
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;
/**
 * What a picture may weigh going up as it is, when this machine cannot shrink
 * it: its base64 stays under a serverless function's 4.5MB request limit.
 */
const MAX_PICTURE_POST = 2560 * 1024;

const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * A picture, as a picture (owner, 2026-10-19).
 *
 * `read_file` used to read a PNG as UTF-8 and hand the model a page of
 * replacement characters. Now it hands over the picture: the server keeps it,
 * shows it in the run, and has a model that can see read it in the same step.
 *
 * @returns {Promise<{ text: string, shot: { data: string, mime: string, name: string } } | null>}
 *   null when the bytes are not a picture after all.
 */
async function readPicture(abs, stat) {
  const bytes = await fsp.readFile(abs);
  const format = sniffPicture(bytes);
  if (!format) return null;
  const copy = await viewCopy(bytes);
  if (!copy) return null;
  if (copy.data.length > MAX_PICTURE_POST) {
    throw new Error(`${rel(abs)} is a picture of ${sizeOf(stat.size)} that could not be made smaller on this computer. Make a smaller copy with edit_image and read that.`);
  }
  const size = copy.width ? `${copy.width}×${copy.height}, ` : '';
  return {
    text: `${rel(abs)} is a picture (${format.split('/')[1].toUpperCase()}, ${size}${sizeOf(stat.size)}).`,
    shot: { data: copy.data.toString('base64'), mime: copy.mime, name: path.basename(abs) },
  };
}
```

  and in `readFile`, right after the directory check:

```js
  if (PICTURE_EXTENSIONS.test(abs) && stat.size <= MAX_PICTURE_BYTES) {
    const picture = await readPicture(abs, stat);
    if (picture) return picture;
  }
```

  - `server/tools/definitions.js` `read_file.description`: `'Read a text file from the workspace (numbered lines), or look at a picture in it — png, jpg, webp, gif, bmp.'`

- [ ] **Step 4: Run** `node test/workspace.test.mjs` — PASS.
- [ ] **Step 5: Commit** `feat(worker): read_file looks at a picture instead of reading its bytes as text`.

---

### Task 4: The server reads the picture `read_file` found (`readPicture` in execute.js)

**Files:**
- Modify: `server/tools/execute.js`
- Modify: `server/i18n/vi.js` (new sentences, as `test/server-i18n.test.mjs` asks)
- Test: `test/agent.test.mjs`

**Interfaces:**
- Consumes: `shot` from Tasks 2–3; `see` (`server/vision.js`), `groundedImage` (`server/imageGround.js`).
- Produces: `export async function readPicture(result, { userId, chatId, signal }, lookWith = see)` → `ToolResult`; called from `executeTool` for `read_file` when `result.shot !== undefined`.

- [ ] **Step 1: Failing test** in `test/agent.test.mjs` next to the `look_at` section:

```js
section('a picture read_file found is read in the same step');
{
  const { readPicture } = await import('../server/tools/execute.js');
  const { keepStepShot } = await import('../server/attachments.js');
  const kept = await keepStepShot(user.id, { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mime: 'image/png', name: 'Figure_4.png' }, { chatId: null });
  const found = { isError: false, content: 'Figure_4.png is a picture (PNG, 1×1, 1 KB).', shot: kept };
  const asked = [];
  const read = await readPicture(found, { userId: user.id }, async (input) => {
    asked.push(input);
    return { text: 'A PRISMA flow diagram: 1969 records identified.', model: 'Test Eyes' };
  });
  check('the model reads what is in it', !read.isError && /PRISMA flow diagram/.test(read.content) && /is a picture/.test(read.content), read.content);
  check('  from the picture that was kept', asked[0]?.images?.[0]?.name === 'Figure_4.png' && !!asked[0].images[0].data);
  check('  and is told which file it is on screen as', new RegExp(kept.id).test(read.note || ''), read.note);
  check('  the picture still goes to the screen', read.shot?.id === kept.id);
  const blind = await readPicture(found, { userId: user.id }, async () => {
    throw new Error('no model that can see answered');
  });
  check('nothing could read it: an error that says so, picture still shown', blind.isError && /could not be read/.test(blind.content) && blind.shot?.id === kept.id, blind.content);
  const lost = await readPicture({ ...found, shot: null }, { userId: user.id });
  check('a picture that could not be kept: an error that says what to do', lost.isError && /edit_image/.test(lost.content), lost.content);
}
```

- [ ] **Step 2: Run** `node test/agent.test.mjs` — FAIL (`readPicture` not exported).

- [ ] **Step 3: Implement** in `server/tools/execute.js`:

```js
import { see } from '../vision.js';
import { groundedImage } from '../imageGround.js';

/**
 * A picture `read_file` found, read the way `look_at` reads one (owner,
 * 2026-10-19).
 *
 * The worker hands over the picture rather than its bytes as text; here a model
 * that can see reads it, so one "Read Figure_4.png" step is the assistant
 * having looked — the way Claude's Read works. When nothing can read it the
 * step says so and is an error, so the model does not describe a picture it
 * never saw; the picture still goes to the screen.
 *
 * @param {ToolResult} result
 * @param {{ userId: string, chatId?: string|null, signal?: AbortSignal }} context
 * @param {typeof see} [lookWith]  the suite's eyes, in place of a real model
 * @returns {Promise<ToolResult>}
 */
export async function readPicture(result, { userId, chatId = null, signal } = {}, lookWith = see) {
  if (!result.shot?.id) {
    return {
      ...result,
      isError: true,
      content: `${result.content}\n\nIt could not be kept to look at, so it was not read. Make a smaller copy with edit_image and read that.`,
    };
  }
  const { id } = result.shot;
  try {
    const row = await getStore().getAttachment(userId, id);
    if (!row) throw new Error('the copy to look at was not stored');
    const picture = await groundedImage(row);
    const { text, model } = await lookWith({ userId, chatId, images: [{ mime: picture.mime, data: picture.data, name: row.name }], signal });
    return {
      ...result,
      content: `${result.content}\n\n${text}`,
      note: `[Read by ${model}. It is on screen for the user as file ${id} — look_at with that file_id and a question looks again.]`,
    };
  } catch (err) {
    return {
      ...result,
      isError: true,
      content: `${result.content}\n\nIt could not be read: ${safeError(err)}. It is on screen for the user as file ${id}.`,
    };
  }
}
```

  In `executeTool`, right after `let result = await runTool(args);`:

```js
  // `read_file` found a picture: a model that can see reads it now (see readPicture).
  if (args.name === 'read_file' && !args.raw && !result?.isError && result?.shot !== undefined) {
    result = await readPicture(result, { userId: args.user.id, chatId: args.chatId ?? null, signal: args.signal });
  }
```

  In `withShotNote`, skip pictures a step read (they carry a name and say their own note):
  `if (!id || args?.raw || result?.isError || result?.shot?.name) return result;`

- [ ] **Step 4: Run** `node test/agent.test.mjs` then `node test/server-i18n.test.mjs`; add each missing sentence the second one names to `server/i18n/vi.js` (with `{0}` holes as it prints them), re-run both — PASS.
- [ ] **Step 5: Commit** `feat(server): a picture read_file found is read by a model that can see, in the same step`.

---

### Task 5: `look_at` reads a cloud path, and every picture it reads comes back as `shot`

**Files:**
- Modify: `server/sandbox.js` (new `readMachineFile`)
- Modify: `server/tools/cloud.js` (`lookAtTool`)
- Modify: `server/tools/definitions.js` (`look_at` `path` + one clause)
- Modify: `server/i18n/vi.js`
- Test: `test/agent.test.mjs`, `test/features.test.mjs`

**Interfaces:**
- Consumes: `sniffPicture` (Task 1), the cloud-branch id pass-through (Task 2).
- Produces: `readMachineFile(userId, path, { signal }) → Promise<Buffer|null>`; `lookAtTool(input, ctx)` returns `string | { content, shot }`; `ctx.see` and `ctx.readCloudFile` override the real ones (suite only).

- [ ] **Step 1: Failing tests**. In `test/agent.test.mjs`:

```js
section('look_at reads a figure on the cloud computer, and the picture comes back to show');
{
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const eyes = async () => ({ text: 'A bar chart.', model: 'Test Eyes' });
  const fromCloud = await CLOUD_IMPLEMENTATIONS.look_at(
    { path: 'out/Figure_4.png' },
    { userId: user.id, chatId: null, see: eyes, readCloudFile: async (_u, p) => (p === 'out/Figure_4.png' ? png : null) },
  );
  check('it reads the file where it was made', typeof fromCloud === 'object' && /A bar chart/.test(fromCloud.content), JSON.stringify(fromCloud).slice(0, 120));
  check('  and hands the picture back to show, named', fromCloud.shot?.name === 'Figure_4.png' && !!fromCloud.shot.data);
  let missing = '';
  try {
    await CLOUD_IMPLEMENTATIONS.look_at({ path: 'nope.png' }, { userId: user.id, see: eyes, readCloudFile: async () => null });
  } catch (err) {
    missing = String(err.message);
  }
  check('a path that is not there says so, and where else to look', /not on the cloud computer/.test(missing) && /read_file/.test(missing), missing);
  await store.createAttachment(user.id, { id: 'att-fig', name: 'Figure_9.png', mime: 'image/png', kind: 'image', bytes: png.length, data: png.toString('base64') });
  const byId = await CLOUD_IMPLEMENTATIONS.look_at({ file_id: 'att-fig' }, { userId: user.id, see: eyes });
  check('a picture already on the account is pointed at, not copied', byId.shot?.id === 'att-fig' && byId.shot.name === 'Figure_9.png', JSON.stringify(byId.shot));
}
```

  In `test/features.test.mjs`, after the existing `look_at` risk checks:

```js
  check('reading a picture on its own cloud computer only reads', assessRisk('look_at', { path: 'out/Figure_4.png' }) === 'safe');
```

- [ ] **Step 2: Run** `node test/agent.test.mjs` — FAIL.

- [ ] **Step 3: Implement.** `server/sandbox.js`:

```js
/**
 * A file's bytes from this account's cloud computer, or null when it is not
 * there (2026-10-19) — for `look_at`, which reads a figure where it was made
 * instead of having it handed over as a file card first.
 */
export async function readMachineFile(userId, path, { signal } = {}) {
  if (!sandboxConfigured()) {
    throw new Error("This account has no cloud computer, so there is nothing at that path. For a file on the user's own computer, use read_file.");
  }
  await chargeCloud(String(userId));
  const machine = await machineForUser(String(userId), { signal });
  return (await machine.readFileToBuffer({ path: workPath(path) }, { signal })) || null;
}
```

  `server/tools/cloud.js` — imports `readMachineFile, workPath` from `../sandbox.js` and `sniffPicture` from `../util/picture.js`; `lookAtTool` becomes:

```js
async function lookAtTool({ file_id: fileId, url, path, pages, question }, { userId, chatId, signal, see: lookWith = see, readCloudFile = readMachineFile }) {
```

  - `file_id` branch: after `item` is built, `if (row.kind === 'image') shot = { id: row.id, name: row.name };`
  - new branch before `url`:

```js
  } else if (path) {
    const where = workPath(path);
    const bytes = await readCloudFile(String(userId), where, { signal });
    if (!bytes) throw new Error(`${where} is not on the cloud computer — check the path with ls. For a file on the user's own computer, use read_file.`);
    const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    const type = isPdf ? 'application/pdf' : sniffPicture(bytes);
    if (!type) throw new Error(`${where} is not an image or a PDF — read it with sandbox_run instead.`);
    const cap = isPdf ? LOOK_MAX_PDF_BYTES : LOOK_MAX_BYTES;
    if (bytes.length > cap) throw new Error(`${where} is over ${Math.round(cap / 1024 / 1024)}MB, too large to look at whole.`);
    const name = where.split('/').pop() || where;
    const data = bytes.toString('base64');
    source = where;
    if (isPdf) {
      item = { pdf: { data, name, pages: wantPages } };
    } else {
      const picture = await groundedImage({ mime: type, data });
      item = { images: [{ mime: picture.mime, data: picture.data, name }] };
      shot = { data, mime: type, name };
    }
  } else if (url) {
```

  - `url` branch, image case: `shot = { data, mime: type, name: safeDecode(parsed.pathname.split('/').pop() || '') || parsed.host };`
  - the no-argument branch passes `see: lookWith` through its recursive call's context.
  - end: `const { text, model } = await lookWith({ userId, chatId, ...item, question: ask, signal }); const content = untrusted(`${source} (read by ${model})`, text); return shot ? { content, shot } : content;`
  - `let shot = null;` declared beside `source`/`item`.

  `server/tools/definitions.js` `look_at`: description clause `…, an image or PDF on the web by url, or one on your cloud computer by path.` and property `path: { type: 'string', description: 'A picture or PDF on your cloud computer (where sandbox_run works), e.g. out/Figure_4.png.' }`. Check `assessRisk` treats `path` as safe (it grades `look_at` by its URL argument only — confirm, adjust if not).

- [ ] **Step 4: Run** `node test/agent.test.mjs`, `node test/features.test.mjs`, `node test/server-i18n.test.mjs` (add the sentences it names), `node test/toolbudget.test.mjs`, `npm run eval` — PASS.
- [ ] **Step 5: Commit** `feat(server): look_at reads a figure on the cloud computer, and the picture it read comes back to show`.

---

### Task 6: `public/js/gallery.js` — the hover preview and the lightbox

**Files:**
- Create: `public/js/gallery.js`
- Modify: `public/js/locales/en.js`, `public/js/locales/vi.js`
- Modify: `public/css/app.css` (gallery styles)
- Test: `test/ui.test.mjs` (Task 7 drives it through a real run card)

**Interfaces:**
- Produces:
  - `registerPictures(card: Element, list: () => Picture[])` where `Picture = { id: string, name?: string, path?: string, label?: string }`.
  - `pictureThumb(picture: Picture, index: number, className?: string): HTMLButtonElement` — a `button[data-pic]` holding an `<img>` of the thumbnail (falls back to the full picture, then hides).
  - `pictureUrl(id): string`, `thumbUrl(id): string`.
  - `openGallery(items: Picture[], index: number, returnTo?: HTMLElement|null)`.
  - Delegated listeners installed lazily on first `registerPictures`: click on `[data-pic]` inside a registered card opens the lightbox (and `preventDefault` so a `<summary>` does not toggle); hover shows the preview.
- i18n keys: `gallery.count` (`{n} of {total}` / `{n} / {total}`), `gallery.prev`, `gallery.next`, `gallery.close`, `gallery.dialog`, `gallery.open` (`Open {name}` / `Mở {name}`), `gallery.more` (`{n} more pictures` / `Thêm {n} ảnh`).

- [ ] **Step 1: Implement `gallery.js`** — full module:

```js
import { t } from './i18n.js';

/**
 * The pictures a run looked at: a preview under the pointer and a lightbox to
 * page through them (owner, 2026-10-19, after Claude's).
 *
 * A card's pictures are looked up when a thumbnail is used, through the card
 * node, rather than copied into data attributes: a run that read 37 figures
 * would otherwise carry its list on every one of 37 thumbnails, and the list
 * grows while the run works.
 *
 * Nothing here touches `document` until a card registers — `render.js` is also
 * imported by the Node suites, which have no DOM.
 */

/** @typedef {{ id: string, name?: string, path?: string, label?: string }} Picture */

/** @type {WeakMap<Element, () => Picture[]>} */
const SOURCES = new WeakMap();
let installed = false;

export const pictureUrl = (id) => `/api/attachments/${encodeURIComponent(id)}`;
export const thumbUrl = (id) => `${pictureUrl(id)}/thumb`;

/** @param {Element} card @param {() => Picture[]} list */
export function registerPictures(card, list) {
  SOURCES.set(card, list);
  install();
}

/** The pictures of the card a thumbnail belongs to, and which one it is. */
function locate(thumb) {
  for (let node = thumb.parentElement; node; node = node.parentElement) {
    const list = SOURCES.get(node);
    if (list) return { items: list(), index: Number(thumb.dataset.pic) || 0 };
  }
  return null;
}

/**
 * One picture's thumbnail, as a button.
 *
 * The stored thumbnail first; a picture kept without one (a browser step's
 * screenshot) falls back to itself, and one that is gone hides its button
 * rather than drawing a broken image in the strip.
 */
export function pictureThumb(picture, index, className = 'pic-thumb') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.pic = String(index);
  button.setAttribute('aria-label', t('gallery.open', { name: picture.name || picture.label || '' }));
  if (picture.path || picture.name) button.title = picture.path || picture.name;
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (!img.dataset.full) {
      img.dataset.full = '1';
      img.src = pictureUrl(picture.id);
    } else {
      button.hidden = true;
    }
  });
  img.src = thumbUrl(picture.id);
  button.append(img);
  return button;
}

/* ── the lightbox ───────────────────────────────────────────────────── */

/** @type {null | { root: HTMLElement, frame: HTMLElement, img: HTMLImageElement, label: HTMLElement, count: HTMLElement, prev: HTMLButtonElement, next: HTMLButtonElement, close: HTMLButtonElement, items: Picture[], index: number, returnTo: HTMLElement|null }} */
let box = null;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function build() {
  const root = document.createElement('div');
  root.className = 'gallery';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('gallery.dialog'));
  root.innerHTML = `
    <button type="button" class="gallery__close"></button>
    <div class="gallery__stage"><figure class="gallery__frame"><img class="gallery__img" alt=""></figure></div>
    <div class="gallery__bar">
      <span class="gallery__label"></span>
      <div class="gallery__nav">
        <button type="button" class="gallery__prev"><span aria-hidden="true">‹</span></button>
        <span class="gallery__count" aria-live="polite"></span>
        <button type="button" class="gallery__next"><span aria-hidden="true">›</span></button>
      </div>
    </div>`;
  const q = (s) => /** @type {any} */ (root.querySelector(s));
  const parts = {
    root,
    frame: q('.gallery__frame'),
    img: q('.gallery__img'),
    label: q('.gallery__label'),
    count: q('.gallery__count'),
    prev: q('.gallery__prev'),
    next: q('.gallery__next'),
    close: q('.gallery__close'),
  };
  parts.close.setAttribute('aria-label', t('gallery.close'));
  parts.close.innerHTML = '<span aria-hidden="true">✕</span>';
  parts.prev.setAttribute('aria-label', t('gallery.prev'));
  parts.next.setAttribute('aria-label', t('gallery.next'));
  parts.close.addEventListener('click', closeGallery);
  parts.prev.addEventListener('click', () => show(box.index - 1, -1));
  parts.next.addEventListener('click', () => show(box.index + 1, 1));
  // The dark around the picture closes it; the picture itself does not.
  root.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === root || target.classList.contains('gallery__stage')) closeGallery();
  });
  root.addEventListener('keydown', onKey);
  // A swipe pages on a phone.
  let startX = null;
  q('.gallery__stage').addEventListener('pointerdown', (event) => {
    startX = event.clientX;
  });
  q('.gallery__stage').addEventListener('pointerup', (event) => {
    if (startX == null) return;
    const dx = event.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) show(box.index + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  });
  return parts;
}

function onKey(event) {
  if (!box) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeGallery();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    show(box.index + 1, 1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    show(box.index - 1, -1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    show(0, -1);
  } else if (event.key === 'End') {
    event.preventDefault();
    show(box.items.length - 1, 1);
  } else if (event.key === 'Tab') {
    // Focus stays in the dialog: close, previous, next, round again.
    const stops = [box.close, box.prev, box.next].filter((b) => !b.disabled);
    const at = stops.indexOf(/** @type {any} */ (document.activeElement));
    event.preventDefault();
    stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
  }
}

/** Show picture `index`, sliding in from the side it came from. */
function show(index, direction = 0) {
  if (!box) return;
  const next = Math.max(0, Math.min(box.items.length - 1, index));
  if (next === box.index && direction !== 0 && box.img.getAttribute('src')) return;
  box.index = next;
  const picture = box.items[next];
  box.img.src = pictureUrl(picture.id);
  box.img.alt = picture.name || picture.label || '';
  box.label.textContent = picture.label || '';
  box.count.textContent = t('gallery.count', { n: next + 1, total: box.items.length });
  box.prev.disabled = next === 0;
  box.next.disabled = next === box.items.length - 1;
  box.frame.classList.remove('is-from-left', 'is-from-right');
  if (direction && !still()) {
    void box.frame.offsetWidth; // restart the animation
    box.frame.classList.add(direction > 0 ? 'is-from-right' : 'is-from-left');
  }
  // The neighbours, so paging does not wait on the network.
  for (const at of [next - 1, next + 1]) {
    if (box.items[at]) new Image().src = pictureUrl(box.items[at].id);
  }
}

/**
 * @param {Picture[]} items
 * @param {number} index
 * @param {HTMLElement|null} [returnTo]  focused again when the lightbox closes
 */
export function openGallery(items, index = 0, returnTo = null) {
  if (!items?.length) return;
  hidePreview();
  if (!box) box = { ...build(), items, index: -1, returnTo };
  box.items = items;
  box.returnTo = returnTo;
  box.index = -1;
  document.body.append(box.root);
  document.documentElement.classList.add('gallery-open');
  show(index, 0);
  (box.next.disabled ? box.close : box.next).focus();
}

export function closeGallery() {
  if (!box?.root.isConnected) return;
  box.root.remove();
  document.documentElement.classList.remove('gallery-open');
  box.returnTo?.focus?.();
}

/** For the interface suite. */
export const __testing = { isOpen: () => !!box?.root.isConnected };

/* ── the preview under the pointer ──────────────────────────────────── */

/** @type {HTMLElement|null} */
let tip = null;
let tipTimer = 0;
const hoverable = () => matchMedia('(hover: hover)').matches;

function showPreview(thumb) {
  const found = locate(thumb);
  if (!found || !thumb.isConnected) return;
  const picture = found.items[found.index];
  if (!picture) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'pic-preview';
    tip.setAttribute('role', 'tooltip');
    tip.innerHTML = '<img class="pic-preview__img" alt=""><div class="pic-preview__foot"><span class="pic-preview__label"></span><span class="pic-preview__count"></span></div>';
  }
  /** @type {HTMLImageElement} */ (tip.querySelector('.pic-preview__img')).src = pictureUrl(picture.id);
  tip.querySelector('.pic-preview__label').textContent = picture.label || '';
  tip.querySelector('.pic-preview__count').textContent = t('gallery.count', { n: found.index + 1, total: found.items.length });
  document.body.append(tip);
  // Above the thumbnail, or below it when there is no room; inside the window.
  const rect = thumb.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const above = rect.top - height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - height - 8, rect.bottom + 8)}px`;
}

export function hidePreview() {
  clearTimeout(tipTimer);
  tip?.remove();
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (event) => {
    const thumb = /** @type {HTMLElement} */ (event.target).closest?.('[data-pic]');
    if (!thumb) return;
    const found = locate(thumb);
    if (!found) return;
    // A thumbnail in a card's header is not a click on the header.
    event.preventDefault();
    event.stopPropagation();
    openGallery(found.items, found.index, /** @type {HTMLElement} */ (thumb));
  });
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse' || !hoverable()) return;
    const thumb = /** @type {HTMLElement} */ (event.target).closest?.('[data-pic]');
    if (!thumb) return;
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => showPreview(thumb), 300);
  });
  document.addEventListener('pointerout', (event) => {
    const thumb = /** @type {HTMLElement} */ (event.target).closest?.('[data-pic]');
    if (!thumb || thumb.contains(/** @type {Node} */ (event.relatedTarget))) return;
    hidePreview();
  });
  document.addEventListener('scroll', hidePreview, { capture: true, passive: true });
  document.addEventListener('pointerdown', hidePreview, { capture: true });
}
```

  Note: `event.stopPropagation()` in a document-level bubbling listener runs after `#messages`' own listener; that listener only acts on `[data-file]`, which thumbnails do not carry, so the order is harmless. `render.js`'s summary click handler must ignore clicks inside `[data-pic]` (Task 7).

- [ ] **Step 2: i18n** — add to `en.js` (near `work.*`): `'gallery.count': '{n} of {total}', 'gallery.prev': 'Previous picture', 'gallery.next': 'Next picture', 'gallery.close': 'Close', 'gallery.dialog': 'Pictures', 'gallery.open': 'Open {name}', 'gallery.more': '{n} more pictures'`; `vi.js`: `'gallery.count': '{n} / {total}', 'gallery.prev': 'Ảnh trước', 'gallery.next': 'Ảnh sau', 'gallery.close': 'Đóng', 'gallery.dialog': 'Ảnh', 'gallery.open': 'Mở {name}', 'gallery.more': 'Thêm {n} ảnh'`.

- [ ] **Step 3: CSS** — append to `public/css/app.css` after the run-of-steps block:

```css
/* ── pictures a run looked at: the preview and the lightbox (2026-10-19) ── */
.gallery-open { overflow: hidden; }
.gallery {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: grid;
  grid-template-rows: 1fr auto;
  background: rgb(0 0 0 / 0.86);
}
.gallery__stage { display: grid; place-items: center; min-height: 0; padding: 56px 24px 8px; overflow: hidden; touch-action: pan-y; }
.gallery__frame { margin: 0; max-width: 100%; max-height: 100%; display: grid; }
.gallery__img {
  max-width: min(92vw, 1600px);
  max-height: calc(100vh - 140px);
  border-radius: 12px;
  background: #fff;
  object-fit: contain;
}
.gallery__frame.is-from-right { animation: gallery-in-right 0.24s ease-out; }
.gallery__frame.is-from-left { animation: gallery-in-left 0.24s ease-out; }
@keyframes gallery-in-right { from { opacity: 0.2; transform: translateX(48px); } }
@keyframes gallery-in-left { from { opacity: 0.2; transform: translateX(-48px); } }
.gallery__bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 12px 24px 22px; color: #e8e8e8; }
.gallery__label { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gallery__nav { display: flex; align-items: center; gap: 18px; font-size: 16px; font-variant-numeric: tabular-nums; }
.gallery__nav button,
.gallery__close {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #f2f2f2;
  font-size: 26px;
  cursor: pointer;
}
.gallery__nav button:hover:not(:disabled),
.gallery__close:hover { background: rgb(255 255 255 / 0.12); }
.gallery__nav button:disabled { opacity: 0.3; cursor: default; }
.gallery__nav button:focus-visible,
.gallery__close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gallery__close { position: absolute; top: 14px; right: 18px; font-size: 20px; }
.pic-preview {
  position: fixed;
  z-index: 390;
  width: min(440px, calc(100vw - 16px));
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel, var(--bg));
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.45);
  pointer-events: none;
}
.pic-preview__img { display: block; width: 100%; height: 280px; object-fit: contain; border-radius: 8px; background: #fff; }
.pic-preview__foot { display: flex; justify-content: space-between; gap: 12px; padding: 8px 4px 2px; color: var(--text-dim); font-size: 13px; }
@media (prefers-reduced-motion: reduce) {
  .gallery__frame.is-from-right,
  .gallery__frame.is-from-left { animation: none; }
}
@media (max-width: 640px) {
  .gallery__stage { padding: 52px 8px 4px; }
  .gallery__bar { padding: 10px 12px 18px; }
}
```

  (Check `--panel` exists in `app.css`'s tokens; use the token the menus use for their surface if it is named differently.)

- [ ] **Step 4: Run** `node test/i18n.test.mjs` and `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(interface): a preview under the pointer and a lightbox for the pictures a run looked at`.

---

### Task 7: The commands card, 1:1 Claude — pictures, summary, crossfade, rows

**Files:**
- Modify: `public/js/render.js`
- Modify: `public/js/locales/en.js`, `vi.js` (`work.readVerb`, `work.failed`, `work.took`)
- Modify: `public/js/clipboard.js` (`CHROME_SELECTOR` gains `.pic-thumb, .steps__thumbs`)
- Modify: `public/css/app.css` (work-family restyle)
- Test: `test/ui.test.mjs` (update the existing commands-card section; add a pictures section)

**Interfaces:**
- Consumes: `registerPictures`, `pictureThumb`, `pictureUrl` (Task 6); `shot: { id, name }` on results (Tasks 2–5).
- Produces: `WORK_KINDS.look_at = 'read'`; `workStep` read rows → `{ verb: t('work.readVerb'), detail: file }`; `export function stripPictures(pictures, shown = 3) → { shown: Picture[], more: number }` (pure, for the suite).

Changes in `render.js`:

1. `import { registerPictures, pictureThumb, pictureUrl } from './gallery.js';`
2. `WORK_KINDS`: add `look_at: 'read'`.
3. `workStep`: in the `ON_A_FILE` branch, for `kind === 'read'` set `verb = t('work.readVerb')` (unless `own`); for `look_at`, `path = input.path || input.url || ''` and `file = baseName(input.path) || urlName(input.url)` where

```js
/** The file a web address names — its last path segment, decoded — or its host. */
const urlName = (raw) => {
  try {
    const u = new URL(String(raw));
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '') || u.host;
  } catch {
    return '';
  }
};
```

4. `workSummary(steps)`: count failures per kind (`step.failed`) and append `' ' + t('work.failed', { n })` to that kind's phrase.
5. `stripPictures`:

```js
/**
 * Which pictures a folded card shows: the newest three, in the order they were
 * read, and how many more there are — Claude's "+33".
 *
 * @template T
 * @param {T[]} pictures
 * @returns {{ shown: T[], more: number }}
 */
export function stripPictures(pictures, shown = 3) {
  const list = pictures.slice(-shown);
  return { shown: list, more: pictures.length - list.length };
}
```

6. `groupFor`: create `const thumbs = el('span', 'steps__thumbs'); thumbs.hidden = true;` appended to the summary after `tally`; store `thumbs` on the group; `registerPictures(node, () => created.steps.filter((s) => s.picture).map((s) => s.picture))`. The summary click handler ignores `event.target.closest('[data-pic]')`.
7. `paintThumbs(run)`:

```js
  /** The strip on a folded card's header: the newest pictures it looked at. */
  function paintThumbs(run) {
    const pictures = run.steps.filter((s) => s.picture).map((s) => s.picture);
    const { shown, more } = stripPictures(pictures);
    run.thumbs.replaceChildren();
    run.thumbs.hidden = pictures.length === 0;
    if (more) {
      const plus = el('span', 'steps__more');
      plus.textContent = `+${more}`;
      plus.setAttribute('aria-label', t('gallery.more', { n: more }));
      run.thumbs.append(plus);
    }
    shown.forEach((picture) => run.thumbs.append(pictureThumb(picture, pictures.indexOf(picture), 'pic-thumb pic-thumb--head')));
  }
```

8. `paintGroupSummary`: title through `setTitle(run, text)` (crossfade + `title` tooltip):

```js
  /**
   * The header's words, and the change between them: the old title fades as
   * the new one comes in, the way Claude's run title passes from "Searching
   * wider for label sources" to "Read 36 files, ran 34 commands". The old words
   * live in a data attribute drawn by CSS, so `textContent` is only ever the
   * title itself.
   */
  function setTitle(run, text) {
    const node = run.title;
    if (node.textContent === text) return;
    const before = node.textContent;
    node.textContent = text;
    node.title = text;
    if (!before || hydrating || run.family !== 'work') return;
    node.dataset.was = before;
    node.classList.remove('is-changing');
    void node.offsetWidth;
    node.classList.add('is-changing');
    clearTimeout(run.fadeTimer);
    run.fadeTimer = setTimeout(() => {
      node.classList.remove('is-changing');
      delete node.dataset.was;
    }, 260);
  }
```

   Work-family tally: failures no longer in `tally` (they are in the summary); `tally` stays empty for work.
9. `startStep`: `entry` gains `picture: null, failed: false`; `item.dataset.kind = said.kind`; the verb node gets `title = verb`; for work rows, `time` is not put in the head — on completion a `p.step__took` with `t('work.took', { time: ms(result.ms) })` is appended to `foldBody` when `result.ms != null`. On completion: `entry.failed = !!result.isError`; for work rows with `result.shot?.id`:

```js
          if (result.shot?.id) {
            const name = result.shot.name || entry.file || '';
            if (!entry.file && name) {
              entry.file = name;
              const what = label.querySelector('.step__detail') || label.appendChild(el('span', 'step__detail'));
              what.textContent = name;
            }
            entry.picture = { id: result.shot.id, name, path: entry.path || name, label: entry.verb };
            const index = run.steps.filter((s) => s.picture).length - 1;
            head.insertBefore(pictureThumb(entry.picture, index, 'pic-thumb pic-thumb--row'), time.parentElement === head ? time : null);
            foldBody.prepend(pictureBody(entry.picture, index));
            paintThumbs(run);
            paintGroupSummary(run);
          }
```

   with

```js
  /** An opened image row: the path it read, then the picture — Claude's `file_path:` and the image. */
  function pictureBody(picture, index) {
    const node = el('div', 'step__picture');
    const where = el('p', 'step__where');
    const key = el('code', 'step__key');
    key.textContent = 'file_path:';
    const open = el('button', 'step__path');
    open.type = 'button';
    open.dataset.pic = String(index);
    open.textContent = picture.path || picture.name;
    where.append(key, ' ', open);
    const shown = el('button', 'step__image');
    shown.type = 'button';
    shown.dataset.pic = String(index);
    shown.setAttribute('aria-label', t('gallery.open', { name: picture.name }));
    const img = el('img');
    img.alt = picture.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = pictureUrl(picture.id);
    shown.append(img);
    node.append(where, shown);
    return node;
  }
```

   (`head` is the row's `summary.step__head`; hoist it out of the `if (work)` block so `complete` can reach it.)
   Browser rows: `result.shot?.id` → `entry.picture = { id, name: '', path: '', label: detail ? `${verb} — ${detail}` : verb }`, the `step__shot` becomes `pictureThumb(entry.picture, index, 'step__shot pic-thumb')` with its `<img>` `width` style kept by CSS (no `data-file`), then `paintThumbs(run)`.
10. Remove the `.step__shot` `data-file` use; `clipboard.js` `CHROME_SELECTOR`: `'button, .copy-btn, .msg__actions, .step__shot, .steps__thumbs, .step__picture'`.

i18n: en `'work.readVerb': 'Read', 'work.failed': '({n} failed)', 'work.took': 'Took {time}'`; vi `'work.readVerb': 'Đọc', 'work.failed': '({n} lỗi)', 'work.took': 'Mất {time}'`.

CSS (append after the run-of-steps block; scoped to `[data-family="work"]` so browser cards keep their look):

```css
/* ── the commands card, after Claude's (owner, 2026-10-19) ─────────────────
 * Folded, one grey line and the pictures it looked at; open, a box of rows
 * with hairlines between them. No border, no tick: the words say what was
 * done, a failure says so in them, and a spinner says it is still going. */
details.block.steps[data-family='work'] {
  border: 0;
  border-radius: 0;
  box-shadow: none;
  overflow: visible;
}
details.block.steps[data-family='work']:has(> summary .mark--pending) { box-shadow: none; }
details.block.steps[data-family='work'] > summary {
  min-height: 34px;
  padding: 4px 0;
  gap: 8px;
  border-bottom: 0;
  border-radius: 8px;
  color: var(--text-dim);
}
details.block.steps[data-family='work'] > summary:hover { background: none; color: var(--text); }
details.block.steps[data-family='work'] > summary > .mark:not(.mark--pending) { display: none; }
details.block.steps[data-family='work'] > summary::after { order: 5; margin-left: 0; }
details.block.steps[data-family='work'] .steps__title {
  position: relative;
  color: inherit;
  font-weight: 400;
  font-size: 14.5px;
}
details.block.steps[data-family='work'] .steps__title.is-changing { animation: steps-title-in 0.24s ease-out; }
details.block.steps[data-family='work'] .steps__title[data-was]::after {
  content: attr(data-was);
  position: absolute;
  inset: 0;
  animation: steps-title-out 0.24s ease-out forwards;
}
@keyframes steps-title-in { from { opacity: 0; transform: translateY(3px); } }
@keyframes steps-title-out { to { opacity: 0; transform: translateY(-3px); } }
details.block.steps[data-family='work'] .steps__detail { order: 2; }
details.block.steps[data-family='work'] .steps__clock { order: 3; }
details.block.steps.steps--error[data-family='work'] .steps__title { color: var(--danger); }
.steps__thumbs {
  order: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-left: 12px;
  flex: none;
}
.steps__thumbs[hidden] { display: none; }
details.block.steps[open] > summary > .steps__thumbs { display: none; }
.steps__more { color: var(--text-dim); font-size: 13px; font-variant-numeric: tabular-nums; margin-right: 4px; }
.pic-thumb {
  display: block;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  overflow: hidden;
  cursor: zoom-in;
  line-height: 0;
}
.pic-thumb img { display: block; height: 100%; width: auto; max-width: 100%; object-fit: cover; }
.pic-thumb--head { height: 36px; max-width: 64px; }
.pic-thumb--row { height: 32px; max-width: 56px; margin-left: auto; }
.pic-thumb:hover { border-color: var(--accent); }
.pic-thumb:focus-visible,
.step__path:focus-visible,
.step__image:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Open: the rows in a box, a hairline between each. */
details.block.steps[data-family='work'] > .steps__list {
  gap: 0;
  margin: 4px 0 8px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
}
details.block.steps[data-family='work'] > .steps__list > .step + .step { border-top: 1px solid var(--line-soft); }
details.block.steps[data-family='work'] .step__fold > summary {
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-height: 44px;
  padding: 6px 14px;
  border-radius: 0;
}
details.block.steps[data-family='work'] .step__fold > summary::after { display: none; }
details.block.steps[data-family='work'] .step__label::after {
  content: '›';
  flex: none;
  color: var(--text-faint);
  transition: transform 0.18s;
}
details.block.steps[data-family='work'] .step__fold[open] .step__label::after { transform: rotate(90deg); }
details.block.steps[data-family='work'] .step__mark:empty { display: none; }
details.block.steps[data-family='work'] .step__verb { color: var(--text-dim); font-size: 14px; }
details.block.steps[data-family='work'] .step[data-kind='read'] .step__detail,
details.block.steps[data-family='work'] .step[data-kind='write'] .step__detail,
details.block.steps[data-family='work'] .step[data-kind='edit'] .step__detail,
details.block.steps[data-family='work'] .step[data-kind='list'] .step__detail {
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
}
details.block.steps[data-family='work'] .step__body { margin: 0 14px 12px; }
.step__took { margin: 0; color: var(--text-faint); font-size: 12px; }
.step__picture { display: grid; gap: 8px; }
.step__where { margin: 0; display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.step__key { color: var(--text-faint); font-family: var(--mono); font-size: 12.5px; }
.step__path {
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--info);
  font-family: var(--mono);
  font-size: 12.5px;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.step__path:hover { text-decoration: underline; text-underline-offset: 3px; }
.step__image {
  width: max-content;
  max-width: 100%;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
  cursor: zoom-in;
  line-height: 0;
}
.step__image img { display: block; max-width: 100%; max-height: 480px; width: auto; height: auto; }
@media (prefers-reduced-motion: reduce) {
  details.block.steps[data-family='work'] .steps__title.is-changing { animation: none; }
  details.block.steps[data-family='work'] .steps__title[data-was]::after { display: none; }
}
```

(`.step__shot` keeps its old rules for browser rows; `.pic-thumb` must not shrink it: `.step__shot.pic-thumb img { width: 210px; height: auto; }`.)

- [ ] **Step 1: Update the existing UI checks** in `test/ui.test.mjs` "commands and files are one card…": `/^(Read file|Đọc tệp)$/` → `/^(Read|Đọc)$/`; the failure check reads the title: `/(\(1 failed\)|\(1 lỗi\))/.test(out.done.title)` and `out.tally === ''`; `finished, it says what was done` → `/^(Ran 2 commands \(1 failed\), read 2 files|Đã chạy 2 lệnh \(1 lỗi\), đọc 2 tệp)$/`.
- [ ] **Step 2: New UI section** after it:

```js
section('a run that read pictures shows them folded, per row, in a preview and a lightbox');
{
  const out = await page.evaluate(async () => {
    const { assistantMessage, stripPictures } = await import('/js/render.js');
    const gallery = await import('/js/gallery.js');
    const turn = assistantMessage();
    document.body.append(turn.node);
    const out = {};
    for (let i = 1; i <= 5; i += 1) {
      turn.startTool({ id: `p${i}`, name: 'read_file', input: { path: `figs/Figure_${i}.png` } }).complete({ content: `Figure_${i}.png is a picture.`, ms: 30, shot: { id: `pic-${i}`, name: `Figure_${i}.png` } });
    }
    turn.startTool({ id: 'p6', name: 'run_command', input: { command: 'ls figs' } }).complete({ content: 'x', ms: 3 });
    const card = turn.node.querySelector('.steps');
    turn.finish();
    const strip = card.querySelector(':scope > summary .steps__thumbs');
    out.title = card.querySelector('.steps__title').textContent;
    out.folded = !card.open;
    out.stripThumbs = strip ? strip.querySelectorAll('.pic-thumb').length : -1;
    out.more = strip?.querySelector('.steps__more')?.textContent || '';
    out.newest = [...(strip?.querySelectorAll('.pic-thumb') || [])].map((b) => b.dataset.pic).join(',');
    out.stripVisible = !!strip && getComputedStyle(strip).display !== 'none';
    out.noBorder = getComputedStyle(card).borderTopWidth === '0px';
    out.chevronAfterTitle = (() => {
      const s = card.querySelector(':scope > summary');
      const title = s.querySelector('.steps__title').getBoundingClientRect();
      const thumbs = strip.getBoundingClientRect();
      return thumbs.left > title.right + 20;
    })();
    card.open = true;
    out.stripHiddenOpen = getComputedStyle(strip).display === 'none';
    const rows = [...card.querySelectorAll('.step--work')];
    out.rowThumbs = rows.filter((r) => r.querySelector('.pic-thumb--row')).length;
    out.rowVerb = rows[0].querySelector('.step__verb').textContent;
    out.rowFile = rows[0].querySelector('.step__detail').textContent;
    out.rowFileBright = getComputedStyle(rows[0].querySelector('.step__detail')).color !== getComputedStyle(rows[0].querySelector('.step__verb')).color;
    rows[0].querySelector('details').open = true;
    out.filePath = rows[0].querySelector('.step__where')?.textContent || '';
    out.bigImage = !!rows[0].querySelector('.step__image img');
    // The lightbox: opened from the third strip thumbnail, paged with the keys.
    card.open = false;
    strip.querySelectorAll('.pic-thumb')[0].click();
    out.toggledByThumb = card.open;
    const dialog = document.querySelector('.gallery');
    out.dialog = !!dialog && dialog.getAttribute('aria-modal') === 'true';
    out.countAtOpen = dialog?.querySelector('.gallery__count')?.textContent || '';
    out.label = dialog?.querySelector('.gallery__label')?.textContent || '';
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    out.countAfterRight = dialog.querySelector('.gallery__count').textContent;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    out.nextDisabledAtEnd = dialog.querySelector('.gallery__next').disabled;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.closed = !gallery.__testing.isOpen();
    out.focusBack = document.activeElement === strip.querySelectorAll('.pic-thumb')[0];
    out.strip37 = stripPictures(Array.from({ length: 37 }, (_, i) => i));
    turn.node.remove();
    return out;
  });
  check('folded: one line, no border, saying what it read', out.folded && out.noBorder && /^(Read 5 files, ran a command|Đã đọc 5 tệp, chạy 1 lệnh)$/.test(out.title), JSON.stringify({ t: out.title, b: out.noBorder }));
  check('  the newest three pictures on the right, with "+2" before them', out.stripVisible && out.stripThumbs === 3 && out.more === '+2' && out.newest === '2,3,4', JSON.stringify(out));
  check('  and the chevron stays with the words, not with the pictures', out.chevronAfterTitle === true);
  check('open: the strip goes, each picture row has its thumbnail', out.stripHiddenOpen && out.rowThumbs === 5, `${out.stripHiddenOpen} ${out.rowThumbs}`);
  check('  a row reads "Read" and the file, the file brighter', /^(Read|Đọc)$/.test(out.rowVerb) && out.rowFile === 'Figure_1.png' && out.rowFileBright, `${out.rowVerb} ${out.rowFile}`);
  check('  opened, file_path and the picture itself', /file_path:\s*figs\/Figure_1\.png/.test(out.filePath) && out.bigImage, out.filePath);
  check('a thumbnail in the header opens the lightbox, not the card', out.dialog && out.toggledByThumb === false, `${out.dialog} ${out.toggledByThumb}`);
  check('  at the picture it showed, counted against all of them', /^(3 of 5|3 \/ 5)$/.test(out.countAtOpen) && /^(Read|Đọc)$/.test(out.label), `${out.countAtOpen} ${out.label}`);
  check('  → pages on, End goes to the last and its arrow rests', /^(4 of 5|4 \/ 5)$/.test(out.countAfterRight) && out.nextDisabledAtEnd, out.countAfterRight);
  check('  Esc closes it and focus goes back to the thumbnail', out.closed && out.focusBack, `${out.closed} ${out.focusBack}`);
  check('thirty-seven pictures: three shown, "+34"', out.strip37.shown.length === 3 && out.strip37.more === 34);
}
```

- [ ] **Step 3: Implement** the `render.js`, locale, clipboard and CSS changes above.
- [ ] **Step 4: Run** `node test/i18n.test.mjs`, `npm run lint`, `npm run typecheck`, then the UI suite (`npm run test:ui`, ~10 min, background; do not edit `public/` while it runs). Iterate on failures.
- [ ] **Step 5: Commit** `feat(interface): the commands card the way Claude draws it, with the pictures it looked at`.

---

### Task 8: Verify, review, ship

- [ ] Run `npm run gate` (lint, hook tests, eval, typecheck, `npm test`) — green stamp.
- [ ] Run `npm run test:ui` — every check passes (report the count).
- [ ] Screenshot the run card folded/open/lightbox in headless Chrome at 1280 and 390 wide, light and dark, and look at them.
- [ ] Code review of the diff (security: `shot.id` only from cloud code; sizes; a11y).
- [ ] README: one line in the tools section that `read_file` and `look_at` show the pictures they read (only if the README lists tool behaviour).
- [ ] Merge `--no-ff` into `main` with a `merge:` message in the house style, push `origin main`.
- [ ] Update memory: new project memory for this round; MEMORY.md pointer.
