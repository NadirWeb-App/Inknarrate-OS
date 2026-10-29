// Turning text into what the Kokoro model takes: cleaned text -> phonemes -> token ids, plus how a
// voice file becomes the style vector. No browser APIs: the espeak call is passed in, so this runs
// in the worker and in the Node tests.
//
// The cleaning rules (numbers, money, titles) and the fix-ups applied to eSpeak's phonemes are adapted
// from kokoro-js by hexgrad and contributors (Apache-2.0), which is how Kokoro's authors run the model in
// JavaScript. See NOTICE.md.
import { KOKORO_MAX_TOKENS } from './model-specs.js';

export const SAMPLE_RATE = 24000;
export const STYLE_DIM = 256;
export const STYLE_ROWS = 510;
const MAX_CHUNK_CHARS = 300;

// ---- cleaning ------------------------------------------------------------------------------------

function splitNum(s) {
  if (s.includes('.')) return s;
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const year = parseInt(s.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return s;
  const left = s.slice(0, 2);
  const right = parseInt(s.slice(2, 4), 10);
  const suffix = s.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(s) {
  const unit = s[0] === '$' ? 'dollar' : 'pound';
  if (Number.isNaN(Number(s.slice(1)))) return `${s.slice(1)} ${unit}s`;
  if (!s.includes('.')) return `${s.slice(1)} ${unit}${s.slice(1) === '1' ? '' : 's'}`;
  const [whole, frac] = s.slice(1).split('.');
  const cents = parseInt(frac.padEnd(2, '0'), 10);
  const small = s[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : (cents === 1 ? 'penny' : 'pence');
  return `${whole} ${unit}${whole === '1' ? '' : 's'} and ${cents} ${small}`;
}

function pointNum(s) {
  const [a, b] = s.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

/** Spell out the things the model reads badly: curly quotes, titles, times, years, money, decimals. */
export function cleanText(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“').replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/、/g, ', ').replace(/。/g, '. ').replace(/！/g, '! ').replace(/，/g, ', ')
    .replace(/：/g, ': ').replace(/；/g, '; ').replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

// ---- phonemes ------------------------------------------------------------------------------------

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

function splitKeep(text, re) {
  const out = [];
  let prev = 0;
  for (const m of text.matchAll(re)) {
    if (prev < m.index) out.push({ punct: false, text: text.slice(prev, m.index) });
    if (m[0].length) out.push({ punct: true, text: m[0] });
    prev = m.index + m[0].length;
  }
  if (prev < text.length) out.push({ punct: false, text: text.slice(prev) });
  return out;
}

/**
 * Text -> the phoneme string Kokoro expects.
 * `espeak(text, lang)` returns an array of strings (the `phonemizer` package). `lang` is 'en-us' for American
 * voices (af_, am_) and 'en' for British ones (bf_, bm_), as in kokoro-js.
 */
export async function phonemizeText(text, espeak, voiceId = 'af_heart') {
  const lang = voiceId[0] === 'b' ? 'en' : 'en-us';
  let ps = '';
  for (const part of splitKeep(cleanText(text), PUNCT_RE)) {
    if (part.punct) ps += part.text;
    else ps += ((await espeak(part.text, lang)) || []).join(' ');
  }
  ps = ps
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'en-us') ps = ps.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return ps.trim();
}

/** Phoneme string -> ids. A character the model doesn't know is dropped (what its tokenizer does). */
export function tokenize(phonemes, vocab) {
  const ids = [];
  for (const ch of phonemes) { const id = vocab.get(ch); if (id !== undefined) ids.push(id); }
  return ids;
}

// ---- long sentences ------------------------------------------------------------------------------

/** Split text that is too long for one pass at sentence marks, then commas, then spaces. */
export function chunkText(text, max = MAX_CHUNK_CHARS) {
  text = text.trim();
  if (text.length <= max) return text ? [text] : [];
  const out = [];
  let cur = '';
  const push = (piece) => {
    if (cur && (cur + ' ' + piece).length > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${piece}` : piece;
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length <= max) { push(sentence); continue; }
    for (const clause of sentence.split(/(?<=[,;:—])\s+/)) {
      if (clause.length <= max) { push(clause); continue; }
      for (const word of clause.split(/\s+/)) {
        if (word.length <= max) push(word);
        else for (let i = 0; i < word.length; i += max) push(word.slice(i, i + max));
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Text -> a list of token-id arrays, each short enough for the model (at most 510 tokens).
 * Normally one; long sentences become several.
 */
export async function textToTokenChunks(text, { espeak, vocab, voiceId, maxTokens = KOKORO_MAX_TOKENS }) {
  const out = [];
  const one = async (piece, depth) => {
    const ids = tokenize(await phonemizeText(piece, espeak, voiceId), vocab);
    if (!ids.length) return;
    if (ids.length <= maxTokens) { out.push(ids); return; }
    const words = piece.split(/\s+/);
    if (words.length < 2 || depth > 8) { out.push(ids.slice(0, maxTokens)); return; }   // one enormous word: cut it
    const half = Math.ceil(words.length / 2);
    await one(words.slice(0, half).join(' '), depth + 1);
    await one(words.slice(half).join(' '), depth + 1);
  };
  for (const piece of chunkText(text)) await one(piece, 0);
  return out;
}

// ---- voices --------------------------------------------------------------------------------------

/** Rows to step away from the default style row for “take” n (0 = the default delivery). */
export function takeRowOffset(take) {
  return take === 0 ? 0 : (take % 2 ? 1 : -1) * Math.ceil(take / 2) * 4;
}

/**
 * The style vector for an utterance of `tokenCount` tokens: row `tokenCount` of the voice (clamped), moved by
 * `rowOffset` rows. `voice` is the voice file as Float32Array(510 * 256).
 */
export function styleRow(voice, tokenCount, rowOffset = 0) {
  const row = Math.max(0, Math.min(STYLE_ROWS - 1, tokenCount + rowOffset));
  return voice.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
}

/** Blend two style vectors (mix 0 = a, 1 = b). */
export function blendStyle(a, b, mix) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - mix) + b[i] * mix;
  return out;
}
