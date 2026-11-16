// A pool of engine workers, so several sentences can be generated at the same time.
//
// Measured with the real Kitten model on 2 cores: one worker using both cores ran at 2.1x real time,
// two single-threaded workers at 3.2x. A single inference scales poorly with threads, so a few workers
// that each take whole sentences beat one worker with many threads.
//
// Worker 0 loads first, so the first Speak starts as early as before. The others load in the background
// once generation begins, and a sentence goes to the least busy worker that is ready.
import { WorkerHost } from './remote.js';

export const MAX_WORKERS = 8;
export const RESTART_MESSAGE = 'Restarting the audio workers.';

/** How many workers "Auto" means: one per core, at most 3 (each holds its own copy of the model in memory),
 *  and only 2 on devices that report little memory. */
export function autoWorkers(cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2,
  memGb = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined) {
  const cap = memGb && memGb <= 4 ? 2 : 3;
  return Math.max(1, Math.min(cap, cores));
}

export class WorkerPool {
  constructor(url, cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) {
    this.url = url;
    this.cores = cores;
    this.size = 1;
    this.slots = [];            // { host, loading, loaded, busy }
    this.expanded = false;      // background loading of workers 1..size-1 has been started
    this.waiters = [];          // sentences waiting for a free worker
  }

  /** Threads each worker gives onnxruntime: the cores shared out evenly. */
  threads() { return Math.max(1, Math.floor(this.cores / this.size)); }

  /** Change the number of workers. Stops the current ones; they load again the next time they're needed. */
  configure(size) {
    size = Math.max(1, Math.min(MAX_WORKERS, Math.round(size) || 1));
    if (size === this.size && this.slots.length) return false;
    this.terminate();
    this.size = size;
    return true;
  }

  terminate() {
    for (const s of this.slots) s.host.terminate(RESTART_MESSAGE);
    this.slots = [];
    this.expanded = false;
    this._wake();   // anything waiting: its call fails with the restart message or finds a fresh pool
  }

  _slot(i) {
    if (!this.slots[i]) this.slots[i] = { host: new WorkerHost(this.url), loading: null, loaded: false, busy: 0 };
    return this.slots[i];
  }

  _load(slot, engine, progress) {
    if (!slot.loading) {
      slot.loading = slot.host.call('load', { engine, threads: this.threads() }, progress).then(() => { slot.loaded = true; });
      slot.loading.catch((err) => { slot.loading = null; slot.failedAt = Date.now(); console.warn('An audio worker failed to load; it will be tried again.', err && err.message); });
    }
    return slot.loading;
  }

  /** Load worker 0 (the page waits for this one). */
  load(engine, progress) {
    return this._load(this._slot(0), engine, progress);
  }

  /** Start loading the other workers in the background. Called on every sentence, so a worker that failed to
   *  load (for example when memory ran short) is tried again, at most every 5 seconds, instead of staying missing. */
  _expand(engine) {
    this.expanded = true;
    const now = Date.now();
    for (let i = 1; i < this.size; i++) {
      const slot = this._slot(i);
      if (slot.loaded || slot.loading || (slot.failedAt && now - slot.failedAt < 5000)) continue;
      this._load(slot, engine, () => {}).catch(() => {});
    }
  }

  /** Wake the sentences waiting for a worker (one became free, or finished loading). */
  _wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }

  async synth(engine, text, opts, progress) {
    const first = this._slot(0);
    if (!first.loaded) await this._load(first, engine, () => {});
    this._expand(engine);
    // Take an idle loaded worker. While others are still loading, wait for one to be free or ready instead of
    // queueing behind a busy worker (a sentence queued early would otherwise stay there when more workers come up).
    let best = null;
    for (;;) {
      if (this.slots[0] !== first) throw new Error(RESTART_MESSAGE);   // the pool was restarted while this sentence waited
      best = null;
      for (let i = 0; i < this.size; i++) {
        const s = this.slots[i];
        if (s && s.loaded && (!best || s.busy < best.busy)) best = s;
      }
      best = best || first;
      const loading = this.slots.some((s, i) => s && !s.loaded && s.loading);
      if (best.busy === 0 || !loading) break;
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        for (const s of this.slots) if (s && s.loading && !s.loaded) s.loading.then(() => this._wake(), () => this._wake());
      });
    }
    best.busy++;
    try { return await best.host.call('synth', { engine, text, opts }, progress); } finally { best.busy--; this._wake(); }
  }

  /** Let an engine get something ready (Chatterbox: listen to a voice). Runs in worker 0; what it learns is saved for the others. */
  async prepare(engine, voice, progress) {
    return this._slot(0).host.call('prepare', { engine, voice }, progress);
  }

  /** How many workers are loaded and ready right now (for the status line). */
  ready() { return this.slots.filter((s) => s.loaded).length; }
}
