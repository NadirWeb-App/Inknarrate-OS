/**
 * model-loader.js — downloads KittenTTS ONNX model + voices from HuggingFace Hub.
 *
 * Node.js: caches to ~/.cache/kitten-tts/
 * Browser: caches in IndexedDB (via Cache API)
 */

const HF_BASE = 'https://huggingface.co';
const CACHE_DIR_NAME = 'kitten-tts';

/** Supported model IDs */
export const MODELS = {
  'KittenML/kitten-tts-nano-0.8': { label: 'nano (~25 MB)' },
  'KittenML/kitten-tts-micro-0.8': { label: 'micro (~40 MB)' },
  'KittenML/kitten-tts-mini-0.8': { label: 'mini (~80 MB)' },
};

// ─── Node.js helpers ─────────────────────────────────────────────────────────

let _fs, _path, _os;
async function getNodeModules() {
  if (_fs) return { fs: _fs, path: _path, os: _os };
  _fs = (await import('fs')).default;
  _path = (await import('path')).default;
  _os = (await import('os')).default;
  return { fs: _fs, path: _path, os: _os };
}

function isNode() {
  return typeof process !== 'undefined' && process.versions && process.versions.node;
}

/**
 * Fetch a URL and return its ArrayBuffer.
 * Works in Node (via global fetch, Node ≥18) and browser.
 */
async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.arrayBuffer();
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function nodeCacheGet(cacheKey) {
  const { fs, path, os } = await getNodeModules();
  const cacheDir = path.join(os.homedir(), '.cache', CACHE_DIR_NAME);
  const filePath = path.join(cacheDir, cacheKey);
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  return null;
}

async function nodeCacheSet(cacheKey, buffer) {
  const { fs, path, os } = await getNodeModules();
  const cacheDir = path.join(os.homedir(), '.cache', CACHE_DIR_NAME);
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, cacheKey);
  fs.writeFileSync(filePath, Buffer.from(buffer));
}

async function browserCacheGet(cacheKey) {
  if (typeof caches === 'undefined') return null;
  const cache = await caches.open(CACHE_DIR_NAME);
  const resp = await cache.match('/' + cacheKey);
  if (!resp) return null;
  return resp.arrayBuffer();
}

async function browserCacheSet(cacheKey, buffer) {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(CACHE_DIR_NAME);
  await cache.put('/' + cacheKey, new Response(buffer));
}

async function cacheGet(key) {
  return isNode() ? nodeCacheGet(key) : browserCacheGet(key);
}

async function cacheSet(key, buffer) {
  return isNode() ? nodeCacheSet(key, buffer) : browserCacheSet(key, buffer);
}

// ─── Main download logic ──────────────────────────────────────────────────────

/**
 * Build a raw HuggingFace URL for a repo file.
 */
function hfUrl(repoId, filename) {
  const local = globalThis.KITTEN_MODEL_BASE;
  if (local) return local + filename;
  return `${HF_BASE}/${repoId}/resolve/main/${filename}`;
}

/**
 * Fetch a file with caching.
 */
async function fetchCached(repoId, filename) {
  // LOCAL CHANGE: when the host app supplies globalThis.KITTEN_READ, the files come from there (the model
  // files the person uploaded) and nothing is downloaded or cached by this library.
  if (globalThis.KITTEN_READ) return globalThis.KITTEN_READ(filename);
  const cacheKey = `${repoId.replace('/', '__')}__${filename.replace(/\//g, '_')}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const url = hfUrl(repoId, filename);
  console.log(`[kitten-tts] Downloading ${url} …`);
  const buffer = await fetchBuffer(url);
  await cacheSet(cacheKey, buffer);
  return buffer;
}

/**
 * Download model files from HuggingFace Hub.
 *
 * @param {string} repoId  — e.g. 'KittenML/kitten-tts-nano-0.8'
 * @param {{ cacheDir?: string }} [opts]
 * @returns {Promise<{ modelBuffer: ArrayBuffer, voicesBuffer: ArrayBuffer, config: object }>}
 */
export async function downloadModel(repoId, opts = {}) {
  if (!MODELS[repoId]) {
    throw new Error(`Unknown model: ${repoId}. Available: ${Object.keys(MODELS).join(', ')}`);
  }

  // 1. Fetch config.json
  const configBuffer = await fetchCached(repoId, 'config.json');
  const config = JSON.parse(new TextDecoder().decode(configBuffer));

  const modelFile = config.model_file;
  const voicesFile = config.voices || 'voices.npz';

  if (!modelFile) throw new Error(`config.json missing 'model_file' for ${repoId}`);

  // 2. Fetch ONNX model and voices in parallel
  const [modelBuffer, voicesBuffer] = await Promise.all([
    fetchCached(repoId, modelFile),
    fetchCached(repoId, voicesFile),
  ]);

  return { modelBuffer, voicesBuffer, config };
}
