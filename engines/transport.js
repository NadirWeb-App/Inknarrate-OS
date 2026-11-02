// Playback of a list of sentences through WebAudio, with play/pause, seek, previous/next.
//
// The transport doesn't know about generation. It asks `provide(index)` for each sentence's audio
// ({ samples: Float32Array, rate }, or null if that sentence failed) and plays the answers in order,
// one or two ahead of the playhead, so consecutive sentences are gapless and a sentence that is still
// being generated just makes the transport wait ("waiting" state).
//
//   items:    [{ id, gapAfter }]   what to play, in order (a snapshot: editing the text doesn't change it)
//   state:    'idle' | 'playing' | 'waiting' (buffering) | 'paused'

import { dbToGain, BASS_HZ, TREBLE_HZ } from './dsp.js';

const LOOKAHEAD = 2;   // sentences scheduled ahead of the one playing
const START_DELAY = 0.03;

export class Transport {
  constructor({ provide, onitem = () => {}, onpos = () => {}, onstate = () => {}, onend = () => {} }) {
    this.provide = provide;
    this.onitem = onitem;    // (index) a sentence started playing
    this.onpos = onpos;      // ({ index, offset, dur, covered }) about 20 times a second while active
    this.onstate = onstate;  // (state)
    this.onend = onend;      // the last sentence finished by itself
    this.ctx = null;
    this.gain = null;        // master volume (what the player's volume slider controls)
    this.input = null;       // start of the tone chain: gain -> bass shelf -> treble shelf -> master volume
    this.fx = { gainDb: 0, bassDb: 0, trebleDb: 0 };
    this.volume = 1;
    this.muted = false;
    this.items = [];
    this.state = 'idle';
    this.token = 0;          // bumped by play/stop: stale async work discards itself
    this.sched = [];         // scheduled clips: { i, src, when, start, end, dur }
    this.lastDone = null;    // the most recent clip that finished playing
    this.nextIdx = 0;
    this.firstIdx = 0;
    this.firstOffset = 0;
    this.lastEnd = 0;
    this.loading = false;
    this.timer = null;
    this.lastItem = -1;
  }

