// Encoding for exports, off the main thread: MP3 (a long recording takes a while) and zip files.
// Started on first use, so pages that never export don't load the encoder.
import { Mp3Encoder, JSZip } from '../vendor/export.bundle.js';

const BLOCK = 1152 * 25;   // samples per encoder call (a multiple of the MP3 frame size)

function mp3(pcm, rate, kbps, progress) {
  const enc = new Mp3Encoder(1, rate, kbps);
  const parts = [];
  let size = 0, lastPct = -1;
  for (let i = 0; i < pcm.length; i += BLOCK) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + BLOCK));
    if (out.length) { parts.push(out); size += out.length; }
    const pct = Math.floor((i / pcm.length) * 100);
    if (pct !== lastPct) { lastPct = pct; progress(pct); }
  }
  const tail = enc.flush();
  if (tail.length) { parts.push(tail); size += tail.length; }
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return bytes;
}

async function zip(files, progress) {
  const z = new JSZip();
  // Audio is already compressed (MP3) or compresses poorly, and STORE is much faster on long recordings.
  for (const f of files) z.file(f.name, f.data, { compression: 'STORE', date: new Date(f.date || Date.now()) });
  let lastPct = -1;
  return z.generateAsync({ type: 'uint8array', compression: 'STORE' }, (m) => {
    const pct = Math.floor(m.percent);
    if (pct !== lastPct) { lastPct = pct; progress(pct); }
  });
}

self.onmessage = async ({ data: { id, method, args } }) => {
  const progress = (pct) => self.postMessage({ id, type: 'progress', message: pct });
  try {
    let result;
    if (method === 'mp3') result = mp3(args.pcm, args.rate, args.kbps, progress);
    else if (method === 'zip') result = await zip(args.files, progress);
    else throw new Error(`Unknown method: ${method}`);
    self.postMessage({ id, type: 'done', result }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
