// A small zip reader for importing .epub and .docx files (both are zip files). Reads the central
// directory, supports "stored" and "deflate" entries, and uses the browser's own DecompressionStream, so it
// needs no library. Pure enough to test in Node (tests/import.test.mjs).
//
// Imported files are untrusted, so it refuses what it can't handle safely: encrypted or ZIP64 archives,
// archives with too many entries, entries whose real size differs from the declared one, and entries
// (or an archive overall) that inflate beyond a limit (a "zip bomb" is a few KB that expands to gigabytes).

export const ZIP_LIMITS = { entries: 10000, entryBytes: 30e6, totalBytes: 150e6 };

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

function nameOf(bytes, utf8) {
  try { return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252', { fatal: false }).decode(bytes); } catch { return ''; }
}

async function inflate(data, maxBytes) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new Error('A file inside the archive is too large.'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** @returns {Promise<{ names: string[], has(name: string): boolean, read(name: string): Promise<Uint8Array> }>} */
export async function readZip(input, limits = ZIP_LIMITS) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = () => new Error('This file is not a valid zip archive.');

  // End of central directory record: the last 22+ bytes, signature PK\5\6.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad();
  const count = u16(view, eocd + 10), cdSize = u32(view, eocd + 12), cdOffset = u32(view, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (count > limits.entries) throw new Error('The archive has too many files.');
  if (cdOffset + cdSize > bytes.length) throw bad();

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(view, p) !== 0x02014b50) throw bad();
    const flags = u16(view, p + 8), method = u16(view, p + 10);
    const csize = u32(view, p + 20), usize = u32(view, p + 24);
    const nlen = u16(view, p + 28), elen = u16(view, p + 30), clen = u16(view, p + 32), off = u32(view, p + 42);
    if (p + 46 + nlen > bytes.length) throw bad();
    const name = nameOf(bytes.subarray(p + 46, p + 46 + nlen), Boolean(flags & 0x800));
    if (flags & 1) throw new Error('Encrypted archives are not supported.');
    entries.set(name, { method, csize, usize, off });
    p += 46 + nlen + elen + clen;
  }

  let budget = limits.totalBytes;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`Missing file in the archive: ${name}`);
      if (e.usize > limits.entryBytes || e.usize > budget) throw new Error('A file inside the archive is too large.');
      if (e.off + 30 > bytes.length || u32(view, e.off) !== 0x04034b50) throw bad();
      const start = e.off + 30 + u16(view, e.off + 26) + u16(view, e.off + 28);
      if (start + e.csize > bytes.length) throw bad();
      const raw = bytes.subarray(start, start + e.csize);
      let out;
      if (e.method === 0) out = raw.slice();
      else if (e.method === 8) out = await inflate(raw, Math.min(limits.entryBytes, budget));
      else throw new Error('This archive uses a compression method that is not supported.');
      if (out.length !== e.usize) throw new Error('A file inside the archive is damaged.');
      budget -= out.length;
      return out;
    },
  };
}
