// Piper (MIT code; each voice has its own licence) through onnxruntime-web. A voice is two files from the
// browser's own storage: <name>.onnx and <name>.onnx.json (what the person added in the Models window).
// Runs inside engines/worker.js. Voices load on first use; the most recent two stay in memory.
import { ort, espeak } from '../vendor/engines.bundle.js';
import { PIPER_META } from './meta.js';
import { readBytes, listFiles } from './model-store.js';
import { parsePiperVoice } from './model-specs.js';
import { textToPiperIds, takeNoise, limitPeak, TARGET_RATE } from './piper-text.js';
import { resample, semitonesToRatio } from './dsp.js';
import * as full from './espeak-full.js';
import { addVowelMarks } from './tashkeel.js';

const KEEP = 2;
const GAP = Math.round(TARGET_RATE * 0.12);   // silence between the pieces of a long sentence
const loaded = new Map();                     // voice base -> { session, cfg, voice (eSpeak name), hasSid }
let threadCount = 0;

/**
 * How to get phonemes for a voice's eSpeak language. English uses the phonemizer in the main bundle (small, fast);
 * every other language uses the full eSpeak build, which is fetched on first use. A language is never swapped for another:
 * if eSpeak doesn't know the voice, the voice can't be used (English accent names are the one exception, falling back to en / en-us).
 */
async function speakerFor(name) {
  if (/^en(-|$)/i.test(name)) {
    const works = async (v) => { try { return ((await espeak('hello', v)) || []).join('').length > 0; } catch { return false; } };
    const use = (await works(name)) ? name : /^en-(gb|uk)/i.test(name) ? 'en' : 'en-us';
    return async (pieces) => { const out = []; for (const p of pieces) out.push(((await espeak(p, use)) || []).join(' ')); return out; };
  }
  if (!(await full.hasVoice(name))) throw new Error(`This voice needs the eSpeak language “${name}”, which this app doesn’t include.`);
  return (pieces) => full.phonemizePieces(pieces, name);
}

async function voiceFor(base) {
  if (loaded.has(base)) { const v = loaded.get(base); loaded.delete(base); loaded.set(base, v); return v; }
  let model, cfgBytes;
  try { [model, cfgBytes] = await Promise.all([readBytes('piper', `voices/${base}.onnx`), readBytes('piper', `voices/${base}.json`)]); }
  catch { throw new Error(`The voice ${base} isn’t fully added. It needs both ${base}.onnx and ${base}.onnx.json (Models window).`); }
  const cfg = JSON.parse(new TextDecoder().decode(cfgBytes));
  if (threadCount) ort.env.wasm.numThreads = threadCount;
  ort.env.wasm.simd = true;
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
  const names = session.inputNames;
  if (!names.includes('input') || !names.includes('input_lengths') || !names.includes('scales')) {
    throw new Error(`${base}.onnx has unexpected inputs (${names.join(', ')}). Use a voice from the rhasspy/piper-voices repository.`);
  }
  const v = { session, cfg, speak: await speakerFor(cfg.espeak.voice), hasSid: names.includes('sid'),
    prepare: /^ar(-|$)/i.test(cfg.espeak.voice) ? addVowelMarks : null };   // Arabic: restore the vowel marks first
  loaded.set(base, v);
  while (loaded.size > KEEP) loaded.delete(loaded.keys().next().value);   // oldest out (its memory is released with it)
  return v;
}

export const piper = {
  ...PIPER_META,
  kind: 'pcm',

  /** Nothing is loaded up front (a voice loads when first used); just make sure something is stored. */
  async load(progress = () => {}, { threads } = {}) {
    threadCount = threads || 0;
    progress('Checking the Piper voices…');
    const recs = await listFiles('piper');
    if (!recs.some((r) => r.key.endsWith('.onnx'))) throw new Error('No Piper voice has been added yet. Add a voice in the Models window.');
  },

  /**
   * opts: voice (“base” or “base#speaker”), speed, plus (all optional)
   *   take   0 = the voice's defaults; 1, 2, 3… vary the noise a little
   *   pitch  semitones, as for the other engines: generate slower, then resample
   */
  async synth(text, { voice, speed = 1, take = 0, pitch = 0 } = {}) {
    const { base, speaker } = parsePiperVoice(voice || '');
    if (!base) throw new Error('No Piper voice is selected.');
    const { session, cfg, speak, hasSid, prepare } = await voiceFor(base);
    const ratio = semitonesToRatio(pitch);
    const inf = cfg.inference || {};
    const noise = takeNoise(Number.isFinite(inf.noise_scale) ? inf.noise_scale : 0.667, take);
    const noiseW = takeNoise(Number.isFinite(inf.noise_w) ? inf.noise_w : 0.8, take);
    const length = (Number.isFinite(inf.length_scale) ? inf.length_scale : 1) * ratio / speed;   // > 1 is slower
    const rate = cfg.audio.sample_rate;
    const chunks = await textToPiperIds(text, { speakPieces: speak, idMap: cfg.phoneme_id_map, prepare });
    const parts = [];
    for (const ids of chunks) {
      const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor('float32', Float32Array.from([noise, length, noiseW]), [3]),
      };
      if (hasSid) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker ?? 0)]), [1]);
      const out = await session.run(feeds);
      parts.push(limitPeak(new Float32Array(out[session.outputNames[0]].data)));   // copy: the buffer belongs to the runtime
    }
    const gap = Math.round(GAP * rate / TARGET_RATE);
    const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
    if (!total) return { samples: new Float32Array(Math.round(TARGET_RATE * 0.05)), sampleRate: TARGET_RATE };
    const joined = new Float32Array(total);
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length + gap; }
    // One resample does both jobs: the pitch change and conversion to 24 kHz.
    return { samples: resample(joined, ratio * rate / TARGET_RATE), sampleRate: TARGET_RATE };
  },
};
