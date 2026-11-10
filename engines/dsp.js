// Small audio helpers. Pure functions (no DOM, no WebAudio), tested in tests/dsp.test.mjs.

/** Semitones -> frequency ratio (+12 = 2). */
export const semitonesToRatio = (st) => 2 ** (st / 12);
export const dbToGain = (db) => 10 ** (db / 20);

// The tone controls are two shelf filters. Shared by live playback (WebAudio nodes) and export (offline render).
export const BASS_HZ = 200;
export const TREBLE_HZ = 4000;

/**
 * Change pitch and duration together by resampling: factor > 1 raises the pitch (and shortens the audio),
 * factor < 1 lowers it. Catmull-Rom (4-point cubic) interpolation. To change pitch alone, generate the
 * speech `factor` times slower first, so the resampling brings the duration back.
 */
export function resample(samples, factor) {
  if (Math.abs(factor - 1) < 1e-6) return samples;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / factor)));
  for (let i = 0; i < out.length; i++) out[i] = cubicAt(samples, i * factor);
  return out;
}

/**
 * Float samples in [-1, 1] -> Int16 PCM at `outRate`, resampled like `resample`. Writes 16-bit straight away,
 * so a long recording never needs a second full-size Float32 copy.
 */
export function resampleToInt16(samples, rate, outRate) {
  const factor = rate / outRate;
  const same = Math.abs(factor - 1) < 1e-6;
  const out = new Int16Array(same ? samples.length : Math.max(1, Math.floor(samples.length / factor)));
  for (let i = 0; i < out.length; i++) {
    const x = Math.max(-1, Math.min(1, same ? samples[i] : cubicAt(samples, i * factor)));
    out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return out;
}

/** Catmull-Rom (4-point cubic) value of `samples` at fractional position x (edges repeat the end samples). */
function cubicAt(samples, x) {
  const n = samples.length;
  const at = (i) => samples[i < 0 ? 0 : i >= n ? n - 1 : i];
  const i1 = Math.floor(x), t = x - i1;
  const p0 = at(i1 - 1), p1 = at(i1), p2 = at(i1 + 1), p3 = at(i1 + 2);
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Largest absolute sample of Int16 PCM, as 0..1. */
export function peakOf(pcm) {
  let m = 0;
  for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > m) m = a; }
  return m / 32768;
}

/**
 * Gain that brings the peak to `targetDb` (e.g. -1 dBFS), never boosting more than `maxBoostDb`.
 * Returns 1 for silent audio.
 */
export function normalizeGain(pcm, targetDb = -1, maxBoostDb = 12) {
  const peak = peakOf(pcm);
  if (peak < 1e-4) return 1;
  return Math.min(dbToGain(targetDb) / peak, dbToGain(maxBoostDb));
}

/**
 * [start, end) of the audible part of Int16 PCM: everything quieter than `thresholdDb` at the edges is
 * cut, keeping `marginMs` of lead-in/out. Returns the full range if nothing is audible.
 */
export function trimBounds(pcm, rate, thresholdDb = -48, marginMs = 40) {
  const thr = dbToGain(thresholdDb) * 32768;
  let a = 0, b = pcm.length - 1;
  while (a < pcm.length && Math.abs(pcm[a]) < thr) a++;
  if (a >= pcm.length) return [0, pcm.length];
  while (b > a && Math.abs(pcm[b]) < thr) b--;
  const m = Math.round((rate * marginMs) / 1000);
  return [Math.max(0, a - m), Math.min(pcm.length, b + 1 + m)];
}

/**
 * Join clips into one signal with silence between them: chunks are [{ samples, rate, gapAfter }] (seconds).
 * Clips at a different rate than the first are resampled to it. Returns { samples, rate }.
 */
export function concatWithGaps(chunks) {
  const rate = chunks[0].rate;
  const parts = chunks.map((c) => (c.rate === rate ? c.samples : resample(c.samples, c.rate / rate)));
  const gaps = chunks.map((c, i) => (i < chunks.length - 1 ? Math.round(rate * (c.gapAfter ?? 0)) : 0));
  const out = new Float32Array(parts.reduce((n, p, i) => n + p.length + gaps[i], 0));
  let o = 0;
  parts.forEach((p, i) => { out.set(p, o); o += p.length + gaps[i]; });
  return { samples: out, rate };
}
