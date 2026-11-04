import { ENGINES, builtin } from './engines/registry.js';
import { normalizeText } from './engines/text.js';
import { createTour } from './engines/tour.js';
import { englishOnlyProblem } from './engines/script-check.js';
import { splitText, reconcile, hash53 } from './engines/segments.js';
import { AudioStore, toFloat32 } from './engines/audio-store.js';
import { createSegmentList } from './engines/segment-list.js';
import { Transport } from './engines/transport.js';
import { createPlayerBar } from './engines/player-bar.js';
import { trimBounds, normalizeGain } from './engines/dsp.js';
import { buildExport, buildSubtitles, MP3_KBPS } from './engines/exporter.js';
import { cancelExport } from './engines/export-host.js';
import { exportBase } from './engines/export-names.js';
import { autoWorkers, MAX_WORKERS, RESTART_MESSAGE } from './engines/pool.js';
import { importFile, MAX_IMPORT_CHARS } from './engines/importers.js';
import { makeProject, parseProject, MAX_PROJECT_BYTES } from './engines/project.js';
import { parseRules, applyRules } from './engines/pronounce.js';
import { describeInstalled, kokoroVoiceLabel, piperVoiceList, modelTag } from './engines/model-specs.js';
import { listFiles } from './engines/model-store.js';
import { createModelsUI } from './engines/models-ui.js';
import { DEFAULT_FX, PRESET_FIELDS, MAX_TAKES, MAX_OVERRIDES, cleanOverride, loadOverrides, saveOverrides, loadFx, saveFx, loadPresets, savePresets, loadTakes, saveTakes } from './engines/settings.js';

const $ = (id) => document.getElementById(id);
const LICENSE = { kitten: 'Apache-2.0', kokoro: 'Apache-2.0', piper: 'MIT (per-voice licences)', builtin: '—' };

