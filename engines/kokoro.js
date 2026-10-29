// Kokoro 82M (Apache-2.0, hexgrad) through onnxruntime-web. The ONNX model, tokenizer.json and the voice
// files come from the browser's own storage (what the person added in the Models window).
// Runs inside engines/worker.js.
import { ort, espeak } from '../vendor/engines.bundle.js';
import { KOKORO_META } from './meta.js';
import { readBytes } from './model-store.js';
import { parseTokenizer } from './model-specs.js';
import { textToTokenChunks, styleRow, blendStyle, takeRowOffset, SAMPLE_RATE, STYLE_DIM } from './kokoro-text.js';
import { resample, semitonesToRatio } from './dsp.js';

const GAP = Math.round(SAMPLE_RATE * 0.1);   // silence between the pieces of a very long sentence

let session = null;
let vocab = null;
let idsName = 'input_ids';
const voices = new Map();   // voice id -> Float32Array(510 * 256)

async function voiceData(id) {
  if (!voices.has(id)) {
    let buf;
    try { buf = await readBytes('kokoro', `voices/${id}.bin`); }
    catch { throw new Error(`The voice ${id} hasn’t been added. Add its .bin file in the Models window.`); }
    voices.set(id, new Float32Array(buf));
  }
  return voices.get(id);
}

export const kokoro = {
  ...KOKORO_META,
  kind: 'pcm',

  async load(progress = () => {}, { threads } = {}) {
    if (session) return;
    progress('Reading the Kokoro files…');
    const [model, tokenizer] = await Promise.all([readBytes('kokoro', 'model.onnx'), readBytes('kokoro', 'tokenizer.json')]);
    const tok = parseTokenizer(new TextDecoder().decode(tokenizer));
    if (!tok.ok) throw new Error(tok.error);
    vocab = tok.vocab;
    if (threads) ort.env.wasm.numThreads = threads;
    ort.env.wasm.simd = true;
    progress('Loading Kokoro model…');
    session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    const names = session.inputNames;
    idsName = names.includes('input_ids') ? 'input_ids' : names.includes('tokens') ? 'tokens' : null;
    if (!idsName || !names.includes('style') || !names.includes('speed')) {
      session = null;
      throw new Error(`This model file has unexpected inputs (${names.join(', ')}). Use model_quantized.onnx or model.onnx from the onnx-community Kokoro repository.`);
    }
  },

  /**
   * opts: voice, speed, plus (all optional)
   *   voice2, mix  blend with a second voice (mix 0..1)
   *   take         0 = default delivery; 1, 2, 3… use a neighbouring style row
   *   pitch        semitones, done like Kitten: generate slower, then resample
   */
  async synth(text, { voice = 'af_heart', speed = 1, voice2, mix = 0, take = 0, pitch = 0 } = {}) {
    const ratio = semitonesToRatio(pitch);
    const chunks = await textToTokenChunks(text, { espeak, vocab, voiceId: voice });
    const v1 = await voiceData(voice);
    const v2 = voice2 && mix > 0 ? await voiceData(voice2) : null;
    const offset = takeRowOffset(take);
    const parts = [];
    for (const ids of chunks) {
      let style = styleRow(v1, ids.length, offset);
      if (v2) style = blendStyle(style, styleRow(v2, ids.length, offset), mix);
      const padded = new BigInt64Array(ids.length + 2);       // 0 at both ends
      for (let i = 0; i < ids.length; i++) padded[i + 1] = BigInt(ids[i]);
      const out = await session.run({
        [idsName]: new ort.Tensor('int64', padded, [1, padded.length]),
        style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
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
