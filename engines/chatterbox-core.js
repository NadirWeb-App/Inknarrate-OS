// Chatterbox (Resemble AI, MIT) pieces that don't need onnxruntime: the text tokenizer, the token-by-token
// generation loop, text preparation and chunking, reading a reference recording, and the saved form of a voice.
// Everything here takes plain arrays and callbacks, so tests can run it with stand-ins (tests/chatterbox.test.mjs).
//
// The pipeline follows the ONNX export in onnx-community/chatterbox-ONNX and the way Transformers.js
// (Apache-2.0) drives it: text ids -> embed_tokens; reference voice -> speech_encoder; a Llama-style language
// model writes speech tokens one at a time (greedy, repetition penalty 1.2); conditional_decoder turns the
// tokens into a 24 kHz waveform.

export const SAMPLE_RATE = 24000;
export const START_SPEECH = 6561;
export const STOP_SPEECH = 6562;
export const SILENCE_TOKEN = 4299;
export const EOS_IDS = [2, 6562];
export const REPETITION_PENALTY = 1.2;
export const MAX_NEW_TOKENS = 256;          // about 10 s of speech, so text goes in short pieces
export const LAYERS = 30, KV_HEADS = 16, HEAD_DIM = 64, AUDIO_DIM = 1024;
export const MAX_CHUNK_CHARS = 130;
export const REFERENCE_SECONDS = 10;
export const MIN_REFERENCE_SECONDS = 1.5;
export const DEFAULT_EXAGGERATION = 0.5;

// ---- the tokenizer (Hugging Face tokenizer.json: plain BPE, no pre-tokenizer) ------------------------

/**
 * Read the file. Returns { ok, tokenizer: { encode(text) -> number[] } } or { ok: false, error }.
 * The sentence template (exaggeration marker, start, text, stop, start of speech) comes from the file itself.
 */
export function parseChatterboxTokenizer(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, error: 'tokenizer.json isn’t valid JSON.' }; }
  const m = j && j.model;
  if (!m || m.type !== 'BPE' || !m.vocab || typeof m.vocab !== 'object' || !Array.isArray(m.merges)) return { ok: false, error: 'This tokenizer.json isn’t a BPE tokenizer.' };
  const added = new Map();
  for (const t of Array.isArray(j.added_tokens) ? j.added_tokens : []) if (t && typeof t.content === 'string' && Number.isInteger(t.id)) added.set(t.content, t.id);
  if (added.get('[START_SPEECH]') !== START_SPEECH || added.get('[STOP_SPEECH]') !== STOP_SPEECH) return { ok: false, error: 'This tokenizer.json doesn’t look like Chatterbox’s (no speech markers).' };
  const vocab = new Map(Object.entries(m.vocab));
  if (vocab.size < 100 || vocab.size > 5000) return { ok: false, error: 'This tokenizer.json doesn’t look like Chatterbox’s (unexpected vocabulary size).' };
  const rank = new Map();
  m.merges.forEach((mg, i) => {
    const key = Array.isArray(mg) ? mg.join(' ') : String(mg);
    if (!rank.has(key)) rank.set(key, i);
  });
  const unk = typeof m.unk_token === 'string' && vocab.has(m.unk_token) ? vocab.get(m.unk_token) : null;

  const pp = j.post_processor;
  let template = null;
  if (pp && pp.type === 'TemplateProcessing' && Array.isArray(pp.single)) {
    template = [];
    for (const item of pp.single) {
      if (item.SpecialToken) {
        const st = pp.special_tokens && pp.special_tokens[item.SpecialToken.id];
        const id = st && st.ids && st.ids[0];
        if (!Number.isInteger(id)) return { ok: false, error: 'This tokenizer.json has a sentence template this app can’t read.' };
        template.push(id);
      } else if (item.Sequence) template.push('A');
    }
    if (!template.includes('A')) template = null;
  }
  if (!template) return { ok: false, error: 'This tokenizer.json has no sentence template, so it isn’t the one from the Chatterbox ONNX repository.' };

  // Markers like [laughter] that are written in the text become their own token.
  const specials = [...added.keys()].filter((k) => k.length > 2 && added.get(k) < 6561 && /^\[[A-Za-z_0-9]+\]$/.test(k));
  const specialRe = specials.length ? new RegExp(specials.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;

  function bpe(piece) {
    let syms = [...piece];
    if (syms.length < 2) return syms;
    for (;;) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < syms.length - 1; i++) {
        const r = rank.get(`${syms[i]} ${syms[i + 1]}`);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best < 0) return syms;
      syms.splice(best, 2, syms[best] + syms[best + 1]);
    }
  }
  function encodePiece(piece, out) {
    if (!piece) return;
    for (const s of bpe(piece)) {
      if (vocab.has(s)) out.push(vocab.get(s));
      else if (unk !== null) out.push(unk);
    }
  }
  function encode(textIn) {
    const norm = String(textIn).replace(/\s+/g, ' ');
    const body = [];
    let at = 0;
    if (specialRe) {
      specialRe.lastIndex = 0;
      for (let mt = specialRe.exec(norm); mt; mt = specialRe.exec(norm)) {
        encodePiece(norm.slice(at, mt.index), body);
        body.push(added.get(mt[0]));
        at = mt.index + mt[0].length;
      }
    }
    encodePiece(norm.slice(at), body);
    const ids = [];
    for (const t of template) { if (t === 'A') ids.push(...body); else ids.push(t); }
    return ids;
  }
  return { ok: true, tokenizer: { encode, vocabSize: vocab.size } };
}

