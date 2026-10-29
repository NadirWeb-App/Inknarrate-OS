// Project files: your text and settings saved as a small JSON file (no audio; audio is regenerated, and
// anything already generated is found again in the cache). Pure functions, tested in tests/export.test.mjs.
//
// Opening a file is opening untrusted input, so parseProject() copies only known fields, converts them to
// the expected type and clamps numbers into their allowed range. Nothing from the file is used as code,
// and unknown fields (including __proto__) are ignored.
import { DEFAULT_FX, PRESET_FIELDS, FX_LIMITS, MAX_TAKES, MAX_OVERRIDES, cleanOverride } from './settings.js';

export const PROJECT_FORMAT = 'offline-tts-project';
export const PROJECT_VERSION = 1;
export const MAX_PROJECT_BYTES = 8e6;   // refuse bigger files before reading them
const MAX_TEXT = 2e6;                   // characters
const MAX_RULES = 2e4;
const MAX_TAKE_ENTRIES = 5000;

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, range, fallback) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, range) : fallback);

/**
 * state: { text, engine, voice, speed, fx, split: { periods, lines }, takes }
 * Takes: { textHash: n }, pass only the ones for the sentences that are in the text.
 */
export function makeProject({ text, engine, voice, speed, fx, split, takes, overrides = {} }) {
  const settings = {};
  for (const k of [...PRESET_FIELDS, 'rules']) settings[k] = fx[k];
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    text, engine, voice, speed,
    settings,
    split: { periods: Boolean(split.periods), lines: Boolean(split.lines) },
    takes: { ...takes },
    overrides: { ...overrides },
  };
}

/** Returns { ok: true, project } with sanitized fields, or { ok: false, error } in plain words. */
export function parseProject(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { ok: false, error: 'This file is not valid JSON.' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== PROJECT_FORMAT) {
    return { ok: false, error: 'This is not a project file from this app.' };
  }
  if (!Number.isInteger(data.version) || data.version < 1) return { ok: false, error: 'The project file has no valid version.' };
  if (data.version > PROJECT_VERSION) return { ok: false, error: 'This project was saved by a newer version of the app. Update the app and try again.' };

  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const settings = { ...DEFAULT_FX };
  settings.voice2 = str(s.voice2, 200);
  for (const k of ['mix', 'pitch', 'gain', 'bass', 'treble', 'gapSentence', 'gapPara']) settings[k] = num(s[k], FX_LIMITS[k], DEFAULT_FX[k]);
  settings.normalize = s.normalize === true;
  settings.trim = s.trim === true;
  settings.rules = str(s.rules, MAX_RULES);

  const takes = {};
  if (data.takes && typeof data.takes === 'object' && !Array.isArray(data.takes)) {
    let count = 0;
    for (const [k, v] of Object.entries(data.takes)) {
      if (count >= MAX_TAKE_ENTRIES) break;
      if (/^[0-9a-z]{1,13}$/.test(k) && Number.isInteger(v) && v >= 1 && v <= MAX_TAKES) { takes[k] = v; count++; }
    }
  }

  const overrides = {};
  if (data.overrides && typeof data.overrides === 'object' && !Array.isArray(data.overrides)) {
    let count = 0;
    for (const [k, v] of Object.entries(data.overrides)) {
      if (count >= MAX_OVERRIDES) break;
      const o = /^[0-9a-z]{1,13}$/.test(k) ? cleanOverride(v) : null;
      if (o) { overrides[k] = o; count++; }
    }
  }

  const sp = data.split && typeof data.split === 'object' ? data.split : {};
  return {
    ok: true,
    project: {
      text: str(data.text, MAX_TEXT),
      engine: str(data.engine, 64),
      voice: str(data.voice, 200),
      speed: num(data.speed, FX_LIMITS.speed, 1),
      settings,
      split: { periods: sp.periods !== false, lines: sp.lines !== false },
      takes,
      overrides,
    },
  };
}
