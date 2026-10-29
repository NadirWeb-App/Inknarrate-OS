/**
 * kitten-tts-js — TypeScript declarations
 */

export interface ModelOptions {
  /** Quantization / precision hint. Default: 'fp32' */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Override local cache directory (Node.js only). Default: ~/.cache/kitten-tts */
  cacheDir?: string;
}

export interface GenerateOptions {
  /**
   * Friendly voice name (e.g. 'Bella', 'Leo') or internal key (e.g. 'expr-voice-2-f').
   * Default: 'Leo'
   */
  voice?: string;
  /** Speed multiplier. Default: 1.0 */
  speed?: number;
  /** Run text preprocessor (number/currency/time expansion). Default: true */
  clean?: boolean;
}

export interface StreamChunk {
  /** The sentence text that was synthesized. */
  text: string;
  /** The synthesized audio for this sentence. */
  audio: RawAudio;
}

export declare class RawAudio {
  /** Raw PCM samples (mono Float32). */
  readonly data: Float32Array;
  /** Sampling rate in Hz (typically 24000). */
  readonly sampling_rate: number;

  constructor(data: Float32Array, sampling_rate: number);

  /** Encode to WAV bytes (16-bit PCM, mono). */
  toWav(): ArrayBuffer;

  /** Save WAV to a file path (Node.js only). */
  save(filePath: string): Promise<void>;

  /** Create a Blob for browser download/playback. */
  toBlob(): Blob;

  /** Create a Web Audio API AudioBuffer. */
  toAudioBuffer(audioContext: AudioContext): AudioBuffer;

  /** Duration in seconds. */
  readonly duration: number;
}

export declare class KittenTTS {
  /**
   * Load a KittenTTS model from HuggingFace Hub.
   *
   * @param modelId HuggingFace repo ID. Default: 'KittenML/kitten-tts-nano-0.8'
   * @param opts    Download / dtype options.
   */
  static from_pretrained(
    modelId?: string,
    opts?: ModelOptions
  ): Promise<KittenTTS>;

  /** List available friendly voice names (e.g. ['Bella', 'Leo', …]). */
  list_voices(): string[];

  /**
   * Synthesize text to audio.
   *
   * @param text  Input text (plain or with numbers/punctuation).
   * @param opts  Voice, speed, and preprocessing options.
   */
  generate(text: string, opts?: GenerateOptions): Promise<RawAudio>;

  /**
   * Stream synthesized audio sentence-by-sentence.
   *
   * @param text  Input text.
   * @param opts  Voice, speed, and preprocessing options.
   */
  stream(text: string, opts?: GenerateOptions): AsyncGenerator<StreamChunk>;
}

export declare class TextCleaner {
  /** Convert a phoneme string to padded token IDs ready for the model. */
  clean(phonemes: string): number[];
  /** Full symbol list (for debugging). */
  readonly symbols: string[];
  /** Vocabulary size. */
  readonly vocabSize: number;
}

export declare class TextPreprocessor {
  /** Normalize text: expand numbers, currency, abbreviations, URLs, etc. */
  process(text: string): string;
}

/** Phonemize text using eSpeak-NG. */
export declare function phonemize(text: string): Promise<string>;

/** Load a .npz archive into a map of Float32Array tensors. */
export declare function loadNpz(
  npzBuffer: ArrayBuffer | Buffer
): Promise<Record<string, { data: Float32Array; shape: number[] }>>;

/** Download model files from HuggingFace Hub. */
export declare function downloadModel(
  repoId: string,
  opts?: ModelOptions
): Promise<{ modelBuffer: ArrayBuffer; voicesBuffer: ArrayBuffer; config: Record<string, unknown> }>;

/** Available model IDs. */
export declare const MODELS: Record<string, { label: string }>;
