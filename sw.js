// Offline cache. Network-first (so edits show up immediately), falling back to the cache when offline.
// Everything same-origin that loads successfully is stored. (Model files are not here: they live in IndexedDB, see engines/model-store.js.)
// Bump VERSION whenever files are removed or renamed, and whenever anything under vendor/ or ui/fonts/ changes (those are
// served cache-first): old caches are deleted on activation.
const VERSION = 'inknarrate-v34';
const CORE = [
  './', 'index.html', 'guide/', 'manifest.webmanifest', 'icon-192.png', 'app.js',
  'engines/text.js', 'engines/script-check.js', 'engines/tour.js', 'engines/segments.js', 'engines/audio-store.js', 'engines/segment-list.js', 'engines/transport.js', 'engines/player-bar.js', 'engines/registry.js', 'engines/meta.js', 'engines/remote.js', 'engines/worker.js',
  'engines/kitten.js', 'engines/kokoro.js', 'engines/kokoro-text.js', 'engines/piper.js', 'engines/piper-text.js', 'engines/model-specs.js', 'engines/model-store.js', 'engines/models-ui.js', 'engines/builtin.js', 'engines/dsp.js', 'engines/pronounce.js', 'engines/settings.js', 'engines/subtitles.js', 'engines/export-names.js', 'engines/project.js', 'engines/exporter.js', 'engines/export-host.js', 'engines/export-worker.js', 'engines/pool.js', 'engines/importers.js', 'engines/zip-read.js',
  'favicon.svg', 'ui/fonts.css', 'ui/inkplainer-ui.css', 'ui/tts.css', 'ui/inkplainer-ui.js',
  'ui/fonts/geist-latin-wght-normal.woff2', 'ui/fonts/caveat-latin-700-normal.woff2',
  'vendor/engines.bundle.js', 'vendor/export.bundle.js',
  'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One failure shouldn't abort the whole install, so add files individually.
    // `reload` skips the browser's HTTP cache, so a new version never pre-caches a stale copy of a file.
    await Promise.all(CORE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  if (new URL(req.url).origin !== location.origin) return;

  const path = new URL(req.url).pathname;
  const heavy = /\/(vendor|ui\/fonts)\//.test(path);   // big files that only change with a new VERSION: serve them from the cache, no network (saves bandwidth)

  event.respondWith((async () => {
    if (heavy) {
      const hit = await caches.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      const type = res.headers.get('content-type') || '';
      // Don't store 404s or SPA-fallback HTML standing in for a missing model file.
      if (res.status === 200 && !res.redirected && (!type.includes('text/html') || req.mode === 'navigate')) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});
