import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { e2bConfigured, e2bScratch, e2bUnavailable } from './e2b.js';
import { LIMITS } from './attachments.js';

/**
 * An Office file as LibreOffice draws it, on a machine of its own (owner, 2026-11-05).
 *
 * Our own drawing (server/office/draw) is instant and free and matched real Office on
 * what it was compared on, but it knows what it knows: SmartArt, WordArt and a chart's
 * finer styling it can only approximate. LibreOffice has met everything. It cannot run
 * on this server, whose functions are too small to hold it, so each file goes to a
 * machine made for that one job and killed after: a stranger's file meets nothing of
 * anybody's, and with no way out to the internet it cannot call anywhere either.
 *
 * It costs about a third of a cent, so what comes back is kept against that exact file
 * and asked for once.
 */

const RENDERS_PER_DAY = 30;
const DAY_MS = 24 * 60 * 60_000;
const CONVERT_SECONDS = 70;
export const RENDER_MACHINE_MS = 100_000;

/** Whether there is anywhere to do this. */
export const canRenderOffice = () => e2bConfigured();

const quoted = (word) => `'${String(word).replace(/'/g, `'\\''`)}'`;

/**
 * The file as a PDF, made if it has not been.
 *
 * @param {string} userId
 * @param {{ id: string, name: string, data: string, origin?: string, chat_id?: string|null }} file
 * @param {{ machineFor?: () => Promise<any> }} [options]  `machineFor`: a suite's stand-in
 * @returns {Promise<{ id: string, name: string, bytes: number }>} the kept PDF
 */
export async function renderWithOffice(userId, file, { machineFor = () => e2bScratch({ ms: RENDER_MACHINE_MS, userId, internet: false, role: 'office-render' }) } = {}) {
  // What is read from a Google account stays off the cloud computer (sandbox.js `bringFiles`).
  if (file.origin === 'google_drive') throw new Error('A file from Google Drive stays off the cloud computer, so LibreOffice cannot draw it. The ordinary preview still works.');
  const store = getStore();
  const stamp = crypto.createHash('sha256').update(String(file.data)).digest('hex');
  const kept = await store.findRenderedFile(userId, file.id, stamp);
  if (kept) return kept;

  if (typeof store.hitRateLimit === 'function') {
    const allowed = await store.hitRateLimit(`office-render:${userId}`, RENDERS_PER_DAY, DAY_MS).catch(() => ({ allowed: true }));
    if (!allowed.allowed) throw new Error('This account has used today\'s LibreOffice drawings. The ordinary preview still works.');
  }

  const extension = String(file.name).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  const input = `/tmp/in/document.${extension}`;
  let machine;
  try {
    machine = await machineFor();
  } catch (err) {
    if (e2bUnavailable(err)) throw new Error('LibreOffice is not available right now. The ordinary preview still works.');
    throw err;
  }
  try {
    await machine.writeFiles([{ path: input, content: Buffer.from(file.data, 'base64') }]);
    const line =
      `cd /tmp/in && HOME=/tmp/in timeout ${CONVERT_SECONDS} soffice --headless --norestore --nolockcheck --convert-to pdf --outdir /tmp/out ${quoted(input)} >/tmp/soffice.log 2>&1; ` +
      'code=$?; ls -l /tmp/out 2>/dev/null | tail -1; exit $code';
    const done = await machine.runCommand({ cmd: 'bash', args: ['--noprofile', '--norc', '-c', `export PATH=/usr/bin:/bin:/usr/local/bin; ${line}`], timeoutMs: (CONVERT_SECONDS + 10) * 1000 });
    const pdf = done.exitCode === 0 ? await machine.readFileToBuffer({ path: '/tmp/out/document.pdf' }) : null;
    if (!pdf?.length) throw new Error('LibreOffice could not draw that file. The ordinary preview still works.');
    if (pdf.length > LIMITS.maxBytes) throw new Error('LibreOffice\'s drawing of that file is too large to keep. The ordinary preview still works.');
    const saved = await store.createAttachment(userId, {
      id: crypto.randomUUID(),
      name: `${String(file.name).replace(/\.[^.]+$/, '')}.pdf`,
      mime: 'application/pdf',
      kind: 'document',
      bytes: pdf.length,
      data: pdf.toString('base64'),
      origin: 'rendered',
      source: stamp,
      // Its conversation's: it goes when the conversation does, retention and incognito included.
      chatId: file.chat_id || null,
      thumb: null,
      derivedFrom: file.id,
    });
    return saved;
  } finally {
    await Promise.resolve(machine.delete?.()).catch(() => {});
  }
}
