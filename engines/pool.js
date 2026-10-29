// A pool of engine workers, so several sentences can be generated at the same time.
//
// Measured with the real Kitten model on 2 cores: one worker using both cores ran at 2.1x real time,
// two single-threaded workers at 3.2x. A single inference scales poorly with threads, so a few workers
// that each take whole sentences beat one worker with many threads.
//
// Worker 0 loads first, so the first Speak starts as early as before. The others load in the background
// once generation begins, and a sentence goes to the least busy worker that is ready.
import { WorkerHost } from './remote.js';

export const MAX_WORKERS = 4;
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
  }

  _slot(i) {
    if (!this.slots[i]) this.slots[i] = { host: new WorkerHost(this.url), loading: null, loaded: false, busy: 0 };
    return this.slots[i];
  }

  _load(slot, engine, progress) {
    if (!slot.loading) {
      slot.loading = slot.host.call('load', { engine, threads: this.threads() }, progress).then(() => { slot.loaded = true; });
      slot.loading.catch(() => { slot.loading = null; });
    }
    return slot.loading;
  }

  /** Load worker 0 (the page waits for this one). */
  load(engine, progress) {
    return this._load(this._slot(0), engine, progress);
  }

  /** Start loading the other workers in the background (once, when generation begins). */
  _expand(engine) {
    if (this.expanded) return;
    this.expanded = true;
    for (let i = 1; i < this.size; i++) this._load(this._slot(i), engine, () => {}).catch(() => {});
  }

  async synth(engine, text, opts) {
    const first = this._slot(0);
    if (!first.loaded) await this._load(first, engine, () => {});
    this._expand(engine);
    let best = null;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s && s.loaded && (!best || s.busy < best.busy)) best = s;
    }
    best = best || first;
    best.busy++;
    try { return await best.host.call('synth', { engine, text, opts }); } finally { best.busy--; }
  }

  /** How many workers are loaded and ready right now (for the status line). */
  ready() { return this.slots.filter((s) => s.loaded).length; }
}
