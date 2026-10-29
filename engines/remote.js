// Small request/response client for the engine worker. One worker is shared by all engines and is
// started on first use, so pages that only use the browser voice never pay for it.
export class WorkerHost {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, progress }
  }

  _failAll(message) {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  _ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(this.url, { type: 'module' });
    w.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      if (data.type === 'progress') { p.progress?.(data.message); return; }
      this.pending.delete(data.id);
      if (data.type === 'error') p.reject(new Error(data.message));
      else p.resolve(data.result);
    };
    // A worker that dies (bad script, crash) must not leave callers waiting forever. The next call
    // starts a fresh worker.
    w.onerror = (ev) => {
      this._failAll(`The audio worker stopped unexpectedly${ev.message ? ` (${ev.message})` : ''}.`);
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    this.worker = w;
    return w;
  }

  /** Stop the worker now (cancel). Waiting callers get an error; the next call starts a fresh worker. */
  terminate(message = 'Cancelled.') {
    this._failAll(message);
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }

  call(method, args, progress, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      try {
        this._ensure().postMessage({ id, method, args }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}
