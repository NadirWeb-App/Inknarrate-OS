// What this app officially supports, which files each model needs, where people get them, and how
// an uploaded file is recognised and checked. Pure data and functions: no browser APIs, so the page,
// the workers and the Node tests all use it.
//
// Nothing here is downloaded by the app. The pages only *link* to the files on Hugging Face; the
// person downloads them in their own browser and adds them with the upload box. The files then stay
// in this browser (IndexedDB) and never leave it.

const HF = 'https://huggingface.co';
const dl = (base, path) => `${base}/resolve/main/${path}?download=true`;
// Small text files: Hugging Face shows them in the tab instead of saving them, so the page saves them itself (see models-ui.js).
const plain = (base, path) => `${base}/resolve/main/${path}`;
const raw = (base, path) => `${base}/raw/main/${path}`;   // small text files straight from git: another way to fetch them if the first one fails

// ---- Kitten TTS (nano 0.8, int8) ----------------------------------------------------------------
const KITTEN_REPO = `${HF}/KittenML/kitten-tts-nano-0.8-int8`;

// ---- Kokoro 82M v1.0 (ONNX conversion by onnx-community) -----------------------------------------
const KOKORO_REPO = `${HF}/onnx-community/Kokoro-82M-v1.0-ONNX`;

/** Voices that Kokoro's authors grade, best first. Grades are theirs (VOICES.md in hexgrad/kokoro, Apache-2.0). */
export const KOKORO_VOICES = [
  ['af_heart', 'Heart', 'A'], ['af_bella', 'Bella', 'A-'], ['af_nicole', 'Nicole', 'B-'],
  ['bf_emma', 'Emma', 'B-'],
  ['af_aoede', 'Aoede', 'C+'], ['af_kore', 'Kore', 'C+'], ['af_sarah', 'Sarah', 'C+'],
  ['am_fenrir', 'Fenrir', 'C+'], ['am_michael', 'Michael', 'C+'], ['am_puck', 'Puck', 'C+'],
  ['af_alloy', 'Alloy', 'C'], ['af_nova', 'Nova', 'C'], ['bf_isabella', 'Isabella', 'C'],
  ['bm_george', 'George', 'C'], ['bm_fable', 'Fable', 'C'],
  ['af_sky', 'Sky', 'C-'], ['bm_lewis', 'Lewis', 'D+'],
  ['af_jessica', 'Jessica', 'D'], ['af_river', 'River', 'D'], ['am_echo', 'Echo', 'D'], ['am_eric', 'Eric', 'D'],
  ['am_liam', 'Liam', 'D'], ['am_onyx', 'Onyx', 'D'], ['bf_alice', 'Alice', 'D'], ['bf_lily', 'Lily', 'D'], ['bm_daniel', 'Daniel', 'D'],
  ['am_santa', 'Santa', 'D-'], ['am_adam', 'Adam', 'F+'],
].map(([id, name, grade]) => ({ id, name, grade }));

/** A short starter set for the guide (the better-graded voices, both accents, both genders). */
export const KOKORO_STARTER = ['af_heart', 'af_bella', 'bf_emma', 'am_michael', 'bm_george'];

// ---- Paradee 8M v1.2 (distilled from Kokoro by Sahil Mahendrakar) --------------------------------
// Only 1.2: 1.0 and 1.1 have one voice and no voice input.
const PARADEE_REPO = `${HF}/sahilmahendrakar/Paradee-8M-v1.2`;

// ---- Piper (rhasspy/piper-voices) ---------------------------------------------------------------
// Unlike Kokoro, every Piper voice is a complete model of its own: an .onnx file plus an .onnx.json file that
// describes it. Licences differ per voice (each folder has a MODEL_CARD), so only voices whose card was read
// are listed below; any other English voice can still be added by the person (the “advanced” path).
export const PIPER_REPO = `${HF}/rhasspy/piper-voices`;
export const PIPER_TREE_URL = `${PIPER_REPO}/tree/main/en`;
/** Languages the app takes for Piper voices (the file name's first part, and eSpeak's language). */
export const PIPER_LANGS = {
  en: { name: 'English', native: 'English', folder: `${PIPER_REPO}/tree/main/en`, example: 'en_US or en_GB' },
  es: { name: 'Spanish', native: 'Español', folder: `${PIPER_REPO}/tree/main/es`, example: 'es_ES, es_MX or es_AR' },
  ar: { name: 'Arabic', native: 'العربية', folder: `${PIPER_REPO}/tree/main/ar`, example: 'ar_JO' },
};
const PIPER_REGIONS = { US: 'US', GB: 'UK', ES: 'Spain', MX: 'Mexico', AR: 'Argentina', JO: 'Jordan' };
const piperFile = (path, base, ext, text) => ({
  name: `${base}${ext}`,
  href: text ? plain(PIPER_REPO, `${path}/${base}${ext}`) : dl(PIPER_REPO, `${path}/${base}${ext}`),
  text: Boolean(text),
});

