// Chatterbox (Resemble AI, MIT) through onnxruntime-web: four ONNX models that were added in the Models window.
// Runs inside engines/worker.js. The maths around the models lives in chatterbox-core.js.
//
// Memory is the limit here (about 1.5 GB of weights), so the voice listener (speech_encoder, 592 MB) is only
// loaded while a voice is being listened to, then released; what it learns about a voice is saved and reused.
import { ort } from '../vendor/engines.bundle.js';
import { CHATTERBOX_META } from './meta.js';
import { readBytes, listFiles, saveFile, removeFile } from './model-store.js';
import {
  parseChatterboxTokenizer, prepareText, chunkText, generateTokens, parseWav, prepareReference,
  packConditioning, unpackConditioning, SAMPLE_RATE, MAX_NEW_TOKENS, SILENCE_TOKEN, LAYERS, KV_HEADS, HEAD_DIM, AUDIO_DIM, DEFAULT_EXAGGERATION,
} from './chatterbox-core.js';

const E = 'chatterbox';
const LM_KEY = 'onnx/language_model.onnx', LM_DATA_KEY = 'onnx/language_model.onnx_data';
const GAP = Math.round(SAMPLE_RATE * 0.12);   // silence between the pieces of a long sentence

let tokenizer = null;
let embedSession = null, lmSession = null, decoderSession = null;
let threadCount = 0;
const conds = new Map();   // voice id -> the encoder's outputs

async function makeSession(name, label, progress) {
  const tRead = performance.now();
  progress(`Reading ${label}…`);
  // The writer is stored under one key; its weights file keeps the name the model refers to.
  const base = name === 'language_model' ? LM_KEY.replace(/\.onnx$/, '') : `onnx/${name}`;
  const dataName = name === 'language_model' ? 'language_model_q4.onnx_data' : `${name}.onnx_data`;
  const [model, hasData] = [await readBytes(E, `${base}.onnx`), (await listFiles(E)).some((r) => r.key === `${base}.onnx_data`)];
  const options = { executionProviders: ['wasm'] };
  if (hasData) options.externalData = [{ path: dataName, data: new Uint8Array(await readBytes(E, `${base}.onnx_data`)) }];
  const tMade = performance.now();
  progress(`Loading ${label}…`);
  try {
    const session = await ort.InferenceSession.create(new Uint8Array(model), options);
    console.info(`[Chatterbox] ${name}: read from storage ${((tMade - tRead) / 1000).toFixed(1)} s, started ${((performance.now() - tMade) / 1000).toFixed(1)} s (processor)`);
    return session;
  }
  catch (err) {
    const msg = (err && err.message) || String(err);
    if (/memory|alloc|abort|bad_alloc/i.test(msg)) throw new Error(`The browser ran out of memory loading ${label}. Chatterbox needs about 2 GB free: close other tabs, or use a computer with more memory.`);
    throw new Error(`${label} couldn’t be loaded (${msg.slice(0, 160)}). Check that its .onnx and .onnx_data files are both added and are the ones from the onnx folder.`);
  }
}

const f32 = (t) => (t.data instanceof Float32Array ? t.data : new Float32Array(t.data));

async function runEmbed(ids, positions, exaggeration) {
  const names = embedSession.inputNames;
  const feeds = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]) };
  if (names.includes('exaggeration')) feeds.exaggeration = new ort.Tensor('float32', new Float32Array([exaggeration]), [1]);
  if (names.includes('position_ids')) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from(positions, BigInt), [1, ids.length]);
  const out = await embedSession.run(feeds);
  const emb = out.inputs_embeds || out[embedSession.outputNames[0]];
  const copy = new Float32Array(f32(emb));
  emb.dispose && emb.dispose();
  return copy;
}

/** A language-model run that keeps its key/value cache between calls. */
function newLm() {
  const kv = lmSession.inputNames.filter((n) => n.startsWith('past_key_values.'));
  const zero = () => new ort.Tensor('float32', new Float32Array(0), [1, KV_HEADS, 0, HEAD_DIM]);
  let past = new Map(kv.map((n) => [n, zero()]));
  let pastLen = 0;
  const names = lmSession.inputNames;
  const step = async (embeds, seq) => {
    const dim = embeds.length / seq;
    const feeds = {
      inputs_embeds: new ort.Tensor('float32', embeds, [1, seq, dim]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(pastLen + seq).fill(1n), [1, pastLen + seq]),
    };
    if (names.includes('position_ids')) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from({ length: seq }, (_, i) => BigInt(pastLen + i)), [1, seq]);
    if (names.includes('use_cache_branch')) feeds.use_cache_branch = new ort.Tensor('bool', new Uint8Array([pastLen > 0 ? 1 : 0]), [1]);
    for (const [n, t] of past) feeds[n] = t;
    const out = await lmSession.run(feeds);
    const logits = out.logits || out[lmSession.outputNames[0]];
    const vocab = logits.dims[logits.dims.length - 1], rows = logits.dims[logits.dims.length - 2];
    const last = new Float32Array(f32(logits).subarray((rows - 1) * vocab, rows * vocab));
    const next = new Map();
    for (const n of lmSession.outputNames) {
      if (!n.startsWith('present')) continue;
      next.set(n.replace(/^present/, 'past_key_values'), out[n]);
    }
    for (const t of past.values()) t.dispose && t.dispose();
    logits.dispose && logits.dispose();
    past = next;
    pastLen += seq;
    return last;
  };
  step.dispose = () => { for (const t of past.values()) t.dispose && t.dispose(); past = new Map(); };
  return step;
}

