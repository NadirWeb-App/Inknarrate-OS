import * as ort from 'onnxruntime-web';
ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
export { KittenTTS } from './kitten-src/kitten-tts.js';
export { ort };
export { phonemize } from './kitten-src/phonemizer.js';
export { phonemize as espeak } from 'phonemizer';