/**
 * Suggested voices. `checked: true` means the model card was read and the licence allows this use; the others exist
 * (their folder and file size were seen) but their model card was not read, so the window says so. `size` is the .onnx file, in bytes.
 */
export const PIPER_VOICES = [
  { id: 'en_US-ljspeech-medium', lang: 'en', checked: true, name: 'LJ Speech', detail: 'US female', path: 'en/en_US/ljspeech/medium', size: 63.5e6,
    license: 'MIT (trained on the public-domain LJ Speech recordings)' },
  { id: 'es_ES-sharvard-medium', lang: 'es', checked: false, name: 'Sharvard', detail: 'Spain, two speakers (male and female)', path: 'es/es_ES/sharvard/medium', size: 76.7e6,
    license: 'speech data CC BY 3.0 (credit: University of Edinburgh); fine-tuned from the US “lessac” voice, whose own terms are unclear: read the model card' },
  { id: 'ar_JO-kareem-medium', lang: 'ar', checked: false, name: 'Kareem', detail: 'Jordanian Arabic, male', path: 'ar/ar_JO/kareem/medium', size: 63.2e6,
    license: 'unclear. The recordings’ licence isn’t stated anywhere we could find (the repository’s MIT tag covers Piper’s files, not necessarily the data). Fine to try; check before using the audio commercially' },
].map((v) => ({
  ...v,
  model: piperFile(v.path, v.id, '.onnx'),
  config: piperFile(v.path, v.id, '.onnx.json', true),
  cardUrl: `${PIPER_REPO}/blob/main/${v.path}/MODEL_CARD`,
}));

export const MAX_MODEL_BYTES = 400e6;       // the largest official file is 326 MB
export const KOKORO_VOICE_BYTES = 510 * 256 * 4;
export const KOKORO_MAX_TOKENS = 510;       // the model takes 512 including the two padding tokens

