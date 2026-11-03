// Static facts about each engine, shared by the main thread (UI) and the worker (inference).
// Keep this file free of heavy imports: the main thread loads it.
//
// The model files are not part of the app: people add them in the Models window (see model-specs.js),
// and they are read from the browser's own storage (model-store.js). A Kokoro voice only exists once its
// file has been added, so the page fills in that voice list at run time.

// What the UI offers for an engine. mix/take/pitch change the generated audio; fx = playback/export
// processing; override = per-sentence settings.
const CAPS = { pitch: true, mix: true, take: true, fx: true, override: true };

export const KITTEN_META = {
  id: 'kitten',
  label: 'Kitten TTS',
  normalize: false, // Kitten has its own number/currency preprocessing
  defaultSpeed: 1.6, // sounds slow at 1x; 1.6x (the top of the slider) sounds natural
  voices: [
    ['Bella', 'F'], ['Luna', 'F'], ['Rosie', 'F'], ['Kiki', 'F'],
    ['Jasper', 'M'], ['Bruno', 'M'], ['Hugo', 'M'], ['Leo', 'M'],
  ].map(([id, g]) => ({ id, label: `${id} (${g === 'F' ? 'female' : 'male'})` })),
  supportsSpeed: () => true,
  caps: CAPS,
};

export const KOKORO_META = {
  id: 'kokoro',
  label: 'Kokoro',
  normalize: false, // the engine cleans numbers, money and titles itself (kokoro-text.js)
  voices: [],       // filled in from the voice files that were added
  supportsSpeed: () => true,
  caps: CAPS,
};

// Paradee 1.2 has its four voices built into the model (one learned vector each, picked by index), so
// there are no style vectors to blend or step through: no mix and no takes.
export const PARADEE_META = {
  id: 'paradee',
  label: 'Paradee',
  normalize: false, // same text cleaning as Kokoro (kokoro-text.js)
  voices: [
    ['af_heart', 'Heart (US female)'], ['am_puck', 'Puck (US male)'],
    ['bf_isabella', 'Isabella (UK female)'], ['bm_fable', 'Fable (UK male)'],
  ].map(([id, label]) => ({ id, label })),
  supportsSpeed: () => true,
  caps: { pitch: true, mix: false, take: false, fx: true, override: true },
};

export const PIPER_META = {
  id: 'piper',
  label: 'Piper',
  normalize: false, // eSpeak reads numbers and abbreviations itself
  voices: [],       // filled in from the voices that were added
  supportsSpeed: () => true,
  caps: { pitch: true, mix: false, take: true, fx: true, override: true },
};
