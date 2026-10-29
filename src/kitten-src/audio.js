/**
 * RawAudio: wraps a Float32Array waveform with sampling_rate metadata.
 * Provides WAV export for both Node.js and browser.
 */

/**
 * Encode Float32Array PCM to a WAV ArrayBuffer (16-bit PCM, mono).
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate) {
  const numSamples = samples.length;
  const bitsPerSample = 16;
  const numChannels = 1;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples: Float32 → Int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

export class RawAudio {
  /**
   * @param {Float32Array} data   — mono PCM samples
   * @param {number} sampling_rate
   */
  constructor(data, sampling_rate) {
    this.data = data;
    this.sampling_rate = sampling_rate;
  }

  /**
   * Encode to WAV bytes.
   * @returns {ArrayBuffer}
   */
  toWav() {
    return encodeWav(this.data, this.sampling_rate);
  }

  /**
   * Save WAV to a file path (Node.js only).
   * @param {string} filePath
   */
  async save(filePath) {
    const { default: fs } = await import('fs');
    const wav = this.toWav();
    fs.writeFileSync(filePath, Buffer.from(wav));
    console.log(`[kitten-tts] Saved WAV: ${filePath} (${this.data.length} samples @ ${this.sampling_rate} Hz)`);
  }

  /**
   * Create a Blob suitable for download or audio playback (browser).
   * @returns {Blob}
   */
  toBlob() {
    return new Blob([this.toWav()], { type: 'audio/wav' });
  }

  /**
   * Create a Web Audio AudioBuffer (browser only).
   * @param {AudioContext} audioContext
   * @returns {AudioBuffer}
   */
  toAudioBuffer(audioContext) {
    const audioBuf = audioContext.createBuffer(1, this.data.length, this.sampling_rate);
    audioBuf.copyToChannel(this.data, 0);
    return audioBuf;
  }

  /** Duration in seconds. */
  get duration() {
    return this.data.length / this.sampling_rate;
  }
}