export const SPECS = {
  kitten: {
    id: 'kitten',
    label: 'Kitten TTS',
    summary: 'Tiny and fast. 8 English voices, about 28 MB in total.',
    author: 'KittenML',
    license: 'Apache-2.0',
    pageUrl: KITTEN_REPO,
    // Hashes of the exact files this app was tested with. A match shows “official copy”; anything else is
    // accepted if it has the right shape but is marked “not checked”.
    files: [
      { key: 'config.json', name: 'config.json', size: 688, sha256: 'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64', href: plain(KITTEN_REPO, 'config.json'), alt: raw(KITTEN_REPO, 'config.json'), text: true },
      { key: 'model.onnx', name: 'kitten_tts_nano_v0_8.onnx', size: 24369971, sha256: 'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc', href: dl(KITTEN_REPO, 'kitten_tts_nano_v0_8.onnx') },
      { key: 'voices.npz', name: 'voices.npz', size: 3278902, sha256: '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f', href: dl(KITTEN_REPO, 'voices.npz') },
    ],
  },
  kokoro: {
    id: 'kokoro',
    label: 'Kokoro',
    summary: 'Higher quality and more natural. English voices (US and UK), 92 MB model plus about 0.5 MB per voice.',
    author: 'hexgrad (ONNX conversion: onnx-community)',
    license: 'Apache-2.0',
    pageUrl: KOKORO_REPO,
    officialPageUrl: `${HF}/hexgrad/Kokoro-82M`,
    // Two official variants; adding one replaces the other. Hashes are the SHA-256 shown on each file's page.
    models: [
      { name: 'model_quantized.onnx', variant: 'q8', size: 92.4e6, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478', href: dl(KOKORO_REPO, 'onnx/model_quantized.onnx'), note: 'Recommended. 8-bit, good quality.' },
      { name: 'model.onnx', variant: 'fp32', size: 326e6, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb', href: dl(KOKORO_REPO, 'onnx/model.onnx'), note: 'Full precision. Best quality, but slower and heavier.' },
    ],
    tokenizer: { key: 'tokenizer.json', name: 'tokenizer.json', size: 3500, href: plain(KOKORO_REPO, 'tokenizer.json'), alt: raw(KOKORO_REPO, 'tokenizer.json'), text: true },
    voiceHref: (id) => dl(KOKORO_REPO, `voices/${id}.bin`),
    voicesPageUrl: `${KOKORO_REPO}/tree/main/voices`,
  },
  paradee: {
    id: 'paradee',
    label: 'Paradee',
    summary: 'A tiny Kokoro: 4 English voices (US and UK) in one 8.5 MB model. Quick on any computer.',
    author: 'Sahil Mahendrakar (distilled from Kokoro by hexgrad)',
    license: 'Apache-2.0',
    pageUrl: PARADEE_REPO,
    // Two variants; adding one replaces the other. Hashes are the SHA-256 Hugging Face lists for each file (the config's was computed from the download).
    models: [
      { name: 'paradee_int8.onnx', variant: 'int8', size: 8462119, sha256: 'a6989796692ac173597e15d405c971989202d5c73cfad65f22e90bd7b6c97da1', href: dl(PARADEE_REPO, 'onnx/paradee_int8.onnx'), note: 'Recommended. 8-bit, what its author ships.' },
      { name: 'paradee.onnx', variant: 'fp32', size: 34779443, sha256: '8bac7b0bebef403cb22b54ead6bee423fa34a04fd91f73326b7f65cd9d0d25b9', href: dl(PARADEE_REPO, 'onnx/paradee.onnx'), note: 'Full precision. Larger, slightly slower.' },
    ],
    config: { key: 'config.json', name: 'config.json', size: 1827, sha256: '002535cf8dd08a434cdddb13372da8a7b4844152bdf9b5b4e7342e12ec30bcfb', href: plain(PARADEE_REPO, 'config.json'), alt: raw(PARADEE_REPO, 'config.json'), text: true },
  },
  piper: {
    id: 'piper',
    label: 'Piper',
    summary: 'English, Spanish and Arabic voices, one small model per voice (about 15 to 110 MB each). Add as many as you like.',
    author: 'Rhasspy / Open Home Foundation (voices by their dataset authors)',
    license: 'MIT code · each voice has its own licence',
    pageUrl: PIPER_REPO,
  },
};

export const ENGINE_IDS = Object.keys(SPECS);

// ---- recognising an uploaded file ---------------------------------------------------------------

/** Browsers rename a second download of the same file to “name (1).ext”. Undo that. */
export function cleanName(name) {
  return String(name || '').trim().replace(/ \(\d+\)(?=(?:\.[^. ]+)+$)/, '');
}

const VOICE_RE = /^([ab][fm]_[a-z0-9]+)\.bin$/;
/** A Piper voice's base name: language_REGION-name-quality, for example en_US-amy-medium. */
const PIPER_BASE_RE = /^([a-z]{2,3})_([A-Za-z]{2,4})-([A-Za-z0-9_]+)-(x_low|low|medium|high)$/;

function piperIdentify(base, role, name) {
  const m = PIPER_BASE_RE.exec(base);
  if (!m) return { error: `${name} doesn’t look like a Piper voice file. Piper files are named like en_US-amy-medium.onnx and en_US-amy-medium.onnx.json.` };
  if (!PIPER_LANGS[m[1]]) return { error: `${name} is a Piper voice for a language this app doesn’t support. It takes English (en_…), Spanish (es_…) and Arabic (ar_…) voices.` };
  return { engine: 'piper', key: `voices/${base}${role === 'piper-model' ? '.onnx' : '.json'}`, role, name, voice: base };
}

/**
 * Which model does this file belong to, and what is it for?
 * Returns { engine, key, role, ... } or { error } (a sentence for the person), or null for something we have no opinion on.
 * `config.json` (Kitten's or Paradee's) can only be told apart by its content: see validateFile.
 */
export function identify(rawName) {
  const name = cleanName(rawName);
  const lower = name.toLowerCase();
  if (lower === 'config.json') return { engine: 'kitten', key: 'config.json', role: 'config', name };
  const pm = SPECS.paradee.models.find((m) => m.name === lower);
  if (pm) return { engine: 'paradee', key: 'model.onnx', role: 'model', name: lower, variant: pm.variant };
  if (lower === 'kitten_tts_nano_v0_8.onnx') return { engine: 'kitten', key: 'model.onnx', role: 'model', name: lower };
  if (lower === 'voices.npz') return { engine: 'kitten', key: 'voices.npz', role: 'voices', name: lower };
  if (lower === 'tokenizer.json') return { engine: 'kokoro', key: 'tokenizer.json', role: 'tokenizer', name: lower };
  const km = SPECS.kokoro.models.find((m) => m.name === lower);
  if (km) return { engine: 'kokoro', key: 'model.onnx', role: 'model', name: lower, variant: km.variant };
  const vm = VOICE_RE.exec(lower);
  if (vm) return { engine: 'kokoro', key: `voices/${vm[1]}.bin`, role: 'voice', name: lower, voice: vm[1] };
  if (/^[a-z]{2}_[a-z0-9]+\.bin$/.test(lower)) {
    return { error: `${name} is a Kokoro voice for another language. This app is English only, so it only takes voices that start with af_, am_, bf_ or bm_.` };
  }
  const pj = /^(.+)\.onnx\.json$/i.exec(name);
  if (pj) return piperIdentify(pj[1], 'piper-config', name);
  if (lower.endsWith('.onnx') && PIPER_BASE_RE.test(name.slice(0, -5))) return piperIdentify(name.slice(0, -5), 'piper-model', name);
  if (/^kitten_tts_.*\.onnx$/.test(lower)) return { error: `${name} is a different Kitten size. This app supports kitten_tts_nano_v0_8.onnx (the nano int8 model).` };
  if (lower.endsWith('.onnx')) {
    return { error: `${name} isn’t one of the supported model files. For Kokoro use model_quantized.onnx (recommended) or model.onnx from the onnx folder; for Paradee, paradee_int8.onnx or paradee.onnx. A Piper voice is named like en_US-amy-medium.onnx.` };
  }
  return null;
}

// ---- checking a file's contents -----------------------------------------------------------------

/** Looks like an ONNX model: a protobuf that starts with the ir_version field. Cheap guard against saving a web page by mistake. */
export function looksLikeOnnx(bytes) {
  return bytes.length > 1e6 && bytes[0] === 0x08;
}

/** Kitten's config.json: { model_file, voices, ... }. Returns { ok, error }. */
export function validateKittenConfig(text) {
  let cfg;
  try { cfg = JSON.parse(text); } catch { return { ok: false, error: 'config.json isn’t valid JSON.' }; }
  if (!cfg || typeof cfg !== 'object' || typeof cfg.model_file !== 'string') {
    return { ok: false, error: 'This config.json isn’t Kitten’s or Paradee’s. If it is Kokoro’s, you don’t need it: Kokoro uses tokenizer.json.' };
  }
  if (cfg.model_file !== 'kitten_tts_nano_v0_8.onnx') {
    return { ok: false, error: `This config.json is for ${cfg.model_file}. This app supports kitten_tts_nano_v0_8.onnx (the nano int8 model).` };
  }
  return { ok: true };
}

/**
 * Kokoro's tokenizer.json (Hugging Face “tokenizers” format). Returns { ok, vocab: Map<char, id> } or { ok: false, error }.
 * Every character of the phoneme string maps to one id; the model's vocabulary has about 100 symbols, ids 0 to 177.
 */
export function parseTokenizer(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, error: 'tokenizer.json isn’t valid JSON.' }; }
  const v = j && j.model && j.model.vocab;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'This tokenizer.json has no vocabulary. Use the one from the onnx-community Kokoro repository.' };
  const vocab = new Map();
  for (const [ch, id] of Object.entries(v)) {
    if (!Number.isInteger(id) || id < 0 || id > 177 || [...ch].length !== 1) return { ok: false, error: 'This tokenizer.json doesn’t look like Kokoro’s.' };
    vocab.set(ch, id);
  }
  if (vocab.size < 60 || vocab.get('$') !== 0 || !vocab.has('a') || !vocab.has('ˈ')) {
    return { ok: false, error: 'This tokenizer.json doesn’t look like Kokoro’s.' };
  }
  return { ok: true, vocab };
}