/** Does this text look like Chatterbox's tokenizer.json (and not Kokoro's, which has the same file name)? */
export function looksLikeChatterboxTokenizer(text) {
  return typeof text === 'string' && text.includes('[START_SPEECH]') && text.includes('"BPE"');
}

// ---- text ---------------------------------------------------------------------------------------

/** Light clean-up before tokenizing: the same small substitutions Chatterbox's own code makes. */
export function prepareText(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const subs = [['…', ', '], [':', ','], [' - ', ' '], [';', ', '], ['—', '-'], ['–', '-'], [' ,', ','], ['“', '"'], ['”', '"'], ['‘', '\''], ['’', '\'']];
  for (const [a, b] of subs) t = t.split(a).join(b);
  t = t.replace(/\s+/g, ' ').trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?,]["')\]]*$/.test(t)) t += '.';
  return t;
}

/** Cut a long sentence into pieces of at most `max` characters, at punctuation first, then at spaces. */
export function chunkText(text, max = MAX_CHUNK_CHARS) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out = [];
  let rest = t;
  while (rest.length > max) {
    const win = rest.slice(0, max + 1);
    let cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
    if (cut < max * 0.4) cut = win.lastIndexOf(' ');
    if (cut <= 0) cut = max;               // one very long word: cut it
    else cut += 1;                         // keep the punctuation with the piece
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// ---- generation ---------------------------------------------------------------------------------

/** Positions the embedding model wants: markers (ids from 6561 up) are 0, other tokens count 0, 1, 2… */
export function promptPositions(ids) {
  let p = 0;
  return ids.map((id) => (id >= START_SPEECH ? 0 : p++));
}

/** Position of the token written after `history`: how many tokens follow the last start-of-speech marker. */
export function stepPosition(history) {
  return history.length - history.lastIndexOf(START_SPEECH) - 1;
}

/** The index of the largest logit after the repetition penalty (HF semantics: negative scores are multiplied, others divided). */
export function pickToken(logits, history, penalty = REPETITION_PENALTY) {
  const seen = new Set(history);
  let best = -1, bestV = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    let v = logits[i];
    if (seen.has(i)) v = v < 0 ? v * penalty : v / penalty;
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

/**
 * Write speech tokens for one piece of text.
 *   ids          the prompt token ids (from the tokenizer)
 *   cond         the voice's audio_features, Float32Array of seq*AUDIO_DIM, put in front of the text embeddings
 *   embed(ids, positions) -> Float32Array(ids.length * dim)
 *   lm(embeds, seq) -> Float32Array logits of the last position (the callback keeps the key/value cache)
 *   shouldStop() optional, checked each step
 * Returns the speech tokens, without the stop marker.
 */
export async function generateTokens({ ids, condFeatures, embed, lm, maxNew = MAX_NEW_TOKENS, penalty = REPETITION_PENALTY, shouldStop, onToken }) {
  const promptEmb = await embed(ids, promptPositions(ids));
  const first = new Float32Array(condFeatures.length + promptEmb.length);
  first.set(condFeatures, 0);
  first.set(promptEmb, condFeatures.length);
  const dim = promptEmb.length / ids.length;
  let logits = await lm(first, first.length / dim);
  const history = ids.slice();
  const out = [];
  for (let step = 0; step < maxNew; step++) {
    if (shouldStop && shouldStop()) throw new Error('Stopped.');
    const next = pickToken(logits, history, penalty);
    if (EOS_IDS.includes(next)) break;
    history.push(next);
    out.push(next);
    if (onToken) onToken(out.length);
    if (step === maxNew - 1) break;
    const e = await embed([next], [stepPosition(history)]);   // history already holds `next`: the first speech token after the marker is position 1
    logits = await lm(e, 1);
  }
  return out;
}

// ---- a voice: reference recording and its saved features -------------------------------------------

/** Linear resampling (the reference recording only; speech is generated at 24 kHz). */
export function resampleLinear(x, from, to) {
  if (from === to) return x;
  const n = Math.max(1, Math.round(x.length * to / from));
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * k, i0 = Math.floor(p), i1 = Math.min(x.length - 1, i0 + 1), f = p - i0;
    out[i] = x[Math.min(i0, x.length - 1)] * (1 - f) + x[i1] * f;
  }
  return out;
}

/** Read a PCM or float WAV file into mono samples. Returns { ok, samples, sampleRate } or { ok: false, error }. */
export function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return { ok: false, error: 'This isn’t a WAV file.' };
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= bytes.byteLength;) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data') { data = { at: body, len: Math.min(size, bytes.byteLength - body) }; break; }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) return { ok: false, error: 'This WAV file is incomplete.' };
  let format = fmt.format;
  if (format === 0xfffe) format = fmt.bits === 32 || fmt.bits === 64 ? 3 : 1;
  const bps = fmt.bits / 8;
  if (!fmt.channels || !Number.isInteger(bps) || bps < 1 || bps > 8 || !(format === 1 || format === 3) || fmt.rate < 4000 || fmt.rate > 192000) {
    return { ok: false, error: 'This WAV file uses a format the app can’t read. Use a normal 16-bit WAV.' };
  }
  const frames = Math.floor(data.len / (bps * fmt.channels));
  const samples = new Float32Array(frames);
  const read = (o) => {
    if (format === 3) return bps === 4 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
    if (bps === 1) return (dv.getUint8(o) - 128) / 128;
    if (bps === 2) return dv.getInt16(o, true) / 32768;
    if (bps === 3) { const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); return v / 8388608; }
    return dv.getInt32(o, true) / 2147483648;
  };
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += read(data.at + (i * fmt.channels + c) * bps);
    samples[i] = s / fmt.channels;
  }
  return { ok: true, samples, sampleRate: fmt.rate };
}