const ORT = ['vendor/engines.bundle.js', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm'];
const RUNTIME = { kitten: ORT, kokoro: ORT, piper: ORT };

const state = {
  fx: loadFx(),
  engine: null,
  installed: {},   // engine id -> its model files are in place
  voices: {},
  tags: {},        // engine id -> part of the cache key that identifies the model file (empty for the tested files)
  modelInfo: {},   // engine id -> describeInstalled(...)
  modelSizes: {},  // engine id -> bytes stored in this browser
  modelsError: '', // set when the browser's storage can't be used
  phase: 'idle', // idle | loading | speaking   (speaking = generating and/or playing)
  busyLabel: 'Speaking',
  opts: { periods: true, lines: true }, // how the text is split into sentences
  activeId: null,                       // sentence being played
  rate: {},                             // per engine: { audio, secs, chars } measured while generating
  run: 0,        // bumped by every Speak and Stop: work belonging to an older run discards itself
  loaded: new Set(),
};
const loads = new Map(); // engine id -> load promise, so a model is never loaded twice
const store = new AudioStore();
let segs = [];           // the sentences: { id, text, start, end, para, key, synthText, edited, busy, error }
let nextId = 1;
const newId = () => 's' + nextId++;
let list = null;         // the segment list view (created in boot)
let bar = null;          // the player bar (created in boot)
let session = null;      // the current Speak / generate run (see startSession)
let tlItems = [];        // the player bar's timeline: [{ dur, ready, gap }]
let compiled = { rules: [], errors: [] }; // the pronunciation rules, parsed
let takes = loadTakes();
let overrides = loadOverrides(); // text hash -> { voice, speed, pitch, pause } set on one sentence
let hasOverrides = Object.keys(overrides).length > 0;  // text hash -> take number (0 = default delivery)
const inflight = new Map(); // cache key -> promise of a clip being generated, so nobody generates it twice

// ---- helpers ---------------------------------------------------------------

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

function setStat(msg, isError = false) {
  const el = $('stat');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

async function cached(url) {
  try { return await caches.match(url); } catch { return undefined; }
}

async function sizeOf(url) {
  const hit = await cached(url);
  if (hit) {
    const n = hit.headers.get('content-length');
    if (n) return +n;
    try { return (await hit.clone().blob()).size; } catch { /* fall through */ }
  }
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const n = r.headers.get('content-length');
    return r.ok && n && !(r.headers.get('content-type') || '').includes('text/html') ? +n : null;
  } catch { return null; }
}

const mb = (n) => (n == null ? '—' : n < 1e6 ? `${(n / 1e3).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`);

// ---- install detection + footprint ----------------------------------------

/** Read what is stored in this browser and work out which engines are ready and which voices they have. */
async function refreshModels() {
  let records = [];
  try { records = await listFiles(); state.modelsError = ''; }
  catch (err) { state.modelsError = (err && err.message) || String(err); }
  for (const e of ENGINES) {
    if (e.id === 'builtin') {
      const ok = e.available();
      if (ok && !state.voices.builtin) state.voices.builtin = await e.refreshVoices();   // once: it can wait for the browser's voice list
      state.installed.builtin = ok;
      continue;
    }
    const mine = records.filter((r) => r.engine === e.id);
    const d = describeInstalled(e.id, mine);
    state.modelInfo[e.id] = d;
    state.installed[e.id] = d.ready;
    state.tags[e.id] = modelTag(e.id, mine);
    state.modelSizes[e.id] = mine.reduce((n, r) => n + (r.size || 0), 0);
    state.voices[e.id] = e.id === 'kokoro' ? d.voices.map(kokoroVoiceLabel) : e.id === 'piper' ? piperVoiceList(mine) : e.voices;
  }
  warmLanguageData();
}

/** Spanish and Arabic voices need extra data (eSpeak for all languages, 18 MB; Arabic also the vowel-mark model, 13 MB). Fetch it now so the service worker keeps it for offline use. */
const warmed = new Set();
function warmLanguageData() {
  const langs = new Set((state.voices.piper || []).map((v) => v.lang));
  const files = [];
  if ([...langs].some((l) => l && l !== 'en')) files.push('vendor/espeak-ng/espeak-ng.js', 'vendor/espeak-ng/espeak-ng.wasm');
  if (langs.has('ar')) files.push('vendor/libtashkeel/libtashkeel_wasm_bg.js', 'vendor/libtashkeel/libtashkeel_wasm_bg.wasm');
  for (const f of files) {
    if (warmed.has(f)) continue;
    warmed.add(f);
    fetch(f).catch(() => warmed.delete(f));
  }
}

async function renderFootprint() {
  const rows = [];
  for (const e of ENGINES.filter((x) => x.id !== 'builtin')) {
    const rt = (RUNTIME[e.id] || []).map((p) => new URL('./' + p, location.href).href);
    const rtSize = (await Promise.all(rt.map(sizeOf))).reduce((a, b) => a + (b || 0), 0);
    const mSize = state.modelSizes[e.id] || 0;
    rows.push(`<tr><td>${e.label}</td><td class="num">${mb(rtSize)}</td>`
      + `<td class="num">${state.installed[e.id] ? mb(mSize) : 'not added'}</td>`
      + `<td class="num">${state.installed[e.id] ? mb(rtSize + mSize) : '—'}</td><td>${LICENSE[e.id]}</td></tr>`);
  }
  $('foot').innerHTML = rows.join('');
}

// ---- controls ------------------------------------------------------------------

function updateControls() {
  const e = state.engine;
  if (!e) return;
  const native = e.kind === 'native';
  const idle = state.phase === 'idle';
  const missing = native ? 0 : segs.filter((x) => !store.has(x.key)).length;
  // Speak is available whenever the engine is, and restarts if something is already playing.
  $('speak').disabled = !state.installed[e.id];
  $('stop').disabled = idle;
  $('genAll').disabled = native || !state.installed[e.id] || missing === 0 || !idle;
  $('workers').disabled = !idle;
  updateExportUI();
}

function setPhase(phase, label) {
  state.phase = phase;
  if (label) state.busyLabel = label;
  updateControls();
  // The dots animate on the compositor, so they keep moving even while the page is busy.
  const el = $('busyLabel');
  if (el) el.textContent = phase === 'loading' ? 'Loading' : state.busyLabel;
  if (window.InkUI) InkUI.busy(phase !== 'idle', '#busy');
  if (list) renderSegs(); // row buttons depend on whether something is running
}

function updateSpeedControl() {
  const e = state.engine;
  const ok = e.supportsSpeed($('voice').value);
  $('speed').disabled = !ok;
  $('speed').title = ok ? '' : 'This voice has no speed control';
}

// The engine list is built once and updated in place, so focus and keyboard position survive a switch.
function buildTabs() {
  const box = $('engines');
  box.innerHTML = '';
  for (const e of ENGINES) {
    const b = document.createElement('button');
    b.className = 'tts-engine';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.id = e.id;
    b.innerHTML = '<span class="tts-dot" aria-hidden="true"></span><span class="tts-engine__text"><span class="tts-engine__name"></span><span class="tts-engine__sub"></span></span>';
    b.querySelector('.tts-engine__name').textContent = e.label;
    b.onclick = () => selectEngine(e);
    b.onkeydown = tabKeys;
    box.append(b);
  }
}

function engineSub(e) {
  if (e.kind === 'native') return state.installed[e.id] ? 'Built into your browser' : 'Not supported here';
  if (!state.installed[e.id]) return 'Not set up yet';
  const n = (state.voices[e.id] || []).length;
  return `Ready · ${n} voice${n === 1 ? '' : 's'}`;
}

function updateTabs() {
  for (const b of $('engines').children) {
    const e = ENGINES.find((x) => x.id === b.dataset.id);
    const ok = Boolean(state.installed[e.id]);
    b.setAttribute('aria-selected', String(e === state.engine));
    b.classList.toggle('is-active', e === state.engine);
    b.classList.toggle('is-missing', !ok);
    b.tabIndex = e === state.engine ? 0 : -1;
    b.title = ok ? 'Ready' : 'Model files not added yet';
    b.querySelector('.tts-dot').className = `tts-dot ${ok ? 'is-ready' : 'is-missing'}`;
    b.querySelector('.tts-engine__sub').textContent = engineSub(e);
  }
}

function tabKeys(ev) {
  const tabs = [...$('engines').children];
  const i = tabs.indexOf(ev.currentTarget);
  const next = {
    ArrowRight: (i + 1) % tabs.length,
    ArrowDown: (i + 1) % tabs.length,
    ArrowLeft: (i - 1 + tabs.length) % tabs.length,
    ArrowUp: (i - 1 + tabs.length) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  }[ev.key];
  if (next === undefined) return;
  ev.preventDefault();
  tabs[next].focus(); // Enter/Space on the focused tab selects it
}

function renderEngine() {
  const e = state.engine;
  const sel = $('voice');
  sel.innerHTML = '';
  const voices = state.voices[e.id] || [];
  for (const v of voices) sel.add(new Option(v.label, v.id));
  const saved = lsGet('voice:' + e.id);
  if (saved && voices.some((v) => v.id === saved)) sel.value = saved;
  sel.disabled = voices.length <= 1;
  loadSpeedFor(e);
  updateSpeedControl();
  renderVoice2();
  applyCaps();
  computeKeys();
  renderSegs();

  const notice = $('notice');
  if (!state.installed[e.id]) {
    notice.hidden = false;
    notice.replaceChildren();
    if (e.id === 'builtin') {
      notice.textContent = 'This browser has no speech synthesis support.';
    } else {
      const d = state.modelInfo[e.id];
      notice.append(`${e.label} isn’t set up yet${d && d.missing.length ? `. Missing: ${d.missing.join(', ')}` : ''}. `);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tts-seg__link'; b.textContent = 'Add the model files';
      b.onclick = () => openModels();
      notice.append(b, '.');
      if (state.modelsError) notice.append(document.createElement('br'), state.modelsError);
    }
  } else {
    notice.hidden = true;
  }
  $('modelsHint').hidden = !(e.kind === 'native' && ENGINES.some((x) => x.kind !== 'native' && !state.installed[x.id]));
  updateControls();
  updateTabs();
}

// ---- loading -------------------------------------------------------------------

/** Start (or join) the one load for this engine. A failed load can be retried. */
function ensureLoaded(e) {
  if (e.kind === 'native') return Promise.resolve(0);
  let p = loads.get(e.id);
  if (!p) {
    const t0 = performance.now();
    p = e.load((msg) => { if (state.engine === e) setStat(msg); })
      .then(() => { state.loaded.add(e.id); return (performance.now() - t0) / 1000; });
    loads.set(e.id, p);
    p.catch(() => loads.delete(e.id));
  }
  return p;
}

/** Load the selected engine in the background so the first Speak starts right away. */
async function preload(e) {
  if (e.kind === 'native' || !state.installed[e.id] || state.loaded.has(e.id)) return;
  setStat(`Loading ${e.label}…`);
  try {
    const secs = await ensureLoaded(e);
    if (state.engine === e && state.phase === 'idle') setStat(`${e.label} ready (loaded in ${secs.toFixed(1)} s).`);
  } catch (err) {
    if (err && err.message === RESTART_MESSAGE) return;   // the workers were restarted on purpose (setting changed); it loads again
    console.error(err);
    if (state.engine === e && state.phase === 'idle') setStat(`${e.label} failed to load: ${err.message || err}`, true);
  }
}

// ---- sentences ---------------------------------------------------------------

const curVoice = () => $('voice').value;
const curSpeed = () => parseFloat($('speed').value);
const ovKey = (text) => String(hash53(text));
const textHash = (s) => s.th ?? (s.th = hash53(s.text));   // memoized: a sentence's text never changes (edits make a new one)
const ovOf = (s) => (hasOverrides ? overrides[String(textHash(s))] || null : null);
/** Pause after a sentence: its own override, else the paragraph / sentence pause. Works on sentences and jobs. */
const gapOf = (s, fx = state.fx) => { const o = ovOf(s); return o && o.pause !== undefined ? o.pause : (s.para ? fx.gapPara : fx.gapSentence); };
const takeOf = (s) => takes[textHash(s)] || 0;

/** Settings that change the generated audio itself (the others are applied while playing / exporting). */
function bakedOpts(e, voice, pitch = state.fx.pitch) {
  const c = e.caps || {}, fx = state.fx, o = {};
  if (c.mix && fx.voice2 && fx.voice2 !== voice && fx.mix > 0) { o.voice2 = fx.voice2; o.mix = fx.mix; }
  if (c.pitch && pitch) o.pitch = pitch;
  return o;
}

/** The voice, speed and pitch a sentence is generated with: its overrides on top of the global settings. */
function effOf(s, e) {
  const o = e.caps && e.caps.override ? ovOf(s) : null;
  const voices = state.voices[e.id] || [];
  const voice = o && o.voice && voices.some((v) => v.id === o.voice) ? o.voice : curVoice();
  const speed = o && o.speed !== undefined && e.supportsSpeed(voice) ? o.speed : curSpeed();
  const pitch = o && o.pitch !== undefined ? o.pitch : state.fx.pitch;
  return { voice, speed, opts: bakedOpts(e, voice, pitch) };
}

/** What gets sent to the engine for a sentence, and the key its audio is stored under. */
function computeKeys() {
  const e = state.engine;
  if (!e) return;
  const c = e.caps || {};
  for (const s of segs) {
    const spoken = applyRules(s.text, compiled.rules);
    s.synthText = e.normalize ? normalizeText(spoken) : spoken;
    if (e.kind === 'native') { s.key = null; continue; }
    const { voice, speed, opts } = effOf(s, e);
    // Only non-default settings add to the key, so audio generated before these settings existed stays valid.
    const extra = [];
    if (opts.voice2) extra.push('v2=' + opts.voice2, 'mix=' + opts.mix.toFixed(2));
    if (opts.pitch) extra.push('pitch=' + opts.pitch);
    const t = c.take ? takeOf(s) : 0;
    if (t) extra.push('take=' + t);
    if (state.tags[e.id]) extra.push('m=' + state.tags[e.id]);   // a different model file makes different audio
    s.key = hash53([e.id, voice, speed.toFixed(2), s.synthText, ...extra].join('\u0001'));
  }
}

/** A sentence was edited: its new text starts with the settings the old text had. */
function carryOverride(oldText, newText) {
  const from = overrides[ovKey(oldText)];
  if (!from || overrides[ovKey(newText)]) return;
  overrides[ovKey(newText)] = { ...from };
  hasOverrides = true;
  const keys = Object.keys(overrides);
  if (keys.length > MAX_OVERRIDES) for (const k of keys.slice(0, keys.length - MAX_OVERRIDES)) delete overrides[k];
  saveOverrides(overrides);
}

/** Re-split the text box. Sentences you didn't touch keep their rows and audio. */
function resegment() {
  const old = new Map(segs.map((x) => [x.id, x]));
  const next = reconcile(segs, splitText($('text').value, state.opts), newId);
  for (const r of next) {
    const prev = old.get(r.id);
    if (prev && prev.text === r.text) { r.busy = prev.busy; r.error = prev.error; r.edited = prev.edited; }
    else if (r.from) {
      r.edited = Boolean(r.from.key && store.has(r.from.key)) || Boolean(r.from.edited);
      carryOverride(r.from.text, r.text);   // editing a sentence keeps its own voice/speed/pitch/pause
    }
    delete r.from;
  }
  segs = next;
  computeKeys();
  for (const r of segs) if (store.has(r.key)) r.edited = false;
  renderSegs();
}

// id -> index, rebuilt only when the sentence array is replaced (a book has tens of thousands of sentences).
let idxMemo = { arr: null, map: null };
const indexOfId = (id) => {
  if (idxMemo.arr !== segs) idxMemo = { arr: segs, map: new Map(segs.map((x, i) => [x.id, i])) };
  const i = idxMemo.map.get(id);
  return i === undefined ? -1 : i;
};
const find = (id) => { const i = indexOfId(id); return i < 0 ? undefined : segs[i]; };

/** Could these two neighbouring sentences be joined by removing the break between them? */
function canMerge(i) {
  const a = segs[i], b = segs[i + 1];
  if (!b || !/\n/.test($('text').value.slice(a.end, b.start))) return false;
  return splitText(a.text + ' ' + b.text, state.opts).length === 1;
}

function viewOf(s, i) {
  const e = state.engine;
  const native = e.kind === 'native';
  const has = !native && store.has(s.key);
  let label, tone = 'idle';
  if (s.busy === 'generating') { label = 'Generating…'; tone = 'busy'; }
  else if (s.busy === 'queued') { label = 'Queued'; }
  else if (s.error) { label = 'Failed'; tone = 'error'; }
  else if (has) { label = `Ready · ${list.fmtDur(store.info(s.key).dur)}${takeOf(s) ? ` · take ${takeOf(s) + 1}` : ''}`; tone = 'ready'; }
  else if (native) { label = 'Not saved (browser voice)'; }
  else if (s.edited) { label = 'Edited · not generated'; tone = 'edited'; }
  else label = 'Not generated';
  return {
    label, tone, title: s.error || '',
    canGen: !native && !has && !s.busy && state.installed[e.id] && state.phase === 'idle',
    hideGen: native || has,
    canRetake: !native && !s.busy && state.installed[e.id] && state.phase === 'idle',
    hideRetake: native || !(e.caps && e.caps.take),
    canTune: !native && !s.busy,
    hideTune: native || !(e.caps && e.caps.override),
    tag: overrideTag(s),
    canPlay: Boolean(state.installed[e.id]),
    canMerge: canMerge(i),
    active: s.id === state.activeId,
  };
}

function renderSegs() {
  if (!list || !state.engine) return;
  list.sync(segs, viewOf);
  updateExportUI();
  updateOvrInfo();
  $('segEmpty').hidden = segs.length > 0;
  const e = state.engine;
  let text = '';
  if (segs.length) {
    text = `${segs.length} sentence${segs.length === 1 ? '' : 's'}`;
    if (e.kind !== 'native') {
      const todo = segs.filter((x) => !store.has(x.key));
      text += ` · ${segs.length - todo.length} ready`;
      if (todo.length) {
        text += ` · ${todo.length} to generate`;
        const r = state.rate[e.id];
        if (r && r.chars) text += ` (≈ ${fmtTime(todo.reduce((n, x) => n + x.synthText.length, 0) * r.secs / r.chars)})`;
      }
    }
  }
  $('segSummary').textContent = text;
  updateControls();
  if (bar) {
    bar.show(e.kind !== 'native' && segs.length > 0);
    rebuildTimeline();
  }
}

function fmtTime(sec) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function repaint(id) {
  const i = indexOfId(id);
  if (i >= 0) list.update(segs[i], i, viewOf(segs[i], i));
}

function setBusy(id, busy) {
  const s = find(id);
  if (!s) return;
  s.busy = busy;
  if (busy) s.error = undefined;
  repaint(id);
}

function clearBusy() {
  const prev = state.activeId;
  for (const s of segs) s.busy = null;
  state.activeId = null;
  if (prev) repaint(prev);
}

function setActive(id) {
  const prev = state.activeId;
  state.activeId = id;
  if (prev) repaint(prev);
  repaint(id);
  list.scrollTo(indexOfId(id));
}

function renderCacheInfo() {
  const { count, bytes } = store.stats();
  $('cacheInfo').textContent = count ? `${count} sentence${count === 1 ? '' : 's'} (${mb(bytes)})` : 'none';
  $('cacheClear').hidden = !count;
}

// ---- speaking / generating --------------------------------------------------------
//
// Generation and playback are separate. A *session* is one Speak / "Generate all" / per-sentence click:
//   - a background loop generates the missing sentences in order (and keeps going while you listen);
//   - the transport plays sentences as their audio becomes available, waiting if it catches up.
// Jumping ahead (seek) generates the sentence you jumped to first, then carries on from there.

const transport = new Transport({
  provide: provideClip,
  onitem: (i) => { if (session && session.jobs[i]) setActive(session.jobs[i].id); },
  onpos: (pos) => renderPlayer(pos),
  onstate: () => { renderPlayer(); updateMediaSession(); maybeIdle(); },
  onend: () => maybeIdle(),
});

function cancelPlayback() {
  transport.stop();
  if (builtin.available()) builtin.stop();
}

/** Stop everything. Bumping the run id makes any in-flight work from the old run discard itself. */
function stop(message) {
  state.run++;
  session = null;
  cancelPlayback();
  clearBusy();
  setPhase('idle');
  if (message !== undefined) setStat(message);
  rebuildTimeline();
}

async function selectEngine(e) {
  if (e === state.engine) return;
  stop();
  state.engine = e;
  lsSet('engine', e.id);
  renderEngine();
  setStat('');
  preload(e);
}

/** A sentence's audio from the store, generating it if needed. Concurrent requests share one generation. */
async function getClip(sess, job) {
  const hit = await store.get(job.key);
  if (hit) return hit;
  let p = inflight.get(job.key);
  if (!p) {
    p = generateOne(sess, job).finally(() => inflight.delete(job.key));
    inflight.set(job.key, p);
  }
  return p;
}

async function generateOne(sess, job) {
  const { e } = sess;
  const { voice, speed, opts } = job;
  const live = () => sess.run === state.run;
  try {
    if (!state.loaded.has(e.id)) {
      if (live()) { setPhase('loading'); setStat(`Loading ${e.label}…`); }
      const secs = await ensureLoaded(e);
      if (live()) { setPhase('speaking'); setStat(`Loaded ${e.label} in ${secs.toFixed(1)} s.`); }
    }
  } catch (err) {
    console.error(err);
    if (live()) { sess.fatal = true; setStat(`${e.label} failed to load: ${err.message || err}`, true); }
    return null;
  }
  setBusy(job.id, 'generating');
  if (live()) setStat(sess.todo.has(job.key) ? `Generating ${Math.min(sess.doneN + 1, sess.todo.size)}/${sess.todo.size}…` : 'Generating…');
  const t0 = performance.now();
  // Time spent generating = the time at least one sentence was in progress (sentences can run side by side).
  if (sess.active++ === 0) sess.activeSince = t0;
  const endActive = () => { if (--sess.active === 0) sess.stats.secs += (performance.now() - sess.activeSince) / 1000; };
  let clip;
  try {
    const out = await e.synth(job.synthText, { voice, speed, ...opts, take: job.take });
    clip = await store.put(job.key, out); // kept even if this run was stopped meanwhile
  } catch (err) {
    endActive();
    console.error(err);
    sess.stats.failed++;
    const s = find(job.id);
    if (s) { s.busy = null; s.error = err.message || String(err); repaint(job.id); }
    return null;
  }
  const secs = (performance.now() - t0) / 1000;
  const r = (state.rate[e.id] ||= { audio: 0, secs: 0, chars: 0 });
  endActive();
  r.audio += clip.dur; r.secs += secs; r.chars += job.synthText.length;
  sess.stats.made++; sess.stats.audio += clip.dur; sess.doneN++;
  const s = find(job.id);
  if (s) { s.busy = null; s.edited = false; }
  renderCacheInfo();
  renderSegs();
  return clip;
}

/** What the transport asks for: sentence i of the session, as playable samples (null if it failed). */
async function provideClip(i) {
  const sess = session;
  const job = sess && sess.jobs[i];
  if (!job) return null;
  const clip = await getClip(sess, job);
  return clip ? prepareClip(clip) : null;
}

/** Playback/export version of a stored clip: optional silence trim and loudness evening (non-destructive). */
function prepareClip(clip, fx = state.fx) {
  let pcm = clip.pcm;
  if (fx.trim) {
    const [a, b] = clip.trim || trimBounds(pcm, clip.rate);
    if (a > 0 || b < pcm.length) pcm = pcm.subarray(a, b);
  }
  const samples = toFloat32(pcm);
  if (fx.normalize) {
    const g = normalizeGain(pcm);
    if (g !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= g;
  }
  return { samples, rate: clip.rate };
}

/** Push the current pause settings into a running transport (applies to sentences not yet scheduled). */
function applyGaps() {
  for (const it of transport.items) { const s = find(it.id); if (s) it.gapAfter = gapOf(s); }
}

/** Generate the missing sentences, in order, from sentence `from` (or just the `only` ids). */
async function runGeneration(sess, { from = 0, only = null } = {}) {
  const token = ++sess.genToken;
  const alive = () => sess.run === state.run && sess.genToken === token;
  const list = only ? sess.jobs.filter((j) => only.includes(j.id)) : sess.jobs.slice(from);
  const todo = list.filter((j) => !store.has(j.key));

  const queued = new Set(todo.map((j) => j.id));
  for (const s of segs) if (s.busy !== 'generating') s.busy = queued.has(s.id) ? 'queued' : null;
  renderSegs();
  sess.todo = new Set(todo.map((j) => j.key));
  sess.doneN = 0;
  sess.genDone = false;
  if (!todo.length) setStat(sess.play ? 'Playing…' : 'Everything is already generated.');

  // Several lanes take sentences in reading order, so up to `workers` sentences are generated at once.
  let next = 0;
  const lane = async () => {
    while (alive() && !sess.fatal) {
      const j = todo[next++];
      if (!j) return;
      if (store.has(j.key)) continue; // already made (a seek asked for it first)
      await getClip(sess, j);
    }
  };
  const lanes = sess.e.workers ? sess.e.workers() : 1;
  await Promise.all(Array.from({ length: Math.min(lanes, todo.length) }, lane));
  if (!alive()) return;

  const { made, failed, audio, secs } = sess.stats;
  if (made) {
    setStat(`Generated ${made} sentence${made === 1 ? '' : 's'}: ${audio.toFixed(1)} s of audio in ${secs.toFixed(1)} s `
      + `(${(audio / secs).toFixed(1)}× real time)${failed ? ` · ${failed} failed` : ''}.`);
  } else if (failed) {
    setStat(`${failed} sentence${failed === 1 ? '' : 's'} failed. Hover a “Failed” label for the reason.`, true);
  }
  sess.genDone = true;
  maybeIdle();
}

/** The session is over when generation is finished and nothing is playing (or paused). */
function maybeIdle() {
  const sess = session;
  if (!sess || sess.run !== state.run || sess.native) return;
  if (transport.active || !sess.genDone) return;
  session = null;
  clearBusy();
  setPhase('idle');
  rebuildTimeline();
}

/**
 * Start a run. `play`: play from sentence `from` (offset seconds in) while generating what's missing.
 * `to`: with `play`, stop before sentence `to` and generate only what is played (default: to the end).
 * `only`: generate just these sentence ids (no playback).
 */
function startSession({ from = 0, to = null, offset = 0, play = false, only = null } = {}) {
  const e = state.engine;
  if (!state.installed[e.id]) return;
  resegment();
  if (!segs.length) return setStat('Type some text first.', true);
  if (e.id === 'kitten' || e.id === 'kokoro') {
    const problem = englishOnlyProblem(segs.map((x) => x.synthText).join(' '), e.label);
    if (problem) { setStat(problem, true); if (window.InkUI) InkUI.toast(problem, 6000); return; }
  }

  const run = ++state.run;
  session = null;
  cancelPlayback();
  clearBusy();
  const voice = curVoice(), speed = curSpeed();
  lsSet('voice:' + e.id, voice);
  // Snapshot: editing the text while this runs must not change what this run does.
  const jobs = segs.map((s) => ({ id: s.id, text: s.text, synthText: s.synthText, key: s.key, para: s.para, chars: s.synthText.length,
    take: (e.caps && e.caps.take) ? takeOf(s) : 0, ...(e.kind === 'native' ? {} : effOf(s, e)) }));
  const label = play ? 'Speaking' : 'Generating';

  if (e.kind === 'native') {
    session = { run, native: true };
    setPhase('speaking', label);
    setStat('Speaking with the browser voice…');
    const list = jobs.slice(from, to ?? undefined);
    e.speak(list.map((j) => j.synthText), {
      voice, speed, pitch: state.fx.pitch, onchunk: (i) => { if (run === state.run) setActive(list[i].id); },
    }).then(() => {
      if (run !== state.run) return;
      session = null; clearBusy(); setPhase('idle'); setStat('Done.');
    });
    return;
  }

  session = { run, e, voice, speed, jobs, play, genToken: 0, genDone: false, fatal: false,
    stats: { made: 0, failed: 0, audio: 0, secs: 0 }, todo: new Set(), doneN: 0, active: 0, activeSince: 0 };
  setPhase('speaking', label);
  rebuildTimeline();
  if (play) transport.play(jobs.map((j) => ({ id: j.id, gapAfter: gapOf(j) })), from, offset, to ?? jobs.length);
  runGeneration(session, { from, only: only || (to != null ? jobs.slice(from, to).map((j) => j.id) : null) });
}

const speak = () => startSession({ play: true });
const playFrom = (index, offset = 0) => startSession({ play: true, from: index, offset });
/** A sentence row's play button: that sentence only. */
const playOne = (index) => startSession({ play: true, from: index, to: index + 1 });

/** Seek: inside a running session jump there (generating that sentence first); otherwise start from there. */
function seekTo(index, offset = 0) {
  if (transport.active && session && !session.native) {
    transport.seek(index, offset);
    runGeneration(session, { from: index });
  } else playFrom(index, offset);
}

function togglePlay() {
  const e = state.engine;
  if (!e || e.kind === 'native' || !state.installed[e.id]) return;
  if (transport.active) transport.toggle();
  else speak();
}

// ---- player bar ----------------------------------------------------------------

function timelineItems() {
  const src = transport.active && session && session.jobs ? session.jobs : segs;
  const r = state.rate[state.engine.id];
  const charsPerSec = r && r.audio ? r.chars / r.audio : 14; // used to estimate sentences that aren't generated yet
  return src.map((s) => {
    const info = s.key && store.has(s.key) ? store.info(s.key) : null;
    const chars = (s.synthText || s.text).length;
    const dur = info ? (state.fx.trim ? store.trimmedDur(s.key) : info.dur) : Math.max(0.6, chars / charsPerSec);
    return { dur, ready: Boolean(info), gap: gapOf(s) };
  });
}

function renderPlayer(pos) {
  if (!bar) return;
  const p = pos || transport.position();
  bar.render({ index: p ? p.index : -1, offset: p ? p.offset : 0, state: transport.state });
}

function rebuildTimeline() {
  if (!bar || !state.engine) return;
  tlItems = timelineItems();
  const p = transport.position();
  bar.render({ items: tlItems, index: p ? p.index : -1, offset: p ? p.offset : 0, state: transport.state });
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    const st = transport.state;
    navigator.mediaSession.playbackState = st === 'paused' ? 'paused' : st === 'idle' ? 'none' : 'playing';
    if (st !== 'idle') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: $('text').value.trim().slice(0, 60) || 'Inknarrate',
        artist: 'Inknarrate', album: `${state.engine.label} · ${curVoice()}`,
      });
    }
  } catch { /* best effort */ }
}

