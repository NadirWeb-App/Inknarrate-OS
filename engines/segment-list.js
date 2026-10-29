// The list of sentences under the text box. Pure DOM: it renders what app.js tells it and reports clicks.
// Rows are keyed by segment id and updated in place, so editing one sentence touches one row.

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  retake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  tune: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  gen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
};

const ROW_H = 76;   // px per row (keep in step with .tts-seg in tts.css)
const BUFFER = 6;   // extra rows kept above and below the visible ones

const fmtDur = (s) => (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';

export function createSegmentList(root, { onPlay, onGenerate, onSelect, onMerge, onRetake, onTune }) {
  const rows = new Map(); // id -> { el, sig }

  function buildRow(seg) {
    const el = document.createElement('div');
    el.className = 'ink-item tts-seg';
    el.setAttribute('role', 'listitem');
    el.dataset.id = seg.id;
    el.innerHTML = `
      <div class="ink-item__row">
        <span class="tts-seg__n" aria-hidden="true"></span>
        <div class="ink-item__main">
          <div class="tts-seg__text" dir="auto" tabindex="0" role="button" title="Show in the text box"></div>
          <div class="ink-item__meta"><span class="tts-seg__status"></span><span class="tts-seg__tag" hidden></span><button type="button" class="tts-seg__link" data-act="merge">Merge with next</button></div>
        </div>
        <button type="button" class="ink-icon-btn" data-act="tune" aria-label="Settings for this sentence" title="Settings for this sentence: voice, speed, pitch, pause">${ICON.tune}</button>
        <button type="button" class="ink-icon-btn" data-act="retake" aria-label="Try another take" title="Try another take: a slightly different delivery">${ICON.retake}</button>
        <button type="button" class="ink-icon-btn" data-act="play" aria-label="Play this sentence" title="Play this sentence">${ICON.play}</button>
        <button type="button" class="ink-icon-btn" data-act="gen" aria-label="Generate this sentence" title="Generate this sentence">${ICON.gen}</button>
      </div>`;
    el.querySelector('.tts-seg__text').textContent = seg.text;
    return el;
  }

  /** What to show for a segment: { label, tone, canGen, canPlay, canMerge }. Computed by app.js. */
  function paint(seg, v) {
    const r = rows.get(seg.id);
    const sig = [seg.text, v.index, v.label, v.tone, v.canGen, v.canPlay, v.canMerge, v.active, v.title, v.canRetake, v.hideRetake, v.canTune, v.hideTune, v.tag].join('\u0001');
    if (r.sig === sig) return;
    r.sig = sig;
    const { el } = r;
    const t = el.querySelector('.tts-seg__text');
    if (t.textContent !== seg.text) t.textContent = seg.text;
    el.querySelector('.tts-seg__n').textContent = v.index + 1;
    const st = el.querySelector('.tts-seg__status');
    st.textContent = v.label;
    st.dataset.tone = v.tone;
    st.title = v.title || '';
    el.querySelector('[data-act=gen]').disabled = !v.canGen;
    el.querySelector('[data-act=gen]').hidden = v.hideGen;
    const tag = el.querySelector('.tts-seg__tag');
    tag.hidden = !v.tag;
    tag.textContent = v.tag || '';
    el.querySelector('[data-act=tune]').disabled = !v.canTune;
    el.querySelector('[data-act=tune]').hidden = v.hideTune;
    el.querySelector('[data-act=tune]').classList.toggle('is-set', Boolean(v.tag));
    el.querySelector('[data-act=retake]').disabled = !v.canRetake;
    el.querySelector('[data-act=retake]').hidden = v.hideRetake;
    el.querySelector('[data-act=play]').disabled = !v.canPlay;
    el.querySelector('[data-act=merge]').hidden = !v.canMerge;
    el.classList.toggle('is-active', !!v.active);
    el.classList.toggle('is-busy', v.tone === 'busy');
  }

  // Only the rows near the visible part of the list exist in the DOM. A book is tens of thousands of
  // sentences; every row has a fixed height so the position of any row is just index * ROW_H.
  const sizer = document.createElement('div');
  sizer.className = 'tts-seg-sizer';
  root.replaceChildren(sizer);
  let data = { segs: [], view: () => ({}) };
  let frame = 0;

  function render() {
    frame = 0;
    const n = data.segs.length;
    sizer.style.height = n * ROW_H + 'px';
    const top = root.scrollTop, h = root.clientHeight || 440;
    const a = Math.max(0, Math.floor(top / ROW_H) - BUFFER), b = Math.min(n, Math.ceil((top + h) / ROW_H) + BUFFER);
    const seen = new Set();
    for (let i = a; i < b; i++) {
      const seg = data.segs[i];
      seen.add(seg.id);
      let r = rows.get(seg.id);
      if (!r) { r = { el: buildRow(seg), sig: '' }; rows.set(seg.id, r); sizer.append(r.el); }
      r.el.style.top = i * ROW_H + 'px';
      r.el.setAttribute('aria-posinset', String(i + 1));
      r.el.setAttribute('aria-setsize', String(n));
      paint(seg, { ...data.view(seg, i), index: i });
    }
    for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  root.addEventListener('scroll', schedule, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(root);

  /** Show `segs` (in order). `view(seg, index)` gives the display state of a row; it is only asked for rows on screen. */
  function sync(segs, view) {
    data = { segs, view };
    root.hidden = segs.length === 0;
    render();
  }

  /** Repaint one row if it is on screen. */
  function update(seg, index, v) { const r = rows.get(seg.id); if (r) paint(seg, { ...v, index }); }

  /** Scroll so the sentence at `index` is in view (only if it isn't). */
  function scrollTo(index) {
    if (index < 0) return;
    const y = index * ROW_H, h = root.clientHeight || 440;
    if (y < root.scrollTop || y + ROW_H > root.scrollTop + h) { root.scrollTop = Math.max(0, y - h / 3); render(); }
  }

  root.addEventListener('click', (ev) => {
    const row = ev.target.closest('.tts-seg');
    if (!row) return;
    const id = row.dataset.id;
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') onPlay(id);
    else if (act === 'gen') onGenerate(id);
    else if (act === 'merge') onMerge(id);
    else if (act === 'retake') onRetake(id);
    else if (act === 'tune') onTune(id);
    else if (ev.target.closest('.tts-seg__text')) onSelect(id);
  });
  root.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('tts-seg__text')) {
      ev.preventDefault();
      onSelect(ev.target.closest('.tts-seg').dataset.id);
    }
  });

  return { sync, update, scrollTo, fmtDur };
}