/** Mono samples at any rate -> what the encoder wants: 24 kHz, at most 10 s, from the first sound. Returns { ok, samples } or { ok: false, error }. */
export function prepareReference(samples, sampleRate) {
  let x = resampleLinear(samples, sampleRate, SAMPLE_RATE);
  let start = 0;
  while (start < x.length && Math.abs(x[start]) < 0.01) start++;
  start = Math.max(0, start - Math.round(SAMPLE_RATE * 0.05));
  x = x.slice(start, start + SAMPLE_RATE * REFERENCE_SECONDS);
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (x.length < SAMPLE_RATE * MIN_REFERENCE_SECONDS) return { ok: false, error: 'The recording is too short. Use at least 2 seconds of clear speech (10 seconds is ideal).' };
  if (peak < 0.005) return { ok: false, error: 'The recording is silent.' };
  return { ok: true, samples: x, seconds: x.length / SAMPLE_RATE };
}

/** The encoder's outputs for one voice, as one small file kept in the browser: { audioFeatures [seq*1024], audioTokens, speakerEmbeddings [192], speakerFeatures [frames*80] }. */
export function packConditioning(c) {
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, af: c.audioFeatures.length, at: c.audioTokens.length, se: c.speakerEmbeddings.length, sf: c.speakerFeatures.length }));
  const pad = (4 - ((8 + header.length) % 4)) % 4;
  const bodyStart = 8 + header.length + pad;
  const total = bodyStart + 4 * (c.audioFeatures.length + c.audioTokens.length + c.speakerEmbeddings.length + c.speakerFeatures.length);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x43424331, true);   // "CBC1"
  dv.setUint32(4, header.length, true);
  new Uint8Array(buf, 8, header.length).set(header);
  let o = bodyStart;
  new Float32Array(buf, o, c.audioFeatures.length).set(c.audioFeatures); o += 4 * c.audioFeatures.length;
  new Int32Array(buf, o, c.audioTokens.length).set(Int32Array.from(c.audioTokens, Number)); o += 4 * c.audioTokens.length;
  new Float32Array(buf, o, c.speakerEmbeddings.length).set(c.speakerEmbeddings); o += 4 * c.speakerEmbeddings.length;
  new Float32Array(buf, o, c.speakerFeatures.length).set(c.speakerFeatures);
  return buf;
}

export function unpackConditioning(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x43424331) throw new Error('This saved voice isn’t readable. Remove it and add it again.');
  const hl = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  const pad = (4 - ((8 + hl) % 4)) % 4;
  let o = 8 + hl + pad;
  if (o + 4 * (h.af + h.at + h.se + h.sf) !== buf.byteLength) throw new Error('This saved voice is damaged. Remove it and add it again.');
  const take = (Type, n) => { const a = new Type(buf.slice(o, o + 4 * n)); o += 4 * n; return a; };
  const audioFeatures = take(Float32Array, h.af);
  const at = take(Int32Array, h.at);
  const speakerEmbeddings = take(Float32Array, h.se);
  const speakerFeatures = take(Float32Array, h.sf);
  return { audioFeatures, audioTokens: BigInt64Array.from(at, BigInt), speakerEmbeddings, speakerFeatures };
}

/** A short id for a voice name: lower-case letters, digits and dashes. */
export function voiceSlug(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return s || 'voice';
}

/** A voice's id: its name plus a few characters taken from the recording, so a new recording under the same name is a different voice (old audio isn't reused). */
export function voiceId(name, samples) {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(samples.length / 2000));
  for (let i = 0; i < samples.length; i += step) h = Math.imul(h ^ Math.round(samples[i] * 32767), 16777619) >>> 0;
  return `${voiceSlug(name)}-${h.toString(16).padStart(8, '0').slice(0, 5)}`;
}
