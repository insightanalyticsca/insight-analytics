/*
 * Insight Analytics — Pull-to-Refresh
 *
 * Behavior:
 *  - Activates only on touch devices (no pointer/mouse interference)
 *  - Fires when: page is at scrollTop === 0, user pulls down past threshold
 *  - Visual: a top-docked indicator slides down showing arrow → spinner
 *  - On release past threshold: triggers window.location.reload() to fetch fresh
 *    content (the service worker will network-first the HTML, so users see updates)
 *  - On release before threshold: snaps back with smooth spring
 *  - Respects overscroll-behavior: contain to prevent browser's native pull-to-refresh
 *    from double-firing on Chrome Android
 *
 * Accessibility:
 *  - Indicator has aria-live="polite" and role="status"
 *  - Keyboard shortcut: Ctrl/Cmd+R still works (native browser)
 *  - prefers-reduced-motion: snap-back is instant
 */
(function () {
  'use strict';

  const PULL_THRESHOLD = 70;        // px to trigger refresh
  const MAX_PULL = 110;             // resistance past threshold
  const RESISTANCE = 0.55;          // 1px input → 0.55px output past threshold
  const SNAP_BACK_MS = 320;         // spring duration

  // Only enable on touch-capable devices
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (!isTouchDevice) return;

  // Respect reduced motion preference — still allow refresh, but no animation
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Build indicator element
  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  indicator.innerHTML = `
    <div class="ptr-spinner" aria-hidden="true">
      <svg viewBox="0 0 24 24" class="ptr-arrow" width="24" height="24">
        <path d="M12 5l0 14M5 12l7-7 7 7" stroke="currentColor" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
      <svg viewBox="0 0 24 24" class="ptr-spin" width="24" height="24" style="display:none">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.4"
                fill="none" stroke-linecap="round" stroke-dasharray="14 28" />
      </svg>
    </div>
    <div class="ptr-label">Pull to refresh</div>
  `;
  document.body.appendChild(indicator);

  const spinner = indicator.querySelector('.ptr-spin');
  const arrow = indicator.querySelector('.ptr-arrow');
  const label = indicator.querySelector('.ptr-label');

  let startY = null;
  let currentY = 0;
  let pulling = false;
  let refreshing = false;

  function setPullDistance(d) {
    // d is the visual offset in px the indicator should slide down
    if (d <= 0) {
      indicator.classList.remove('ptr-visible', 'ready');
      indicator.style.transform = 'translate3d(0, 0, 0)';
      label.textContent = 'Pull to refresh';
      arrow.style.transform = 'rotate(0deg)';
      arrow.style.display = '';
      spinner.style.display = 'none';
      spinner.style.animation = '';
      return;
    }
    indicator.classList.add('ptr-visible');
    indicator.style.transform = `translate3d(0, ${d}px, 0)`;
    const ready = d >= PULL_THRESHOLD;
    indicator.classList.toggle('ready', ready);
    if (ready) {
      label.textContent = 'Release to refresh';
      arrow.style.transform = 'rotate(180deg)';
    } else {
      label.textContent = 'Pull to refresh';
      // Rotate arrow 0→180 proportionally as pull progresses
      const pct = d / PULL_THRESHOLD;
      arrow.style.transform = `rotate(${pct * 180}deg)`;
    }
  }

  function startRefreshing() {
    refreshing = true;
    indicator.classList.add('refreshing');
    arrow.style.display = 'none';
    spinner.style.display = '';
    spinner.style.animation = 'ptr-spin 0.8s linear infinite';
    label.textContent = 'Refreshing…';
    // Force indicator to stay at threshold height
    indicator.style.transform = `translate3d(0, ${PULL_THRESHOLD * 0.65}px, 0)`;
    // Trigger reload shortly so the indicator is visible
    setTimeout(() => {
      window.location.reload();
    }, 350);
  }

  function snapBack() {
    if (prefersReducedMotion) {
      indicator.style.transition = 'none';
      setPullDistance(0);
      return;
    }
    indicator.style.transition = `transform ${SNAP_BACK_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    setPullDistance(0);
    setTimeout(() => {
      indicator.style.transition = '';
    }, SNAP_BACK_MS + 20);
  }
  function onTouchStart(e) {
    if (refreshing) return;
    // Only one finger
    if (e.touches.length !== 1) return;
    // Only start if page is at the very top
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    currentY = startY;
    pulling = false; // will become true once user moves down past a small buffer
  }

  function onTouchMove(e) {
    if (refreshing || startY === null) return;
    const y = e.touches[0].clientY;
    const delta = y - startY;
    if (delta <= 0) {
      // User is scrolling up — abort pull tracking
      pulling = false;
      setPullDistance(0);
      startY = null;
      return;
    }
    // User is pulling down — engage pull-to-refresh
    if (!pulling) {
      pulling = true;
      // Prevent native browser refresh on Chrome Android while we handle it
      if (e.cancelable) e.preventDefault();
    }
    if (e.cancelable) e.preventDefault();

    // Compute visual distance with resistance past threshold
    let visual;
    if (delta <= PULL_THRESHOLD) {
      visual = delta;
    } else {
      const extra = delta - PULL_THRESHOLD;
      visual = PULL_THRESHOLD + extra * RESISTANCE;
      visual = Math.min(visual, MAX_PULL);
    }
    currentY = y;
    setPullDistance(visual);
  }

  function onTouchEnd() {
    if (refreshing) return;
    if (!pulling) {
      startY = null;
      return;
    }
    pulling = false;
    const visual = parseFloat(indicator.style.transform.replace(/[^0-9.]/g, '')) || 0;
    if (visual >= PULL_THRESHOLD) {
      startRefreshing();
    } else {
      snapBack();
    }
    startY = null;
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });

  // Prevent native browser pull-to-refresh on Chrome Android by setting overscroll-behavior
  document.documentElement.style.overscrollBehaviorY = 'contain';
  document.body.style.overscrollBehaviorY = 'contain';
})();