function selectInBox(id) {
  const s = find(id);
  if (!s) return;
  const ta = $('text');
  ta.focus();
  ta.setSelectionRange(s.start, s.end);
  // Bring the selection into view (textareas don't always scroll on setSelectionRange).
  const before = ta.value.slice(0, s.start).split('\n').length;
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, before * lh - ta.clientHeight / 2);
}

function mergeWithNext(id) {
  const i = segs.findIndex((x) => x.id === id);
  if (i < 0 || !canMerge(i)) return;
  const t = $('text').value;
  $('text').value = t.slice(0, segs[i].end) + ' ' + t.slice(segs[i + 1].start);
  textChanged();
}

function splitAtCursor() {
  const ta = $('text');
  const t = ta.value;
  let a = ta.selectionStart, b = ta.selectionEnd;
  while (a > 0 && /[ \t]/.test(t[a - 1])) a--;
  while (b < t.length && /[ \t]/.test(t[b])) b++;
  ta.value = t.slice(0, a) + '\n' + t.slice(b);
  ta.setSelectionRange(a + 1, a + 1);
  ta.focus();
  if (!state.opts.lines) {
    setOpt('lines', true);
    if (window.InkUI) InkUI.toast('Turned on “Split at line breaks”');
  }
  textChanged();
}

