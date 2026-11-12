/**
 * Reading the user's documents so they can be searched by meaning.
 *
 * This half runs on their machine. It walks a folder, pulls text out of whatever
 * it finds, cuts it into passages, and hands those up — nothing else. The files
 * stay where they are; what leaves is the text that was going to be searched
 * anyway, and only from the folder somebody explicitly named.
 *
 * The sink is injected rather than imported for the same reason the screen
 * frames' is: there are two ways this code gets run. In the worker it posts to
 * the server over the paired device's token; inside a locally-run server it is
 * called directly, with no HTTP hop at all. Neither half needs to know which.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace, rel } from './paths.js';

/** How much text goes in one passage, and how much of it the next one repeats. */
const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 200;

/** Sent per call. Small enough that one embedding request stays well inside its limits. */
const BATCH_CHUNKS = 96;

const MAX_FILE_BYTES = 12_000_000;
const MAX_FILES = 3000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', '.gradle', 'vendor', 'Pods', '.terraform',
  '$RECYCLE.BIN', 'System Volume Information', 'AppData',
]);

/**
 * Files that are never indexed, whatever their extension says.
 *
 * `index_folder` reads a folder chosen by the model and ships the *contents* of
 * everything it can read to an embedding API, where it is then retrievable by
 * `search_docs` — so a credential that lands in here leaves the machine and
 * keeps coming back. Pointed at a project root, that is the whole of .env.
 *
 * A bare `.env` was in fact already skipped, but only by accident:
 * `path.extname('.env')` is `''`, not `.env`, so it never matched the extension
 * set that listed it. `.env` in that list was matching `config.env` and
 * `settings.env` instead — real files that hold real keys. Protection that
 * works by accident is protection that stops working when somebody fixes the
 * accident, so it is written down here by name.
 *
 * Matched on the whole filename, lower-cased, plus a prefix rule for the
 * `.env.production.local` family.
 */
const NEVER_INDEX = new Set([
  '.env', '.envrc', '.npmrc', '.pypirc', '.netrc', '_netrc', '.pgpass',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.htpasswd',
  'credentials', 'secrets.json', 'secrets.yaml', 'secrets.yml',
]);

/**
 * True for `.env`, `.env.local`, `.env.production.local`, `config.env`, and so on.
 * Exported for the suite — a rule about credentials is worth pinning by name.
 */
export function isSecretFile(file) {
  const name = path.basename(file).toLowerCase();
  if (NEVER_INDEX.has(name)) return true;
  if (name.startsWith('.env.') || name.endsWith('.env')) return true;
  if (name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.pfx') || name.endsWith('.p12')) return true;
  return false;
}

/** Extensions worth reading. Anything else is skipped in silence. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.org', '.tex', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.ps1', '.sql', '.r', '.lua',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.svg', '.css', '.scss', '.vue', '.svelte',
]);

let sink = null;

/** Where finished batches go. Set by the worker, or by a locally-run server. */
export function setIndexSink(fn) {
  sink = fn;
}

async function send(payload) {
  if (!sink) throw new Error('This worker has nowhere to send an index to — it is not connected to a server.');
  return sink(payload);
}

// ── reading ───────────────────────────────────────────────────────────

/**
 * @param {string} dir
 * @param {number} [depth]
 * @param {{ partial: boolean }} [state]  set when a folder could not be read: then the
 *   walk did not see everything there, and nothing may be forgotten on its word
 */
async function* walk(dir, depth = 0, state = { partial: false }) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // A folder we may not read is not a failure worth stopping for — but its files
    // were not seen, so they must not look deleted.
    state.partial = true;
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(full, depth + 1, state);
    } else if (entry.isFile() && !entry.name.startsWith('~$')) {
      yield full;
    }
  }
}

/** Office formats, read by the same code the chat and the projects use. */
const OFFICE_EXTENSIONS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);

/**
 * The text of one file, or null when there is none to be had.
 *
 * PDFs and Office documents go through the same extractors the chat attachments
 * use, so a document reads identically whether it was dropped on the window or
 * found on disk. That matters here more than anywhere: a folder of contracts is
 * mostly .docx, and an indexer that skipped them would quietly make the
 * assistant's "I searched your documents" a lie.
 */
