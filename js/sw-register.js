/*
 * sw-register.js — shared service worker registration + update flow.
 *
 * Included on ALL pages (main site + blog posts) so that:
 *   1. reg.update() is called on every page load → browser checks for new
 *      SW immediately (bypasses the 24h throttle)
 *   2. controllerchange listener reloads the page when a new SW activates
 *   3. Force-refresh button appears when an update is pending
 *
 * Uses ABSOLUTE paths (/service-worker.js, scope: /) so it works from
 * any page on the site regardless of URL depth (e.g. /blog/some-post).
 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  var EXPECTED_SW_VERSION = 'v4.72.2';

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none'
    }).then(function (reg) {
      console.log('[SW] registered, scope:', reg.scope);
      // Force an immediate check for a new SW on every page load.
      // Browsers throttle automatic checks (~24h via navigation).
      // reg.update() bypasses the throttle and checks NOW.
      reg.update();

      // Wire the updatefound listener — uses the captured registration
      // (no race condition with getRegistration).
      reg.addEventListener('updatefound', function () {
        var newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', function () {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New SW installed while another is controlling the page.
            showForceRefresh();
          }
        });
      });
    }).catch(function (err) {
      console.warn('[SW] registration failed:', err);
    });

    // When a new SW takes over (skipWaiting + clients.claim), reload once.
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    // ─── Force-refresh escape hatch ───────────────────────────────────
    // Only shown when an SW update is pending (updatefound + state=installed
    // + hasController). NOT shown on initial load (per user feedback).
    function showForceRefresh() {
      addForceRefreshButton();
      // Also show a transient toast for 15s
      if (document.getElementById('sw-update-toast')) return;
      var toast = document.createElement('div');
      toast.id = 'sw-update-toast';
      toast.style.cssText = [
        'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
        'background:linear-gradient(135deg,#4338ca,#0e7490)', 'color:#fff',
        'padding:12px 20px', 'border-radius:12px',
        'box-shadow:0 12px 32px -8px rgba(67,56,202,0.55)',
        'font-family:Inter,system-ui,sans-serif', 'font-size:14px', 'font-weight:600',
        'z-index:99999', 'cursor:pointer', 'display:flex', 'align-items:center', 'gap:10px',
        'max-width:calc(100vw - 32px)'
      ].join(';');
      toast.innerHTML = '<span>\u2728 Site updated \u2014 tap to reload</span>';
      toast.onclick = function () {
        navigator.serviceWorker.getRegistration().then(function (reg) {
          if (reg && reg.waiting) {
            reg.waiting.postMessage('skipWaiting');
          } else {
            forceRefresh();
          }
        });
      };
      document.body.appendChild(toast);
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 15000);
    }

    function addForceRefreshButton() {
      if (document.getElementById('pb-force-refresh')) return;
      var btn = document.createElement('button');
      btn.id = 'pb-force-refresh';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Force refresh — clear all cached content and reload');
      btn.title = 'Stuck on an old version? Click to clear cache and reload.';
      btn.style.cssText = [
        'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99998',
        'display:inline-flex', 'align-items:center', 'gap:6px',
        'padding:8px 14px', 'border-radius:999px', 'cursor:pointer',
        'font-family:Inter,system-ui,sans-serif', 'font-size:12px', 'font-weight:600',
        'color:#fff', 'border:1px solid rgba(255,255,255,0.18)',
        'background:linear-gradient(135deg,#4338ca,#0e7490)',
        'box-shadow:0 8px 24px -8px rgba(67,56,202,0.55)',
        'transition:transform 180ms ease, box-shadow 180ms ease'
      ].join(';');
      btn.innerHTML = '<i class="fas fa-rotate" aria-hidden="true" style="font-size:11px"></i><span>Force refresh</span>';
      btn.addEventListener('mouseenter', function () {
        btn.style.transform = 'translateY(-2px)';
        btn.style.boxShadow = '0 12px 28px -10px rgba(67,56,202,0.65)';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.transform = '';
        btn.style.boxShadow = '0 8px 24px -8px rgba(67,56,202,0.55)';
      });
      btn.addEventListener('click', forceRefresh);
      document.body.appendChild(btn);
    }

    function forceRefresh() {
      var btn = document.getElementById('pb-force-refresh');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true" style="font-size:11px"></i><span>Clearing\u2026</span>';
      }
      var wipeCaches = caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      });
      var wipeSW = navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      });
      Promise.all([wipeCaches, wipeSW]).then(function () {
        var url = new URL(window.location.href);
        url.searchParams.set('pb-refresh', Date.now().toString());
        window.location.href = url.toString();
      }).catch(function () { window.location.reload(); });
    }
  });
})();
