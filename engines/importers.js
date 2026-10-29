// Turn a file into plain text for the text box: .txt, .md, .srt/.vtt, .html, .epub, .docx.
// Everything here is pure (no DOM), so it is tested in Node (tests/import.test.mjs). The result is only
// ever put into the text box as plain text, never as HTML.
import { readZip } from './zip-read.js';

export const MAX_IMPORT_BYTES = 50e6;
export const MAX_IMPORT_CHARS = 2e6;
export const IMPORT_ACCEPT = '.txt,.text,.md,.markdown,.srt,.vtt,.html,.htm,.xhtml,.epub,.docx';

// ---- text decoding ---------------------------------------------------------------------------

/** Bytes -> string. Honours a UTF-8 / UTF-16 byte-order mark; otherwise UTF-8, falling back to Windows-1252. */
export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç',
};

/** &amp; &#233; &#xe9; -> characters. Unknown names are left as they are. */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return Object.hasOwn(NAMED, g.toLowerCase()) ? NAMED[g.toLowerCase()] : m;
  });
}

/** Common final cleanup: newlines, trailing spaces, at most one blank line in a row. */
export function tidy(text) {
  return text
    .replace(new RegExp('\\r\\n?|[\\u2028\\u2029]', 'g'), '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t ]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- plain text -----------------------------------------------------------------------------

/**
 * Hard-wrapped text (old e-book .txt files break every ~70 characters) would turn every line into its own
 * sentence. A paragraph whose lines are all long and mostly end mid-sentence is joined into one line.
 * Short lines (poems, lists, scripts) are left alone.
 */
export function unwrapLines(text) {
  let changed = false;
  const out = text.split(/\n{2,}/).map((para) => {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) return para;
    const body = lines.slice(0, -1);
    const longish = body.filter((l) => l.length >= 40 && l.length <= 120).length / body.length;
    const midSentence = body.filter((l) => !/[.!?:;"”’)]$/.test(l)).length / body.length;
    if (longish >= 0.7 && midSentence >= 0.6) { changed = true; return lines.join(' '); }
    return para;
  }).join('\n\n');
  return { text: out, changed };
}

export function fromPlain(text) {
  return unwrapLines(tidy(text)).text;
}

// ---- markdown ---------------------------------------------------------------------------------

export function fromMarkdown(src) {
  const lines = tidy(src).split('\n');
  const blocks = [];       // each: string (a paragraph or heading)
  let para = [];
  let fence = false;
  const flush = () => { if (para.length) { blocks.push(para.join(' ')); para = []; } };
  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:[^>]*>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1');
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fence = !fence; continue; }   // code is not read aloud
    if (fence) continue;
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); continue; }
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (h) { flush(); blocks.push(inline(h[1])); continue; }
    const li = line.match(/^([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (li) { flush(); blocks.push(inline(li[2])); continue; }
    para.push(inline(line.replace(/^>\s?/, '')));
  }
  flush();
  return tidy(blocks.filter(Boolean).join('\n\n'));
}

// ---- subtitles ---------------------------------------------------------------------------------

/** SRT / WebVTT -> one line per cue (so with "Split at line breaks" each cue stays its own sentence). */
export function fromSubtitles(src) {
  const out = [];
  for (const block of tidy(src).split(/\n{2,}/)) {
    const lines = block.split('\n');
    const t = lines.findIndex((l) => l.includes('-->'));
    if (t < 0) continue;   // WEBVTT header, NOTE, STYLE, REGION
    const text = decodeEntities(lines.slice(t + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '')).replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out.join('\n');
}

// ---- html / xhtml ---------------------------------------------------------------------------------

const BLOCK_END = /<\/(p|div|h[1-6]|blockquote|section|article|tr|table|ul|ol|pre|figure|header|footer)\s*>/gi;
const LINE_BREAK = /<(br|hr)\b[^>]*>|<\/(li|dd|dt)\s*>/gi;

export function fromHtml(src) {
  let s = String(src)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<(head|script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_END, '\u0001')
    .replace(LINE_BREAK, '\u0002')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/[ \t\r\n\f ]+/g, ' ');
  s = s.replace(/ ?\u0002 ?/g, '\n').replace(/ ?\u0001 ?/g, '\n\n');
  return tidy(s);
}

// ---- epub ---------------------------------------------------------------------------------------

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
};

/** Resolve an href found in a file at `base` (both zip paths). Handles ../, %20 and #fragments. */
export function resolvePath(base, href) {
  const parts = base.split('/').slice(0, -1);
  let h = href.split('#')[0].split('?')[0];
  try { h = decodeURIComponent(h); } catch { /* keep as is */ }
  for (const seg of h.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export async function fromEpub(zip) {
  const dec = async (name) => new TextDecoder('utf-8').decode(await zip.read(name));
  if (!zip.has('META-INF/container.xml')) throw new Error('This does not look like an EPUB (no container.xml).');
  const container = await dec('META-INF/container.xml');
  const rootTag = (container.match(/<rootfile\b[^>]*>/i) || [''])[0];
  const opfPath = attr(rootTag, 'full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('The EPUB has no readable book description.');
  const opf = await dec(opfPath);

  const manifest = new Map();
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(tag, 'id'), href = attr(tag, 'href');
    if (id && href) manifest.set(id, { href, type: attr(tag, 'media-type') || '', props: attr(tag, 'properties') || '' });
  }
  const chapters = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const it = manifest.get(attr(tag, 'idref'));
    if (!it || /\bnav\b/.test(it.props) || !/x?html/i.test(it.type)) continue;   // skip the table of contents page
    chapters.push(resolvePath(opfPath, it.href));
  }
  if (!chapters.length) throw new Error('The EPUB has no chapters I can read.');
  const texts = [];
  for (const path of chapters) {
    if (!zip.has(path)) continue;
    const t = fromHtml(await dec(path));
    if (t) texts.push(t);
  }
  return tidy(texts.join('\n\n'));
}

// ---- docx ---------------------------------------------------------------------------------------

export function fromDocxXml(xml) {
  const paras = [];
  for (const p of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []) {
    let t = '';
    for (const m of p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g)) {
      if (m[1] !== undefined) t += decodeEntities(m[1]);
      else t += m[0].startsWith('<w:br') ? '\n' : ' ';
    }
    paras.push(t.replace(/[ \t]+/g, ' ').trim());
  }
  return tidy(paras.filter(Boolean).join('\n\n'));
}

export async function fromDocx(zip) {
  if (!zip.has('word/document.xml')) throw new Error('This does not look like a Word document (no document.xml).');
  return fromDocxXml(new TextDecoder('utf-8').decode(await zip.read('word/document.xml')));
}

// ---- entry point ---------------------------------------------------------------------------------

const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

/**
 * Read an imported file. `file` is anything with .name, .size and .arrayBuffer() (a File).
 * Returns { text, kind, truncated }. Throws an Error with a plain-words message.
 */
export async function importFile(file) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is too big to import (the limit is 50 MB).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = extOf(file.name);
  let text, kind;
  if (ext === 'epub') { kind = 'EPUB'; text = await fromEpub(await readZip(bytes)); }
  else if (ext === 'docx') { kind = 'Word document'; text = await fromDocx(await readZip(bytes)); }
  else if (ext === 'srt' || ext === 'vtt') { kind = 'subtitles'; text = fromSubtitles(decodeText(bytes)); }
  else if (['html', 'htm', 'xhtml'].includes(ext)) { kind = 'web page'; text = fromHtml(decodeText(bytes)); }
  else if (ext === 'md' || ext === 'markdown') { kind = 'Markdown'; text = fromMarkdown(decodeText(bytes)); }
  else if (ext === 'txt' || ext === 'text' || ext === '') {
    if (bytes.subarray(0, 8192).includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) throw new Error('That does not look like a text file.');
    kind = 'text'; text = fromPlain(decodeText(bytes));
  } else throw new Error(`.${ext} files are not supported. Try .txt, .md, .srt, .vtt, .html, .epub or .docx.`);
  if (!text) throw new Error('No text was found in that file.');
  const truncated = text.length > MAX_IMPORT_CHARS;
  if (truncated) text = text.slice(0, MAX_IMPORT_CHARS);
  return { text, kind, truncated };
}
