/**
 * KittenTTS — main class.
 *
 * Usage:
 *   const tts = await KittenTTS.from_pretrained('KittenML/kitten-tts-nano-0.8');
 *   const audio = await tts.generate('Hello world', { voice: 'Bella' });
 *   await audio.save('output.wav');
 */

import { downloadModel } from './model-loader.js';
import { loadNpz } from './npz-loader.js';
import { TextCleaner, basic_english_tokenize } from './text-cleaner.js';
import { TextPreprocessor } from './preprocess.js';
import { phonemize } from './phonemizer.js';
import { RawAudio } from './audio.js';

const SAMPLE_RATE = 24000;
const AUDIO_TRIM = 5000;  // trim last N samples from model output
const MAX_CHUNK_CHARS = 400;

/** Voice aliases: friendly name → internal NPZ key */
const DEFAULT_VOICE_ALIASES = {
  Bella: 'expr-voice-2-f',
  Jasper: 'expr-voice-2-m',
  Luna: 'expr-voice-3-f',
  Bruno: 'expr-voice-3-m',
  Rosie: 'expr-voice-4-f',
  Hugo: 'expr-voice-4-m',
  Kiki: 'expr-voice-5-f',
  Leo: 'expr-voice-5-m',
};
const DEFAULT_VOICE = 'Leo';

export class KittenTTS {
  /** @private */
  constructor(session, voices, config) {
    this._session = session;
    this._voices = voices;
    this._config = config;
    this._cleaner = new TextCleaner();
    this._preprocessor = new TextPreprocessor({ remove_punctuation: false });

    // Constants
    this.sampleRate = config.sample_rate || SAMPLE_RATE;
    this.voiceAliases = { ...DEFAULT_VOICE_ALIASES, ...(config.voice_aliases || {}) };
    this.speedPriors = config.speed_priors || {};
    this.availableVoices = Object.keys(this._voices);
  }

  /**
   * Load model from HuggingFace Hub.
   *
   * @param {string} [modelId='KittenML/kitten-tts-nano-0.8']
   * @param {{ dtype?: string, cacheDir?: string }} [opts]
   * @returns {Promise<KittenTTS>}
   */
  static async from_pretrained(modelId = 'KittenML/kitten-tts-nano-0.8', opts = {}) {
    const { modelBuffer, voicesBuffer, config } = await downloadModel(modelId, opts);

    // Load ONNX runtime (Node vs browser via conditional exports)
    let ort;
    try {
      ort = await import('onnxruntime-node');
    } catch {
      ort = await import('onnxruntime-web');
      // Tell onnxruntime-web where its .wasm files live.
      // In the GitHub Pages build the files are copied next to bundle.js.
      // Fall back to the jsDelivr CDN if running from a custom origin.
      if (!ort.env.wasm.wasmPaths) {
        try {
          // Resolve relative to the current script's location
          const scriptBase = new URL('.', import.meta.url).href;
          ort.env.wasm.wasmPaths = scriptBase;
        } catch {
          ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20/dist/';
        }
      }

      // Accelerate inference via WASM SIMD and Multi-threading
      // LOCAL CHANGE: the app can ask for a thread count (globalThis.KITTEN_THREADS) so several workers don't fight over the cores.
      ort.env.wasm.numThreads = globalThis.KITTEN_THREADS || (typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4);
      ort.env.wasm.simd = true;
    }

    const sessionOptions = ort.env.wasm ? { executionProviders: ['wasm'] } : {};
    const session = await ort.InferenceSession.create(modelBuffer, sessionOptions);
    const voices = await loadNpz(voicesBuffer);

    return new KittenTTS(session, voices, config);
  }

  /**
   * List available friendly voice names.
   * @returns {string[]}
   */
  list_voices() {
    return Object.keys(this.voiceAliases);
  }

  /**
   * Generate audio for the given text.
   *
   * @param {string} text
   * @param {{ voice?: string, speed?: number, clean?: boolean }} [opts]
   * @returns {Promise<RawAudio>}
   */
  async generate(text, opts = {}) {
    const { voice = DEFAULT_VOICE, speed = 1.0, clean = true, voice2, mix = 0, styleOffset = 0 } = opts;
    const chunks = this._chunkText(text);

    const audioChunks = [];
    for (const chunk of chunks) {
      const inputs = await this._prepareInputs(chunk, voice, speed, clean, { voice2, mix, styleOffset });
      const chunkAudio = await this._runInference(inputs);
      audioChunks.push(chunkAudio);
    }

    // Concatenate all chunks
    const totalLen = audioChunks.reduce((s, a) => s + a.length, 0);
    const combined = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of audioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return new RawAudio(combined, SAMPLE_RATE);
  }

  /**
   * Stream audio chunk-by-chunk (one per sentence).
   *
   * @param {string} text
   * @param {{ voice?: string, speed?: number, clean?: boolean }} [opts]
   * @yields {{ text: string, audio: RawAudio }}
   */
  async *stream(text, opts = {}) {
    const { voice = DEFAULT_VOICE, speed = 1.0, clean = true, voice2, mix = 0, styleOffset = 0 } = opts;
    const chunks = this._chunkText(text);

    for (const chunk of chunks) {
      const inputs = await this._prepareInputs(chunk, voice, speed, clean, { voice2, mix, styleOffset });
      const chunkAudio = await this._runInference(inputs);
      yield { text: chunk, audio: new RawAudio(chunkAudio, SAMPLE_RATE) };
    }
  }

