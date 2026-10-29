#!/usr/bin/env node
// Rebuilds the two generated things in vendor/ from source:
//   vendor/engines.bundle.js        src/entry.js + src/kitten-src + onnxruntime-web + phonemizer (eSpeak NG) + jszip
//   vendor/export.bundle.js         src/export-entry.js + lamejs (MP3) + jszip, loaded only by the export worker
//   vendor/ort/ort-wasm-simd-threaded.{mjs,wasm}   copied from onnxruntime-web
//   vendor/libtashkeel/libtashkeel_wasm_bg.{js,wasm} copied from the libtashkeel-wasm package (Arabic vowel marks; lazy-loaded)
//   vendor/espeak-ng/espeak-ng.{js,wasm}            copied from the espeak-ng package (all languages; lazy-loaded)
// Usage:  npm ci && npm run bundle
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(ROOT, 'src/entry.js')],
  outfile: join(ROOT, 'vendor/engines.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  logLevel: 'info',
  // CPU/WASM-only entry point: the default one also looks for a WebGPU (jsep) wasm file we don't ship.
  alias: { 'onnxruntime-web': 'onnxruntime-web/wasm' },
  // kitten-tts-js has Node-only branches (dynamic import of fs/path/os) that never run in a browser.
  external: ['fs', 'path', 'os'],
});

await build({
  entryPoints: [join(ROOT, 'src/export-entry.js')],
  outfile: join(ROOT, 'vendor/export.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  logLevel: 'info',
});

await mkdir(join(ROOT, 'vendor/ort'), { recursive: true });
const dist = join(ROOT, 'node_modules/onnxruntime-web/dist');
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(join(dist, f), join(ROOT, 'vendor/ort', f));
}
// eSpeak NG with every language's data (the bundled phonemizer only has English). Loaded on demand by engines/espeak-full.js,
// only for Piper voices in Spanish or Arabic, so English-only visitors never download it.
await mkdir(join(ROOT, 'vendor/espeak-ng'), { recursive: true });
for (const f of ['espeak-ng.js', 'espeak-ng.wasm']) {
  await copyFile(join(ROOT, 'node_modules/espeak-ng/dist', f), join(ROOT, 'vendor/espeak-ng', f));
}
// libtashkeel: puts the vowel marks back into Arabic text (written Arabic leaves them out) before it goes to eSpeak.
// Loaded on demand by engines/tashkeel.js, only for Arabic Piper voices. 13 MB, mostly its model.
await mkdir(join(ROOT, 'vendor/libtashkeel'), { recursive: true });
for (const f of ['libtashkeel_wasm_bg.js', 'libtashkeel_wasm_bg.wasm']) {
  await copyFile(join(ROOT, 'node_modules/libtashkeel-wasm', f), join(ROOT, 'vendor/libtashkeel', f));
}
console.log('Built vendor/engines.bundle.js, vendor/export.bundle.js, vendor/ort/*, vendor/espeak-ng/* and vendor/libtashkeel/*');
