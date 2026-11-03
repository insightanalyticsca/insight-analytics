/* ════════════════════════════════════════════════════════════════════════════
   pull-to-refresh.js — Pull-down-to-refresh for PWA/mobile
   Detects when user pulls down at the top of the page and triggers a refresh.
   Works on touch devices + trackpad/mouse with overscroll.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var THRESHOLD = 70;          // px to pull before refresh triggers
  var MAX_PULL = 120;          // max visual pull distance
  var RESISTANCE = 0.5;        // how much the pull "resists" (0=no movement, 1=1:1)
  var pulling = false;
  var startY = 0;
  var currentPull = 0;
  var indicator = null;

  function createIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.id = 'ptr-indicator';
    indicator.style.cssText = [
      'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
      'z-index:999999', 'width:36px', 'height:36px', 'border-radius:50%',
      'background:rgba(76,111,255,.15)', 'border:2px solid rgba(76,111,255,.4)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-size:16px', 'color:#4c6fff', 'transition:opacity .2s ease',
      'opacity:0', 'pointer-events:none', 'margin-top:-36px'
    ].join(';');
    indicator.innerHTML = '↻';
    document.body.appendChild(indicator);
    return indicator;
  }

  function showIndicator(pull) {
    var ind = createIndicator();
    var pct = Math.min(1, pull / THRESHOLD);
    var rotation = pct * 360;
    ind.style.opacity = String(pct);
    ind.style.transform = 'translateX(-50%) translateY(' + (pull * RESISTANCE) + 'px) rotate(' + rotation + 'deg)';
    ind.style.transition = 'none';
  }

  function hideIndicator(animate) {
    if (!indicator) return;
    if (animate) indicator.style.transition = 'opacity .2s ease, transform .2s ease';
    indicator.style.opacity = '0';
    indicator.style.transform = 'translateX(-50%) translateY(0) rotate(0deg)';
  }

  function triggerRefresh() {
    var ind = createIndicator();
    ind.style.transition = 'opacity .2s ease';
    ind.style.opacity = '1';
    ind.innerHTML = '<span style="animation:ptr-spin .6s linear infinite;display:inline-block">↻</span>';

    // Add spin keyframe if not present
    if (!document.getElementById('ptr-spin-style')) {
      var style = document.createElement('style');
      style.id = 'ptr-spin-style';
      style.textContent = '@keyframes ptr-spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }

    // Clear service worker cache, then reload
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
      navigator.serviceWorker.addEventListener('message', function handler(e) {
        if (e.data && e.data.type === 'CACHE_CLEARED') {
          navigator.serviceWorker.removeEventListener('message', handler);
          window.location.reload();
        }
      });
      // Fallback: reload after 1.5s even if no CACHE_CLEARED message
      setTimeout(function() { window.location.reload(); }, 1500);
    } else {
      window.location.reload();
    }
  }

  function isAtTop() {
    return (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) === 0;
  }

  function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  // ── Touch events (mobile) ──
  if (isTouchDevice()) {
    document.addEventListener('touchstart', function(e) {
      if (!isAtTop()) { pulling = false; return; }
      if (e.touches.length !== 1) return;
      pulling = true;
      startY = e.touches[0].clientY;
      currentPull = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!pulling) return;
      var diff = e.touches[0].clientY - startY;
      if (diff <= 0) { hideIndicator(false); return; }
      // Only intercept if user is pulling down at the top
      if (isAtTop()) {
        currentPull = Math.min(MAX_PULL, diff);
        showIndicator(currentPull);
        // Prevent native overscroll bounce while pulling
        if (currentPull > 5) e.preventDefault();
      } else {
        pulling = false;
        hideIndicator(true);
      }
    }, { passive: false });

    document.addEventListener('touchend', function() {
      if (!pulling) return;
      pulling = false;
      if (currentPull >= THRESHOLD) {
        triggerRefresh();
      } else {
        hideIndicator(true);
      }
      currentPull = 0;
    }, { passive: true });
  }

  // ── Mouse/trackpad overscroll (desktop PWA) ──
  var wheelTimeout = null;
  window.addEventListener('wheel', function(e) {
    if (!isAtTop()) return;
    if (e.deltaY < 0) {
      // Scrolling up at the top — potential pull-to-refresh
      currentPull = Math.min(MAX_PULL, Math.abs(e.deltaY) * 2);
      showIndicator(currentPull);
      clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(function() {
        if (currentPull >= THRESHOLD) {
          triggerRefresh();
        } else {
          hideIndicator(true);
        }
        currentPull = 0;
      }, 200);
    }
  }, { passive: true });
})();
