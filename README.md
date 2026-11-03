# Inknarrate

Free, offline text-to-speech that runs entirely in your browser. Paste or import text, pick a voice, listen, and export it as WAV, MP3 or a zip with one file per sentence (plus subtitles). Nothing is uploaded anywhere.

**The app ships with no voice models.** You download the model files once from Hugging Face and drop them into the **Models** window; they are checked and kept in your browser's own storage (IndexedDB). Until you add one, the browser's built-in voice is used.

| Engine | Voices | Files you add | Licence of the weights |
|---|---|---|---|
| **Kokoro 82M v1.0** (ONNX, onnx-community) | English (US and UK), one `.bin` per voice | `model_quantized.onnx` (92 MB, recommended) or `model.onnx`, `tokenizer.json`, and at least one voice such as `af_heart.bin` | Apache-2.0 |
| **Kitten TTS** nano 0.8 int8 | 8 English voices | `config.json`, `kitten_tts_nano_v0_8.onnx`, `voices.npz` (about 28 MB) | Apache-2.0 |
| **Paradee 8M v1.2** (sahilmahendrakar, distilled from Kokoro) | English (US and UK), 4 voices built in | `paradee_int8.onnx` (8.5 MB, recommended) or `paradee.onnx`, and `config.json` | Apache-2.0 |
| **Piper** (rhasspy/piper-voices) | English, Spanish, Arabic | per voice: `<name>.onnx` and `<name>.onnx.json` | each voice has its own licence (see its model card) |
| Browser voice | whatever your system has | none | n/a |

## Run it

```
node serve.mjs    # http://localhost:8080
```

Any static server works, but `serve.mjs` sends the cross-origin-isolation headers (`_headers` has the same ones for Cloudflare Pages and Netlify) that let onnxruntime-web use several threads. To host it, upload the folder as it is: the site has no build step and contains no models.

## Features

- Engines: Kokoro, Kitten, Paradee, Piper, browser voice. Each neural engine runs in its own Web Worker pool, so the page stays responsive.
- Text is split into sentences; each is generated and cached separately (edit one, regenerate only that one). Import `.txt`, `.md`, `.srt`, `.vtt`, `.html`, `.epub`, `.docx`.
- Per-voice speed, pitch, voice blending, retakes, per-sentence settings, pronunciation rules (`Siobhan = Shiv-awn`), loudness, tone and pauses.
- Export one recording (WAV or MP3), a zip with one file per sentence, SRT or WebVTT subtitles. Save and open projects (`.ttsproject.json`, no audio).
- Works offline after the first visit (service worker); models and generated audio stay in your browser.
- Every added model file is validated (name, shape, SHA-256 against the tested copy) before it is kept. Spanish and Arabic Piper voices load an extra eSpeak build, and Arabic voices add vowel marks with libtashkeel, both fetched on first use.

The in-app **Guide** (`guide/`) explains all of this for users.

## Rebuilding the bundle (GPL source)

`vendor/engines.bundle.js`, `vendor/export.bundle.js` and `vendor/ort/*` are generated. Their sources are in `src/` plus the pinned dependencies in `package.json` and `package-lock.json`:

```
npm ci
npm run bundle
```

A clean rebuild gives a byte-identical bundle. Bump `VERSION` in `sw.js` whenever you change anything under `vendor/` or `ui/fonts/`, or remove or rename files.

## Code map

```
index.html, app.js    page and UI logic
engines/              engines (kitten, kokoro, paradee, piper, browser voice), model checks and storage,
                      worker pool, sentences, cache, player, audio processing, export, import
ui/                   Inkplainer UI kit, self-hosted fonts, tts.css
vendor/               generated: onnxruntime-web, eSpeak NG, libtashkeel, MP3/zip encoder
src/, scripts/        bundle sources and the bundle script
guide/                the user guide
```

Adding an engine takes a `*_META` entry in `engines/meta.js`, an entry in `engines/model-specs.js`, an engine module like `engines/kokoro.js`, and one line each in `engines/registry.js` and `engines/worker.js`.

## Licence

GPL-3.0-or-later, because the bundle embeds eSpeak NG. See `LICENSE`, `NOTICE.md` and `licenses/`. No model weights are included or hosted; people download them from Hugging Face themselves.

