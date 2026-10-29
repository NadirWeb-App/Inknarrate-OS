// eSpeak NG with all languages, for Piper voices that are not English (the phonemizer inside the main bundle only
// carries English). Loaded on first use, so English-only visitors never download its 18 MB. GPL-3.0-or-later (see NOTICE.md).
//
// The build we ship is a command-line program compiled to WebAssembly: each call runs it once. The WebAssembly is
// compiled a single time and re-instantiated per call, which costs roughly 0.2 s, so callers send a whole sentence
// in one call (separated by blank lines) instead of one call per word group.
// eSpeak marks a switch of language inside a text (a Latin word in Arabic text) like (en) ... (ar); the voices don't know these marks.
const SWITCH = /\([a-z]{2,3}(?:-[a-z0-9]+)*\)/gi;
let compiled = null;
let factory = null;

async function ready() {
  if (!compiled) {
    compiled = (async () => {
      const base = new URL('../vendor/espeak-ng/', import.meta.url);
      const [mod, wasm] = await Promise.all([import(new URL('espeak-ng.js', base).href), fetch(new URL('espeak-ng.wasm', base).href)]);
      if (!wasm.ok) throw new Error('The extra eSpeak data for this language could not be loaded (it is fetched once, then kept for offline use).');
      factory = mod.default;
      return WebAssembly.compileStreaming ? WebAssembly.compileStreaming(wasm) : WebAssembly.compile(await wasm.arrayBuffer());
    })();
    compiled.catch(() => { compiled = null; });
  }
  return compiled;
}

/** Run eSpeak once. Returns the IPA phonemes, one line per clause. `voice` is an eSpeak voice name such as es, es-419 or ar. */
async function run(text, voice) {
  const mod = await ready();
  let err = '';
  const m = await factory({
    arguments: ['--phonout', 'out', '-q', '--ipa', '-v', voice, text],
    print() {}, printErr(s) { err += s + '\n'; },
    instantiateWasm(imports, done) { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; },
  });
  let out = '';
  try { out = m.FS.readFile('out', { encoding: 'utf8' }); } catch { /* no output */ }
  if (!out.trim() && /voice|language/i.test(err)) throw new Error(`eSpeak has no voice called "${voice}".`);
  return out;
}

/** Does this build know the voice? (An unknown voice produces an error or nothing at all.) */
export async function hasVoice(voice) {
  try { return (await run('a', voice)).trim().length > 0; } catch { return false; }
}

/**
 * Phonemes for several text pieces in one call. Returns one string per piece (the same length as `pieces`).
 * A blank line between pieces keeps eSpeak from merging them; if the line count still doesn't match, falls back to one call per piece.
 */
export async function phonemizePieces(pieces, voice) {
  if (!pieces.length) return [];
  const clean = (t) => t.replace(/\s+/g, ' ').trim();
  const out = await run(pieces.map(clean).join('\n\n'), voice);
  const tidy = (l) => l.replace(SWITCH, '').replace(/\s+/g, ' ').trim();
  const lines = out.split('\n').map(tidy).filter(Boolean);
  if (lines.length === pieces.length) return lines;
  const each = [];
  for (const p of pieces) each.push((await run(clean(p), voice)).split('\n').map(tidy).filter(Boolean).join(' '));
  return each;
}