let saveTimer, segTimer;
function textChanged() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => lsSet('text', $('text').value), 300);
  clearTimeout(segTimer);
  segTimer = setTimeout(resegment, 120);
}

function setOpt(name, on) {
  state.opts[name] = on;
  lsSet('split:' + name, on ? '1' : '0');
  const el = $(name === 'periods' ? 'optPeriods' : 'optLines');
  el.classList.toggle('is-on', on);
  el.setAttribute('aria-pressed', String(on));
}

// ---- importing text files -----------------------------------------------------

async function importText(file) {
  if (!file) return;
  const fail = (msg) => { setStat(msg, true); if (window.InkUI) InkUI.toast(msg, 4500); };
  setStat(`Reading ${file.name}…`);
  let r;
  try { r = await importFile(file); } catch (err) { return fail(err.message || String(err)); }
  const box = $('text');
  let text = r.text, truncated = r.truncated;
  if (box.value.trim()) {
    const replace = confirm(`Replace the current text with this ${r.kind}?\n\nOK replaces it. Cancel adds it to the end instead.`);
    if (!replace) text = box.value.replace(/\s+$/, '') + '\n\n' + r.text;
  }
  if (text.length > MAX_IMPORT_CHARS) { text = text.slice(0, MAX_IMPORT_CHARS); truncated = true; }
  stop();
  box.value = text;
  box.scrollTop = 0;
  textChanged();
  clearTimeout(segTimer);
  resegment();
  lsSet('text', text);
  const words = text.trim().split(/\s+/).length;
  setStat(`Imported ${r.kind} “${file.name}”: ${segs.length.toLocaleString()} sentences, about ${words.toLocaleString()} words.${truncated ? ' It was cut at 2 million characters.' : ''}`);
}

