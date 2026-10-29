// Generated audio, keyed by a hash of everything that shapes it (engine, voice, speed, pitch, blend,
// take, text). Same key = same speech (a re-run differs only by tiny random vocoder noise), so a sentence
// is generated once and reused: editing one sentence only
// regenerates that sentence, and a reload keeps everything.
//
// Clips are stored as 16-bit PCM (half the size of Float32). They live in memory (recent ones) and in
// IndexedDB (all of them, up to a size cap). If IndexedDB is unavailable (private window), it is memory only.

import { trimBounds } from './dsp.js';

const DB_NAME = 'tts-audio';
const MEM_CAP = 160e6;   // bytes kept in memory
const DISK_CAP = 900e6;  // bytes kept in IndexedDB before the oldest clips are dropped

const toInt16 = (f32) => {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return out;
};

/** Int16 PCM -> Float32 samples in [-1, 1], ready for WebAudio or the WAV encoder. */
export function toFloat32(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const txDone = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });

export class AudioStore {
  constructor() {
    this.meta = new Map();   // key -> { bytes, dur, rate, t }   (every clip, memory or disk)
    this.mem = new Map();    // key -> Int16Array                (recently used clips; Map order = recency)
    this.memBytes = 0;
    this.db = null;
    this.ready = this._open();
  }

  async _open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('meta', { keyPath: 'key' });
          r.result.createObjectStore('clips', { keyPath: 'key' });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('blocked'));
      });
      for (const m of await req(this.db.transaction('meta').objectStore('meta').getAll())) this.meta.set(m.key, m);
    } catch {
      this.db = null; // memory only
    }
  }

  has(key) { return this.meta.has(key); }
  info(key) { return this.meta.get(key); }

  /** Resolves { pcm: Int16Array, rate, dur } or null. */
  async get(key) {
    const m = this.meta.get(key);
    if (!m) return null;
    let pcm = this.mem.get(key);
    if (pcm) { this.mem.delete(key); this.mem.set(key, pcm); } // mark as recently used
    else if (this.db) {
      try {
        const row = await req(this.db.transaction('clips').objectStore('clips').get(key));
        if (!row) { this.meta.delete(key); return null; }
        pcm = row.pcm;
        this._remember(key, pcm);
      } catch { return null; }
    } else return null;
    if (!m.trim) m.trim = trimBounds(pcm, m.rate);
    return { pcm, rate: m.rate, dur: m.dur, trim: m.trim };
  }

  /** Length in seconds once the silence at both edges is cut (what "Trim silence" plays). */
  trimmedDur(key) {
    const m = this.meta.get(key);
    return m ? (m.trim ? (m.trim[1] - m.trim[0]) / m.rate : m.dur) : 0;
  }

  /** Store a freshly generated clip ({ samples: Float32Array, sampleRate }). Resolves the stored clip. */
  async put(key, { samples, sampleRate }) {
    const pcm = toInt16(samples);
    const m = { key, bytes: pcm.byteLength, dur: samples.length / sampleRate, rate: sampleRate, t: Date.now(), trim: trimBounds(pcm, sampleRate) };
    this.meta.set(key, m);
    this._remember(key, pcm);
    if (this.db) {
      try {
        const tx = this.db.transaction(['meta', 'clips'], 'readwrite');
        tx.objectStore('meta').put(m);
        tx.objectStore('clips').put({ key, pcm });
        await txDone(tx);
        await this._trimDisk(key);
      } catch { /* quota or private mode: the clip still works from memory */ }
    }
    return { pcm, rate: sampleRate, dur: m.dur, trim: m.trim };
  }

  _remember(key, pcm) {
    if (this.mem.has(key)) this.memBytes -= this.mem.get(key).byteLength;
    this.mem.set(key, pcm);
    this.memBytes += pcm.byteLength;
    // Only drop from memory what the disk still has.
    for (const k of this.mem.keys()) {
      if (this.memBytes <= MEM_CAP || !this.db || k === key) break;
      this.memBytes -= this.mem.get(k).byteLength;
      this.mem.delete(k);
    }
  }

  async _trimDisk(keep) {
    let total = 0;
    for (const m of this.meta.values()) total += m.bytes;
    if (total <= DISK_CAP) return;
    const oldest = [...this.meta.values()].filter((m) => m.key !== keep).sort((a, b) => a.t - b.t);
    const tx = this.db.transaction(['meta', 'clips'], 'readwrite');
    for (const m of oldest) {
      if (total <= DISK_CAP * 0.9) break;
      tx.objectStore('meta').delete(m.key);
      tx.objectStore('clips').delete(m.key);
      this.meta.delete(m.key);
      const p = this.mem.get(m.key);
      if (p) { this.memBytes -= p.byteLength; this.mem.delete(m.key); }
      total -= m.bytes;
    }
    await txDone(tx);
  }

  stats() {
    let bytes = 0;
    for (const m of this.meta.values()) bytes += m.bytes;
    return { count: this.meta.size, bytes };
  }

  async clear() {
    this.meta.clear(); this.mem.clear(); this.memBytes = 0;
    if (this.db) {
      try {
        const tx = this.db.transaction(['meta', 'clips'], 'readwrite');
        tx.objectStore('meta').clear();
        tx.objectStore('clips').clear();
        await txDone(tx);
      } catch { /* nothing more to do */ }
    }
  }
}
