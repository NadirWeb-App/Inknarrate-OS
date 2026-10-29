// Page-side client of the export worker.
import { WorkerHost } from './remote.js';

const host = new WorkerHost(new URL('./export-worker.js', import.meta.url));

/** Int16 mono PCM -> MP3 bytes. `pcm` is handed over to the worker (it is empty afterwards). */
export const encodeMp3 = (pcm, rate, kbps, onProgress) => host.call('mp3', { pcm, rate, kbps }, onProgress, [pcm.buffer]);

/** files: [{ name, data: Uint8Array | string }] -> zip bytes. Binary data is handed over to the worker. */
export const makeZip = (files, onProgress) => host.call('zip', { files },
  onProgress, files.filter((f) => typeof f.data !== 'string').map((f) => f.data.buffer));

export const cancelExport = () => host.terminate('Export cancelled.');
