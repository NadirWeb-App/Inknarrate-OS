#!/usr/bin/env node
// Tiny static server for local testing: correct MIME types, real 404s for missing files, and the
// cross-origin-isolation headers that let onnxruntime-web use several threads (same as _headers).
//   node serve.mjs [port]
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.npz': 'application/octet-stream',
  '.data': 'application/octet-stream', '.map': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  if (process.env.SERVE_LOG) console.log('REQ ' + req.method + ' ' + req.url);
  const headers = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-cache',
  };
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = join(ROOT, normalize(rel));
    if (!file.startsWith(ROOT)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    // Clean URLs like Cloudflare Pages: /guide serves guide.html
    if (!extname(file)) { try { if ((await stat(file + '.html')).isFile()) file += '.html'; } catch { /* not a page */ } }
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    headers['Content-Type'] = TYPES[extname(file)] || 'application/octet-stream';
    headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(file));
  } catch (err) {
    res.writeHead(err.code === 'EACCES' ? 403 : 404, { ...headers, 'Content-Type': 'text/plain' });
    res.end(err.code === 'EACCES' ? 'forbidden' : 'not found');
  }
}).listen(PORT, () => console.log(`Serving on http://localhost:${PORT}`));
