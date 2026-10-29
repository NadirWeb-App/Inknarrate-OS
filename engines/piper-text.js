// Turning text into what a Piper voice takes: text -> eSpeak phonemes (with the punctuation kept) -> ids from the
// voice's own phoneme table. No browser APIs: the espeak call is passed in, so this runs in the worker and in Node tests.
// Piper feeds the model raw eSpeak phonemes (unlike Kokoro there are no fix-ups), padded with the "_" symbol.
import { chunkText } from './kokoro-text.js';

export const TARGET_RATE = 24000;   // every engine hands the app 24 kHz audio, so clips from different voices mix cleanly
const MAX_CHARS = 220;

const PUNCT = ';:,.!?';
const PUNCT_RE = /[;:,.!?]+/g;

/**
 * Light cleaning: curly quotes, odd spaces, long dashes. eSpeak itself reads numbers and abbreviations.
 * Arabic marks become their ASCII twins (so they split and pause like ours), and Spanish ¿ ¡ are dropped (the ? and ! stay).
 */
export function cleanForPiper(text) {
  return String(text)
    .replace(/\u061f/g, '?').replace(/[\u060c\u061b]/g, (c) => (c === '\u060c' ? ',' : ';')).replace(/\u06d4/g, '.')
    .replace(/[¿¡]/g, '').replace(/\u0640/g, '')   // also the Arabic tatweel (a decorative stretch)
    .replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"')
    .replace(/[—–]/g, ', ').replace(/…/g, '...')
    .replace(/[、，]/g, ', ').replace(/。/g, '. ')
    .replace(/[^\S \n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Text -> a phoneme string with ; : , . ! ? kept where they were, the way Piper's own phonemizer does it.
 * `speakPieces(pieces)` takes the pieces of text between the punctuation marks and returns one phoneme string per piece
 * (all of them in one eSpeak run: see piper.js).
 */
export async function phonemizePiper(text, speakPieces) {
  const t = cleanForPiper(text);
  const pieces = [], marks = [];
  let prev = 0;
  for (const m of t.matchAll(PUNCT_RE)) { pieces.push(t.slice(prev, m.index)); marks.push(m[0]); prev = m.index + m[0].length; }
  pieces.push(t.slice(prev));
  const speakable = pieces.map((p) => /[\p{L}\p{N}]/u.test(p));
  const spoken = await speakPieces(pieces.filter((_, i) => speakable[i]));
  let k = 0, out = '';
  pieces.forEach((_, i) => {
    out += speakable[i] ? String(spoken[k++] || '').replace(/\s+/g, ' ').trim() : '';
    if (i < marks.length) out += marks[i] + ' ';
  });
  return out.trim();
}

/**
 * Phoneme string -> model ids: the start symbol, then each phoneme's ids followed by padding, then the end symbol.
 * Characters the voice doesn't know are skipped. Phonemes are split into code points after Unicode NFD, as in training.
 */
export function phonemesToIds(phonemes, idMap) {
  const ids = [...idMap['^']];
  for (const ch of String(phonemes).normalize('NFD')) {
    const v = idMap[ch];
    if (!v) continue;
    ids.push(...v, ...idMap._);
  }
  ids.push(...idMap.$);
  return ids;
}

/** Text -> id arrays, one per piece (long sentences are cut at sentence marks, commas, then spaces). */
export async function textToPiperIds(text, { speakPieces, idMap, prepare }) {
  const out = [];
  // `prepare` (Arabic: add the vowel marks) runs on each piece before the text is cleaned and phonemized.
  for (const piece of chunkText(cleanForPiper(text), MAX_CHARS)) {
    const ids = phonemesToIds(await phonemizePiper(prepare ? await prepare(piece) : piece, speakPieces), idMap);
    if (ids.length > 4) out.push(ids);
  }
  return out;
}

/** Noise values for “take” n (0 = the voice's defaults): a little more or less variation, within safe limits. */
export function takeNoise(base, take) {
  if (!take) return base;
  const k = (take % 2 ? 1 : -1) * Math.ceil(take / 2);
  return Math.min(1.2, Math.max(0.1, base * (1 + 0.12 * k)));
}

/** Largest absolute sample; scale down only if the model overshoots full scale. */
export function limitPeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (peak > 1) for (let i = 0; i < samples.length; i++) samples[i] /= peak;
  return samples;
}

export { PUNCT };
