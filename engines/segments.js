// Splits the text box into segments (one generation each) and keeps their ids stable while you edit.
// Pure functions, no DOM: tested in tests/segments.test.mjs.

const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}']);
const OPENERS = /^["'“‘(\[{]+/;
// Never end a sentence: "Dr. Smith", "vs. the", "Inc. announced".
const NEVER = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'gen', 'col', 'lt', 'capt', 'sgt',
  'rev', 'hon', 'gov', 'sen', 'rep', 'vs', 'inc', 'ltd', 'co', 'fig', 'approx', 'dept']);

const isSpace = (c) => c === undefined || /\s/.test(c);

/** First non-space character after position i, or ''. */
function nextChar(text, i) {
  for (let j = i; j < text.length; j++) if (!isSpace(text[j])) return text[j];
  return '';
}

/** Is the "." at text[i] the end of a sentence? segStart is where the current segment began. */
function endsSentence(text, i, segStart) {
  let j = i + 1;
  while (j < text.length && CLOSERS.has(text[j])) j++;
  if (j < text.length && !isSpace(text[j])) return false; // "3.5", "example.com", "file.txt"

  const after = nextChar(text, j);
  // Ellipsis ("Well... I guess"): only a break if a new capitalised sentence follows.
  if (text[i - 1] === '.') return /[A-Z0-9]/.test(after);

  // The word before the dot.
  let k = i;
  while (k > segStart && !isSpace(text[k - 1])) k--;
  const tok = text.slice(k, i).replace(OPENERS, '');
  if (!tok) return false; // stray "."
  const lower = tok.toLowerCase();

  if (/^\d+$/.test(tok) && k === segStart) return false;      // list marker: "1. Intro"
  if (/^[A-HJ-Z]$/.test(tok)) return false;                    // initials: "J. K. Rowling" (not A / I)
  if (/^(?:[a-z]{1,2}\.)+[a-z]{1,2}$/i.test(tok)) return false; // e.g.  i.e.  U.S.  a.m.  Ph.D.
  if (NEVER.has(lower)) return false;
  if (lower === 'no' && /\d/.test(after)) return false;        // "No. 5"
  if (lower === 'etc') return /[A-Z0-9]/.test(after);          // "etc. and so" vs "etc. Then"
  return true;
}

/**
 * Split text into segments.
 *  - periods: a "." followed by whitespace ends a sentence (not "?" or "!", on purpose).
 *  - lines:   every line break ends a segment; a blank line also marks a paragraph break (longer pause).
 * Returns [{ text, start, end, para }]: start/end are offsets into the original text, para = paragraph break after.
 */
export function splitText(text, { periods = true, lines = true } = {}) {
  const out = [];
  let segStart = 0;
  const push = (a, b, para) => {
    let s = a, e = b;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) {
      out.push({ text: text.slice(s, e).replace(/\s+/g, ' '), start: s, end: e, para: !!para });
    } else if (para && out.length) {
      out[out.length - 1].para = true;
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n' && lines) {
      let j = i, breaks = 0;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) { if (text[j] === '\n') breaks++; j++; }
      push(segStart, i, breaks > 1);
      segStart = i = j;
      continue;
    }
    if (ch === '.' && periods && endsSentence(text, i, segStart)) {
      let j = i + 1;
      while (j < text.length && CLOSERS.has(text[j])) j++;
      push(segStart, j, false);
      segStart = i = j;
      continue;
    }
    i++;
  }
  push(segStart, text.length, false);
  return out;
}

/**
 * Give freshly split segments ids, reusing the ids of the old segments they came from, so a row keeps its
 * element (and its audio status) while you edit it. Returns the new list; each item gets { id, from }
 * where `from` is the old segment it replaced (an edit) or undefined (brand new).
 */
export function reconcile(oldSegs, fresh, newId) {
  const o = oldSegs, n = fresh;
  let p = 0;
  while (p < o.length && p < n.length && o[p].text === n[p].text) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s].text === n[n.length - 1 - s].text) s++;

  const res = new Array(n.length);
  for (let i = 0; i < p; i++) res[i] = { ...n[i], id: o[i].id, from: undefined };
  for (let i = 0; i < s; i++) {
    const oi = o.length - 1 - i, ni = n.length - 1 - i;
    res[ni] = { ...n[ni], id: o[oi].id, from: undefined };
  }

  const om = o.slice(p, o.length - s);
  const nmStart = p, nmEnd = n.length - s;
  // Same sentence moved elsewhere in the edited region: keep its id.
  const pool = new Map();
  for (const x of om) { if (!pool.has(x.text)) pool.set(x.text, []); pool.get(x.text).push(x); }
  const used = new Set();
  const open = [];
  for (let i = nmStart; i < nmEnd; i++) {
    const q = pool.get(n[i].text);
    if (q && q.length) { const m = q.shift(); used.add(m); res[i] = { ...n[i], id: m.id, from: undefined }; }
    else open.push(i);
  }
  // The rest are edits: pair them up in order with the old segments that disappeared.
  const gone = om.filter((x) => !used.has(x));
  open.forEach((i, k) => {
    res[i] = k < gone.length ? { ...n[i], id: gone[k].id, from: gone[k] } : { ...n[i], id: newId(), from: undefined };
  });
  return res;
}

/** Small, fast, well-distributed 53-bit string hash (cyrb53). Used for audio cache keys. */
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
