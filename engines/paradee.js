// Paradee 8M v1.2 (Apache-2.0, Sahil Mahendrakar), a small model distilled from Kokoro 82M, through
// onnxruntime-web. Same phoneme vocabulary, input format and 24 kHz output as Kokoro, but the voices live in
// the model (an index from config.json) and the phonemes have to be in misaki's spelling (paradee-text.js).
// The model file and config.json come from the browser's own storage. Runs inside engines/worker.js.
import { ort, espeak } from '../vendor/engines.bundle.js';
import { PARADEE_META } from './meta.js';
import { readBytes } from './model-store.js';
import { parseParadeeConfig } from './model-specs.js';
import { textToTokenChunks, SAMPLE_RATE } from './kokoro-text.js';
import { toMisaki } from './paradee-text.js';
import { resample, semitonesToRatio } from './dsp.js';

const GAP = Math.round(SAMPLE_RATE * 0.1);   // silence between the pieces of a very long sentence

let session = null;
let vocab = null;
let voiceIndex = null;   // voice id -> its row in the model's voice table

export const paradee = {
  ...PARADEE_META,
  kind: 'pcm',

  async load(progress = () => {}, { threads } = {}) {
    if (session) return;
    progress('Reading the Paradee files…');
    const [model, config] = await Promise.all([readBytes('paradee', 'model.onnx'), readBytes('paradee', 'config.json')]);
    const cfg = parseParadeeConfig(new TextDecoder().decode(config));
    if (!cfg.ok) throw new Error(cfg.error);
    vocab = cfg.vocab;
    voiceIndex = new Map(cfg.voices.map((v, i) => [v, i]));
    if (threads) ort.env.wasm.numThreads = threads;
    ort.env.wasm.simd = true;
    progress('Loading Paradee model…');
    session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    const names = session.inputNames;
    if (!['input_ids', 'voice', 'speed'].every((n) => names.includes(n))) {
      session = null;
      throw new Error(`This model file has unexpected inputs (${names.join(', ')}). Use paradee_int8.onnx or paradee.onnx from Paradee-8M-v1.2 (older versions have no voice input).`);
    }
  },

  /**
   * opts: voice, speed, plus (optional)
   *   pitch        semitones, done like Kokoro: generate slower, then resample
   */
  async synth(text, { voice = 'af_heart', speed = 1, pitch = 0 } = {}) {
    const index = voiceIndex.get(voice);
    if (index === undefined) throw new Error(`This Paradee model has no voice ${voice}.`);
    const ratio = semitonesToRatio(pitch);
    const british = voice[0] === 'b';
    const chunks = await textToTokenChunks(text, { espeak, vocab, voiceId: voice, mapPhonemes: (ps) => toMisaki(ps, british) });
    const parts = [];
    for (const ids of chunks) {
      const padded = new BigInt64Array(ids.length + 2);       // 0 at both ends
      for (let i = 0; i < ids.length; i++) padded[i + 1] = BigInt(ids[i]);
      const out = await session.run({
        input_ids: new ort.Tensor('int64', padded, [1, padded.length]),
        voice: new ort.Tensor('int64', new BigInt64Array([BigInt(index)]), [1]),
        speed: new ort.Tensor('float32', new Float32Array([speed / ratio]), [1]),
      });
      const wave = out.waveform || out[session.outputNames[0]];
      parts.push(new Float32Array(wave.data));                // copy: the tensor's buffer belongs to the runtime
    }
    if (!parts.length) return { samples: new Float32Array(Math.round(SAMPLE_RATE * 0.05)), sampleRate: SAMPLE_RATE };
    const total = parts.reduce((n, p) => n + p.length, 0) + GAP * (parts.length - 1);
    const samples = new Float32Array(total);
    let at = 0;
    for (const p of parts) { samples.set(p, at); at += p.length + GAP; }
    return { samples: resample(samples, ratio), sampleRate: SAMPLE_RATE };
  },
};