async function extract(file) {
  // Before anything is read, not after: the point is that these bytes never
  // reach memory, let alone an embedding request.
  if (isSecretFile(file)) return null;

  const ext = path.extname(file).toLowerCase();

  if (ext === '.pdf') {
    const { extractPdfText } = await import('../server/pdf.js');
    const base64 = (await fsp.readFile(file)).toString('base64');
    const result = await extractPdfText(base64).catch(() => null);
    return result?.text || null;
  }

  if (OFFICE_EXTENSIONS.has(ext)) {
    const { officeFormat, readOffice } = await import('../server/office/index.js');
    const buffer = await fsp.readFile(file);
    try {
      return readOffice(officeFormat(file, ''), buffer).text || null;
    } catch {
      // Password-protected, or written by something that got the format wrong.
      // One unreadable file in a folder of two thousand is not a reason to stop.
      return null;
    }
  }

  if (!TEXT_EXTENSIONS.has(ext)) return null;

  const text = await fsp.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  // A .json that is really a binary blob, or a file saved as UTF-16: either way
  // the embedding would be of nonsense.
  if (text.includes('\u0000')) return null;
  return text;
}

// ── chunking ──────────────────────────────────────────────────────────

const HEADING = /^(#{1,6}\s+.+|.+\n[=-]{3,})$/;

/**
 * Cut text into overlapping passages, preferring to break where the author did.
 *
 * The overlap is what stops a definition that happens to straddle a boundary
 * from being unfindable in both halves. Breaking on blank lines rather than on a
 * character count means a passage usually starts at the top of a thought, which
 * is most of what makes a retrieved result readable on its own.
 */
export function chunk(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text).replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/);
  const chunks = [];
  let current = '';
  let heading = null;
  let lastHeading = null;

  const flush = () => {
    const body = current.trim();
    if (body) chunks.push({ text: body, heading: lastHeading });
    current = '';
  };

  for (const paragraph of paragraphs) {
    const first = paragraph.split('\n')[0];
    if (HEADING.test(paragraph) || (first.startsWith('#') && first.length < 120)) {
      heading = first.replace(/^#+\s*/, '').trim().slice(0, 120);
    }

    // One paragraph longer than a whole passage: cut it on its own.
    if (paragraph.length > size) {
      flush();
      for (let i = 0; i < paragraph.length; i += size - overlap) {
        const slice = paragraph.slice(i, i + size).trim();
        if (slice) chunks.push({ text: slice, heading: heading || lastHeading });
      }
      lastHeading = heading;
      continue;
    }

    if (current.length + paragraph.length + 2 > size) {
      flush();
      // Carry the tail of the last passage into the next one.
      const tail = chunks[chunks.length - 1]?.text.slice(-overlap) || '';
      current = tail ? `${tail}\n\n` : '';
      lastHeading = heading;
    }
    if (!lastHeading) lastHeading = heading;
    current += `${paragraph}\n\n`;
  }
  flush();

  return chunks;
}

// ── the tool ──────────────────────────────────────────────────────────

/**
 * Index a folder of the user's documents.
 *
 * Files whose modification time has not moved since the last run are skipped,
 * which is what makes re-indexing a large folder cheap enough to do casually —
 * embedding is billed per token, and re-reading an unchanged archive every time
 * would be a bill for nothing.
 *
 * A file deleted or renamed since is forgotten (2026-11-12): after a walk that saw the
 * whole folder, every path found there is sent as `prune`, and the server drops the
 * source's others. Never after a partial walk — stopped by the person, cut at the
 * file cap, or with a folder it could not read — because then a file not found is not
 * a file that is gone.
 *
 * @param {{ path?: string, reindex?: boolean }} input
 * @param {{ chatId?: string|null, signal?: AbortSignal, maxFiles?: number }} [context]
 *   `maxFiles` is for the suite, which cannot write 3,000 files to reach the cap
 */