  get active() { return this.state !== 'idle'; }

  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.input = this.ctx.createGain();
    this.low = this.ctx.createBiquadFilter();
    this.low.type = 'lowshelf'; this.low.frequency.value = BASS_HZ;
    this.high = this.ctx.createBiquadFilter();
    this.high.type = 'highshelf'; this.high.frequency.value = TREBLE_HZ;
    this.input.connect(this.low); this.low.connect(this.high); this.high.connect(this.gain);
    this._applyGain();
    this._applyFx();
  }

  _applyGain() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }

  /** Tone controls, applied live to everything playing and scheduled: { gainDb, bassDb, trebleDb }. */
  setFx(fx) { this.fx = { ...this.fx, ...fx }; this._applyFx(); }
  _applyFx() {
    if (!this.input) return;
    this.input.gain.value = dbToGain(this.fx.gainDb);
    this.low.gain.value = this.fx.bassDb;
    this.high.gain.value = this.fx.trebleDb;
  }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this._applyGain(); }
  setMuted(m) { this.muted = !!m; this._applyGain(); }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onstate(s);
  }

  _stopSources() {
    for (const e of this.sched) { e.src.onended = null; try { e.src.stop(); } catch { /* not started */ } try { e.src.disconnect(); } catch { /* gone */ } }
    this.sched = [];
  }

  /** Start playing `items` from sentence `index`, `offset` seconds in. Call from a user gesture. */
  async play(items, index = 0, offset = 0) {
    const token = ++this.token;
    this.wantPaused = false;
    this._stopSources();
    clearInterval(this.timer);
    this.items = items;
    this.nextIdx = this.firstIdx = Math.max(0, Math.min(index, items.length - 1));
    this.firstOffset = offset;
    this.lastEnd = 0;
    this.lastDone = null;
    this.lastItem = -1;
    this.loading = false;
    this._ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (token !== this.token) return;
    this._setState('waiting');
    this.timer = setInterval(() => this._tick(), 50);
    this._pump();
  }

  _pump() {
    if (this.loading || !this.active || this.nextIdx >= this.items.length) return;
    const now = this.ctx.currentTime;
    if (this.sched.filter((e) => e.end > now).length >= LOOKAHEAD) return;
    const i = this.nextIdx, token = this.token;
    this.loading = true;
    Promise.resolve()
      .then(() => this.provide(i))
      .catch(() => null)
      .then((clip) => {
        if (token !== this.token) return;
        this.loading = false;
        if (clip && clip.samples.length) this._schedule(i, clip);
        this.nextIdx = i + 1;
        this._pump();
      });
  }

  _schedule(i, clip) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, clip.samples.length, clip.rate);
    buf.copyToChannel(clip.samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.input);
    const offset = i === this.firstIdx ? Math.min(this.firstOffset, Math.max(0, buf.duration - 0.01)) : 0;
    const when = Math.max(ctx.currentTime + START_DELAY, this.lastEnd);
    src.start(when, offset);
    const entry = { i, src, when, start: when - offset, end: when + (buf.duration - offset), dur: buf.duration };
    this.sched.push(entry);
    this.lastEnd = entry.end + (this.items[i].gapAfter ?? 0.12);
    src.onended = () => { try { src.disconnect(); } catch { /* gone */ } };
  }

  /** Where the playhead is: { index, offset, dur, covered } (covered = a sentence is audible right now). */
  position() {
    if (!this.active) return null;
    const now = this.ctx.currentTime;
    for (const e of this.sched) {
      if (now >= e.when && now < e.end) return { index: e.i, offset: Math.max(0, now - e.start), dur: e.dur, covered: true };
    }
    const upcoming = this.sched.some((e) => e.when > now);
    if (this.lastDone && (upcoming || this.nextIdx >= this.items.length)) {
      return { index: this.lastDone.i, offset: this.lastDone.dur, dur: this.lastDone.dur, covered: false };
    }
    const index = Math.min(this.nextIdx, this.items.length - 1);
    return { index, offset: this.lastDone || index !== this.firstIdx ? 0 : this.firstOffset, dur: 0, covered: false, waiting: true };
  }

  _tick() {
    if (!this.active) return;
    const now = this.ctx.currentTime;
    for (const e of this.sched) if (e.end <= now && (!this.lastDone || e.end > this.lastDone.end)) this.lastDone = e;
    this.sched = this.sched.filter((e) => e.end > now - 0.5);
    this._pump();

    const pos = this.position();
    if (this.state !== 'paused') this._setState(pos.waiting ? 'waiting' : 'playing');
    if (pos.covered && pos.index !== this.lastItem) { this.lastItem = pos.index; this.onitem(pos.index); }
    this.onpos(pos);

    const finished = this.nextIdx >= this.items.length && !this.loading && this.sched.every((e) => e.end <= now);
    if (finished && this.state !== 'paused') {
      this.token++;
      clearInterval(this.timer);
      this._setState('idle');
      this.onend();
    }
  }

  // Pause and resume change the state at once and remember what the person last asked for. The browser's
  // suspend()/resume() calls take a moment; waiting for them used to swallow a click that came in meanwhile.
  pause() {
    if (this.state !== 'playing' && this.state !== 'waiting') return;
    this.wantPaused = true;
    this._setState('paused');
    this.ctx.suspend().catch(() => {});
  }

  async resume() {
    if (this.state !== 'paused') return;
    this.wantPaused = false;
    this._setState('playing');
    await this.ctx.resume().catch(() => {});
    if (this.wantPaused && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});   // paused again while it was resuming
  }

  toggle() { return this.state === 'paused' ? this.resume() : this.pause(); }

  stop() {
    this.token++;
    this.wantPaused = false;
    this._stopSources();
    clearInterval(this.timer);
    this.loading = false;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this._setState('idle');
  }

  /** Jump to sentence `index`, `offset` seconds in (keeps playing from there, even if it was paused). */
  seek(index, offset = 0) { return this.play(this.items, index, offset); }

  next() {
    const p = this.position();
    if (p && p.index + 1 < this.items.length) return this.seek(p.index + 1, 0);
  }

  prev() {
    const p = this.position();
    if (!p) return;
    return this.seek(p.offset > 2 || p.index === 0 ? p.index : p.index - 1, 0);
  }
}
