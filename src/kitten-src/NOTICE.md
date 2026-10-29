This folder is a copy of the source of **kitten-tts-js** (Apache-2.0), the browser/Node port of
KittenTTS, with three local changes: (1) `model-loader.js` reads model files from `globalThis.KITTEN_READ`
(set by `engines/kitten.js`, which reads the files the person added in the app) instead of downloading from Hugging Face, marked `LOCAL CHANGE`; (2) `kitten-tts.js` accepts `voice2`/`mix` (blend two voices)
and `styleOffset` (pick a neighbouring style row) in `generate()`, marked `LOCAL CHANGE`; (3) `kitten-tts.js` takes the onnxruntime thread count from `globalThis.KITTEN_THREADS` when set (so several workers can share the cores), also marked `LOCAL CHANGE`. Everything else is upstream.
Original license: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