/**
 * Paradee's config.json: { model_type: 'paradee', version, sample_rate, voices: [id], vocab: { char: id } }.
 * Returns { ok, vocab: Map<char, id>, voices: [id] } or { ok: false, error }. The vocabulary is Kokoro's.
 */
export function parseParadeeConfig(text) {
  let c;
  try { c = JSON.parse(text); } catch { return { ok: false, error: 'config.json isn’t valid JSON.' }; }
  if (!c || typeof c !== 'object' || c.model_type !== 'paradee') return { ok: false, error: 'This config.json isn’t Paradee’s.' };
  if (!Array.isArray(c.voices) || !c.voices.length) {
    return { ok: false, error: `This is the config.json of Paradee ${String(c.version || '1.0').slice(0, 8)}, which has one voice and no voice input. This app supports Paradee 1.2.` };
  }
  if (c.sample_rate !== 24000) return { ok: false, error: 'This Paradee config.json has an unexpected sample rate.' };
  if (!c.voices.every((v) => typeof v === 'string' && /^[ab][fm]_[a-z0-9]+$/.test(v))) {
    return { ok: false, error: 'This Paradee config.json lists voices this app doesn’t know (it takes US and UK English: af_, am_, bf_, bm_).' };
  }
  const v = c.vocab;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'This Paradee config.json has no vocabulary.' };
  const vocab = new Map();
  for (const [ch, id] of Object.entries(v)) {
    if (!Number.isInteger(id) || id < 1 || id > 177 || [...ch].length !== 1) return { ok: false, error: 'The vocabulary in this Paradee config.json is malformed.' };
    vocab.set(ch, id);
  }
  if (vocab.size < 60 || !vocab.has('a') || !vocab.has('ˈ')) return { ok: false, error: 'The vocabulary in this Paradee config.json is malformed.' };
  return { ok: true, vocab, voices: c.voices };
}

