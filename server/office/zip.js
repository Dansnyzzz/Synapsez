/**
 * The ZIP half of an Office document.
 *
 * A .docx, .xlsx or .pptx is a ZIP archive full of XML parts, so reading one
 * begins with reading a ZIP — and Node already ships the hard part. `zlib` does
 * DEFLATE in C; what is left is the archive's own bookkeeping, which is a
 * handful of fixed-width headers and a table of contents at the end of the file.
 *
 * That is small enough to do here, and doing it here is what keeps three
 * document formats from costing a dependency each — with the supply chain,
 * bundle weight and upgrade treadmill that goes with them. The formats do not
 * move: this is ECMA-376, frozen since 2006, and PKZIP's central directory is
 * older than that.
 *
 * What it is generous about, because real files do these things:
 *
 *   **Zip64.** Some writers mark sizes and offsets with the 0xFFFFFFFF sentinel
 *   and put the real numbers in a Zip64 extra field even for a small file, and
 *   a large archive keeps its table of contents in a Zip64 record. Both are
 *   read; a file past what memory can hold is still refused by size.
 *
 *   **Names.** OPC part names compare without case (ECMA-376 Part 2), and some
 *   writers store `xl\worksheets\sheet1.xml` or a leading slash. A lookup that
 *   insisted on the exact bytes found no sheets in a perfectly good workbook.
 *
 * And one thing it does not do: **encryption**. A password-protected file fails
 * by name, which is the only useful thing to say about it.
 */
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const SENTINEL32 = 0xffffffff;

/** How a part name is looked up: separators made forward, no leading slash, any case. */
const partKey = (name) => String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

/** A 64-bit little-endian count as a Number — every real file is far below 2^53. */
const uint64 = (bytes, at) => Number(bytes.readBigUInt64LE(at));

/**
 * The real numbers behind 0xFFFFFFFF sentinels, from an entry's Zip64 extra
 * field. Only the fields that were sentinels are present, in this fixed order.
 */
function zip64Values(bytes, extraStart, extraLength, wanted) {
  const end = extraStart + extraLength;
  for (let at = extraStart; at + 4 <= end; ) {
    const id = bytes.readUInt16LE(at);
    const size = bytes.readUInt16LE(at + 2);
    if (id === ZIP64_EXTRA) {
      const out = {};
      let field = at + 4;
      for (const name of ['size', 'compressedSize', 'localOffset']) {
        if (!wanted[name]) continue;
        if (field + 8 > at + 4 + size) break;
        out[name] = uint64(bytes, field);
        field += 8;
      }
      return out;
    }
    at += 4 + size;
  }
  return {};
}

/** Where the end-of-central-directory record can start hiding: 22 bytes plus a 64KB comment. */
const EOCD_MAX_SCAN = 22 + 0xffff;

/**
 * A ceiling on what one part may inflate to.
 *
 * DEFLATE reaches roughly 1000:1 on repetitive input, so a 5MB upload can claim
 * to be gigabytes. The parts of a real document are XML in the tens of megabytes
 * at the very worst; anything past this is not a document, and refusing it here
 * is cheaper than discovering it as an out-of-memory crash.
 */
const MAX_PART_BYTES = 64 * 1024 * 1024;

/* ── CRC-32, the checksum a ZIP stores for every entry ──────────────── */

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

