// Text helpers shared by all engines: normalization, sentence splitting, WAV export.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function below1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], 'hundred'); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) out.push(ONES[n]); }
  else if (n > 0 || out.length === 0) out.push(ONES[n]);
  return out.join(' ');
}

export function intToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const parts = [];
  let i = 0;
  while (n > 0 && i < SCALES.length) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(below1000(chunk) + (SCALES[i] ? ' ' + SCALES[i] : ''));
    n = Math.floor(n / 1000);
    i++;
  }
  return parts.join(' ');
}

function digitsToWords(s) { return [...s].map((d) => ONES[+d]).join(' '); }

const ORD_IRREGULAR = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
function ordinalWords(n) {
  const words = intToWords(n).split(' ');
  const last = words.pop();
  words.push(ORD_IRREGULAR[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th'));
  return words.join(' ');
}

function yearWords(y) {
  const hi = Math.floor(y / 100), lo = y % 100;
  if (y >= 2000 && y < 2010) return intToWords(y);
  if (lo === 0) return intToWords(hi) + ' hundred';
  return intToWords(hi) + ' ' + (lo < 10 ? 'oh ' + ONES[lo] : intToWords(lo));
}

const ABBR = [
  [/\bMr\./g, 'Mister'], [/\bMrs\./g, 'Missus'], [/\bMs\./g, 'Miss'], [/\bDr\./g, 'Doctor'],
  [/\bProf\./g, 'Professor'], [/\bSt\./g, 'Saint'], [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\be\.g\./gi, 'for example'], [/\bi\.e\./gi, 'that is'], [/\betc\./gi, 'et cetera'],
];

/** Make text easier for tiny models: expand numbers, symbols and common abbreviations. */
export function normalizeText(text) {
  let t = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[ \t]+/g, ' ').trim();
  for (const [re, rep] of ABBR) t = t.replace(re, rep);

  t = t.replace(/\$(\d[\d,]*)(?:\.(\d{2}))?/g, (_, d, c) => {
    const dollars = parseInt(d.replace(/,/g, ''), 10);
    let s = `${intToWords(dollars)} dollar${dollars === 1 ? '' : 's'}`;
    if (c && +c) s += ` and ${intToWords(+c)} cent${+c === 1 ? '' : 's'}`;
    return s;
  });
  t = t.replace(/(\d+(?:\.\d+)?)\s?%/g, '$1 percent');
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n) => ordinalWords(+n));
  t = t.replace(/\b(1[1-9]\d{2}|20\d{2})\b(?!,\d)/g, (_, y) => yearWords(+y));
  t = t.replace(/\b(\d+)\.(\d+)\b/g, (_, a, b) => `${intToWords(+a)} point ${digitsToWords(b)}`);
  t = t.replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (m) => intToWords(parseInt(m.replace(/,/g, ''), 10)));

  return t.replace(/&/g, ' and ').replace(/@/g, ' at ').replace(/\+/g, ' plus ').replace(/[ \t]+/g, ' ').trim();
}

/** Split into sentence-sized chunks so playback starts early and models see short inputs. */
export function splitSentences(text, maxLen = 220) {
  const raw = text.replace(/\r/g, '').split(/\n+/).flatMap((para) =>
    para.split(/(?<=[.!?…])["')\]]*\s+/));
  const out = [];
  for (let s of raw) {
    s = s.trim();
    if (!s) continue;
    while (s.length > maxLen) {
      let cut = s.lastIndexOf(', ', maxLen);
      if (cut < maxLen * 0.4) cut = s.lastIndexOf(' ', maxLen);
      if (cut <= 0) cut = maxLen;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/** Encode chunks ({samples, sampleRate, gapAfter?}) into one 16-bit mono WAV, with a pause after each (except the last). */
export function encodeWavChunks(chunks, gapSeconds = 0.12) {
  const sr = chunks[0].sampleRate;
  const gapOf = (c) => Math.round(sr * (c.gapAfter ?? gapSeconds));
  const total = chunks.reduce((n, c, i) => n + c.samples.length + (i < chunks.length - 1 ? gapOf(c) : 0), 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, total * 2, true);
  let o = 44;
  chunks.forEach((c, i) => {
    for (let k = 0; k < c.samples.length; k++, o += 2) {
      const x = Math.max(-1, Math.min(1, c.samples[k]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    if (i < chunks.length - 1) o += gapOf(c) * 2; // zeros = silence
  });
  return new Blob([buf], { type: 'audio/wav' });
}

/** Gapless-ish sequential playback of PCM chunks through WebAudio. */
export class Player {
  constructor() { this.ctx = null; this.next = 0; this.sources = new Set(); this.timers = new Set(); }

  async resume() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Queue a clip after the previous one. onstart/onend fire when it begins and finishes playing. */
  enqueue(samples, sampleRate, gap = 0.12, { onstart, onend } = {}) {
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.03, this.next);
    src.start(t);
    this.next = t + buf.duration + gap;
    this.sources.add(src);
    if (onstart) {
      const id = setTimeout(() => { this.timers.delete(id); onstart(); }, Math.max(0, (t - this.ctx.currentTime) * 1000));
      this.timers.add(id);
    }
    src.onended = () => { this.sources.delete(src); if (onend) onend(); };
  }

  stop() {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.next = 0;
  }

  whenDone() {
    return new Promise((resolve) => {
      const check = () => (this.sources.size === 0 ? resolve() : setTimeout(check, 80));
      check();
    });
  }
}
