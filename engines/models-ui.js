// The Models window: how people get a model into the app, with the download links for each file.
// Nothing is fetched from here: the links open huggingface.co, the person saves the files and adds them
// with the box at the top. The files are checked, then kept in this browser's own storage.
import {
  SPECS, KOKORO_STARTER, PIPER_VOICES, PIPER_LANGS, MAX_MODEL_BYTES, identify, validateFile, sha256Hex, expectedHash,
  describeInstalled, kokoroVoiceLabel, piperVoiceList,
} from './model-specs.js';
import { saveFile, listFiles, removeFile, removeEngine, persistStorage, estimate } from './model-store.js';

const mb = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`);

/** Tiny DOM helper. Text always goes in as text, never as HTML (file names come from the person's disk). */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'onclick') el.onclick = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

const ICON = {
  down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>',
  ext: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};
/** An element holding one of the fixed icons above (never built from user text). */
const icon = (name, cls = 'tts-ico') => { const el = h('span', { class: cls, 'aria-hidden': 'true' }); el.innerHTML = ICON[name]; return el; };

/**
 * Wire up the window. `els`: { body, results, input, pick, drop, storage }.
 * `onChange(engineIds)` runs after files were added or removed.
 */
export function createModelsUI(els, { onChange, audio } = {}) {
  const audioInfo = audio && audio.info;
  const audioClear = audio && audio.clear;
  let records = [];
  let busy = false;

  async function reload() {
    try { records = await listFiles(); }
    catch (err) { records = []; els.body.replaceChildren(h('p', { class: 'tts-note is-error' }, err.message)); return false; }
    return true;
  }

  const recs = (engine) => records.filter((r) => r.engine === engine);
  const has = (engine, key) => records.some((r) => r.engine === engine && r.key === key);

  // ---- rendering -------------------------------------------------------------------------------

  const openState = new Map();   // engine id -> the person opened or closed its card (otherwise: open until it is ready)

  const tick = (ok) => h('span', { class: `tts-tick${ok ? ' is-ok' : ''}`, 'aria-hidden': 'true' }, ok ? icon('check', 'tts-tick__i') : null);

  /** Save a small text file by fetching it ourselves (Hugging Face would otherwise show it in a tab). */
  async function saveText(file, hint) {
    let reason = '';
    for (const href of [file.href, file.alt].filter(Boolean)) {
      try {
        const r = await fetch(href, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        if (!blob.size) throw new Error('empty answer');
        const url = URL.createObjectURL(blob);
        const tmp = h('a', { href: url, download: file.name });
        document.body.append(tmp); tmp.click(); tmp.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        if (hint) { hint.textContent = `Saved ${file.name}. Now drop it into the box above.`; hint.hidden = false; }
        return;
      } catch (err) { reason = (err && err.message) || String(err); }
    }
    // Both ways failed: open the file in a tab and say how to keep it.
    window.open(file.href, '_blank', 'noopener,noreferrer');
    if (hint) {
      hint.textContent = `Couldn’t save ${file.name} directly (${reason}). It opened in a new tab: press Ctrl+S (Cmd+S on a Mac), choose “Save as”, and name it ${file.name}. Then drop it into the box above.`;
      hint.hidden = false;
    }
  }

  /** Start a download of a big file: the link opens in a new tab that the download replaces. */
  function openDownload(file) {
    const a = h('a', { href: file.href, target: '_blank', rel: 'noopener noreferrer' });
    document.body.append(a); a.click(); a.remove();
  }

  /** The Download button. The two small text files are saved by the page (one click); the rest are plain links. */
  function downloadButton(file, hint, label = 'Download') {
    const a = h('a', { class: 'ink-btn tts-dl', href: file.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Download ${file.name}` }, icon('down'), label);
    if (!file.text) return a;
    a.onclick = async (ev) => {
      ev.preventDefault();
      a.classList.add('is-busy');
      await saveText(file, hint);
      a.classList.remove('is-busy');
    };
    return a;
  }

  /** "New here?" box: points at Kokoro's files (nothing is downloaded until the person presses a Download button). */
  function renderQuickStart() {
    const spec = SPECS.kokoro;
    const state = describeInstalled('kokoro', recs('kokoro'));
    if (state.ready) return null;
    const model = spec.models[0];
    const left = [
      has('kokoro', 'model.onnx'), has('kokoro', 'tokenizer.json'), has('kokoro', `voices/${KOKORO_STARTER[0]}.bin`),
    ].filter((done) => !done).length;
    const btn = h('button', {
      class: 'ink-btn ink-btn--primary', type: 'button', id: 'modelsQuickBtn',
      onclick: () => {
        const card = els.body.querySelector('.tts-model[data-engine="kokoro"]');
        if (!card) return;
        card.open = true;
        openState.set('kokoro', true);
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        card.classList.add('is-flash');
        setTimeout(() => card.classList.remove('is-flash'), 1800);
      },
    }, 'Show me the files');
    return h('div', { class: 'tts-quick' },
      h('div', {},
        h('div', { class: 'tts-quick__title' }, 'New here? Start with Kokoro'),
        h('div', { class: 'tts-quick__sub' }, `A natural English voice, about ${Math.round((model.size + 0.6e6) / 1e6)} MB in ${left} file${left === 1 ? '' : 's'} (the model, a small text file and one voice). Press the Download button next to each file, then drop them in the box below.`)),
      btn);
  }

  function fileRow({ name, note, size, file, added }) {
    const hint = h('div', { class: 'tts-file__hint', hidden: true, role: 'status' });
    return h('li', { class: `tts-file${added ? ' is-added' : ''}` },
      tick(added),
      h('div', { class: 'tts-file__main' },
        h('div', { class: 'tts-file__name' }, name),
        h('div', { class: 'tts-file__meta' }, [size, note].filter(Boolean).join(' · ')),
        hint),
      added ? h('span', { class: 'tts-added' }, 'Added') : downloadButton(file, hint));
  }

  function voiceCard(spec, id) {
    const v = kokoroVoiceLabel(id);
    const added = has('kokoro', `voices/${id}.bin`);
    const file = { name: `${id}.bin`, href: spec.voiceHref(id) };
    return h('li', { class: `tts-voice${added ? ' is-added' : ''}` },
      tick(added),
      h('div', { class: 'tts-file__main', title: `${id}.bin` },
        h('div', { class: 'tts-voice__name' }, v.label.replace(/ \(.*\)$/, ''), v.grade ? h('span', { class: 'tts-grade', title: 'Quality grade given by Kokoro’s authors' }, v.grade) : null),
        h('div', { class: 'tts-file__meta' }, v.label.match(/\((.*)\)/)[1])),
      added ? h('span', { class: 'tts-added' }, 'Added') : downloadButton(file, h('span')));
  }

  function chip(state) {
    const text = state.ready
      ? `Ready${state.official ? '' : ' · not the tested copy'}`
      : state.have ? `Needs ${state.missing.length} more` : 'Not set up';
    return h('span', { class: `tts-chip ${state.ready ? 'is-ready' : 'is-missing'}`, title: state.ready ? (state.official ? 'These are the files this app was tested with.' : '') : `Missing: ${state.missing.join(', ')}` }, text);
  }

  function group(num, title, sub, ...body) {
    return h('div', { class: 'tts-group' },
      h('div', { class: 'tts-group__head' }, h('span', { class: 'tts-step' }, String(num)),
        h('div', {}, h('div', { class: 'tts-group__title' }, title), sub ? h('div', { class: 'tts-group__sub' }, sub) : null)),
      ...body);
  }

  function card(spec, engine, state, ...body) {
    const mine = recs(engine);
    const recommended = engine === 'kokoro';
    const el = h('details', { class: `tts-model${recommended ? ' is-recommended' : ''}`, 'data-engine': engine },
      h('summary', { class: 'tts-model__head' },
        h('div', { class: 'tts-model__title' },
          h('h3', {}, spec.label, recommended ? h('span', { class: 'tts-reco' }, 'Recommended') : null),
          h('span', { class: 'tts-model__sub' }, spec.summary)),
        chip({ ...state, have: mine.length > 0 }),
        h('span', { class: 'tts-model__chev', 'aria-hidden': 'true' }, '▾')),
      h('div', { class: 'tts-model__body' },
        ...body,
        h('div', { class: 'tts-model__foot' },
          h('span', { class: 'tts-meta' }, `${spec.license} · by ${spec.author}`),
          h('span', { class: 'tts-foot__links' },
            h('a', { href: spec.pageUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Hugging Face page ', icon('ext', 'tts-ico tts-ico--sm')),
            mine.length ? h('button', {
              class: 'tts-seg__link tts-remove',
              type: 'button',
              onclick: async () => {
                if (!confirm(`Remove ${spec.label} from this browser? You can add the files again later.`)) return;
                await removeEngine(engine);
                await afterChange([engine]);
              },
            }, 'Remove from this browser') : null))));
    el.open = openState.has(engine) ? openState.get(engine) : false;   // closed until the person opens one
    el.querySelector('summary').addEventListener('click', () => openState.set(engine, !el.open));   // only the person's own clicks count
    return el;
  }

  function renderKitten() {
    const spec = SPECS.kitten;
    const state = describeInstalled('kitten', recs('kitten'));
    return card(spec, 'kitten', state,
      group(1, 'Download these 3 files', 'Then drop them into the box at the top.',
        h('ul', { class: 'tts-files' }, spec.files.map((f) => fileRow({
          name: f.name, size: mb(f.size), file: f, added: has('kitten', f.key),
        })))));
  }

  function renderKokoro() {
    const spec = SPECS.kokoro;
    const state = describeInstalled('kokoro', recs('kokoro'));
    const model = recs('kokoro').find((r) => r.key === 'model.onnx');
    const modelRows = spec.models.map((m) => fileRow({
      name: m.name, size: mb(m.size), note: m.note, file: m,
      added: Boolean(model && model.variant === m.variant),
    }));
    const addedVoices = state.voices;
    return card(spec, 'kokoro', state,
      group(1, 'The model', 'Pick one. Adding the other later replaces it.', h('ul', { class: 'tts-files' }, modelRows)),
      group(2, 'The tokenizer', 'A tiny text file that turns phonemes into numbers.',
        h('ul', { class: 'tts-files' }, fileRow({ name: spec.tokenizer.name, size: 'a few KB', file: spec.tokenizer, added: has('kokoro', 'tokenizer.json') }))),
      group(3, 'At least one voice', 'About half a megabyte each. Here are some good ones.',
        h('ul', { class: 'tts-voices' }, KOKORO_STARTER.map((id) => voiceCard(spec, id))),
        h('p', { class: 'tts-more' }, 'More voices are in ', link(spec.voicesPageUrl, 'the voices folder'),
          '. Take the ones starting with af_, am_, bf_ or bm_ (US and UK English); the others are for other languages.'),
        addedVoices.length ? h('div', { class: 'tts-voicechips' },
          h('span', { class: 'tts-voicechips__label' }, 'Your voices'),
          addedVoices.map((id) => h('span', { class: 'tts-chip is-ready' },
            kokoroVoiceLabel(id).label, ' ', h('button', {
              class: 'tts-chip__x', type: 'button', 'aria-label': `Remove ${id}`, title: `Remove ${id}.bin`,
              onclick: async () => { await removeFile('kokoro', `voices/${id}.bin`); await afterChange(['kokoro']); },
            }, '×')))) : null));
  }

  function piperVoiceCard(v, added) {
    const hint = h('div', { class: 'tts-file__hint', hidden: true, role: 'status' });
    return h('li', { class: `tts-piper${added ? ' is-added' : ''}` },
      tick(added),
      h('div', { class: 'tts-file__main' },
        h('div', { class: 'tts-voice__name' }, v.name),
        h('div', { class: 'tts-file__meta' }, `${v.detail} · ${mb(v.size)}`),
        h('div', { class: `tts-file__meta${v.checked ? '' : ' tts-warn'}` }, `Licence: ${v.license}`, ' · ', link(v.cardUrl, 'model card')),
        hint),
      added ? h('span', { class: 'tts-added' }, 'Added')
        : h('span', { class: 'tts-dl-pair' }, downloadButton(v.model, hint, 'Voice file'), downloadButton(v.config, hint, 'Settings')));
  }

  function renderPiper() {
    const spec = SPECS.piper;
    const mine = recs('piper');
    const state = describeInstalled('piper', mine);
    const have = new Set(state.voices);
    const labels = new Map();
    for (const v of piperVoiceList(mine)) { const b = v.id.split('#')[0]; if (!labels.has(b)) labels.set(b, v.label.replace(/ \(.*$/, '').replace(/ · .*$/, '')); }
    return card(spec, 'piper', state,
      group(1, 'Pick a voice', 'Each voice is two files: the voice and its settings. Download both. You can add as many voices as you like, in any of the languages.',
        Object.entries(PIPER_LANGS).map(([code, lang]) => {
          const list = PIPER_VOICES.filter((v) => v.lang === code);
          return h('div', { class: 'tts-lang', 'data-lang': code },
            h('div', { class: 'tts-lang__head', lang: code, dir: code === 'ar' ? 'rtl' : 'ltr' }, lang.native, lang.native !== lang.name ? h('span', { class: 'tts-lang__en' }, ` ${lang.name}`) : null),
            code === 'ar' ? h('p', { class: 'tts-more' }, 'For the best Arabic, write your text with its vowel marks (التشكيل). Text that already has them is spoken exactly as written; text without them gets marks added automatically, which is good but not perfect.') : null,
            list.length ? h('ul', { class: 'tts-piperlist' }, list.map((v) => piperVoiceCard(v, have.has(v.id))))
              : h('p', { class: 'tts-more' }, 'No suggested voice yet. Pick one from ', link(lang.folder, `the ${lang.name} voices`), ' (see below).'));
        })),
      group(2, 'Advanced: any other voice', 'Piper has more voices than the ones suggested here (some with many speakers).',
        h('p', { class: 'tts-more' }, 'Browse the voices: ',
          Object.values(PIPER_LANGS).flatMap((lang, i) => [i ? ' · ' : null, link(lang.folder, lang.name)]),
          '. Open a folder (for example ', PIPER_LANGS.en.example, '), then a voice, then a quality (medium is a good balance). Download both the .onnx file and the .onnx.json file with the same name, then drop them in the box above.'),
        h('p', { class: 'tts-more' }, 'Each voice has its own licence (see its MODEL_CARD file). Voices you add yourself aren’t checked by this app; read the card before using the audio commercially. Spanish and Arabic voices load an extra 18 MB of language data once; it is then kept for offline use.')),
      group(3, 'Your voices', null,
        state.voices.length ? h('div', { class: 'tts-voicechips' },
          state.voices.map((base) => h('span', { class: 'tts-chip is-ready' }, labels.get(base) || base, ' ', h('button', {
            class: 'tts-chip__x', type: 'button', 'aria-label': `Remove ${base}`, title: `Remove ${base}`,
            onclick: async () => { await removeVoice(base); },
          }, '×')))) : h('p', { class: 'tts-more' }, 'None yet.'),
        state.partial.length ? h('p', { class: 'tts-note is-error' }, state.partial.map((p) => `${p.base} still needs ${p.missing}.`).join(' ')) : null));
  }

  async function removeVoice(base) {
    await removeFile('piper', `voices/${base}.onnx`);
    await removeFile('piper', `voices/${base}.json`);
    await afterChange(['piper']);
  }

  // ---- the storage panel: everything kept in this browser, with a way to delete each part -----------

  /** What is stored, as rows a person understands: [{ engine, name, size, keys }]. */
  function storageItems() {
    const items = [];
    for (const r of records) {
      if (r.engine === 'piper') continue;
      let name = r.key;
      if (r.engine === 'kitten') name = (SPECS.kitten.files.find((f) => f.key === r.key) || {}).name || r.key;
      else if (r.key === 'model.onnx') name = (SPECS.kokoro.models.find((m) => m.variant === r.variant) || {}).name || 'model.onnx';
      else if (r.key.startsWith('voices/')) name = `${r.key.slice(7, -4)} (voice)`;
      items.push({ engine: r.engine, name, size: r.size || 0, keys: [r.key] });
    }
    const pairs = new Map();
    for (const r of recs('piper')) {
      const base = r.key.slice(7).replace(/\.(onnx|json)$/, '');
      if (!pairs.has(base)) pairs.set(base, { engine: 'piper', name: base, size: 0, keys: [] });
      const p = pairs.get(base); p.size += r.size || 0; p.keys.push(r.key);
    }
    items.push(...pairs.values());
    const order = ['kitten', 'kokoro', 'piper'];
    return items.sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine) || a.name.localeCompare(b.name));
  }

  async function renderStorage() {
    if (!els.storage) return;
    const e = await estimate();
    const items = storageItems();
    const total = items.reduce((n, i) => n + i.size, 0);
    const audio = audioInfo ? await audioInfo() : null;
    const rows = items.map((it) => h('li', { class: 'tts-store__row' },
      h('span', { class: 'tts-store__eng' }, SPECS[it.engine].label),
      h('span', { class: 'tts-store__name', title: it.name }, it.name),
      h('span', { class: 'tts-store__size' }, mb(it.size)),
      h('button', {
        class: 'ink-btn tts-store__del', type: 'button', 'aria-label': `Delete ${it.name}`,
        onclick: async () => {
          if (!confirm(`Delete ${it.name} (${mb(it.size)}) from this browser? You can add it again later.`)) return;
          for (const k of it.keys) await removeFile(it.engine, k);
          await afterChange([it.engine]);
        },
      }, 'Delete')));
    els.storage.replaceChildren(...[
      h('div', { class: 'tts-store__head' },
        h('div', {}, h('h3', { class: 'tts-store__title' }, 'Stored in this browser'),
          h('div', { class: 'tts-group__sub' }, items.length
            ? `${mb(total)} of model files${e && e.quota ? ` · about ${mb(e.quota)} available to this site` : ''}`
            : 'No model files are stored yet.')),
        items.length ? h('button', {
          class: 'ink-btn tts-store__all', type: 'button', id: 'modelsDeleteAll',
          onclick: async () => {
            if (!confirm(`Delete all ${items.length} stored model files (${mb(total)}) from this browser? Your text, settings and generated audio stay. You can add the files again later.`)) return;
            await removeEngine();
            await afterChange(['kitten', 'kokoro', 'piper']);
          },
        }, 'Delete all model files') : null),
      items.length ? h('ul', { class: 'tts-store__list' }, rows) : null,
      audio ? h('div', { class: 'tts-store__audio' },
        h('span', {}, `Generated audio: ${audio.text}`),
        audio.count ? h('button', { class: 'ink-btn tts-store__del', type: 'button', id: 'modelsClearAudio', onclick: async () => { await audioClear(); await renderStorage(); } }, 'Clear audio') : null) : null,
      h('p', { class: 'tts-note' }, 'Deleting here only affects this browser. Clearing the whole site’s data in your browser settings would also remove your saved text and settings, which is why this list exists.'),
    ].filter(Boolean));
  }

  async function render() {
    if (!(await reload())) return;
    els.body.replaceChildren(renderKitten(), renderKokoro(), renderPiper());
    if (els.quick) els.quick.replaceChildren(...[renderQuickStart()].filter(Boolean));
    await renderStorage();
  }

  async function afterChange(engines) {
    await render();
    await onChange([...new Set(engines)]);
  }

  // ---- adding files ----------------------------------------------------------------------------

  function say(ok, text) {
    els.results.append(h('li', { class: ok ? 'is-ok' : 'is-error' }, h('span', { class: 'tts-res__mark', 'aria-hidden': 'true' }, ok ? '✓' : '!'), h('span', {}, text)));
  }

  async function addOne(file) {
    const info = identify(file.name);
    if (!info) return say(false, `${file.name}: not a model file this app uses. Skipped.`);
    if (info.error) return say(false, info.error);
    const limit = info.role === 'model' || info.role === 'piper-model' ? MAX_MODEL_BYTES : 5e6;
    if (file.size > limit) return say(false, `${file.name}: too big for a ${info.role} file.`);
    if (file.size === 0) return say(false, `${file.name}: the file is empty.`);

    els.results.append(h('li', { class: 'is-wait' }, h('span', { class: 'tts-res__mark', 'aria-hidden': 'true' }, '…'), h('span', {}, `Checking ${file.name}…`)));
    const wait = els.results.lastChild;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = validateFile(info, bytes);
    if (!check.ok) { wait.remove(); return say(false, `${file.name}: ${check.error}`); }

    const sha256 = await sha256Hex(bytes);
    const want = expectedHash(info);
    const meta = { size: file.size, sha256, verified: want ? want === sha256 : null };
    if (info.variant) meta.variant = info.variant;
    if (check.summary) meta.piper = check.summary;
    const replacing = info.role === 'model' && has(info.engine, 'model.onnx');
    try { await saveFile(info.engine, info.key, file, meta); }
    catch (err) { wait.remove(); return say(false, `${file.name}: ${err.message}`); }
    wait.remove();
    const label = SPECS[info.engine].label;
    if (info.engine === 'piper') {
      const otherKey = `voices/${info.voice}${info.role === 'piper-model' ? '.json' : '.onnx'}`;
      const other = (await listFiles('piper')).some((r) => r.key === otherKey);
      return say(true, `${file.name} added to Piper${other ? ` (${info.voice} is complete)` : `. Now add ${info.voice}${info.role === 'piper-model' ? '.onnx.json' : '.onnx'} to finish this voice`}.`), info.engine;
    }
    const tail = want
      ? (meta.verified ? ' (official copy)' : ' (different from the copy we tested: it may still work)')
      : '';
    say(true, `${file.name} added to ${label}${tail}${replacing ? ', replacing the previous model' : ''}.`);
    return info.engine;
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length || busy) return;
    busy = true;
    els.results.replaceChildren();
    els.drop.classList.add('is-busy');
    const changed = [];
    try {
      for (const f of files) {
        try { const e = await addOne(f); if (e) changed.push(e); }
        catch (err) { say(false, `${f.name}: ${(err && err.message) || err}`); }
      }
      if (changed.length) { await persistStorage(); await afterChange(changed); }
    } finally {
      busy = false;
      els.drop.classList.remove('is-busy');
    }
  }

  els.pick.onclick = () => els.input.click();
  els.input.onchange = async () => { const f = [...els.input.files]; els.input.value = ''; await addFiles(f); };
  for (const t of ['dragenter', 'dragover']) els.drop.addEventListener(t, (ev) => { ev.preventDefault(); els.drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) els.drop.addEventListener(t, () => els.drop.classList.remove('is-over'));
  els.drop.addEventListener('drop', async (ev) => { ev.preventDefault(); await addFiles(ev.dataTransfer.files); });

  return { render, addFiles, records: () => records };
}