/** A Kokoro voice file: 510 style vectors of 256 float32 values. Returns { ok, error }. */
export function validateKokoroVoice(bytes) {
  if (bytes.byteLength !== KOKORO_VOICE_BYTES) {
    return { ok: false, error: `Wrong size (${bytes.byteLength} bytes, expected ${KOKORO_VOICE_BYTES}). Is it a voice .bin file from the voices folder?` };
  }
  const a = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (!Number.isFinite(x) || x > 8 || x < -8) return { ok: false, error: 'The numbers in this file are out of range, so it isn’t a Kokoro voice.' };
  }
  return { ok: true };
}

/**
 * A Piper voice's .onnx.json. Returns { ok, summary } or { ok: false, error }. The summary is what the page keeps
 * next to the file (sample rate, speakers, ...) so it can list voices without reading the files again.
 */
export function validatePiperConfig(text) {
  let c;
  try { c = JSON.parse(text); } catch { return { ok: false, error: 'This file isn’t valid JSON. Was it saved as a web page? Use the Download button.' }; }
  if (!c || typeof c !== 'object') return { ok: false, error: 'This doesn’t look like a Piper voice description.' };
  const sr = c.audio && c.audio.sample_rate;
  const map = c.phoneme_id_map;
  if (!Number.isInteger(sr) || sr < 8000 || sr > 48000 || !map || typeof map !== 'object' || Array.isArray(map)) {
    return { ok: false, error: 'This doesn’t look like a Piper voice description (no audio.sample_rate or phoneme_id_map).' };
  }
  const entries = Object.entries(map);
  if (entries.length < 10 || !entries.every(([, v]) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n >= 0 && n < 4096))) {
    return { ok: false, error: 'The phoneme table in this file is malformed.' };
  }
  if (!map['^'] || !map['$'] || !map['_']) return { ok: false, error: 'The phoneme table in this file lacks the start, end or padding symbol.' };
  if (c.phoneme_type !== undefined && c.phoneme_type !== 'espeak') {
    return { ok: false, error: `This voice uses a different text system (“${String(c.phoneme_type).slice(0, 20)}”). This app only supports Piper voices that use eSpeak.` };
  }
  const voice = c.espeak && c.espeak.voice;
  if (typeof voice !== 'string' || !/^[a-z0-9-]{2,30}$/i.test(voice)) return { ok: false, error: 'This file names no eSpeak voice.' };
  if (!/^(en|es|ar)(-|$)/i.test(voice)) return { ok: false, error: `This voice speaks a language the app doesn’t support (${voice}). It takes English, Spanish and Arabic voices.` };
  const n = Number.isInteger(c.num_speakers) && c.num_speakers > 0 ? c.num_speakers : 1;
  const inf = c.inference || {};
  const num = (x, d) => (Number.isFinite(x) && x >= 0 && x <= 5 ? x : d);
  const speakers = [];
  if (n > 1) {
    const sm = c.speaker_id_map && typeof c.speaker_id_map === 'object' ? c.speaker_id_map : {};
    for (const [name, id] of Object.entries(sm)) if (Number.isInteger(id) && id >= 0 && id < n) speakers.push({ name: String(name).slice(0, 40), id });
    if (!speakers.length) for (let i = 0; i < n; i++) speakers.push({ name: `Speaker ${i + 1}`, id: i });
    speakers.sort((a, b) => a.id - b.id);
  }
  return { ok: true, summary: {
    sampleRate: sr, espeakVoice: voice, numSpeakers: n, speakers,
    noise: num(inf.noise_scale, 0.667), length: num(inf.length_scale, 1), noiseW: num(inf.noise_w, 0.8),
    lang: voice.slice(0, 2).toLowerCase(),
    quality: c.audio.quality ? String(c.audio.quality).slice(0, 12) : '', language: c.language && c.language.code ? String(c.language.code).slice(0, 8) : '',
  } };
}

