# Licenses and notices

This project is released under **GPL-3.0-or-later** (see `LICENSE`). The reason is a bundled
component: `vendor/engines.bundle.js` contains the `phonemizer` package, which embeds eSpeak NG
(GPL-3.0-or-later), so the combined app has to be distributed under GPL-compatible terms.
This is not legal advice.

| Component | Where | License |
|---|---|---|
| This app's own code (`app.js`, `engines/`, `sw.js`, `serve.mjs`) | repo | GPL-3.0-or-later |
| onnxruntime-web (wasm build) | `vendor/ort/`, bundled in `vendor/engines.bundle.js` | MIT |
| kitten-tts-js | bundled in `vendor/engines.bundle.js` | Apache-2.0 |
| phonemizer + eSpeak NG | bundled in `vendor/engines.bundle.js` | GPL-3.0-or-later |
| libtashkeel-wasm 1.6.4 (Arabic vowel-mark restoration, by Musharraf Omer) | `vendor/libtashkeel/`, copied from the npm package by `npm run bundle`; loaded only for Arabic Piper voices | MIT, Copyright (c) 2023 Musharraf (text in `licenses/libtashkeel-MIT.txt`, from the project's LICENSE file; the npm package also declares Apache-2.0). The repository's licence covers what the author ships, including the model; the licence of the dataset the model was trained on is not stated there |
| espeak-ng 1.0.2 (eSpeak NG compiled to WebAssembly, all languages) | `vendor/espeak-ng/`, copied from the npm package by `npm run bundle`; loaded only for Spanish and Arabic Piper voices | GPL-3.0-or-later |
| JSZip | bundled in `vendor/engines.bundle.js` and `vendor/export.bundle.js` | MIT or GPL-3.0-or-later |
| @breezystack/lamejs (MP3 encoder, a JavaScript port of LAME) | bundled in `vendor/export.bundle.js` | LGPL-3.0 (declared in the package's `license` field; compatible with this project's GPL-3.0-or-later) |
| Text cleaning and eSpeak phoneme fix-ups for Kokoro (`engines/kokoro-text.js`) | adapted from kokoro-js 1.2.1 by hexgrad and contributors | Apache-2.0 (text in `licenses/kokoro-js-Apache-2.0.txt`). Changes: rewritten as plain functions with the eSpeak call passed in, long-sentence splitting added, one eSpeak call at a time |
| Kitten TTS Nano 0.8 weights | **not included**; the person downloads them and adds them in the app | Apache-2.0, per the license field on the [Hugging Face repo](https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8) (KittenML) |
| Piper voices (`.onnx` + `.onnx.json`) | **not included**; the person downloads them from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) | Licence differs per voice (see each folder's MODEL_CARD); the listed `en_US-ljspeech-medium` is MIT, trained on the public-domain LJ Speech recordings. The Piper engine code in this repo is original (it follows Piper's documented model inputs; no Piper source is copied) |
| Kokoro 82M v1.0 weights, ONNX files and tokenizer | **not included**; the person downloads them and adds them in the app | Apache-2.0, per the license field on [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and the [onnx-community conversion](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| Geist and Caveat fonts (`ui/fonts/`) | self-hosted | SIL OFL 1.1 (texts included) |
| Inkplainer UI kit (`ui/inkplainer-ui.*`) | `ui/` | the project author's own work |

The weights are separate works, not part of this repo. The app never hosts them and never downloads model weights: the Models window links to Hugging Face, and the person saves the files and adds them. The one thing the page can fetch itself is the two tiny text files (`config.json`, `tokenizer.json`), straight from huggingface.co and only when the person presses that file's Download button. If you redistribute any weights yourself, credit KittenML (Kitten) and hexgrad (Kokoro) and keep their license terms. Kokoro's training-data notes say it was trained on permissively licensed or public-domain audio and on synthetic audio from closed providers; read the model card before relying on it commercially.

The browser voice is whatever your operating system provides.

Corresponding source for the GPL parts (the compiled eSpeak NG that ships in `vendor/`): eSpeak NG itself is at https://github.com/espeak-ng/espeak-ng. The WebAssembly builds come from the npm packages `phonemizer` 1.2.1 (https://github.com/xenova/phonemizer.js; the `phonemizer` code is Apache-2.0, the eSpeak NG inside it GPL-3.0-or-later) and `espeak-ng` 1.0.2 (https://github.com/ianmarmour/espeak-ng.js). This app's own source is at https://github.com/NadirWeb-App/Inknarrate-OS. The other bundled components' sources: onnxruntime-web https://github.com/microsoft/onnxruntime, JSZip https://github.com/Stuk/jszip, lamejs https://github.com/zhuker/lamejs (the npm package @breezystack/lamejs is a fork), libtashkeel https://github.com/mush42/libtashkeel.

Licence texts for the bundled third-party code are in the `licenses/` folder (index in `licenses/README.txt`).

Other license texts in this repo: `LICENSE` (GPL-3.0), `src/kitten-src/LICENSE` and `src/kitten-src/NOTICE.md` (kitten-tts-js, with the local changes listed), `licenses/kokoro-js-Apache-2.0.txt` (kokoro-js), and the font licenses in `ui/fonts/`.