/** Listen to a reference recording (24 kHz mono samples) and keep what the decoder needs about the voice. */
async function listen(samples, progress) {
  const enc = await makeSession('speech_encoder', 'the voice listener', progress);
  try {
    progress('Listening to the voice (once per voice, can take a minute or two)…');
    const out = await enc.run({ audio_values: new ort.Tensor('float32', samples, [1, samples.length]) });
    const c = {
      audioFeatures: new Float32Array(f32(out.audio_features)),
      audioTokens: BigInt64Array.from(out.audio_tokens.data, BigInt),
      speakerEmbeddings: new Float32Array(f32(out.speaker_embeddings)),
      speakerFeatures: new Float32Array(f32(out.speaker_features)),
    };
    return c;
  } finally { try { await enc.release(); } catch { /* already gone */ } }
}

async function voiceConditioning(voice, progress) {
  if (conds.has(voice)) return conds.get(voice);
  const condKey = `voices/${voice}.cond`;
  const records = await listFiles(E);
  let c = null;
  if (records.some((r) => r.key === condKey)) {
    try { c = unpackConditioning(await readBytes(E, condKey)); } catch { await removeFile(E, condKey); c = null; }
  }
  if (!c) {
    let samples;
    if (voice === 'default') {
      if (!records.some((r) => r.key === 'default_voice.wav')) throw new Error('The default voice (default_voice.wav) hasn’t been added. Add it in the Models window, or pick one of your own voices.');
      const wav = parseWav(new Uint8Array(await readBytes(E, 'default_voice.wav')));
      if (!wav.ok) throw new Error(wav.error);
      const ref = prepareReference(wav.samples, wav.sampleRate);
      if (!ref.ok) throw new Error(ref.error);
      samples = ref.samples;
    } else {
      if (!records.some((r) => r.key === `voices/${voice}.ref`)) throw new Error(`The voice ${voice} hasn’t been added. Add a recording of it in the Models window.`);
      samples = new Float32Array(await readBytes(E, `voices/${voice}.ref`));
    }
    c = await listen(samples, progress);
    const packed = new Blob([packConditioning(c)]);
    try { await saveFile(E, condKey, packed, { size: packed.size, sha256: null, verified: null }); } catch { /* next time it listens again */ }
  }
  conds.set(voice, c);
  return c;
}