export async function indexFolder({ path: target = '.', reindex = false }, { signal, maxFiles = MAX_FILES } = {}) {
  const root = resolveInWorkspace(target);
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat) throw new Error(`There is nothing at ${target} on this computer.`);
  if (!stat.isDirectory()) throw new Error(`${rel(root)} is a file. Point index_folder at a folder.`);

  const source = rel(root);
  const known = reindex ? { stamps: {}, model: null } : await send({ op: 'stamps', source });

  let seen = 0;
  let indexed = 0;
  let skipped = 0;
  let unreadable = 0;
  let chunks = 0;
  let flagged = 0;
  let cleaned = 0;
  const failures = [];
  /** Every file the walk found, whether or not it was read — what the folder still has. */
  const kept = new Set();
  const walked = { partial: false };
  let cut = false;

  let batch = [];
  let batchChunks = 0;

  const flush = async () => {
    if (!batch.length) return;
    const result = await send({ op: 'ingest', source, files: batch });
    indexed += result?.files || 0;
    chunks += result?.chunks || 0;
    flagged += result?.flagged || 0;
    cleaned += result?.cleaned || 0;
    batch = [];
    batchChunks = 0;
  };

  for await (const file of walk(root, 0, walked)) {
    if (seen >= maxFiles) {
      // Only a file past the cap makes this a cut: a folder of exactly the cap is whole.
      cut = true;
      break;
    }
    // Checked per file: stopping the turn stops the walk, and what was already
    // sent stays indexed rather than being half-undone (AUTO-009).
    if (signal?.aborted) break;
    seen += 1;

    const key = file.split(path.sep).join('/');
    // Kept before anything can skip it: an empty, huge or unreadable file is still
    // there, and its passages go only when the file does.
    kept.add(key);

    const info = await fsp.stat(file).catch(() => null);
    if (!info || info.size === 0 || info.size > MAX_FILE_BYTES) continue;

    const mtime = Math.floor(info.mtimeMs);
    if (!reindex && known.stamps?.[key] && known.stamps[key] >= mtime) {
      skipped += 1;
      continue;
    }

    let text;
    try {
      text = await extract(file);
    } catch (err) {
      unreadable += 1;
      if (failures.length < 5) failures.push(`${path.basename(file)}: ${err.message}`);
      continue;
    }
    if (!text) continue;

    const pieces = chunk(text);
    if (!pieces.length) continue;

    // A single enormous file is split across calls rather than sent whole.
    for (let i = 0; i < pieces.length; i += BATCH_CHUNKS) {
      const slice = pieces.slice(i, i + BATCH_CHUNKS);
      if (batchChunks + slice.length > BATCH_CHUNKS) await flush();
      batch.push({ path: key, mtime, chunks: slice.map((c, n) => ({ ...c, ordinal: i + n })) });
      batchChunks += slice.length;
    }
    if (batchChunks >= BATCH_CHUNKS) await flush();
  }
  await flush();

  // Whole only if nothing cut it short. Asked after the last batch as well, for a stop
  // that landed while it was being sent.
  const whole = !cut && !walked.partial && !signal?.aborted;
  let pruned = null;
  let pruneFailed = '';
  if (whole) {
    try {
      pruned = await send({ op: 'prune', source, keep: [...kept] });
    } catch (err) {
      // What was indexed stays indexed; only the tidy did not happen.
      pruneFailed = err?.message || String(err);
    }
  }

  const lines = [
    `Indexed ${source}/ — ${indexed} file${indexed === 1 ? '' : 's'}, ${chunks} passage${chunks === 1 ? '' : 's'}.`,
  ];
  if (skipped) lines.push(`${skipped} unchanged since last time, so they were not re-read.`);
  if (unreadable) lines.push(`${unreadable} could not be read${failures.length ? `: ${failures.join('; ')}` : '.'}`);
  if (pruned?.files) {
    lines.push(`${pruned.files} file${pruned.files === 1 ? '' : 's'} no longer in the folder ${pruned.files === 1 ? 'was' : 'were'} removed from the index.`);
  }
  if (pruneFailed) lines.push(`Files no longer in the folder could not be removed from the index: ${pruneFailed}`);
  if (walked.partial) lines.push('Some folders in it could not be read, so files missing from them were left in the index.');
  if (flagged) {
    lines.push(
      `${flagged} passage${flagged === 1 ? '' : 's'} ${flagged === 1 ? 'contains' : 'contain'} text addressed to an AI — indexed as written, and marked as such when found.`,
    );
  }
  if (cleaned) lines.push(`Invisible characters were taken out of ${cleaned} passage${cleaned === 1 ? '' : 's'}.`);
  if (cut) lines.push(`Stopped at ${maxFiles} files. Index a narrower folder to reach the rest.`);
  if (signal?.aborted) {
    // Said first and plainly. Without it a walk stopped on its first file fell
    // through to "nothing in there was a document this can read", which tells
    // the model the folder is empty when it was only cut short.
    lines.push('Stopped part-way because the user cancelled it; what is listed above was indexed before that.');
    return lines.join(' ');
  }
  if (!indexed && !skipped) {
    lines.push(
      'Nothing in there was a document this can read — it looks for text, code, Markdown, PDFs, ' +
        'and Word, Excel and PowerPoint files.',
    );
  } else {
    lines.push('search_docs can find this now.');
  }
  return lines.join(' ');
}

export const INDEX_IMPLEMENTATIONS = { index_folder: indexFolder };
