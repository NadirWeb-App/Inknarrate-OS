// File names for exports. Pure functions, tested in tests/export.test.mjs.

/** "Hello, World! It's 42." -> "hello-world-it-s-42" (ASCII, lower case, at most `max` characters). */
export function slug(text, max = 40) {
  const s = String(text)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // é -> e
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  // Cut at a word boundary when there is one ("first-sentence-here-second", not "...-sente").
  const cut = s[max] === '-' ? s.slice(0, max) : s.slice(0, max).replace(/-[^-]*$/, '') || s.slice(0, max);
  return cut.replace(/-+$/, '');
}

/** Base name of a whole-recording export: the first words of the text, or the engine and voice. */
export function exportBase(text, engineId, voice) {
  const words = slug(String(text).trim().split(/\s+/).slice(0, 6).join(' '), 32);
  return words ? `tts-${words}` : `tts-${slug(engineId) || 'audio'}-${slug(voice) || 'voice'}`;
}

/** "007-the-quick-brown-fox.wav": numbered so the files sort in reading order. */
export function sentenceFileName(index, total, text, ext) {
  const width = Math.max(3, String(total).length);
  const s = slug(text, 36);
  return `${String(index + 1).padStart(width, '0')}${s ? '-' + s : ''}.${ext}`;
}
