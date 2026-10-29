/*!
 * Inkplainer UI Kit · behaviour helper · v1.0
 * Optional. Vanilla JS, no dependencies. Pairs with inkplainer-ui.css.
 *
 * Wires up automatically (via event delegation, so it also works for
 * elements you add later):
 *   .ink-range                      keeps the --pct fill in sync with the value
 *   .ink-toggle                     click flips .is-on  (+ aria-pressed)
 *   [data-ink-group] > children     click sets .is-active on the clicked child only
 *   .ink-tab[data-target="#paneId"] switches tabs and .ink-pane panels
 *   .ink-card__header               click collapses / expands the card
 *   [data-ink-open="#modalId"]      opens a modal
 *   [data-ink-close]                closes the surrounding modal (Esc + backdrop click also close)
 *
 * Events (bubble, so you can listen on document):
 *   ink:toggle   detail = { el, on }
 *   ink:select   detail = { el, group }
 *   ink:range    detail = { el, value }
 *   ink:tab      detail = { el, pane }
 *
 * API:  InkUI.toast(msg, ms?)  InkUI.openModal(el|sel)  InkUI.closeModal(el|sel)
 *       InkUI.syncRange(el)    InkUI.busy(true|false, el?)
 */
(function () {
  'use strict';

  function $(sel, root) { return typeof sel === 'string' ? (root || document).querySelector(sel) : sel; }
  function emit(el, name, detail) { el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail })); }

  /* ── Range fill ───────────────────────────────────────────────────── */
  function syncRange(input) {
    if (!input) return;
    var min = Number(input.min || 0), max = Number(input.max || 100), val = Number(input.value || min);
    var pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  }
  function syncAllRanges(root) {
    (root || document).querySelectorAll('.ink-range').forEach(syncRange);
  }

  /* ── Toast ────────────────────────────────────────────────────────── */
  var toastEl = null, toastTimer = null;
  function toast(msg, ms) {
    if (toastEl) { toastEl.remove(); clearTimeout(toastTimer); }
    toastEl = document.createElement('div');
    toastEl.className = 'ink-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.textContent = msg;
    document.body.appendChild(toastEl);
    var el = toastEl;
    toastTimer = setTimeout(function () {
      el.classList.add('is-leaving');
      setTimeout(function () { el.remove(); if (toastEl === el) toastEl = null; }, 260);
    }, ms || 2000);
  }

  /* ── Modal ────────────────────────────────────────────────────────── */
  function openModal(m) { m = $(m); if (m) m.classList.add('is-open'); }
  function closeModal(m) { m = $(m); if (m) m.classList.remove('is-open'); }

  /* ── Busy indicator ───────────────────────────────────────────────── */
  function busy(on, el) {
    el = $(el || '.ink-busy');
    if (el) el.classList.toggle('is-visible', !!on);
  }

  /* ── Delegated listeners ──────────────────────────────────────────── */
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('ink-range')) {
      syncRange(t);
      emit(t, 'ink:range', { el: t, value: Number(t.value) });
    }
  });

  document.addEventListener('click', function (e) {
    var t = e.target;

    // Toggle
    var tog = t.closest('.ink-toggle');
    if (tog) {
      var on = !tog.classList.contains('is-on');
      tog.classList.toggle('is-on', on);
      tog.setAttribute('aria-pressed', on ? 'true' : 'false');
      emit(tog, 'ink:toggle', { el: tog, on: on });
      return;
    }

    // Tabs
    var tab = t.closest('.ink-tab');
    if (tab) {
      var tabs = tab.closest('.ink-tabs');
      if (tabs) tabs.querySelectorAll('.ink-tab').forEach(function (b) {
        b.classList.toggle('is-active', b === tab);
        b.setAttribute('aria-selected', b === tab ? 'true' : 'false');
      });
      var target = tab.getAttribute('data-target');
      if (target) {
        var pane = $(target);
        if (pane && pane.parentElement) {
          Array.prototype.forEach.call(pane.parentElement.children, function (p) {
            if (p.classList.contains('ink-pane')) p.classList.toggle('is-active', p === pane);
          });
        }
        emit(tab, 'ink:tab', { el: tab, pane: pane });
      }
      return;
    }

    // Card collapse
    var head = t.closest('.ink-card__header');
    if (head) { head.closest('.ink-card').classList.toggle('is-collapsed'); return; }

    // Single-select groups
    var group = t.closest('[data-ink-group]');
    if (group) {
      var child = t;
      while (child && child.parentElement !== group) child = child.parentElement;
      if (child && child.nodeType === 1) {
        Array.prototype.forEach.call(group.children, function (c) { c.classList.toggle('is-active', c === child); });
        emit(child, 'ink:select', { el: child, group: group });
      }
      return;
    }

    // Modal open / close
    var opener = t.closest('[data-ink-open]');
    if (opener) { openModal(opener.getAttribute('data-ink-open')); return; }
    var closer = t.closest('[data-ink-close]');
    if (closer) { closeModal(closer.closest('.ink-modal')); return; }
    if (t.classList && t.classList.contains('ink-modal')) closeModal(t); // backdrop click
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('.ink-modal.is-open').forEach(closeModal);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { syncAllRanges(); });
  else syncAllRanges();

  window.InkUI = { toast: toast, openModal: openModal, closeModal: closeModal, syncRange: syncRange, syncAllRanges: syncAllRanges, busy: busy };
})();
