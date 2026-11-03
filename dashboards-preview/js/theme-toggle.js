/* ════════════════════════════════════════════════════════════════════════════
   theme-toggle.js — Site-wide light/dark theme controller
   - Tiny icon (sun/moon) fixed in top-right corner
   - Persists to localStorage ('docchat-theme')
   - Broadcasts to all iframes via postMessage (csr-dashboard-theme:apply)
   - Swaps ECharts registered theme on all chart instances
   - Applies CSS variables via [data-theme] on <html>
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STORAGE_KEY = 'docchat-theme';
  var THEME_APPLY = 'csr-dashboard-theme:apply';

  function resolveTheme() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (_) {}
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  }

  function applyTheme(theme) {
    var t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
    if (document.body) document.body.setAttribute('data-theme', t);

    // Update toggle icon — inline SVG for reliability (no font dependency)
    var iconHost = document.getElementById('themeToggleIcon');
    if (iconHost) {
      if (t === 'dark') {
        // Sun icon
        iconHost.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      } else {
        // Moon icon
        iconHost.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      }
    }

    // Broadcast to all iframes (CSR runtime listens for csr-dashboard-theme:apply)
    document.querySelectorAll('iframe').forEach(function (frame) {
      if (frame.contentWindow) {
        try {
          frame.contentWindow.postMessage({ type: THEME_APPLY, theme: t }, '*');
          // Inject CSS override into iframe for text contrast
          var doc = frame.contentWindow.document;
          if (doc) {
            var existing = doc.getElementById('theme-override');
            if (existing) existing.remove();
            var style = doc.createElement('style');
            style.id = 'theme-override';
            if (t === 'dark') {
              style.textContent = '* { color: #e2e8f0 !important; } ' +
                '.title, .tile-title, .head .title, th, .cat-row td { color: #f1f5f9 !important; } ' +
                '.subtitle, .muted, .foot, .empty, .hint { color: #94a3b8 !important; } ' +
                'body, .tile, .state, table { background: transparent !important; color: #e2e8f0 !important; } ' +
                '.pbix-table th { background: #1e293b !important; color: #f1f5f9 !important; } ' +
                '.pbix-table td { background: rgba(255,255,255,0.04) !important; color: #e2e8f0 !important; border-color: rgba(255,255,255,0.08) !important; } ' +
                '.svc-row td { background: rgba(255,255,255,0.06) !important; color: #e2e8f0 !important; } ' +
                '.cat-row td { background: #1e293b !important; color: #f1f5f9 !important; } ' +
                '.legend span { color: #cbd5e1 !important; } ' +
                '.its-kpi-value, .kv, .val { color: #f1f5f9 !important; } ' +
                '.kl, .lab, .ocsf-kpi-label { color: #94a3b8 !important; } ' +
                '.kb4-card, .its-card, .priority-card, .ocsf-report { background: rgba(255,255,255,0.04) !important; color: #e2e8f0 !important; } ' +
                '.head .title, .ocsf-title { color: #f1f5f9 !important; } ' +
                '.pill, .its-pill { background: rgba(255,255,255,0.08) !important; color: #cbd5e1 !important; } ' +
                'svg text { fill: #e2e8f0 !important; }';
            } else {
              style.textContent = '* { color: #171777 !important; } ' +
                '.subtitle, .muted, .foot, .empty, .hint { color: #3b4a6b !important; } ' +
                '.pbix-table th { background: #171777 !important; color: #fff !important; } ' +
                '.pbix-table td { background: #f8f9ff !important; color: #171777 !important; border-color: #d8deea !important; } ' +
                '.svc-row td { background: #eef0f8 !important; color: #171777 !important; } ' +
                '.cat-row td { background: #171777 !important; color: #fff !important; } ' +
                '.its-kpi-value, .kv, .val { color: #171777 !important; font-weight: 800 !important; } ' +
                '.kl, .lab, .ocsf-kpi-label { color: #3b4a6b !important; font-weight: 700 !important; } ' +
                '.legend span { color: #3b4a6b !important; font-weight: 600 !important; } ' +
                '.head .title { color: #171777 !important; font-weight: 800 !important; } ' +
                'svg text { fill: #171777 !important; }';
            }
            doc.head.appendChild(style);
          }
        } catch (_) {}
      }
    });

    // Also set data-csr-theme on <html> for CSR visuals that check it
    document.documentElement.setAttribute('data-csr-theme', t);

    // Re-apply ECharts theme to all chart instances
    if (typeof echarts !== 'undefined') {
      document.querySelectorAll('canvas').forEach(function (canvas) {
        var container = canvas.parentElement || canvas;
        var inst = echarts.getInstanceByDom(container);
        if (inst) {
          // Dispose and re-init with new theme
          var option = inst.getOption();
          inst.dispose();
          echarts.init(container, t === 'dark' ? 'vivid-dark' : 'vivid').setOption(option);
        }
      });
    }

    try { localStorage.setItem(STORAGE_KEY, t); } catch (_) {}
    return t;
  }

  function init() {
    // Create toggle button if it doesn't exist
    var existing = document.getElementById('themeToggle');
    if (existing) return;

    var btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle dark/light theme');
    btn.title = 'Toggle theme';
    btn.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'right:14px',
      'z-index:9999',
      'width:30px',
      'height:30px',
      'border-radius:8px',
      'border:1px solid var(--toggle-border, rgba(255,255,255,0.18))',
      'background:var(--toggle-bg, rgba(99,102,241,0.15))',
      'color:var(--toggle-color, #fff)',
      'font-size:12px',
      'cursor:pointer',
      'display:grid',
      'place-items:center',
      'transition:all 220ms cubic-bezier(.22,1,.36,1)',
      'backdrop-filter:blur(10px) saturate(160%)',
      '-webkit-backdrop-filter:blur(10px) saturate(160%)',
      'box-shadow:0 4px 14px rgba(0,0,0,0.18)'
    ].join(';');

    var icon = document.createElement('span');
    icon.id = 'themeToggleIcon';
    icon.style.cssText = 'display:grid;place-items:center;width:100%;height:100%;line-height:1;';
    btn.appendChild(icon);

    btn.addEventListener('mouseenter', function () {
      btn.style.transform = 'translateY(-2px) scale(1.05)';
      btn.style.boxShadow = '0 8px 24px rgba(99,102,241,0.35)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.transform = '';
      btn.style.boxShadow = '0 4px 14px rgba(0,0,0,0.18)';
    });

    btn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    document.body.appendChild(btn);

    // Apply initial theme
    applyTheme(resolveTheme());

    // Listen for cross-tab sync
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        applyTheme(e.newValue);
      }
    });

    // Listen for iframe theme requests (CSR runtime sends csr-dashboard-theme:request)
    window.addEventListener('message', function (event) {
      var msg = event.data || {};
      if (msg.type === 'csr-dashboard-theme:request' && event.source) {
        try {
          var currentTheme = document.documentElement.getAttribute('data-theme') || resolveTheme();
          event.source.postMessage({ type: THEME_APPLY, theme: currentTheme }, '*');
        } catch (_) {}
      }
    });
  }

  // Expose for programmatic use
  window.DocChatTheme = {
    get: function () { return document.documentElement.getAttribute('data-theme') || resolveTheme(); },
    set: applyTheme,
    toggle: function () {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      return applyTheme(current === 'dark' ? 'light' : 'dark');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
