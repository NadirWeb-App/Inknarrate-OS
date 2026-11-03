// What the page sees: the same engine interface for every engine (label, voices, load, synth), but the
// neural engines run in workers behind it, so this module stays light.
import { WorkerPool } from './pool.js';
import { builtin } from './builtin.js';
import { KITTEN_META, KOKORO_META, PARADEE_META, PIPER_META } from './meta.js';

const workerUrl = new URL('./worker.js', import.meta.url);
// One pool per engine: each keeps its own workers, so a model is only ever loaded into the workers that use it.
const pools = new Map();
const poolOf = (id) => { if (!pools.has(id)) pools.set(id, new WorkerPool(workerUrl)); return pools.get(id); };

function remote(meta) {
  const pool = poolOf(meta.id);
  return {
    ...meta,
    kind: 'pcm',
    load: (progress) => pool.load(meta.id, progress),
    synth: (text, opts) => pool.synth(meta.id, text, opts),
    /** Number of sentences that may be generated at once. */
    workers: () => pool.size,
    /** Change it. Returns true when the workers were restarted (the model has to load again). */
    setWorkers: (n) => pool.configure(n),
    readyWorkers: () => pool.ready(),
    /** Forget the loaded model (its files were replaced or removed): it loads again on next use. */
    reset: () => pool.terminate(),
  };
}

export { builtin };
export const ENGINES = [remote(KITTEN_META), remote(KOKORO_META), remote(PARADEE_META), remote(PIPER_META), builtin];
