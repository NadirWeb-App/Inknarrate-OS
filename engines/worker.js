// Runs the neural engines (Kitten, Kokoro) off the main thread, so model loading and synthesis never block the UI
// (Kitten can take about as long to synthesize as the audio lasts, which froze the page and the
// Stop button when it ran on the main thread).
import { kitten } from './kitten.js';
import { kokoro } from './kokoro.js';
import { piper } from './piper.js';
import { paradee } from './paradee.js';

const engines = { kitten, kokoro, piper, paradee };

// One job at a time: the ONNX sessions aren't meant to be run concurrently, and a new request
// from the page can arrive while the previous sentence is still being synthesized.
let tail = Promise.resolve();
function exclusive(fn) {
  const run = tail.then(fn);
  tail = run.catch(() => {});
  return run;
}

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    const engine = engines[args.engine];
    if (!engine) throw new Error(`Unknown engine: ${args.engine}`);

    if (method === 'load') {
      await exclusive(() => engine.load((message) => self.postMessage({ id, type: 'progress', message }), { threads: args.threads }));
      self.postMessage({ id, type: 'done', result: true });
    } else if (method === 'synth') {
      const out = await exclusive(() => engine.synth(args.text, args.opts));
      self.postMessage({ id, type: 'done', result: out }, [out.samples.buffer]);
    } else {
      throw new Error(`Unknown method: ${method}`);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
