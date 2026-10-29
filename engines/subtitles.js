// Subtitles (SRT / WebVTT) for an exported recording. Pure functions, tested in tests/export.test.mjs.
//
// The cue times come from the same arithmetic as the audio join (concatWithGaps in dsp.js): a clip of
// n samples followed by a gap of round(rate * gapAfter) samples. So the subtitles line up with the file.

/**
 * clips: [{ n, gapAfter, text }]  n = number of samples actually exported for that sentence
 * Returns [{ start, end, text }] in seconds. No gap is counted after the last clip.
 */
export function cuesFor(clips, rate) {
  const cues = [];
  let at = 0;
  clips.forEach((c, i) => {
    cues.push({ start: at / rate, end: (at + c.n) / rate, text: c.text });
    at += c.n + (i < clips.length - 1 ? Math.round(rate * (c.gapAfter ?? 0)) : 0);
  });
  return cues;
}

const pad = (n, w) => String(n).padStart(w, '0');

function clock(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor(ms / 60000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}${sep}${pad(ms % 1000, 3)}`;
}
export const srtTime = (sec) => clock(sec, ',');
export const vttTime = (sec) => clock(sec, '.');

/** One line of plain text: whitespace (including newlines) collapsed. A blank line would end a cue. */
const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();

/** Cues whose end would not come after their start (empty clips) are dropped; the rest are numbered from 1. */
function usable(cues) {
  return cues.map((c) => ({ ...c, text: oneLine(c.text) })).filter((c) => c.text && c.end > c.start);
}

export function toSrt(cues) {
  return usable(cues).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

/** WebVTT text can't contain & or < unescaped. */
const vttText = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toVtt(cues) {
  const body = usable(cues).map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${vttText(c.text)}\n`).join('\n');
  return `WEBVTT\n\n${body}`;
}
