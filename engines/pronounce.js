// Pronunciation dictionary: "word = respelling" rules applied to the text before it is spoken.
// The model reads text, so the way to change how a name is said is to respell it ("Siobhan = Shiv-awn").
// Pure functions, tested in tests/pronounce.test.mjs.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse the rules box. One rule per line, `from = to` (or `from => to`). Blank lines and lines starting
 * with # are ignored. Returns { rules, errors } where errors are [{ line, message }] (1-based).
 */
export function parseRules(text) {
  const rules = [];
  const errors = [];
  (text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const arrow = line.indexOf('=>');
    const k = arrow >= 0 ? arrow : line.indexOf('=');
    if (k < 0) { errors.push({ line: i + 1, message: 'Use “word = respelling”.' }); return; }
    const from = line.slice(0, k).trim();
    const to = line.slice(k + (arrow >= 0 ? 2 : 1)).trim();
    if (!from) { errors.push({ line: i + 1, message: 'Nothing before the “=”.' }); return; }
    // Whole words only, case-insensitive: "Siobhan" matches "siobhan" but not "Siobhana".
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(from)}(?![\\p{L}\\p{N}_])`, 'giu');
    rules.push({ from, to, re });
  });
  // Longer phrases first, so "New York City = ..." wins over "New York = ...".
  rules.sort((a, b) => b.from.length - a.from.length);
  return { rules, errors };
}

export function applyRules(text, rules) {
  let out = text;
  for (const r of rules) out = out.replace(r.re, () => r.to);
  return out;
}
