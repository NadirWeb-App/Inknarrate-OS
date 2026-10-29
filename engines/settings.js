// Voice and sound settings that aren't tied to one engine, plus presets and per-sentence takes.
// Stored in localStorage (every access is guarded: it can be unavailable).

/**
 * Defaults. "Baked" settings change the generated audio (so they're part of each sentence's cache key):
 * voice2, mix, pitch (and voice, speed, kept elsewhere). "Live" settings are applied while playing and
 * exporting, so changing them never regenerates anything.
 */
export const DEFAULT_FX = {
  voice2: '',          // second voice to blend in ('' = none)          baked
  mix: 0.5,            // 0..1 share of the second voice                baked
  pitch: 0,            // semitones                                     baked
  gain: 0,             // dB                                            live
  bass: 0,             // dB                                            live
  treble: 0,           // dB                                            live
  normalize: false,    // even out loudness between sentences           live
  trim: false,         // cut silence at sentence edges                 live
  gapSentence: 0.12,   // seconds of pause after a sentence             live
  gapPara: 0.5,        // seconds of pause after a paragraph            live
  rules: '',           // pronunciation rules text (see pronounce.js)   baked (through the text)
};

/** Fields saved in a preset (the pronunciation rules are not: they belong to your text, not a voice). */
export const PRESET_FIELDS = ['voice2', 'mix', 'pitch', 'gain', 'bass', 'treble', 'normalize', 'trim', 'gapSentence', 'gapPara'];

export const MAX_TAKES = 6; // retake cycles through take 1..6, then back to the default

function read(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }

export const loadFx = () => ({ ...DEFAULT_FX, ...read('tts:fx', {}) });
export const saveFx = (fx) => write('tts:fx', fx);
export const loadPresets = () => read('tts:presets', {});
export const savePresets = (p) => write('tts:presets', p);
export const loadTakes = () => read('tts:takes', {});
export const saveTakes = (t) => write('tts:takes', t);

/** Allowed range of each numeric setting (the sliders use the same ones). Used to sanitize opened project files. */
export const FX_LIMITS = {
  speed: [0.6, 1.6], mix: [0, 1], pitch: [-3, 3], gain: [-12, 12], bass: [-8, 8], treble: [-8, 8],
  gapSentence: [0, 1.5], gapPara: [0, 3], pause: [0, 3],
};

/**
 * Per-sentence overrides: { voice?, speed?, pitch?, pause? }, stored by the hash of the sentence text.
 * Anything not set follows the global setting. Returns the cleaned override, or null if nothing is set.
 */
export function cleanOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  if (typeof o.voice === 'string' && o.voice) out.voice = o.voice.slice(0, 200);
  for (const k of ['speed', 'pitch', 'pause']) if (typeof o[k] === 'number' && Number.isFinite(o[k])) out[k] = clamp(o[k], FX_LIMITS[k]);
  return Object.keys(out).length ? out : null;
}

/** Sentence hashes (hash53) are base-36 strings of at most 11 characters. */
export const MAX_OVERRIDES = 5000;
export const loadOverrides = () => {
  const raw = read('tts:overrides', {});
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const c = /^[0-9a-z]{1,13}$/.test(k) ? cleanOverride(v) : null;
    if (c) out[k] = c;
  }
  return out;
};
export const saveOverrides = (o) => write('tts:overrides', o);
