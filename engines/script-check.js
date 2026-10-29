// Kitten and Kokoro only speak English. Given text in another writing system, English eSpeak spells the letters out
// ("Arabic letter meem, Arabic letter alef…"), which is long, useless audio. Detect that up front so the page can say so.
const LETTER = /\p{L}/gu;
const LATIN = /\p{Script=Latin}/u;

/** Which share (0..1) of the letters is not Latin, and the name of the main other script. */
export function scriptShare(text) {
  let total = 0, other = 0;
  const count = new Map();
  for (const ch of String(text).match(LETTER) || []) {
    total++;
    if (LATIN.test(ch)) continue;
    other++;
    const name = ch.match(/\p{Script=Arabic}/u) ? 'Arabic' : ch.match(/\p{Script=Cyrillic}/u) ? 'Cyrillic'
      : ch.match(/\p{Script=Greek}/u) ? 'Greek' : ch.match(/\p{Script=Hebrew}/u) ? 'Hebrew'
      : ch.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u) ? 'Chinese or Japanese' : ch.match(/\p{Script=Hangul}/u) ? 'Korean'
      : ch.match(/\p{Script=Devanagari}/u) ? 'Hindi' : ch.match(/\p{Script=Thai}/u) ? 'Thai' : 'non-Latin';
    count.set(name, (count.get(name) || 0) + 1);
  }
  let main = '';
  for (const [k, v] of count) if (!main || v > count.get(main)) main = k;
  return { share: total ? other / total : 0, script: main };
}

/** A message when an English-only engine is given text that is mostly another script; otherwise ''. */
export function englishOnlyProblem(text, engineLabel) {
  const { share, script } = scriptShare(text);
  if (share < 0.2) return '';
  return `${engineLabel} only speaks English, and this text is mostly ${script}. Choose Piper with an ${script === 'Arabic' ? 'Arabic' : 'installed'} voice, or the browser voice.`;
}