/** Kitten's voices.npz is a zip archive (the file starts with “PK”). */
export function looksLikeNpz(bytes) {
  return bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * Check a file's size and contents for its role. `bytes` is a Uint8Array of the whole file (the text files are small).
 * Returns { ok, error }, plus `engine` for a config.json: whose it is (identify can't tell from the name).
 */
export function validateFile(info, bytes) {
  if (info.role === 'config') {
    const text = new TextDecoder().decode(bytes);
    if (/"model_type"\s*:\s*"paradee"/.test(text)) { const r = parseParadeeConfig(text); return { ok: r.ok, error: r.error, engine: 'paradee' }; }
    return { ...validateKittenConfig(text), engine: 'kitten' };
  }
  if (info.role === 'tokenizer') { const r = parseTokenizer(new TextDecoder().decode(bytes)); return { ok: r.ok, error: r.error }; }
  if (info.role === 'voice') return validateKokoroVoice(bytes);
  if (info.role === 'piper-config') return validatePiperConfig(new TextDecoder().decode(bytes));
  if (info.role === 'voices') return looksLikeNpz(bytes) ? { ok: true } : { ok: false, error: 'voices.npz should be a zip-style .npz file.' };
  if (info.role === 'model' || info.role === 'piper-model') {
    if (bytes.length > MAX_MODEL_BYTES) return { ok: false, error: 'This file is bigger than any supported model.' };
    return looksLikeOnnx(bytes) ? { ok: true } : { ok: false, error: `${info.name} doesn’t look like an ONNX model. Was it saved as a web page? Use the download link and try again.` };
  }
  return { ok: false, error: 'Unknown file.' };
}

/** Hex SHA-256 of some bytes (WebCrypto exists in browsers, workers and current Node). */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The expected hash for a recognised file, if we know it. */
export function expectedHash(info) {
  if (info.engine === 'kitten') return (SPECS.kitten.files.find((f) => f.key === info.key) || {}).sha256 || null;
  if (info.engine === 'kokoro' && info.role === 'model') return (SPECS.kokoro.models.find((m) => m.name === info.name) || {}).sha256 || null;
  if (info.engine === 'paradee') return info.role === 'model' ? (SPECS.paradee.models.find((m) => m.name === info.name) || {}).sha256 || null : SPECS.paradee.config.sha256;
  return null;
}

// ---- what is installed ---------------------------------------------------------------------------

/**
 * Given the saved file records of one engine ([{ key, size, verified, variant }]), what state is it in?
 * Returns { ready, missing: [description], voices: [id], variant, official }.
 */
export function describeInstalled(engineId, records) {
  const has = new Map(records.map((r) => [r.key, r]));
  const missing = [];
  if (engineId === 'kitten') {
    for (const f of SPECS.kitten.files) if (!has.has(f.key)) missing.push(f.name);
    const recs = SPECS.kitten.files.map((f) => has.get(f.key)).filter(Boolean);
    return { ready: missing.length === 0, missing, voices: [], variant: '', official: recs.length > 0 && recs.every((r) => r.verified) };
  }
  if (engineId === 'kokoro') {
    if (!has.has('model.onnx')) missing.push('model_quantized.onnx');
    if (!has.has('tokenizer.json')) missing.push('tokenizer.json');
    const voices = records.filter((r) => r.key.startsWith('voices/')).map((r) => r.key.slice(7, -4));
    const order = new Map(KOKORO_VOICES.map((v, i) => [v.id, i]));
    voices.sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b));
    if (!voices.length) missing.push('at least one voice (for example af_heart.bin)');
    const m = has.get('model.onnx');
    return { ready: missing.length === 0, missing, voices, variant: m ? m.variant || '' : '', official: Boolean(m && m.verified) };
  }
  if (engineId === 'paradee') {
    if (!has.has('model.onnx')) missing.push('paradee_int8.onnx');
    if (!has.has('config.json')) missing.push('config.json');
    const m = has.get('model.onnx'), c = has.get('config.json');
    return { ready: missing.length === 0, missing, voices: [], variant: m ? m.variant || '' : '', official: Boolean(m && m.verified && c && c.verified) };
  }
  if (engineId === 'piper') {
    const byBase = new Map();
    for (const r of records) {
      const m = /^voices\/(.+)\.(onnx|json)$/.exec(r.key);
      if (!m) continue;
      if (!byBase.has(m[1])) byBase.set(m[1], {});
      byBase.get(m[1])[m[2]] = r;
    }
    const complete = [], partial = [];
    for (const [base, f] of byBase) {
      if (f.onnx && f.json) complete.push(base);
      else partial.push({ base, missing: f.onnx ? `${base}.onnx.json` : `${base}.onnx` });
    }
    complete.sort();
    if (!complete.length) missing.push(partial.length ? partial.map((p) => p.missing).join(', ') : 'at least one voice (an .onnx file and its .onnx.json file)');
    return { ready: complete.length > 0, missing, voices: complete, partial, variant: '', official: true };
  }
  return { ready: false, missing: [], voices: [], variant: '', official: false };
}

