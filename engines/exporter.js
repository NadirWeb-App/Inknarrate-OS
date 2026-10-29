// Turns the generated sentences into files: one recording (WAV or MP3), a zip with one file per sentence,
// or subtitles. The page hands in what it knows (the sentences, the audio store and how a stored clip
// becomes the audio you hear), so this file has no state of its own.
import { concatWithGaps, trimBounds, dbToGain, BASS_HZ, TREBLE_HZ } from './dsp.js';
import { encodeWavChunks } from './text.js';
import { encodeMp3, makeZip } from './export-host.js';
import { cuesFor, toSrt, toVtt } from './subtitles.js';
import { sentenceFileName } from './export-names.js';

export const MP3_KBPS = [64, 96, 128, 160];   // 24 kHz MP3 (MPEG-2 layer III) tops out at 160 kbps

const hasTone = (fx) => Boolean(fx.gain || fx.bass || fx.treble);

/** Render samples through the same gain + bass + treble chain that playback uses. */
export async function renderTone(samples, rate, fx) {
  const ctx = new OfflineAudioContext(1, samples.length, rate);
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain(); g.gain.value = dbToGain(fx.gain);
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = BASS_HZ; low.gain.value = fx.bass;
  const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = TREBLE_HZ; high.gain.value = fx.treble;
  src.connect(g); g.connect(low); low.connect(high); high.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return out;
}

/** Number of samples a stored clip has once "trim silence" is applied (it matches prepareClip in app.js). */
function exportedLength(clip, fx) {
  if (!fx.trim) return clip.pcm.length;
  const [a, b] = clip.trim || trimBounds(clip.pcm, clip.rate);
  return b - a;
}

/** The generated sentences, in order: [{ seg, clip }]. Sentences without audio are left out. */
async function readyClips(segs, store) {
  const out = [];
  let skipped = 0;
  for (const seg of segs) {
    const clip = seg.key && store.has(seg.key) ? await store.get(seg.key) : null;
    if (clip) out.push({ seg, clip }); else skipped++;
  }
  return { ready: out, skipped };
}

/** Subtitle text for the one-file export (the timing matches the audio sample for sample). */
export async function buildSubtitles({ segs, store, fx, gapFor, kind }) {
  const { ready } = await readyClips(segs, store);
  if (!ready.length) return null;
  const rate = ready[0].clip.rate;
  const cues = cuesFor(ready.map(({ seg, clip }) => ({ n: exportedLength(clip, fx), gapAfter: gapFor(seg), text: seg.text })), rate);
  return kind === 'vtt' ? toVtt(cues) : toSrt(cues);
}

async function encodeOne(samples, rate, format, kbps, onProgress) {
  if (format === 'mp3') return encodeMp3(toInt16(samples), rate, kbps, onProgress);
  return new Uint8Array(await encodeWavChunks([{ samples, sampleRate: rate }], 0).arrayBuffer());
}

/**
 * Build an export.
 *   scope 'single'  one recording of everything that is generated
 *   scope 'zip'     one file per sentence, plus sentences.txt and subtitles for the whole recording
 * Returns { blob, ext, skipped } or null when nothing is generated. `onStatus(text)` reports progress,
 * `isCancelled()` is polled between sentences.
 */
export async function buildExport({ segs, store, fx, prepareClip, gapFor, format, kbps, scope, onStatus, isCancelled }) {
  const { ready, skipped } = await readyClips(segs, store);
  if (!ready.length) return null;
  const ext = format === 'mp3' ? 'mp3' : 'wav';
  const check = () => { if (isCancelled()) throw new Error('Export cancelled.'); };

  if (scope === 'single') {
    onStatus('Joining sentences…');
    const chunks = ready.map(({ seg, clip }) => ({ ...prepareClip(clip, fx), gapAfter: gapFor(seg) }));
    let { samples, rate } = concatWithGaps(chunks);
    check();
    if (hasTone(fx)) { onStatus('Applying volume and tone…'); samples = await renderTone(samples, rate, fx); check(); }
    onStatus(format === 'mp3' ? 'Encoding MP3… 0%' : 'Writing WAV…');
    const bytes = await encodeOne(samples, rate, format, kbps, (p) => onStatus(`Encoding MP3… ${p}%`));
    return { blob: new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }), ext, skipped };
  }

  // One file per sentence.
  const files = [];
  const lines = [];
  const lengths = [];
  const rate = ready[0].clip.rate;
  for (let i = 0; i < ready.length; i++) {
    check();
    const { seg, clip } = ready[i];
    onStatus(`Sentence ${i + 1} of ${ready.length}…`);
    let { samples } = prepareClip(clip, fx);
    if (hasTone(fx)) samples = await renderTone(samples, clip.rate, fx);
    const name = sentenceFileName(i, ready.length, seg.text, ext);
    files.push({ name, data: await encodeOne(samples, clip.rate, format, kbps, () => {}) });
    lines.push(`${name}\t${seg.text.replace(/\s+/g, ' ').trim()}`);
    lengths.push(samples.length);
  }
  const cues = cuesFor(ready.map(({ seg }, i) => ({ n: lengths[i], gapAfter: gapFor(seg), text: seg.text })), rate);
  const enc = new TextEncoder();
  files.push({ name: 'sentences.txt', data: enc.encode(lines.join('\n') + '\n') });
  files.push({ name: 'subtitles.srt', data: enc.encode(toSrt(cues)) });
  files.push({ name: 'subtitles.vtt', data: enc.encode(toVtt(cues)) });
  onStatus('Making the zip…');
  const zip = await makeZip(files, (p) => onStatus(`Making the zip… ${p}%`));
  return { blob: new Blob([zip], { type: 'application/zip' }), ext: 'zip', skipped };
}