export const chatterbox = {
  ...CHATTERBOX_META,
  kind: 'pcm',

  async load(progress = () => {}, { threads } = {}) {
    if (lmSession) return;
    progress('Reading the Chatterbox files…');
    const tok = parseChatterboxTokenizer(new TextDecoder().decode(await readBytes(E, 'tokenizer.json')));
    if (!tok.ok) throw new Error(tok.error);
    tokenizer = tok.tokenizer;
    if (threads) { ort.env.wasm.numThreads = threads; threadCount = threads; }
    ort.env.wasm.simd = true;
    try {
      embedSession = await makeSession('embed_tokens', 'the text reader', progress);
      decoderSession = await makeSession('conditional_decoder', 'the sound maker', progress);
      lmSession = await makeSession('language_model', 'the writer', progress);
    } catch (err) {
      for (const s of [embedSession, decoderSession, lmSession]) { try { s && await s.release(); } catch { /* ignore */ } }
      embedSession = decoderSession = lmSession = null;
      throw err;
    }
    const need = ['inputs_embeds', 'attention_mask'];
    const lmNames = lmSession.inputNames;
    if (need.some((n) => !lmNames.includes(n)) || !lmNames.some((n) => n.startsWith('past_key_values.'))) {
      embedSession = decoderSession = lmSession = null;
      throw new Error(`The writer model has unexpected inputs (${lmNames.slice(0, 6).join(', ')}…). Use a language_model file from the onnx folder of the onnx-community Chatterbox repository.`);
    }
    if (lmNames.filter((n) => n.startsWith('past_key_values.')).length !== LAYERS * 2) {
      embedSession = decoderSession = lmSession = null;
      throw new Error('The writer model isn’t the size this app expects. Use language_model_q4.onnx from the onnx-community Chatterbox repository.');
    }
  },

  /** opts: voice ('default' or a saved voice), exaggeration (0.25 to 2; 0.5 is neutral). Speed isn't adjustable. */
  async synth(text, { voice = 'default', exaggeration = DEFAULT_EXAGGERATION } = {}, progress = () => {}) {
    const pieces = chunkText(prepareText(text));
    if (!pieces.length) return { samples: new Float32Array(Math.round(SAMPLE_RATE * 0.05)), sampleRate: SAMPLE_RATE };
    const cond = await voiceConditioning(voice, progress);
    const parts = [];
    const slow = typeof self !== 'undefined' && self.crossOriginIsolated === false ? ' · one core only: this page isn’t cross-origin isolated, so it is slow' : '';
    let pi = 0;
    for (const piece of pieces) {
      pi++;
      progress(`Chatterbox writing part ${pi}/${pieces.length}${slow}`);
      const ids = tokenizer.encode(piece);
      const lmStep = newLm();
      const t = { embed: 0, writer: 0 };
      const timed = (key, fn) => async (...a) => { const t0 = performance.now(); try { return await fn(...a); } finally { t[key] += performance.now() - t0; } };
      const lm = Object.assign(timed('writer', lmStep), { dispose: lmStep.dispose });
      const tPiece = performance.now();
      let tokens;
      try {
        tokens = await generateTokens({
          ids, condFeatures: cond.audioFeatures,
          embed: timed('embed', (i, p) => runEmbed(i, p, exaggeration)),
          lm,
          onToken: (k) => { if (k % 8 === 0) progress(`Chatterbox writing part ${pi}/${pieces.length}, ${k} of up to ${MAX_NEW_TOKENS} steps${slow}`); },
        });
      } finally { lm.dispose(); }
      const tTok = performance.now() - tPiece;
      console.info(`[Chatterbox] part ${pi}/${pieces.length} timing: ${tokens.length} steps in ${(tTok / 1000).toFixed(1)} s (${(tTok / Math.max(1, tokens.length)).toFixed(0)} ms/step): writer ${(t.writer / 1000).toFixed(1)} s, text reader ${(t.embed / 1000).toFixed(1)} s, rest ${((tTok - t.writer - t.embed) / 1000).toFixed(1)} s`);
      if (!tokens.length) continue;
      const speech = new BigInt64Array(cond.audioTokens.length + tokens.length + 3);
      speech.set(cond.audioTokens, 0);
      tokens.forEach((t, i) => { speech[cond.audioTokens.length + i] = BigInt(t); });
      speech.fill(BigInt(SILENCE_TOKEN), speech.length - 3);
      const tDec = performance.now();
      const out = await decoderSession.run({
        speech_tokens: new ort.Tensor('int64', speech, [1, speech.length]),
        speaker_features: new ort.Tensor('float32', cond.speakerFeatures, [1, cond.speakerFeatures.length / 80, 80]),
        speaker_embeddings: new ort.Tensor('float32', cond.speakerEmbeddings, [1, cond.speakerEmbeddings.length]),
      });
      const wave = out.waveform || out[decoderSession.outputNames[0]];
      console.info(`[Chatterbox] part ${pi}/${pieces.length}: sound maker ran in ${((performance.now() - tDec) / 1000).toFixed(1)} s`);
      const w = new Float32Array(f32(wave));    // copy: the tensor's buffer belongs to the runtime
      let peak = 0, bad = 0;
      for (let i = 0; i < w.length; i++) { const a = Math.abs(w[i]); if (a !== a || a === Infinity) bad++; else if (a > peak) peak = a; }
      console.info(`[Chatterbox] part ${pi}/${pieces.length}: ${tokens.length} speech tokens (first: ${tokens.slice(0, 6).join(',')}), ${(w.length / SAMPLE_RATE).toFixed(1)} s, loudest sample ${peak.toFixed(3)}${bad ? `, ${bad} invalid values` : ''}`);
      if (bad || peak < 1e-3) throw new Error(`The audio came out ${bad ? 'broken (invalid numbers)' : 'silent'}. Details are in the browser console (lines starting with [Chatterbox]).`);
      parts.push(w);
    }
    if (!parts.length) return { samples: new Float32Array(Math.round(SAMPLE_RATE * 0.05)), sampleRate: SAMPLE_RATE };
    const total = parts.reduce((n, p) => n + p.length, 0) + GAP * (parts.length - 1);
    const samples = new Float32Array(total);
    let at = 0;
    for (const p of parts) { samples.set(p, at); at += p.length + GAP; }
    return { samples, sampleRate: SAMPLE_RATE };
  },

  /** Listen to a voice now (when it is added), so the first Speak doesn't have to. */
  async prepare(voice, progress = () => {}) {
    conds.delete(voice);
    await voiceConditioning(voice, progress);
  },

  /** Forget what was learned about a voice (its recording was replaced or removed). */
  forget(voice) { conds.delete(voice); },
};

void AUDIO_DIM; void threadCount;