  /**
   * Release the underlying ONNX Runtime session to free WebAssembly memory.
   * This is especially important in browsers to prevent memory leaks when switching models.
   */
  async release() {
    if (this._session && typeof this._session.release === 'function') {
      try {
        await this._session.release();
      } catch (err) {
        console.warn('[kitten-tts] Failed to release ONNX session:', err);
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Ensure text ends with punctuation. If not, add a comma.
   * Direct port from Python onnx_model.py.
   * @param {string} text
   * @returns {string}
   */
  _ensurePunctuation(text) {
    let t = text.trim();
    if (!t) return t;
    const last = t[t.length - 1];
    if (!['.', '!', '?', ',', ';', ':'].includes(last)) {
      t += ',';
    }
    return t;
  }

  /**
   * Split text into chunks for processing long texts.
   * Direct port from Python chunk_text().
   * @param {string} text
   * @returns {string[]}
   */
  _chunkText(text) {
    // Note: Python's re.split(r'[.!?]+', text) destroys the delimiter.
    const sentences = text.split(/[.!?]+/);
    const chunks = [];

    for (const s of sentences) {
      const sentence = s.trim();
      if (!sentence) continue;

      if (sentence.length <= MAX_CHUNK_CHARS) {
        chunks.push(this._ensurePunctuation(sentence));
      } else {
        // Split long sentences by words
        const words = sentence.split(/\s+/);
        let tempChunk = '';
        for (const word of words) {
          if (tempChunk.length + word.length + 1 <= MAX_CHUNK_CHARS) {
            tempChunk += tempChunk ? ` ${word}` : word;
          } else {
            if (tempChunk) {
              chunks.push(this._ensurePunctuation(tempChunk.trim()));
            }
            tempChunk = word;
          }
        }
        if (tempChunk) {
          chunks.push(this._ensurePunctuation(tempChunk.trim()));
        }
      }
    }

    return chunks;
  }

  /**
   * Preprocess text, phonemize, and build ONNX input tensors.
   * @private
   */
  async _prepareInputs(chunk, voiceName, speed, clean, extra = {}) {
    // 1. Preprocess
    const processedText = clean ? this._preprocessor.process(chunk) : chunk;

    // 2. Phonemize
    let phonemes = await phonemize(processedText);

    // 3. Tokenize → IDs with padding
    phonemes = basic_english_tokenize(phonemes).join(' ');
    const tokenIds = this._cleaner.clean(phonemes);

    // 4. Look up voice
    if (this.voiceAliases[voiceName]) {
      voiceName = this.voiceAliases[voiceName];
    }
    if (!this._voices[voiceName]) {
      throw new Error(`Voice '${voiceName}' not found. Available: ${this.availableVoices.join(', ')}`);
    }
    const voiceEntry = this._voices[voiceName];
    const voiceData = voiceEntry.data;
    const [numStyles, styleDim] = voiceEntry.shape;

    // 5. Apply speed priors from config metadata exactly like Python does
    let prior = this.speedPriors[voiceName] ?? 1;

    // ref_id = min(text_len, N-1)   (+ styleOffset: a neighbouring style row gives a different "take")
    const baseRef = Math.min(tokenIds.length, numStyles - 1);
    const refId = Math.max(0, Math.min(numStyles - 1, baseRef + (extra.styleOffset | 0)));
    let style = voiceData.slice(refId * styleDim, (refId + 1) * styleDim);

    // LOCAL CHANGE: blend with a second voice (same style row of both voices, linear mix).
    const mix = Math.max(0, Math.min(1, Number(extra.mix) || 0));
    if (extra.voice2 && mix > 0) {
      let v2 = extra.voice2;
      if (this.voiceAliases[v2]) v2 = this.voiceAliases[v2];
      if (!this._voices[v2]) throw new Error(`Voice '${v2}' not found.`);
      const d2 = this._voices[v2].data;
      const r2 = Math.min(refId, this._voices[v2].shape[0] - 1);
      const other = d2.slice(r2 * styleDim, (r2 + 1) * styleDim);
      style = style.map((x, i) => x * (1 - mix) + other[i] * mix);
      prior = prior * (1 - mix) + (this.speedPriors[v2] ?? 1) * mix;
    }
    speed = speed * prior;

    return {
      input_ids: tokenIds,
      style,
      styleDim,
      speed,
    };
  }

  /**
   * Run ONNX inference and return trimmed audio samples.
   * @private
   */
  async _runInference({ input_ids, style, styleDim, speed }) {
    let ort;
    try {
      ort = await import('onnxruntime-node');
    } catch {
      ort = await import('onnxruntime-web');
    }
    // (wasmPaths already set in from_pretrained)

    const seqLen = input_ids.length;
    const inputIdsTensor = new ort.Tensor('int64',
      BigInt64Array.from(input_ids.map(BigInt)),
      [1, seqLen]);

    const styleTensor = new ort.Tensor('float32',
      new Float32Array(style),
      [1, styleDim]);

    const speedTensor = new ort.Tensor('float32',
      new Float32Array([speed]),
      [1]);

    const feeds = {
      input_ids: inputIdsTensor,
      style: styleTensor,
      speed: speedTensor,
    };

    const results = await this._session.run(feeds);

    // Output key is usually 'audio' or first key
    const outputKey = Object.keys(results)[0];
    const audioData = results[outputKey].data; // Float32Array (flat)

    // Trim last AUDIO_TRIM samples
    const trimmed = audioData.slice(0, Math.max(0, audioData.length - AUDIO_TRIM));
    return new Float32Array(trimmed);
  }
}
