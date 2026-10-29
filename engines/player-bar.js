// The player bar at the bottom of the page: transport buttons, a seek bar that shows every sentence
// (generated ones solid, missing ones hatched), elapsed/total time and volume. Pure view: app.js feeds
// it the timeline and the playhead and handles what the buttons do.

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h4l5 4v-13l-5 4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h4l5 4v-13l-5 4z" fill="currentColor"/><path d="m17 9.5 5 5m0-5-5 5"/></svg>',
};

export function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function createPlayerBar(els, { onToggle, onPrev, onNext, onSeek, onVolume, onMute }) {
  const { root, play, prev, next, seek, canvas, time, total, mute, vol } = els;
  const g = canvas.getContext('2d');
  let tl = { items: [], starts: [], total: 0 };    // timeline: per sentence { dur, ready }, start time, total length
  let head = { index: -1, offset: 0 };            // the playhead
  let state = 'idle';
  let drag = null;                                 // { time } while scrubbing
  let colors = null;

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    colors = { ready: v('--ink-border-hi', '#ccc'), played: v('--ink-accent', '#1a1a1a'), missing: v('--ink-surface-2', '#e4e4e4'), knob: '#fff' };
    colors.ready = '#c7c7c7';
  };

  play.innerHTML = ICON.play;
  mute.innerHTML = ICON.vol;
  prev.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2.2v14H6zM19 5.5v13L9.5 12z"/></svg>';
  next.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.8 5H18v14h-2.2zM5 5.5v13l9.5-6.5z"/></svg>';

  function setTimeline(items) {
    const starts = [];
    let t = 0;
    items.forEach((it, i) => { starts.push(t); t += it.dur + (i < items.length - 1 ? it.gap : 0); });
    tl = { items, starts, total: t };
  }

  /** Playhead position in seconds along the whole timeline. */
  const elapsed = () => (head.index >= 0 && tl.starts[head.index] !== undefined ? tl.starts[head.index] + Math.min(head.offset, tl.items[head.index].dur) : 0);

  /** Which sentence (and how far into it) a time on the timeline falls in. */
  function locate(t) {
    t = Math.max(0, Math.min(t, tl.total));
    let lo = 0, hi = tl.items.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tl.starts[mid] <= t) lo = mid; else hi = mid - 1; }
    const it = tl.items[lo];
    return { index: lo, offset: it && it.ready ? Math.max(0, Math.min(t - tl.starts[lo], it.dur)) : 0 };
  }

  function draw() {
    if (!colors) readColors();
    const dpr = window.devicePixelRatio || 1;
    const w = seek.clientWidth, h = seek.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const PAD = 8, tw = w - 2 * PAD;
    const y = Math.round(h / 2 - 5), bh = 10;
    const total = tl.total || 1;
    const t = drag ? drag.time : elapsed();
    const px = PAD + Math.max(0, Math.min(1, t / total)) * tw;
    const n = tl.items.length;
    const gapPx = n > 1 && tw / n > 5 ? 1.5 : 0;

    for (let i = 0; i < n; i++) {
      const it = tl.items[i];
      const x0 = PAD + (tl.starts[i] / total) * tw;
      const x1 = PAD + ((tl.starts[i] + it.dur) / total) * tw;
      const ww = Math.max(1, x1 - x0 - gapPx);
      g.fillStyle = it.ready ? colors.ready : colors.missing;
      g.fillRect(x0, y, ww, bh);
      if (!it.ready && ww > 6) { // hatch the sentences that aren't generated yet
        g.save(); g.beginPath(); g.rect(x0, y, ww, bh); g.clip();
        g.strokeStyle = '#fff'; g.lineWidth = 1.5;
        for (let k = -bh; k < ww; k += 5) { g.beginPath(); g.moveTo(x0 + k, y + bh); g.lineTo(x0 + k + bh, y); g.stroke(); }
        g.restore();
      }
      if (it.ready && px > x0) { g.fillStyle = colors.played; g.fillRect(x0, y, Math.min(ww, px - x0), bh); }
    }
    if (n) { // knob
      g.beginPath(); g.arc(px, h / 2, 7, 0, Math.PI * 2);
      g.fillStyle = colors.knob; g.fill();
      g.lineWidth = 2; g.strokeStyle = colors.played; g.stroke();
    }
  }

  function render({ items, index, offset, state: st }) {
    if (!drag) head = { index, offset };
    if (items) setTimeline(items);
    state = st;
    const allReady = tl.items.every((i) => i.ready);
    const t = drag ? drag.time : elapsed();
    time.textContent = fmtClock(t);
    total.textContent = (allReady ? '' : '~') + fmtClock(tl.total);
    seek.setAttribute('aria-valuenow', String(Math.round(t)));
    seek.setAttribute('aria-valuemax', String(Math.round(tl.total)));
    seek.setAttribute('aria-valuetext', `${fmtClock(t)} of ${fmtClock(tl.total)}`);
    const playing = st === 'playing' || st === 'waiting';
    play.innerHTML = playing ? ICON.pause : ICON.play;
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.classList.toggle('is-waiting', st === 'waiting');
    prev.disabled = next.disabled = st === 'idle';
    draw();
  }

  function timeAt(ev) {
    const r = seek.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left - 8) / (r.width - 16))) * tl.total;
  }

  seek.addEventListener('pointerdown', (ev) => {
    if (!tl.items.length) return;
    seek.setPointerCapture(ev.pointerId);
    drag = { time: timeAt(ev) };
    render({ state });
  });
  seek.addEventListener('pointermove', (ev) => { if (drag) { drag.time = timeAt(ev); render({ state }); } });
  const endDrag = (ev) => {
    if (!drag) return;
    const loc = locate(timeAt(ev));
    drag = null;
    onSeek(loc.index, loc.offset);
  };
  seek.addEventListener('pointerup', endDrag);
  seek.addEventListener('pointercancel', () => { drag = null; render({ state, index: head.index, offset: head.offset }); });
  seek.addEventListener('keydown', (ev) => {
    const step = { ArrowRight: 5, ArrowLeft: -5 }[ev.key];
    if (step !== undefined) { ev.preventDefault(); const l = locate(elapsed() + step); onSeek(l.index, l.offset); }
    else if (ev.key === 'Home') { ev.preventDefault(); onSeek(0, 0); }
    else if (ev.key === 'PageDown') { ev.preventDefault(); onNext(); }
    else if (ev.key === 'PageUp') { ev.preventDefault(); onPrev(); }
  });

  play.onclick = onToggle;
  prev.onclick = onPrev;
  next.onclick = onNext;
  vol.oninput = () => { onVolume(parseFloat(vol.value)); };
  mute.onclick = () => onMute();
  new ResizeObserver(draw).observe(seek);

  return {
    render,
    setMuted(m) { mute.innerHTML = m ? ICON.mute : ICON.vol; mute.setAttribute('aria-label', m ? 'Unmute' : 'Mute'); },
    setVolume(v) { vol.value = v; if (window.InkUI) InkUI.syncRange(vol); },
    show(on) { root.hidden = !on; document.body.classList.toggle('has-player', on); },
  };
}
