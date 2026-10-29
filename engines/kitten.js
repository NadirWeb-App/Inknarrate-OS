// Kitten TTS (Apache-2.0) via the kitten-tts-js port. The model files come from the browser's own storage
// (what the person added in the Models window), not from the network. Runs inside engines/worker.js.
import { KittenTTS } from '../vendor/engines.bundle.js';
import { KITTEN_META } from './meta.js';
import { readBytes } from './model-store.js';
import { resample, semitonesToRatio } from './dsp.js';

let tts = null;

/** The library asks for config.json, the model file named inside it, and the voices file. */
function read(name) {
  const key = name === 'config.json' ? 'config.json' : /\.onnx$/i.test(name) ? 'model.onnx' : name;
  return readBytes('kitten', key);
}

export const kitten = {
  ...KITTEN_META,
  kind: 'pcm',

  async load(progress = () => {}, { threads } = {}) {
    if (tts) return;
    if (threads) globalThis.KITTEN_THREADS = threads;
    progress('Loading Kitten model…');
    globalThis.KITTEN_READ = read;
    tts = await KittenTTS.from_pretrained('KittenML/kitten-tts-nano-0.8');
  },

  /**
   * opts: voice, speed, plus (all optional)
   *   voice2, mix  blend the voice with a second one (mix 0..1)
   *   take         0 = default delivery; 1, 2, 3… pick a neighbouring style row for a different, similar delivery
   *   pitch        semitones. The model has no pitch input, so generate slower and resample (pitch up = shorter
   *                audio, so slow the speech down by the same factor first to keep the duration)
   */
  async synth(text, { voice = 'Leo', speed = 1, voice2, mix = 0, take = 0, pitch = 0 } = {}) {
    const ratio = semitonesToRatio(pitch);
    const styleOffset = take === 0 ? 0 : (take % 2 ? 1 : -1) * Math.ceil(take / 2) * 4;
    const audio = await tts.generate(text, { voice, speed: speed / ratio, voice2, mix, styleOffset });
    return { samples: resample(audio.data, ratio), sampleRate: audio.sampling_rate };
  },
};
