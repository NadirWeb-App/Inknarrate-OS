// Arabic is normally written without its short vowels, and a voice cannot guess them from eSpeak's rules alone
// (unvowelled text comes out as consonant clusters). libtashkeel (MIT or Apache-2.0, by Musharraf Omer) restores the
// vowel marks with a small neural model first. Loaded on first use (13 MB, mostly the model), only for Arabic voices.
let ready = null;
let bg = null;

async function init() {
  const base = new URL('../vendor/libtashkeel/', import.meta.url);
  bg = await import(new URL('libtashkeel_wasm_bg.js', base).href);
  const res = await fetch(new URL('libtashkeel_wasm_bg.wasm', base).href);
  if (!res.ok) throw new Error('The Arabic vowel-mark data could not be loaded (it is fetched once, then kept for offline use).');
  const imports = { './libtashkeel_wasm_bg.js': bg };
  const { instance } = WebAssembly.instantiateStreaming
    ? await WebAssembly.instantiateStreaming(res, imports)
    : await WebAssembly.instantiate(await res.arrayBuffer(), imports);
  bg.__wbg_set_wasm(instance.exports);
  if (instance.exports.__wbindgen_start) instance.exports.__wbindgen_start();
}

/** Is this Arabic text already vowelled (written with its marks, التشكيل)? Then it is spoken exactly as written. */
export function isVowelled(text) {
  const letters = (text.match(/[\u0621-\u064a]/g) || []).length;
  const marks = (text.match(/[\u064b-\u0652]/g) || []).length;
  return letters > 0 && marks / letters >= 0.3;
}

/** Text with vowel marks (harakat) added. Text that already has them, or has no Arabic, comes back unchanged. */
export async function addVowelMarks(text) {
  if (!/[\u0600-\u06ff]/.test(text) || isVowelled(text)) return text;
  if (!ready) { ready = init(); ready.catch(() => { ready = null; }); }
  await ready;
  try { return bg.do_tashkeel(text) || text; }
  catch { return text; }   // a sentence the model can't handle is spoken as it was written
}
