'use strict';
/**
 * OT+T — the motion layer.
 *
 * Four primitives the whole site draws on: an entrance for anything that scrolls into view, a
 * pointer-tracked highlight for cards, a count-up for figures that opt in, and a draw-on for the
 * chart paths ui.js builds. Nothing here introduces a colour: every effect below is spent in the
 * palette style.css already defines, because the identity's one-accent rule is what keeps this a
 * carrier site rather than a launchpad.
 *
 * Targets are found by selector rather than marked up by hand. esim.js and status.js draw about
 * 1750 lines of DOM between them, and threading a data-attribute through all of it would be a diff
 * that touches every screen and risks the class names the browser tests hold. A MutationObserver on
 * #view catches whatever those two render asynchronously, so a tile that arrives after its fetch
 * gets the same entrance as one that was there at paint.
 *
 * Every effect is gated on prefers-reduced-motion: when it is set, elements are placed in their
 * final state immediately and no observer, listener or frame loop is installed at all.
 */
(function () {
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(mq && mq.matches);

  const REVEAL = [
    '.hero-copy > *', '.hero-visual', '.section-head', '.trust-item', '.plan-picker',
    '.plan-card', '.steps > *', '.cov-item', '.card', '.card-quiet', '.stat-tile', '.num-cell',
    '.dh-tile', '.prose-entry', '.status-row', '.page-head',
  ].join(',');

  const SPOTLIGHT = '.plan-card, .card, .stat-tile, .dh-tile';

  const matches = (el, sel) => el.nodeType === 1 && typeof el.matches === 'function' && el.matches(sel);

  // ============================================================================ count-up
  /**
   * Opt-in only, via data-count. The figures on the plan cards are asserted on by name in the
   * browser tests, and a number caught mid-flight is a flake, so nothing is animated here unless
   * its author asked for it. The element's own text is the target: prefix, suffix, grouping and
   * decimal places are all read back off it so the final frame is byte-identical to the string
   * that was there before the animation started.
   */
  function countUp(el) {
    if (el.dataset.counted) return;
    const source = el.getAttribute('data-count') || el.textContent || '';
    const m = String(source).match(/^(\D*)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
    if (!m) return;
    const [, pre, digits, post] = m;
    const target = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(target)) return;
    el.dataset.counted = '1';

    const dp = (digits.split('.')[1] || '').length;
    const grouped = digits.indexOf(',') !== -1;
    const render = (n) => {
      let s = n.toFixed(dp);
      if (grouped) {
        const [i, f] = s.split('.');
        s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
      }
      return pre + s + post;
    };

    if (reduced()) { el.textContent = render(target); return; }

    const dur = 900;
    const t0 = performance.now();
    el.style.fontVariantNumeric = 'tabular-nums';
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = render(target * eased);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = render(target);   // land on the exact source string, never a rounding of it
    };
    requestAnimationFrame(step);
  }

  // ============================================================================ chart draw-on
  /**
   * The chart svgs use a 0–100 viewBox with preserveAspectRatio="none", so getTotalLength answers
   * in that stretched user space rather than pixels. The dash figure is therefore not a real length
   * and the line does not draw at a perfectly even speed — which does not matter, because what is
   * wanted is the line arriving rather than a constant rate along it.
   */
  function drawPaths(root) {
    const paths = root.querySelectorAll('.u-chart-line, .u-spark path');
    for (const p of paths) {
      if (p.dataset.drawn) continue;
      p.dataset.drawn = '1';
      if (reduced()) continue;
      let len = 0;
      try { len = p.getTotalLength(); } catch (e) { continue; }
      if (!len) continue;
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
      void p.getBoundingClientRect();
      p.style.transition = 'stroke-dashoffset 1100ms cubic-bezier(.22, 1, .36, 1)';
      p.style.strokeDashoffset = '0';
    }
    const areas = root.querySelectorAll('.u-chart-area');
    for (const a of areas) {
      if (a.dataset.drawn) continue;
      a.dataset.drawn = '1';
      if (reduced()) continue;
      a.style.opacity = '0';
      void a.getBoundingClientRect();
      a.style.transition = 'opacity 700ms ease 300ms';
      a.style.opacity = '1';
    }
  }

  // ============================================================================ entrance
  let io = null;
  function observer() {
    if (io) return io;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        // Above the viewport counts as seen: an element the reader has already scrolled past must
        // never be left hidden just because it was never caught mid-screen.
        if (!e.isIntersecting && e.boundingClientRect.top > 0) continue;
        show(e.target, !e.isIntersecting);
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    return io;
  }

  /**
   * `instant` is for an element the reader has already scrolled past. Such an element is never
   * watched animating, and a transition started off screen does not tick at all — the browser
   * throttles animation outside the viewport, so it would sit at its first frame and only begin if
   * the reader happened to scroll back. Snapping it to the finished state is both what the reader
   * would expect and one fewer pending animation to carry.
   */
  function show(el, instant) {
    if (el.classList.contains('is-in')) return;
    if (io) io.unobserve(el);
    if (instant) el.classList.add('reveal-instant');
    el.classList.add('is-in');
    played(el);
  }

  /**
   * The guarantee behind the observer. A fast scroll, an anchor jump or End can carry an element
   * from below the fold to above it inside a single frame, and IntersectionObserver reports no
   * crossing for that — which would leave the content invisible for the rest of the page's life.
   * This sweeps whatever is still hidden on every scroll frame and retires itself once the last
   * one has been shown, so the cost is bounded and ends.
   */
  let sweepQueued = false;
  function sweep() {
    sweepQueued = false;
    const pending = document.querySelectorAll('.will-reveal:not(.is-in)');
    if (!pending.length) { window.removeEventListener('scroll', onScroll); return; }
    const h = window.innerHeight || 0;
    for (const el of pending) {
      const r = el.getBoundingClientRect();
      if (r.top < h) show(el, r.bottom < 0);
    }
  }
  function onScroll() {
    if (sweepQueued) return;
    sweepQueued = true;
    requestAnimationFrame(sweep);
  }

  function played(el) {
    if (matches(el, '[data-count]')) countUp(el);
    el.querySelectorAll('[data-count]').forEach(countUp);
    drawPaths(el);
  }

  function tagReveal(el) {
    if (el.dataset.reveal) return;
    el.dataset.reveal = '1';

    // Stagger is per-parent, so a row of three plan cards ripples but the next section starts over
    // rather than inheriting a delay from everything above it on the page.
    let i = 0;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (matches(sib, REVEAL)) i++;
    }
    el.style.setProperty('--reveal-i', String(Math.min(i, 10)));

    if (reduced()) { el.classList.add('is-in'); played(el); return; }
    el.classList.add('will-reveal');
    observer().observe(el);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function bindSpotlight(el) {
    if (el.dataset.spot || reduced()) return;
    el.dataset.spot = '1';
    el.classList.add('has-spot');
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      el.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(2) + '%');
      el.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(2) + '%');
    });
  }

  /**
   * The hero schematic is the one thing on this site that loops. It is paused whenever it is off
   * screen, so scrolling past it costs nothing for the rest of the page's life.
   */
  let idleIo = null;
  function bindIdle(el) {
    if (el.dataset.idleBound || reduced()) return;
    el.dataset.idleBound = '1';
    if (!idleIo) {
      idleIo = new IntersectionObserver((entries) => {
        for (const e of entries) e.target.classList.toggle('is-idle', !e.isIntersecting);
      }, { threshold: 0 });
    }
    idleIo.observe(el);
  }

  function scan(root) {
    const scope = root && root.nodeType === 1 ? root : document.body;
    if (!scope) return;
    if (matches(scope, REVEAL)) tagReveal(scope);
    scope.querySelectorAll(REVEAL).forEach(tagReveal);
    if (matches(scope, SPOTLIGHT)) bindSpotlight(scope);
    scope.querySelectorAll(SPOTLIGHT).forEach(bindSpotlight);
    if (matches(scope, '.schematic')) bindIdle(scope);
    scope.querySelectorAll('.schematic').forEach(bindIdle);
  }

  // ============================================================================ the shell
  function masthead() {
    const mh = document.getElementById('masthead');
    if (!mh) return;
    let state = null;
    const on = () => {
      const past = window.scrollY > 8;
      if (past === state) return;
      state = past;
      mh.classList.toggle('is-scrolled', past);
    };
    window.addEventListener('scroll', on, { passive: true });
    on();
  }

  /**
   * Registered before app.js's own hashchange handler, so the class lands while the outgoing route
   * is still on screen and the incoming one paints into an element that is already animating.
   */
  function routeTransition() {
    window.addEventListener('hashchange', () => {
      const v = document.getElementById('view');
      if (!v || reduced()) return;
      v.classList.remove('view-enter');
      void v.offsetWidth;
      v.classList.add('view-enter');
    });
  }

  function boot() {
    const view = document.getElementById('view');
    masthead();
    routeTransition();
    scan(document.body);
    if (!view) return;
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
    }).observe(view, { childList: true, subtree: true });
  }

  window.OTTMotion = { scan, countUp, drawPaths };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
