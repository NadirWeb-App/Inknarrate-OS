// A short guided tour: one dark bubble at a time, pointing at a part of the page, with Back / Next / Skip.
// No dimming layer: the page stays usable while the tour is open. Esc closes it, arrow keys move.
// `steps`: [{ target: selector, title, body }]. The tour is marked as seen in localStorage (if allowed).


const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

export function createTour(allSteps, { key = 'tour-done' } = {}) {
  const seen = () => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
  const markSeen = () => { try { localStorage.setItem(key, '1'); } catch { /* storage blocked: the tour just shows again next time */ } };
  let steps = allSteps;
  let box = null, ring = null, i = 0, onKey = null, onMove = null;

  function place() {
    if (!box) return;
    const step = steps[i];
    const t = document.querySelector(step.target);
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    box.classList.remove('is-right', 'is-left', 'is-below', 'is-above');
    if (!t || !t.getClientRects().length) { ring.hidden = true; box.style.cssText = 'left:50%;top:50%;transform:translate(-50%,-50%)'; return; }
    ring.hidden = false;
    const r = t.getBoundingClientRect();
    const pad = 4;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const bw = box.offsetWidth, bh = box.offsetHeight, gap = 14, m = 10;
    box.style.transform = '';
    const clampY = (y) => Math.max(m, Math.min(vh - bh - m, y));
    const clampX = (x) => Math.max(m, Math.min(vw - bw - m, x));
    let side, x, y;
    if (vw < 700) {                                   // phones: the bubble sits above or below, full width
      side = r.top > vh / 2 ? 'above' : 'below';
      x = clampX((vw - bw) / 2);
      y = side === 'above' ? Math.max(m, r.top - bh - gap) : Math.min(vh - bh - m, r.bottom + gap);
    } else if (r.right + gap + bw <= vw - m) { side = 'right'; x = r.right + gap; y = clampY(r.top + Math.min(r.height, 120) / 2 - 24); }
    else if (r.left - gap - bw >= m) { side = 'left'; x = r.left - gap - bw; y = clampY(r.top + Math.min(r.height, 120) / 2 - 24); }
    else if (r.bottom + gap + bh <= vh - m) { side = 'below'; x = clampX(r.left + r.width / 2 - bw / 2); y = r.bottom + gap; }
    else { side = 'above'; x = clampX(r.left + r.width / 2 - bw / 2); y = Math.max(m, r.top - bh - gap); }
    box.classList.add(`is-${side}`);
    box.style.left = `${x}px`; box.style.top = `${y}px`;
    const arrow = side === 'right' || side === 'left' ? r.top + Math.min(r.height, 120) / 2 - y : r.left + r.width / 2 - x;
    box.style.setProperty('--tour-arrow', `${Math.max(16, Math.min((side === 'right' || side === 'left' ? bh : bw) - 16, arrow))}px`);
  }

  function show() {
    const step = steps[i];
    const t = document.querySelector(step.target);
    if (t) t.scrollIntoView({ block: 'center', inline: 'nearest' });
    box.replaceChildren();
    box.append(el('div', 'tts-tour__count', `TIP ${i + 1} OF ${steps.length}`), el('div', 'tts-tour__title', step.title), el('div', 'tts-tour__body', step.body));
    const foot = el('div', 'tts-tour__foot');
    const dots = el('div', 'tts-tour__dots');
    steps.forEach((_, n) => dots.append(el('span', n === i ? 'is-on' : '')));
    const skip = el('button', 'tts-tour__skip', 'Skip'); skip.type = 'button'; skip.onclick = () => end();
    const back = el('button', 'tts-tour__btn', '← Back'); back.type = 'button'; back.disabled = i === 0; back.onclick = () => go(-1);
    const next = el('button', 'tts-tour__btn tts-tour__btn--next', i === steps.length - 1 ? 'Done' : 'Next →'); next.type = 'button'; next.onclick = () => go(1);
    foot.append(dots, skip, back, next);
    box.append(foot);
    requestAnimationFrame(() => { place(); next.focus({ preventScroll: true }); });
  }

  function go(d) {
    const n = i + d;
    if (n >= steps.length) return end();
    if (n < 0) return;
    i = n; show();
  }

  function end() {
    if (!box) return;
    markSeen();
    removeEventListener('keydown', onKey, true); removeEventListener('resize', onMove); removeEventListener('scroll', onMove, true);
    box.remove(); ring.remove(); box = ring = null;
  }

  function start() {
    if (box) return;
    // Only the tips whose target is on screen right now (e.g. no "quick start" tip once a model is installed).
    steps = allSteps.filter((st) => { const t = document.querySelector(st.target); return t && t.getClientRects().length; });
    if (!steps.length) return;
    i = 0;
    ring = el('div', 'tts-tour-ring'); ring.setAttribute('aria-hidden', 'true');
    box = el('div', 'tts-tour'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Quick tour'); box.setAttribute('aria-live', 'polite');
    document.body.append(ring, box);
    onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); end(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    onMove = () => place();
    addEventListener('keydown', onKey, true); addEventListener('resize', onMove); addEventListener('scroll', onMove, true);
    show();
  }

  return { start, end, seen, active: () => Boolean(box) };
}