/** “Amy (US, medium)” style labels for the voices of a stored Piper set; multi-speaker voices list every speaker. */
export function piperVoiceList(records) {
  const out = [];
  for (const base of describeInstalled('piper', records).voices) {
    const cfg = records.find((r) => r.key === `voices/${base}.json`);
    const sum = (cfg && cfg.piper) || {};
    const m = PIPER_BASE_RE.exec(base);
    const known = PIPER_VOICES.find((v) => v.id === base);
    const name = known ? known.name : (m ? m[3] : base).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const region = m ? (PIPER_REGIONS[m[2].toUpperCase()] || m[2].toUpperCase()) : '';
    const lang = m ? m[1] : 'en';
    const tail = `${region}${region && m ? ', ' : ''}${m ? m[4].replace('_', ' ') : ''}`;
    if (sum.numSpeakers > 1 && sum.speakers && sum.speakers.length) {
      for (const sp of sum.speakers) out.push({ id: `${base}#${sp.id}`, label: `${name} · ${sp.name} (${tail})`, lang });
    } else out.push({ id: base, label: `${name} (${tail})`, lang });
  }
  return out;
}

/** Split a Piper voice id (“en_US-amy-medium” or “en_US-libritts_r-medium#12”) into its parts. */
export function parsePiperVoice(id) {
  const [base, sid] = String(id).split('#');
  return { base, speaker: sid === undefined ? null : Number(sid) };
}

/** A label for a Kokoro voice id: “Heart (US female)”. */
export function kokoroVoiceLabel(id) {
  const known = KOKORO_VOICES.find((v) => v.id === id);
  const name = known ? known.name : id.slice(3).replace(/^./, (c) => c.toUpperCase());
  const accent = id[0] === 'b' ? 'UK' : 'US';
  const gender = id[1] === 'm' ? 'male' : 'female';
  return { id, label: `${name} (${accent} ${gender})`, grade: known ? known.grade : '' };
}

/** Part of every cache key, so audio made by a different model file is not reused. Empty for the files the app was tested with. */
export function modelTag(engineId, records) {
  if (engineId === 'kokoro' || engineId === 'paradee') {
    const m = records.find((r) => r.key === 'model.onnx');
    if (!m) return '';
    return m.verified ? m.variant || '' : `u${String(m.sha256 || '').slice(0, 8)}`;
  }
  if (engineId === 'kitten') {
    const bad = records.filter((r) => r.key === 'model.onnx' && !r.verified);
    return bad.length ? `u${String(bad[0].sha256 || '').slice(0, 8)}` : '';
  }
  return '';
}
