// The browser's own speechSynthesis, included as a baseline to compare the tiny models against.
// Its audio can't be captured, so it has no WAV download.
function loadVoices() {
  return new Promise((resolve) => {
    const get = () => speechSynthesis.getVoices();
    if (get().length) return resolve(get());
    speechSynthesis.addEventListener('voiceschanged', () => resolve(get()), { once: true });
    setTimeout(() => resolve(get()), 1500);
  });
}

export const builtin = {
  id: 'builtin',
  label: 'Browser voice',
  kind: 'native',
  normalize: false,
  voices: [],
  files: [],
  supportsSpeed: () => true,
  caps: { pitch: true, mix: false, take: false, fx: false },
  available: () => 'speechSynthesis' in window,

  async refreshVoices() {
    const all = await loadVoices();
    this.voices = all
      .filter((v) => /^en/i.test(v.lang))
      .sort((a, b) => Number(b.localService) - Number(a.localService))
      .map((v) => ({ id: v.voiceURI, label: `${v.name}${v.localService ? '' : ' (online only)'}`, _v: v }));
    return this.voices;
  },

  speak(chunks, { voice, speed = 1, pitch = 0, onchunk } = {}) {
    speechSynthesis.cancel();
    const v = this.voices.find((x) => x.id === voice);
    return new Promise((resolve) => {
      chunks.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c);
        if (v) u.voice = v._v;
        u.rate = speed;
        u.pitch = Math.max(0.5, Math.min(2, 2 ** (pitch / 12)));
        if (onchunk) u.onstart = () => onchunk(i);
        if (i === chunks.length - 1) { u.onend = resolve; u.onerror = resolve; }
        speechSynthesis.speak(u);
      });
    });
  },

  stop() { speechSynthesis.cancel(); },
};