export function crc32(buffer) {
  const table = crcTable();
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/* ── reading ────────────────────────────────────────────────────────── */

function findEocd(buffer) {
  const from = Math.max(0, buffer.length - EOCD_MAX_SCAN);
  // Backwards: the record is at the end, and a stray signature inside the
  // compressed data of a large archive would otherwise win the race.
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Open an archive.
 *
 * Entries are indexed eagerly — the table of contents is tiny — and inflated
 * only when something asks for one. A .docx has a dozen parts and two of them
 * are ever read; decompressing the rest to answer a question about the text
 * would be work for nothing.
 *
 * @param buffer  the whole file
 * @returns `{ names, has(name), read(name), text(name) }`
 */
export function openZip(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 22) throw new Error('That file is too small to be an Office document.');

  const eocd = findEocd(bytes);
  if (eocd === -1) {
    throw Object.assign(new Error('That file is not a ZIP archive, so it is not an Office document.'), {
      code: 'not_zip',
    });
  }

  let total = bytes.readUInt16LE(eocd + 10);
  let cdSize = bytes.readUInt32LE(eocd + 12);
  let cdOffset = bytes.readUInt32LE(eocd + 16);

  // A Zip64 table of contents: the locator sits just before the classic record
  // and points at the Zip64 one, which holds the real counts.
  if (total === 0xffff || cdSize === SENTINEL32 || cdOffset === SENTINEL32) {
    const locator = eocd - 20;
    if (locator < 0 || bytes.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) {
      throw Object.assign(new Error('That archive says it is ZIP64 but has no ZIP64 record — it is corrupt.'), { code: 'zip64' });
    }
    const record = uint64(bytes, locator + 8);
    if (record + 56 > bytes.length || bytes.readUInt32LE(record) !== ZIP64_EOCD_SIG) {
      throw Object.assign(new Error('That archive\'s ZIP64 record is not where it says.'), { code: 'zip64' });
    }
    total = uint64(bytes, record + 32);
    cdSize = uint64(bytes, record + 40);
    cdOffset = uint64(bytes, record + 48);
  }
  if (cdOffset + cdSize > bytes.length) throw new Error('That archive is truncated or corrupt.');

  const entries = new Map();
  let at = cdOffset;

  for (let i = 0; i < total; i += 1) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new Error('That archive is corrupt — its table of contents does not line up.');
    }

    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    // Sizes come from the central directory rather than the local header: when
    // an entry was written with a streaming data descriptor (flag bit 3) the
    // local header's copies are zero, and reading them gives an empty file.
    let compressedSize = bytes.readUInt32LE(at + 20);
    let size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    let localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);

    if (flags & 0x01) {
      throw Object.assign(new Error('That document is password-protected, so it cannot be read.'), {
        code: 'encrypted',
      });
    }

    if (size === SENTINEL32 || compressedSize === SENTINEL32 || localOffset === SENTINEL32) {
      const real = zip64Values(bytes, at + 46 + nameLength, extraLength, {
        size: size === SENTINEL32,
        compressedSize: compressedSize === SENTINEL32,
        localOffset: localOffset === SENTINEL32,
      });
      size = real.size ?? size;
      compressedSize = real.compressedSize ?? compressedSize;
      localOffset = real.localOffset ?? localOffset;
    }

    // Directory entries are not parts; they exist only to carry a name.
    if (!name.endsWith('/') && !name.endsWith('\\')) {
      const key = partKey(name);
      // The first of two names that differ only by case wins, as it would in a
      // reader that walked the table of contents in order.
      if (!entries.has(key)) entries.set(key, { name, method, compressedSize, size, localOffset });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }

  /** The entry a part name means: as given, or with its %-escapes undone (a relationship target is a URI). */
  const entryFor = (name) => {
    const direct = entries.get(partKey(name));
    if (direct) return direct;
    try {
      return entries.get(partKey(decodeURIComponent(String(name || ''))));
    } catch {
      return undefined;
    }
  };

  const read = (name) => {
    const entry = entryFor(name);
    if (!entry) throw new Error(`This document has no part called ${name}.`);
    if (entry.size > MAX_PART_BYTES) {
      throw new Error(`${name} claims to be ${entry.size} bytes, which is too large to read.`);
    }

    const head = entry.localOffset;
    if (head + 30 > bytes.length || bytes.readUInt32LE(head) !== LOCAL_SIG) {
      throw new Error(`This document's ${name} is not where its table of contents says it is.`);
    }
    // The local header repeats the name and extra field, and their lengths are
    // allowed to differ from the central copy — so the data offset has to be
    // computed from the local header's own numbers.
    const start = head + 30 + bytes.readUInt16LE(head + 26) + bytes.readUInt16LE(head + 28);
    const raw = bytes.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method !== 8) throw new Error(`${name} uses compression method ${entry.method}, which is not supported.`);

    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES });
    } catch (err) {
      throw new Error(`${name} could not be decompressed: ${err.message}`);
    }
  };

  return {
    names: [...entries.values()].map((entry) => entry.name),
    has: (name) => !!entryFor(name),
    read,
    /** A part as text. Every XML part of an OOXML package is UTF-8. */
    text: (name) => read(name).toString('utf8').replace(/^\uFEFF/, ''),
  };
}

/** Whether these bytes even claim to be a ZIP. Cheap enough to ask first. */
export const looksLikeZip = (buffer) =>
  buffer?.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIG;

/* ── writing ────────────────────────────────────────────────────────── */

/** MS-DOS packed date and time, which is what a ZIP header stores. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build an archive.
 *
 * @param parts `[{ name, data }]` — `data` may be a string or a Buffer. Order is
 *   preserved, which matters for `[Content_Types].xml`: the OPC spec puts it in
 *   the package, and every reader in the world expects to meet it first.
 * @param modified the timestamp written into each entry's header
 */
export function writeZip(parts, { modified = new Date() } = {}) {
  const stamp = dosStamp(modified);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8');
    const checksum = crc32(data);

    // Compressed unless compression made it bigger, which happens with tiny
    // parts — a 20-byte .rels file gains a DEFLATE header it cannot pay for.
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, which is DEFLATE
    // Bit 11 says the name is UTF-8. Our part names are ASCII, but saying so
    // costs nothing and is correct for anything that follows.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL_SIG, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.date, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 38); // external attributes: an ordinary file
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, directory, eocd]);
}
