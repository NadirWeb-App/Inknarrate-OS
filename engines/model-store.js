// Where the model files the person uploaded live: IndexedDB in this browser, nowhere else.
// Used by the page (to add, list and remove) and by the workers (to read). Small records describing each
// file are kept apart from the file contents, so listing never touches the big blobs.
const DB_NAME = 'tts-models';
const META = 'meta';
const BLOBS = 'blobs';

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('This browser has no IndexedDB, so models can’t be stored.')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META, { keyPath: 'id' });
        req.result.createObjectStore(BLOBS);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('Could not open the model store.'));
      req.onblocked = () => reject(new Error('The model store is blocked by another tab. Close other tabs of this page and try again.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('Storage failed.'));
  tx.onabort = () => reject(tx.error || new Error('Storage was refused (the disk may be full, or the browser blocked it).'));
});
const result = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

const idOf = (engine, key) => `${engine}/${key}`;

/** Save one file. `meta` is { size, sha256, verified, variant? }. Replaces a file with the same key. */
export async function saveFile(engine, key, blob, meta) {
  const db = await open();
  const tx = db.transaction([META, BLOBS], 'readwrite');
  const id = idOf(engine, key);
  tx.objectStore(META).put({ id, engine, key, added: Date.now(), ...meta });
  tx.objectStore(BLOBS).put(blob, id);
  await done(tx);
  await verifySaved(engine, key, blob);
}

/** Read the saved copy back (first and last bytes). If the browser cannot, store an in-memory copy instead and check again. */
async function verifySaved(engine, key, original) {
  const probe = async () => {
    const b = await getBlob(engine, key);
    if (b.size !== original.size) throw new Error('size differs');
    if (b.size) { await b.slice(0, 1).arrayBuffer(); await b.slice(b.size - 1).arrayBuffer(); }
  };
  try { await probe(); return; } catch { /* fall through to the in-memory copy */ }
  const db = await open();
  const copy = new Blob([await original.arrayBuffer()]);
  const tx = db.transaction([BLOBS], 'readwrite');
  tx.objectStore(BLOBS).put(copy, idOf(engine, key));
  await done(tx);
  try { await probe(); } catch { throw new Error(`The browser could not store ${key} reliably. Try again, or free some disk space.`); }
}

/** Records of the saved files (no contents), for one engine or all. */
export async function listFiles(engine) {
  const db = await open();
  const all = await result(db.transaction(META).objectStore(META).getAll());
  return engine ? all.filter((r) => r.engine === engine) : all;
}

export async function getBlob(engine, key) {
  const db = await open();
  const blob = await result(db.transaction(BLOBS).objectStore(BLOBS).get(idOf(engine, key)));
  if (!blob) throw new Error(`The saved file ${key} is missing. Add it again from the Models window.`);
  return blob;
}

const lost = (key) => new Error(`The saved file ${key} can’t be read right now (the browser lost track of it). Open Models, remove it under “Stored in this browser”, and add it again.`);

/** Read a saved file. A NotFoundError can come from the browser's blob storage; one fresh try fixes the usual case. */
export async function readBytes(engine, key) {
  for (let attempt = 0; ; attempt++) {
    try { return await (await getBlob(engine, key)).arrayBuffer(); }
    catch (err) {
      if (err && err.name === 'NotFoundError') {
        if (attempt === 0) { dbPromise = null; await new Promise((r) => setTimeout(r, 150)); continue; }
        throw lost(key);
      }
      throw err;
    }
  }
}

export async function removeFile(engine, key) {
  const db = await open();
  const tx = db.transaction([META, BLOBS], 'readwrite');
  tx.objectStore(META).delete(idOf(engine, key));
  tx.objectStore(BLOBS).delete(idOf(engine, key));
  await done(tx);
}

/** Remove every file of one engine, or of all of them. */
export async function removeEngine(engine) {
  for (const r of await listFiles(engine)) await removeFile(r.engine, r.key);
}

/** Ask the browser not to evict the files when space runs low. Returns true if it agreed. */
export async function persistStorage() {
  try { return Boolean(navigator.storage && navigator.storage.persist && await navigator.storage.persist()); } catch { return false; }
}

/** { used, quota } in bytes for this site (an estimate), or null. */
export async function estimate() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  } catch { return null; }
}