function initImport() {
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    await importText(file);
  };
  // Drop a file on the text box. (Dropping selected text still works as usual.)
  const box = $('text');
  const hasFile = (ev) => ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
  box.addEventListener('dragover', (ev) => { if (hasFile(ev)) { ev.preventDefault(); box.classList.add('is-drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('is-drop'));
  box.addEventListener('drop', async (ev) => {
    box.classList.remove('is-drop');
    if (!hasFile(ev)) return;
    ev.preventDefault();
    await importText(ev.dataTransfer.files[0]);
  });
}

// ---- generation workers ---------------------------------------------------------

/** "Auto" or 1..4 from the select -> how many workers the engines should use. */
function wantedWorkers() {
  const v = $('workers').value;
  return v === 'auto' ? autoWorkers() : Math.max(1, Math.min(MAX_WORKERS, parseInt(v, 10) || 1));
}

/** Tell the engines. Returns true when one was restarted (its model has to load again). */
function applyWorkers() {
  const n = wantedWorkers();
  let restarted = false;
  for (const e of ENGINES) {
    if (e.setWorkers && e.setWorkers(n)) { restarted = true; loads.delete(e.id); state.loaded.delete(e.id); }
  }
  $('workersInfo').textContent = $('workers').value === 'auto'
    ? `Auto uses ${n} worker${n === 1 ? '' : 's'} on this device.`
    : `${n} sentence${n === 1 ? '' : 's'} at a time.`;
  return restarted;
}

function initWorkers() {
  const sel = $('workers');
  const saved = lsGet('workers');
  if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  applyWorkers();
  sel.onchange = () => {
    lsSet('workers', sel.value);
    const e = state.engine;
    if (applyWorkers() && e && e.kind !== 'native') preload(e);
  };
}

// ---- per-sentence settings --------------------------------------------------

const OVR_FMT = { speed: (v) => `${v.toFixed(2)}×`, pitch: (v) => `${v > 0 ? '+' : ''}${v} st`, pause: (v) => `${v.toFixed(2)} s` };
let tuneId = null;     // the sentence being edited in the dialog
let draft = {};        // its settings so far; a missing key means "use the main setting"

/** The small label on a row that has its own settings, e.g. "Bella · 1.20× · +1 st". */
function overrideTag(s) {
  const e = state.engine;
  const o = e && e.caps && e.caps.override ? ovOf(s) : null;
  if (!o) return '';
  const parts = [];
  if (o.voice) { const v = (state.voices[e.id] || []).find((x) => x.id === o.voice); if (v) parts.push(v.label.replace(/ \(.*\)$/, '')); }
  if (o.speed !== undefined) parts.push(OVR_FMT.speed(o.speed));
  if (o.pitch !== undefined) parts.push(OVR_FMT.pitch(o.pitch));
  if (o.pause !== undefined) parts.push(`${o.pause.toFixed(2)} s pause`);
  return parts.join(' · ');
}

function updateOvrInfo() {
  const row = $('ovrInfoRow');
  if (!row || !state.engine) return;
  const n = state.engine.caps && state.engine.caps.override ? segs.filter((s) => ovOf(s)).length : 0;
  row.hidden = n === 0;
  $('ovrInfo').textContent = `${n} sentence${n === 1 ? ' has' : 's have'} its own settings.`;
}

function afterOverrides() {
  const keys = Object.keys(overrides);
  if (keys.length > MAX_OVERRIDES) for (const k of keys.slice(0, keys.length - MAX_OVERRIDES)) delete overrides[k];
  hasOverrides = Object.keys(overrides).length > 0;
  saveOverrides(overrides);
  computeKeys();
  renderSegs();
  rebuildTimeline();
  applyGaps();
  updateControls();
  updateOvrInfo();
}

function setOverride(text, o) {
  if (o) overrides[ovKey(text)] = o; else delete overrides[ovKey(text)];
  hasOverrides = Object.keys(overrides).length > 0;
}

function renderTune() {
  const e = state.engine;
  const s = find(tuneId);
  const voices = state.voices[e.id] || [];
  const sel = $('ovrVoice');
  const def = voices.find((v) => v.id === curVoice());
  sel.innerHTML = '';
  sel.add(new Option(`Default (${def ? def.label : curVoice()})`, ''));
  for (const v of voices) sel.add(new Option(v.label, v.id));
  sel.value = draft.voice && voices.some((v) => v.id === draft.voice) ? draft.voice : '';
  // What a sentence without its own setting would use.
  const global = { speed: curSpeed(), pitch: state.fx.pitch, pause: s && s.para ? state.fx.gapPara : state.fx.gapSentence };
  for (const k of ['speed', 'pitch', 'pause']) {
    const input = document.querySelector(`[data-ovr="${k}"]`);
    const own = draft[k] !== undefined;
    input.value = own ? draft[k] : global[k];
    if (window.InkUI) InkUI.syncRange(input);
    document.querySelector(`[data-ovr-out="${k}"]`).textContent = own ? OVR_FMT[k](draft[k]) : `default · ${OVR_FMT[k](global[k])}`;
    document.querySelector(`[data-ovr-reset="${k}"]`).hidden = !own;
  }
  document.querySelector('[data-ovr="speed"]').disabled = !e.supportsSpeed($('ovrVoice').value || curVoice());
}

function openTune(id) {
  const s = find(id);
  if (!s) return;
  tuneId = id;
  draft = { ...(ovOf(s) || {}) };
  $('ovrText').textContent = s.text;
  renderTune();
  if (window.InkUI) InkUI.openModal('#ovrModal');
}

function initTune() {
  $('ovrVoice').onchange = () => { if ($('ovrVoice').value) draft.voice = $('ovrVoice').value; else delete draft.voice; renderTune(); };
  document.querySelectorAll('[data-ovr]').forEach((input) => input.addEventListener('input', () => {
    const k = input.dataset.ovr;
    draft[k] = parseFloat(input.value);
    document.querySelector(`[data-ovr-out="${k}"]`).textContent = OVR_FMT[k](draft[k]);
    document.querySelector(`[data-ovr-reset="${k}"]`).hidden = false;
  }));
  document.querySelectorAll('[data-ovr-reset]').forEach((b) => { b.onclick = () => { delete draft[b.dataset.ovrReset]; renderTune(); }; });
  const close = () => window.InkUI && InkUI.closeModal('#ovrModal');
  $('ovrSave').onclick = () => {
    const s = find(tuneId);
    if (s) { setOverride(s.text, cleanOverride(draft)); afterOverrides(); }
    close();
  };
  $('ovrAll').onclick = () => {
    const o = cleanOverride(draft);
    for (const s of segs) setOverride(s.text, o ? { ...o } : null);
    afterOverrides();
    close();
    if (window.InkUI) InkUI.toast('Applied to every sentence');
  };
  $('ovrClear').onclick = () => {
    const s = find(tuneId);
    if (s) { setOverride(s.text, null); afterOverrides(); }
    close();
  };
  $('ovrReset').onclick = () => {
    if (!confirm('Remove the own settings from every sentence?')) return;
    for (const s of segs) setOverride(s.text, null);
    afterOverrides();
  };
}

// ---- voice & sound settings -------------------------------------------------

const FMT = {
  pct: (v) => `${Math.round(v * 100)}%`,
  st: (v) => `${v > 0 ? '+' : ''}${v} st`,
  db: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  s: (v) => `${v.toFixed(2)} s`,
};
const BAKED = new Set(['mix', 'pitch']);
const showSpeed = () => { $('speedOut').textContent = `${parseFloat($('speed').value).toFixed(2)}×`; };

/** Show only the controls the selected engine supports. */
function applyCaps() {
  const c = (state.engine && state.engine.caps) || {};
  const native = state.engine && state.engine.kind === 'native';
  document.querySelectorAll('[data-needs]').forEach((el) => { el.hidden = !(el.dataset.needs === 'fx' ? !native : c[el.dataset.needs]); });
  $('mixRow').hidden = !(c.mix && state.fx.voice2);
}

/** "Blend with" lists the other voices of this engine. */
function renderVoice2() {
  const e = state.engine;
  if (!e) return;
  const sel = $('voice2');
  const cur = curVoice();
  const others = (state.voices[e.id] || []).filter((v) => v.id !== cur);
  sel.innerHTML = '';
  sel.add(new Option('None', ''));
  for (const v of others) sel.add(new Option(v.label, v.id));
  if (!others.some((v) => v.id === state.fx.voice2)) state.fx.voice2 = '';
  sel.value = state.fx.voice2;
  $('mixRow').hidden = !((e.caps && e.caps.mix) && state.fx.voice2);
}

function showFx(name) {
  const el = document.querySelector(`[data-fx="${name}"]`);
  const out = document.querySelector(`[data-fx-out="${name}"]`);
  if (el && out) out.textContent = FMT[el.dataset.fmt](state.fx[name]);
}

/** Make every settings control show state.fx. */
function syncFxUI() {
  document.querySelectorAll('[data-fx]').forEach((el) => {
    el.value = state.fx[el.dataset.fx];
    if (window.InkUI) InkUI.syncRange(el);
    showFx(el.dataset.fx);
  });
  document.querySelectorAll('[data-fx-toggle]').forEach((el) => {
    const on = Boolean(state.fx[el.dataset.fxToggle]);
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-pressed', String(on));
  });
  $('voice2').value = state.fx.voice2;
  $('rules').value = state.fx.rules;
  applyCaps();
  rulesChanged(false);
}

function pushLiveFx() {
  const f = state.fx;
  transport.setFx({ gainDb: f.gain, bassDb: f.bass, trebleDb: f.treble });
  applyGaps();
}

/** A setting changed: save it, and update whatever depends on it. */
function fxChanged(name) {
  saveFx(state.fx);
  if (name === 'gain' || name === 'bass' || name === 'treble') pushLiveFx();
  else if (name === 'gapSentence' || name === 'gapPara') { applyGaps(); rebuildTimeline(); }
  else if (name === 'trim') rebuildTimeline();
  else if (BAKED.has(name) || name === 'voice2') { computeKeys(); renderSegs(); rebuildTimeline(); updateControls(); }
}

function rulesChanged(save = true) {
  state.fx.rules = $('rules').value;
  compiled = parseRules(state.fx.rules);
  const info = $('rulesInfo');
  const n = compiled.rules.length, bad = compiled.errors;
  info.classList.toggle('is-error', bad.length > 0);
  info.textContent = bad.length
    ? `Line ${bad[0].line}: ${bad[0].message}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`
    : n ? `${n} rule${n === 1 ? '' : 's'} active.` : '';
  if (save) { saveFx(state.fx); computeKeys(); renderSegs(); rebuildTimeline(); updateControls(); }
}

function renderPresets(selected = '') {
  const all = loadPresets();
  const sel = $('presetSel');
  sel.innerHTML = '';
  sel.add(new Option('Choose a preset…', ''));
  for (const name of Object.keys(all).sort()) sel.add(new Option(name, name));
  sel.value = Object.hasOwn(all, selected) ? selected : '';
  $('presetDelete').disabled = !sel.value;
}

function afterBulkFx() {
  saveFx(state.fx);
  renderVoice2();
  syncFxUI();
  pushLiveFx();
  updateSpeedControl();
  computeKeys(); renderSegs(); rebuildTimeline(); updateControls();
}

function setSpeedValue(v) {
  $('speed').value = v;
  lsSet('speed:' + state.engine.id, String(v));
  if (window.InkUI) InkUI.syncRange($('speed'));
  showSpeed();
}

/** Speed is remembered per engine; an engine that sounds slow at 1x can start somewhere else (Kitten: 1.6x). */
function loadSpeedFor(e) {
  const saved = parseFloat(lsGet('speed:' + e.id));
  $('speed').value = Number.isFinite(saved) ? saved : (e.defaultSpeed ?? 1);
  if (window.InkUI) InkUI.syncRange($('speed'));
  showSpeed();
}

function applyPreset(name) {
  const p = loadPresets()[name];
  if (!p) return;
  for (const k of PRESET_FIELDS) if (k in p) state.fx[k] = p[k];
  const voices = state.voices[state.engine.id] || [];
  if (p.engine === state.engine.id && voices.some((v) => v.id === p.voice)) { $('voice').value = p.voice; lsSet('voice:' + p.engine, p.voice); }
  if (typeof p.speed === 'number') setSpeedValue(p.speed);
  afterBulkFx();
}

function retake(id) {
  const s = find(id);
  if (!s || state.phase !== 'idle') return;
  const h = textHash(s);
  const n = ((takes[h] || 0) + 1) % (MAX_TAKES + 1);
  if (n) takes[h] = n; else delete takes[h];
  const keys = Object.keys(takes);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete takes[k];
  saveTakes(takes);
  computeKeys();
  renderSegs();
  startSession({ only: [id] });
}

function initSettings() {
  document.querySelectorAll('[data-fx]').forEach((el) => {
    let t;
    el.addEventListener('input', () => {
      const name = el.dataset.fx;
      state.fx[name] = parseFloat(el.value);
      showFx(name);
      clearTimeout(t);
      t = setTimeout(() => fxChanged(name), BAKED.has(name) ? 120 : 0);
    });
  });
  document.addEventListener('ink:toggle', (ev) => {
    const { el, on } = ev.detail;
    if (el.dataset && el.dataset.fxToggle) { state.fx[el.dataset.fxToggle] = on; fxChanged(el.dataset.fxToggle); }
  });
  $('voice2').onchange = () => { state.fx.voice2 = $('voice2').value; applyCaps(); fxChanged('voice2'); };
  let rt;
  $('rules').addEventListener('input', () => { clearTimeout(rt); rt = setTimeout(rulesChanged, 250); });

  $('presetSel').onchange = () => { $('presetDelete').disabled = !$('presetSel').value; if ($('presetSel').value) applyPreset($('presetSel').value); };
  $('presetSave').onclick = () => {
    const name = $('presetName').value.trim();
    if (!name || name === '__proto__') { if (window.InkUI) InkUI.toast('Type a name for the preset first'); return; }
    const all = loadPresets();
    const p = { engine: state.engine.id, voice: curVoice(), speed: curSpeed() };
    for (const k of PRESET_FIELDS) p[k] = state.fx[k];
    all[name] = p;
    savePresets(all);
    $('presetName').value = '';
    renderPresets(name);
    if (window.InkUI) InkUI.toast(`Preset “${name}” saved`);
  };
  $('presetDelete').onclick = () => {
    const name = $('presetSel').value;
    const all = loadPresets();
    if (!name || !Object.hasOwn(all, name)) return;
    delete all[name];
    savePresets(all);
    renderPresets();
  };
  $('presetReset').onclick = () => {
    for (const k of PRESET_FIELDS) state.fx[k] = DEFAULT_FX[k];
    setSpeedValue(1);
    renderPresets();
    afterBulkFx();
  };

  state.fx.voice2 = state.fx.voice2 || '';
  syncFxUI();
  renderPresets();
  pushLiveFx();
}

// ---- export & projects --------------------------------------------------------

let exporting = false, expCancelled = false;
const expFmt = () => $('expFormat').value;
const expStatus = (m) => { $('expStat').textContent = m; };

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function updateExportUI() {
  const e = state.engine;
  if (!e || !$('expZip')) return;
  const native = e.kind === 'native';
  const ready = native ? 0 : segs.filter((x) => store.has(x.key)).length;
  const ok = ready > 0 && !exporting;
  $('expNote').hidden = !native;
  for (const id of ['expZip', 'expSrt', 'expVtt', 'dl']) $(id).disabled = !ok;
  $('expKbpsRow').hidden = expFmt() !== 'mp3';
  $('dl').textContent = `Download ${expFmt().toUpperCase()}`;
  $('expCancel').hidden = !exporting;
  $('expInfo').textContent = !native && segs.length ? `${ready} of ${segs.length} sentence${segs.length === 1 ? '' : 's'} generated.` : '';
}

/** Settings as they are when the button is pressed: changing a slider mid-export must not change the file. */
function exportEnv() {
  const fx = { ...state.fx };
  return { segs: segs.slice(), store, fx, gapFor: (seg) => gapOf(seg, fx) };
}
const exportName = () => exportBase($('text').value, state.engine.id, curVoice());

async function runExport(scope) {
  if (exporting) return;
  exporting = true; expCancelled = false;
  updateExportUI();
  expStatus('Starting…');
  try {
    const out = await buildExport({
      ...exportEnv(), prepareClip, scope, format: expFmt(), kbps: parseInt($('expKbps').value, 10),
      onStatus: expStatus, isCancelled: () => expCancelled,
    });
    if (!out) { expStatus('Nothing is generated yet.'); return; }
    const name = `${exportName()}.${out.ext}`;
    saveBlob(out.blob, name);
    const mb = out.blob.size / 1e6;
    expStatus(`Saved ${name} · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB${out.skipped ? ` · ${out.skipped} not generated yet, skipped` : ''}.`);
  } catch (err) {
    if (!expCancelled) console.error(err);
    const big = err instanceof RangeError || /memory|allocation/i.test(String(err && err.message));
    expStatus(expCancelled ? 'Export cancelled.' : `Export failed: ${err.message || err}${big ? ' This recording is too big for the browser’s memory. Use “Zip per sentence” instead.' : ''}`);
  } finally {
    exporting = false;
    updateExportUI();
  }
}

async function saveSubtitles(kind) {
  try {
    const text = await buildSubtitles({ ...exportEnv(), kind });
    if (!text) return;
    saveBlob(new Blob([text], { type: kind === 'vtt' ? 'text/vtt' : 'application/x-subrip' }), `${exportName()}.${kind}`);
    expStatus(`Saved ${exportName()}.${kind}`);
  } catch (err) {
    console.error(err);
    expStatus(`Subtitles failed: ${err.message || err}`);
  }
}

function saveProject() {
  const hashes = new Set(segs.map(textHash));
  const mine = {};
  for (const [k, v] of Object.entries(takes)) if (hashes.has(k)) mine[k] = v;
  const mineOv = {};
  for (const [k, v] of Object.entries(overrides)) if (hashes.has(k)) mineOv[k] = v;
  const project = makeProject({
    text: $('text').value, engine: state.engine.id, voice: curVoice(), speed: curSpeed(),
    fx: state.fx, split: state.opts, takes: mine, overrides: mineOv,
  });
  saveBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${exportName()}.ttsproject.json`);
  if (window.InkUI) InkUI.toast('Project saved');
}

async function openProject(file) {
  if (!file) return;
  const fail = (msg) => { setStat(msg, true); if (window.InkUI) InkUI.toast(msg, 4000); };
  if (file.size > MAX_PROJECT_BYTES) return fail('That file is too big to be a project.');
  const r = parseProject(await file.text());
  if (!r.ok) return fail(r.error);
  const p = r.project;
  const cur = $('text').value.trim();
  if (cur && cur !== p.text.trim() && !confirm('Replace the current text and settings with this project?')) return;

  stop();
  $('text').value = p.text;
  lsSet('text', p.text);
  for (const k of ['periods', 'lines']) setOpt(k, p.split[k]);
  const wanted = ENGINES.find((x) => x.id === p.engine);
  let note = '';
  if (wanted && wanted !== state.engine) {
    if (state.installed[wanted.id]) await selectEngine(wanted);
    else note = ` ${wanted.label} isn’t available here, so the current engine was kept.`;
  }
  state.fx = { ...DEFAULT_FX, ...p.settings };
  const voices = state.voices[state.engine.id] || [];
  if (p.engine === state.engine.id && voices.some((v) => v.id === p.voice)) { $('voice').value = p.voice; lsSet('voice:' + p.engine, p.voice); }
  setSpeedValue(p.speed);
  for (const [k, v] of Object.entries(p.takes)) takes[k] = v;
  saveTakes(takes);
  for (const [k, v] of Object.entries(p.overrides)) overrides[k] = v;
  hasOverrides = Object.keys(overrides).length > 0;
  saveOverrides(overrides);
  afterBulkFx();
  resegment();
  rebuildTimeline();
  setStat(`Opened project.${note}`);
  if (window.InkUI) InkUI.toast('Project opened');
}

function initExport() {
  const f = lsGet('exp:format');
  if (f === 'wav' || f === 'mp3') $('expFormat').value = f;
  const k = lsGet('exp:kbps');
  if (MP3_KBPS.includes(Number(k))) $('expKbps').value = k;
  $('expFormat').onchange = () => { lsSet('exp:format', expFmt()); updateExportUI(); };
  $('expKbps').onchange = () => lsSet('exp:kbps', $('expKbps').value);
  $('dl').onclick = () => runExport('single');
  $('expZip').onclick = () => runExport('zip');
  $('expSrt').onclick = () => saveSubtitles('srt');
  $('expVtt').onclick = () => saveSubtitles('vtt');
  $('expCancel').onclick = () => { expCancelled = true; cancelExport(); };
  $('projSave').onclick = saveProject;
  $('projOpen').onclick = () => $('projFile').click();
  $('projFile').onchange = async () => {
    const file = $('projFile').files[0];
    $('projFile').value = '';
    await openProject(file);
  };
  updateExportUI();
}

// ---- models window ------------------------------------------------------------

let modelsUI = null;

function openModels() {
  if (window.InkUI) InkUI.openModal('#modelsModal');
  if (modelsUI) modelsUI.render();
}

/** Files were added or removed: forget what those engines had loaded, re-read what is installed, update the page. */
async function onModelsChanged(ids) {
  stop();
  const before = { ...state.installed };
  for (const id of ids) {
    const e = ENGINES.find((x) => x.id === id);
    if (e && e.reset) e.reset();
    loads.delete(id);
    state.loaded.delete(id);
  }
  await refreshModels();
  // An engine that just became ready is the one the person was setting up: switch to it.
  const fresh = ids.find((id) => !before[id] && state.installed[id]);
  if (fresh) { state.engine = ENGINES.find((x) => x.id === fresh); lsSet('engine', fresh); }
  else if (!state.installed[state.engine.id]) state.engine = ENGINES.find((x) => state.installed[x.id]) || ENGINES[0];
  renderEngine();
  resegment();
  renderFootprint();
  setStat('');
  preload(state.engine);
}

function initModels() {
  $('modelsDropIcon').innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></svg>';
  modelsUI = createModelsUI(
    { quick: $('modelsQuick'), body: $('modelsBody'), results: $('modelsResults'), input: $('modelsFile'), pick: $('modelsPick'), drop: $('modelsDrop'), storage: $('modelsStorage') },
    {
      onChange: onModelsChanged,
      audio: {
        info: async () => { const { count, bytes } = store.stats(); return { count, text: count ? `${count} sentence${count === 1 ? '' : 's'} (${mb(bytes)})` : 'none' }; },
        clear: async () => { await store.clear(); renderCacheInfo(); resegment(); },
      },
    },
  );
  document.querySelectorAll('[data-ink-open="#modelsModal"]').forEach((b) => b.addEventListener('click', () => modelsUI.render()));
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  buildTabs();
  $('speak').onclick = speak;
  $('stop').onclick = () => stop('Stopped.');
  $('genAll').onclick = () => startSession();
  $('splitHere').onclick = splitAtCursor;
  $('cacheClear').onclick = async () => { await store.clear(); renderCacheInfo(); resegment(); };
  list = createSegmentList($('segList'), {
    onPlay: (id) => playOne(Math.max(0, indexOfId(id))),
    onGenerate: (id) => startSession({ only: [id] }),
    onSelect: selectInBox,
    onMerge: mergeWithNext,
    onRetake: retake,
    onTune: openTune,
  });

  // Player bar
  bar = createPlayerBar({
    root: $('player'), play: $('pPlay'), prev: $('pPrev'), next: $('pNext'), seek: $('pSeek'),
    canvas: $('pCanvas'), time: $('pTime'), total: $('pTotal'), mute: $('pMute'), vol: $('pVol'),
  }, {
    onToggle: togglePlay,
    onPrev: () => { const p = transport.position(); if (p && session) { transport.prev(); runGeneration(session, { from: Math.max(0, p.offset > 2 ? p.index : p.index - 1) }); } },
    onNext: () => { const p = transport.position(); if (p && session) { transport.next(); runGeneration(session, { from: Math.min(session.jobs.length - 1, p.index + 1) }); } },
    onSeek: seekTo,
    onVolume: (v) => { transport.setVolume(v); lsSet('volume', String(v)); if (transport.muted && v > 0) setMuted(false); },
    onMute: () => setMuted(!transport.muted),
  });
  const setMuted = (m) => { transport.setMuted(m); bar.setMuted(m); lsSet('muted', m ? '1' : '0'); };
  const savedVol = parseFloat(lsGet('volume'));
  if (!Number.isNaN(savedVol)) { transport.setVolume(savedVol); bar.setVolume(savedVol); }
  if (lsGet('muted') === '1') setMuted(true);
  if ('mediaSession' in navigator) {
    const handlers = { play: () => transport.resume(), pause: () => transport.pause(), previoustrack: () => transport.prev(), nexttrack: () => transport.next() };
    for (const [action, fn] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ } }
  }

  // Voice and speed are part of every sentence's cache key, so changing them updates the row states.
  $('voice').onchange = () => { lsSet('voice:' + state.engine.id, $('voice').value); updateSpeedControl(); renderVoice2(); computeKeys(); renderSegs(); rebuildTimeline(); };
  let speedTimer;
  $('speed').oninput = () => {
    showSpeed(); lsSet('speed:' + state.engine.id, $('speed').value);
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => { computeKeys(); renderSegs(); }, 120);
  };

  initModels();
  initWorkers();
  initImport();
  initSettings();
  initTune();
  initExport();

  // Sentence splitting options (the toggles are wired by the UI kit; we just listen).
  for (const name of ['periods', 'lines']) setOpt(name, lsGet('split:' + name) !== '0');
  document.addEventListener('ink:toggle', (ev) => {
    const { el, on } = ev.detail;
    if (el.id === 'optPeriods' || el.id === 'optLines') {
      state.opts[el.id === 'optPeriods' ? 'periods' : 'lines'] = on;
      lsSet('split:' + (el.id === 'optPeriods' ? 'periods' : 'lines'), on ? '1' : '0');
      resegment();
    }
  });

  // Remember the text between visits (the speed is restored per engine in renderEngine).
  const savedText = lsGet('text');
  if (savedText) $('text').value = savedText;
  $('text').addEventListener('input', textChanged);

  // The footprint card header is a div with role=button: make Enter/Space work like a click.
  document.querySelectorAll('.ink-card__header').forEach((h) => h.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); h.click(); }
  }));

  // Ctrl/Cmd+Enter speaks from the text box; Escape stops.
  $('text').addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); speak(); }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.phase !== 'idle') stop('Stopped.');
    // Space pauses / resumes (or starts) playback, unless you're typing or on a control that uses Space itself.
    if (ev.code === 'Space' && !ev.repeat && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const t = ev.target;
      const role = t.getAttribute && t.getAttribute('role');
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(t.tagName)
        || ['button', 'slider', 'tab'].includes(role)) return;
      ev.preventDefault();
      togglePlay();
    }
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  await refreshModels();
  const wanted = ENGINES.find((e) => e.id === lsGet('engine'));
  state.engine = (wanted && state.installed[wanted.id] && wanted) || ENGINES.find((e) => state.installed[e.id]) || ENGINES[0];
  await store.ready;
  renderEngine();
  resegment();
  renderCacheInfo();
  renderFootprint();
  preload(state.engine);
  initTour();
}

// ---- tutorial ----------------------------------------------------------------

function initMenus() {
  const pairs = [['appsBtn', 'appsMenu'], ['logoBtn', 'logoMenu']].map(([b, m]) => [$(b), $(m)]).filter(([b, m]) => b && m);
  const closeAll = (except) => pairs.forEach(([btn, menu]) => { if (menu !== except && !menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
  for (const [btn, menu] of pairs) {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      closeAll(menu);
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    };
  }
  document.addEventListener('click', (ev) => { for (const [, menu] of pairs) if (!menu.hidden && !menu.contains(ev.target)) closeAll(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const open = pairs.find(([, menu]) => !menu.hidden);
    if (open) { closeAll(); open[0].focus(); }
  });
}

function initTour() {
  const tour = createTour([
    { target: '#text', title: 'Add your text', body: 'Type or paste text here, or drop a .txt, .epub or .docx file on the box. Every sentence becomes its own clip in the list below.' },
    { target: '#speak', title: 'Press Speak', body: 'It starts at once with your browser’s own voice. Natural voices need a one-time download (next tip). Ctrl + Enter does the same.' },
    { target: '#openModels', title: 'Add natural voices', body: 'Kitten, Kokoro and Piper (English, Spanish, Arabic). Download the files once and drop them in the Models window. They stay in your browser and work offline.' },
    { target: '#engines', title: 'Choose engine and voice', body: 'Pick an engine, then a voice, speed and pitch. Sound, pauses and pronunciation are in the cards below it.' },
    { target: '#segList', title: 'Sentences', body: 'Each sentence is generated once and kept. Play any sentence on its own, retake one, or edit it and only that one is made again.' },
    { target: '#dl', title: 'Download', body: 'Save the whole recording as WAV or MP3. Under the buttons you can also get subtitles or a zip with one file per sentence. Reopen this tour any time with Tutorial.' },
  ]);
  initMenus();
  initModelsTour();
  const btn = $('tourBtn');
  if (btn) btn.onclick = () => (tour.active() ? tour.end() : tour.start());
  // First visit: show it once. Not for automated browsers (it would sit on top of the page under test) or ?notour.
  if (!tour.seen() && !navigator.webdriver && !/[?&]notour\b/.test(location.search)) setTimeout(() => {
    if (!document.querySelector('.ink-modal.is-open')) tour.start();
  }, 900);
}

function initModelsTour() {
  const tour = createTour([
    { target: '#modelsQuick', title: 'Quick start', body: 'New here? Kokoro is a very natural English voice (about 93 MB in three files). This button takes you to its files; you press Download next to each one.' },
    { target: '.tts-howto', title: 'Three steps', body: 'Download the files, drop them into the box, then pick a voice. You only do this once per model; the files stay in this browser.' },
    { target: '#modelsDrop', title: 'Drop the files here', body: 'Drag the downloaded files onto this box, or press Choose files. You can add them all at once or one by one. The app tells you what each file was and what is still missing.' },
    { target: '#modelsBody .tts-model.is-recommended', title: 'Pick a model', body: 'The cards are closed to keep things tidy: press one to see its files, each with a Download button. Kokoro (green) is the one we recommend: very natural English. Kitten is tiny and fast, and Piper adds Spanish and Arabic.' },
    { target: '#modelsStorage', title: 'Your stored files', body: 'See what is saved in this browser, delete a single file, or remove everything the app stored. Deleting a model never touches your text or projects.' },
  ], { key: 'tour-models-done' });
  const modal = $('modelsModal');
  const btn = $('modelsTourBtn');
  if (btn) btn.onclick = () => (tour.active() ? tour.end() : tour.start());
  // The tip bubble belongs to the open window: close it when the window closes.
  if (modal) new MutationObserver(() => {
    if (!modal.classList.contains('is-open')) { if (tour.active()) tour.end(); return; }
    if (!tour.seen() && !navigator.webdriver && !/[?&]notour\b/.test(location.search)) setTimeout(() => { if (modal.classList.contains('is-open') && !tour.seen()) tour.start(); }, 700);
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
}

boot();
