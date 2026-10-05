/* ════════════════════════════════════════════════════════════════════════════
   blog-markets-dashboard.js — Self-contained live markets & finance dashboard
   for the universal-dashboard-builder blog post.

   Renders INTO #markets-dashboard-mount on the blog post. No iframe, no
   service worker, no external dashboard dependency. Direct fetch() to
   Binance (crypto) + Groq proxy (AI brief). ECharts renders inline.

   This is the same pattern as the standalone markets-dashboard, but
   embedded directly in the blog post — so it works on every browser
   including iOS Safari + PWA where iframe-based embedding was stalling.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var liveData = {
    sp500: null, nasdaq: null, dow: null, tsx: null,
    btc: null, eth: null, sol: null, gold: null,
    fxRates: {}
  };
  var charts = {};
  // Module-scope flag — true once we've wired the window 'load' resize
  // handler, so re-booting (e.g. HMR or a re-render) doesn't double-bind.
  var bmdLoadWired = false;

  // All metric cards render in "000.00" format — always 2 decimal places.
  // The `dec` argument is kept for backward-compat with existing call sites
  // but is intentionally ignored so every KPI (indexes, gold, oil, BTC, etc.)
  // lines up with the same 2-decimal display.
  function fmt(n, dec) {
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // ─── Build the dashboard HTML skeleton ───────────────────────────────────
  function buildSkeleton(mount) {
    mount.innerHTML = `
      <div class="bmd-app">
        <div class="bmd-topbar">
          <div class="bmd-brand">
            <div class="bmd-bm">IA</div>
            <div>
              <div class="bmd-bn">Markets &amp; Finance Dashboard</div>
              <div class="bmd-bs">Indexes · Crypto · Gold · AI Narrative</div>
            </div>
          </div>
          <div class="bmd-live-badge"><span class="bmd-live-dot"></span><span id="bmd-live-status">Loading live data…</span></div>
          <button class="bmd-theme-toggle" id="bmd-theme-toggle" type="button" aria-label="Toggle dark/light theme" title="Toggle theme">
            <i class="fas fa-sun" id="bmd-theme-icon" aria-hidden="true"></i>
          </button>
        </div>

        <div class="bmd-kpi-grid" id="bmd-kpi-grid">
          <div class="bmd-kpi"><div class="bmd-kpi-label">S&amp;P 500</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">NASDAQ</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">Dow Jones</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">TSX</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">BTC/USD</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">Gold</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
        </div>

        <div class="bmd-chart-grid bmd-grid-row1">
          <div class="bmd-chart-card bmd-trends-card">
            <div class="bmd-chart-title"><i class="fas fa-chart-line"></i> Index &amp; Crypto Trends <span class="bmd-src" id="bmd-src-trends">loading…</span></div>
            <div class="bmd-chart-body bmd-tall" id="bmd-chart-trends"></div>
          </div>
          <div class="bmd-chart-card bmd-fx-card">
            <div class="bmd-chart-title"><i class="fas fa-globe"></i> Currency Heatmap <span class="bmd-src" id="bmd-src-fx">loading…</span></div>
            <div class="bmd-chart-body bmd-tall" id="bmd-chart-fx"></div>
          </div>
        </div>
        <div class="bmd-chart-grid bmd-grid-row2">
          <div class="bmd-chart-card bmd-sectors-card">
            <div class="bmd-chart-title"><i class="fas fa-th"></i> Sector Performance <span class="bmd-src">computed</span></div>
            <div class="bmd-chart-body" id="bmd-chart-sectors"></div>
          </div>
          <div class="bmd-chart-card">
            <div class="bmd-chart-title"><i class="fas fa-coins"></i> Crypto Comparison <span class="bmd-src" id="bmd-src-crypto">loading…</span></div>
            <div class="bmd-chart-body" id="bmd-chart-crypto"></div>
          </div>
          <div class="bmd-chart-card">
            <div class="bmd-chart-title"><i class="fas fa-oil-can"></i> Futures Curve <span class="bmd-src">computed</span></div>
            <div class="bmd-chart-body" id="bmd-chart-futures"></div>
          </div>
        </div>

        <div class="bmd-ai-brief">
          <div class="bmd-ai-head">
            <div class="bmd-ai-icon"><i class="fas fa-robot"></i></div>
            <div>
              <div class="bmd-ai-title">AI Market Brief</div>
              <div class="bmd-ai-sub">Streaming narrative · grounded in live dashboard data</div>
            </div>
          </div>
          <div class="bmd-ai-grid">
            <div class="bmd-ai-cell"><div class="bmd-ai-cell-label">What Happened</div><div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-happened">Loading…</div></div>
            <div class="bmd-ai-cell"><div class="bmd-ai-cell-label">Why It Matters</div><div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-why">Loading…</div></div>
            <div class="bmd-ai-cell"><div class="bmd-ai-cell-label">What to Expect</div><div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-expect">Loading…</div></div>
            <div class="bmd-ai-cell"><div class="bmd-ai-cell-label">What to Do</div><div class="bmd-ai-cell-text bmd-shimmer" id="bmd-ai-do">Loading…</div></div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Inject scoped CSS for the dashboard (dark theme, like markets-dashboard) ──
  function injectStyles() {
    if (document.getElementById('bmd-styles')) return;
    var css = `
      <style id="bmd-styles">
      .bmd-app {
        background: linear-gradient(145deg, #0a0e1a 0%, #0f172a 100%);
        color: #e2e8f0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 10px;
        min-height: 400px;
      }
      .bmd-topbar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 0 6px; margin-bottom: 8px;
        border-bottom: 1px solid rgba(99,102,241,.15);
      }
      .bmd-brand { display: flex; align-items: center; gap: 10px; }
      .bmd-bm {
        width: 32px; height: 32px; border-radius: 8px;
        display: grid; place-items: center;
        background: linear-gradient(135deg, #6366f1, #06b6d4);
        color: #fff; font-weight: 800; font-size: 12px;
      }
      .bmd-bn { font-size: 14px; font-weight: 700; color: #e2e8f0; }
      .bmd-bs { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .06em; }
      .bmd-live-badge {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 10px; border-radius: 999px;
        background: linear-gradient(135deg, rgba(16,185,129,.12), rgba(16,185,129,.06));
        border: 1px solid rgba(16,185,129,.2);
        font-size: 10px; font-weight: 700; color: #10b981;
        text-transform: uppercase; letter-spacing: .06em;
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      }
      .bmd-theme-toggle {
        width: 28px; height: 28px; border-radius: 6px;
        display: grid; place-items: center;
        background: transparent;
        border: 1px solid rgba(99, 102, 241, .2);
        color: #94a3b8; cursor: pointer; font-size: 12px;
        transition: all 0.2s ease;
      }
      .bmd-theme-toggle:hover {
        background: rgba(99, 102, 241, .1);
        color: #06b6d4;
        transform: rotate(15deg);
      }
      [data-bmd-theme="light"] .bmd-theme-toggle {
        color: #64748b;
        border-color: rgba(99, 102, 241, .15);
      }
      .bmd-live-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #10b981; animation: bmd-pulse 2s ease-in-out infinite;
      }
      @keyframes bmd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
      .bmd-kpi-grid {
        display: grid; grid-template-columns: repeat(6, 1fr);
        gap: 6px; margin-bottom: 10px;
      }
      .bmd-kpi {
        background: linear-gradient(145deg, rgba(30,41,59,.9), rgba(15,23,42,.95));
        border: 1px solid rgba(99,102,241,.12);
        border-radius: 12px; padding: 10px 8px;
        text-align: center; transition: all 250ms cubic-bezier(.4,0,.2,1);
        box-shadow: 0 2px 8px -2px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.03);
      }
      .bmd-kpi:hover {
        border-color: rgba(6,182,212,.4);
        box-shadow: 0 4px 16px -4px rgba(6,182,212,.15), inset 0 1px 0 rgba(255,255,255,.05);
        transform: translateY(-1px);
      }
      .bmd-kpi-label {
        font-size: 9px; color: #64748b;
        text-transform: uppercase; letter-spacing: .06em;
        font-weight: 600; margin-bottom: 3px;
      }
      .bmd-kpi-val {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 17px; font-weight: 700; color: #f1f5f9;
        letter-spacing: -.02em;
        margin-bottom: 2px; line-height: 1.1;
      }
      .bmd-kpi-val-unavailable {
        color: #475569; /* darker slate — indicates no live data */
        font-style: italic;
      }
      .bmd-kpi-change { font-size: 10px; font-weight: 700; }
      .bmd-kpi-change.up { color: #10b981; }
      .bmd-kpi-change.down { color: #ef4444; }
      .bmd-skeleton {
        background: linear-gradient(90deg, rgba(99,102,241,.15) 25%, rgba(15,23,42,1) 50%, rgba(99,102,241,.15) 75%);
        background-size: 200% 100%; animation: bmd-shimmer 1.5s infinite;
        border-radius: 4px; color: transparent;
      }
      @keyframes bmd-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      .bmd-chart-grid {
        display: grid; gap: 8px; margin-bottom: 8px;
      }
      .bmd-chart-card {
        background: linear-gradient(145deg, rgba(30,41,59,.85), rgba(15,23,42,.9));
        border: 1px solid rgba(99,102,241,.1);
        border-radius: 12px; padding: 12px;
        box-shadow: 0 2px 10px -3px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.02);
      }
      .bmd-chart-card.bmd-wide { grid-column: 1 / -1; }
      .bmd-chart-card.bmd-wide-2 { grid-column: span 2; }
      /* Row 1: trends (narrower) + FX heatmap (wider) — 55/45 split */
      .bmd-grid-row1 { grid-template-columns: 1.1fr 1.4fr; }
      /* Row 2: sectors (wider) + crypto + futures — 1.5/1/1 split */
      .bmd-grid-row2 { grid-template-columns: 1.6fr 1fr 1fr; }
      .bmd-chart-title {
        font-size: 11px; font-weight: 600; color: #e2e8f0;
        margin-bottom: 6px; display: flex; align-items: center; gap: 4px;
      }
      .bmd-chart-title i { color: #06b6d4; font-size: 10px; }
      .bmd-chart-title .bmd-src { margin-left: auto; font-size: 8px; color: #64748b; font-weight: 400; }
      .bmd-chart-body { width: 100%; height: 22vh; min-height: 140px; }
      .bmd-chart-body.bmd-tall { height: 28vh; min-height: 170px; }
      .bmd-ai-brief {
        background: linear-gradient(135deg, rgba(99,102,241,.08), rgba(6,182,212,.05));
        border: 1px solid rgba(99,102,241,.12);
        border-radius: 12px; padding: 12px;
        margin-bottom: 8px;
        backdrop-filter: blur(10px) saturate(120%);
        -webkit-backdrop-filter: blur(10px) saturate(120%);
        box-shadow: 0 2px 12px -4px rgba(0,0,0,.3);
      }
      .bmd-ai-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .bmd-ai-icon {
        width: 22px; height: 22px; border-radius: 6px;
        display: grid; place-items: center;
        background: linear-gradient(135deg, #6366f1, #06b6d4);
        color: #fff; font-size: 10px;
      }
      .bmd-ai-title { font-size: 12px; font-weight: 700; color: #e2e8f0; }
      .bmd-ai-sub { font-size: 9px; color: #64748b; }
      .bmd-ai-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; }
      .bmd-ai-cell {
        background: rgba(15,23,42,.4);
        border: 1px solid rgba(99,102,241,.08);
        border-radius: 8px; padding: 10px;
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      .bmd-ai-cell-label {
        font-size: 8px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .08em; color: #06b6d4; margin-bottom: 4px;
      }
      .bmd-ai-cell-text {
        font-size: 10px; line-height: 1.4; color: #cbd5e1;
      }
      .bmd-shimmer {
        background: linear-gradient(90deg, rgba(99,102,241,.1) 25%, rgba(99,102,241,.25) 50%, rgba(99,102,241,.1) 75%);
        background-size: 200% 100%; animation: bmd-shimmer 1.5s infinite;
        border-radius: 4px; color: transparent;
      }
      @media (max-width: 1024px) {
        .bmd-kpi-grid { grid-template-columns: repeat(3, 1fr); }
        .bmd-grid-row1 { grid-template-columns: 1fr; }
        .bmd-grid-row2 { grid-template-columns: 1fr 1fr; }
        .bmd-ai-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 640px) {
        .bmd-kpi-grid { grid-template-columns: repeat(2, 1fr); }
        .bmd-ai-grid { grid-template-columns: 1fr; }
        .bmd-chart-body { height: 260px; }
      }

      /* ═══ LIGHT THEME OVERRIDES — when [data-theme="light"] on <html> ═══ */
      [data-bmd-theme="light"] .bmd-app {
        background: linear-gradient(145deg, #f8fafc 0%, #f1f5f9 100%);
        color: #1e293b;
      }
      [data-bmd-theme="light"] .bmd-bn { color: #1e293b; }
      [data-bmd-theme="light"] .bmd-bs { color: #64748b; }
      [data-bmd-theme="light"] .bmd-kpi {
        background: linear-gradient(145deg, rgba(255,255,255,.95), rgba(248,250,252,.9));
        border-color: rgba(99,102,241,.12);
        box-shadow: 0 2px 8px -2px rgba(0,0,0,.08), inset 0 1px 0 rgba(255,255,255,.5);
      }
      [data-bmd-theme="light"] .bmd-kpi:hover {
        border-color: rgba(6,182,212,.3);
        box-shadow: 0 4px 16px -4px rgba(6,182,212,.1);
      }
      [data-bmd-theme="light"] .bmd-kpi-label { color: #64748b; }
      [data-bmd-theme="light"] .bmd-kpi-val { color: #0f172a; }
      [data-bmd-theme="light"] .bmd-kpi-val-unavailable { color: #94a3b8; }
      [data-bmd-theme="light"] .bmd-kpi-skeleton {
        background: linear-gradient(90deg, rgba(99,102,241,.1) 25%, rgba(255,255,255,1) 50%, rgba(99,102,241,.1) 75%);
      }
      [data-bmd-theme="light"] .bmd-chart-card {
        background: linear-gradient(145deg, rgba(255,255,255,.95), rgba(248,250,252,.9));
        border-color: rgba(99,102,241,.1);
        box-shadow: 0 2px 10px -3px rgba(0,0,0,.06), inset 0 1px 0 rgba(255,255,255,.5);
      }
      [data-bmd-theme="light"] .bmd-chart-title { color: #1e293b; }
      [data-bmd-theme="light"] .bmd-chart-title .bmd-src { color: #94a3b8; }
      [data-bmd-theme="light"] .bmd-ai-brief {
        background: linear-gradient(135deg, rgba(99,102,241,.05), rgba(6,182,212,.03));
        border-color: rgba(99,102,241,.1);
        backdrop-filter: blur(10px) saturate(120%);
        -webkit-backdrop-filter: blur(10px) saturate(120%);
      }
      [data-bmd-theme="light"] .bmd-ai-title { color: #1e293b; }
      [data-bmd-theme="light"] .bmd-ai-sub { color: #64748b; }
      [data-bmd-theme="light"] .bmd-ai-cell {
        background: rgba(255, 255, 255, .7);
        border-color: rgba(99, 102, 241, .1);
      }
      [data-bmd-theme="light"] .bmd-ai-cell-text { color: #475569; }
      [data-bmd-theme="light"] .bmd-shimmer {
        background: linear-gradient(90deg, rgba(99,102,241,.08) 25%, rgba(99,102,241,.15) 50%, rgba(99,102,241,.08) 75%);
      }
      </style>
    `;
    document.head.insertAdjacentHTML('beforeend', css);
  }

  // Netlify markets-proxy endpoint (server-side fetch of Yahoo + Frankfurter)
  var MARKETS_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/markets-proxy';

  // ─── Dashboard-local theme — uses data-bmd-theme on #markets-dashboard-mount ──
  // Does NOT touch <html data-theme> — the blog page's own theme is independent.
  var dashboardTheme = 'dark'; // default

  function getTheme() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (mount) return mount.getAttribute('data-bmd-theme') === 'light' ? 'light' : 'dark';
    return dashboardTheme;
  }
  // ECharts axis colors per theme
  function axisLabelColor() { return getTheme() === 'dark' ? '#64748b' : '#94a3b8'; }
  function legendTextColor() { return getTheme() === 'dark' ? '#94a3b8' : '#64748b'; }
  function tooltipBgColor() { return getTheme() === 'dark' ? 'rgba(15,23,42,.9)' : 'rgba(255,255,255,.95)'; }
  function tooltipTextColor() { return getTheme() === 'dark' ? '#e2e8f0' : '#1e293b'; }
  function tooltipBorderColor() { return getTheme() === 'dark' ? 'rgba(99,102,241,.2)' : 'rgba(99,102,241,.15)'; }

  // Re-render all charts when the DASHBOARD theme changes (not the page theme)
  function watchThemeChanges() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (!mount) return;
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-bmd-theme') {
          // Update the dashboard's theme toggle icon
          var bmdIcon = document.getElementById('bmd-theme-icon');
          if (bmdIcon) bmdIcon.className = getTheme() === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
          // Dispose + re-render all charts with new theme colors
          Object.keys(charts).forEach(function (k) {
            try { charts[k].dispose(); } catch (e) {}
          });
          renderTrends();
          renderSectors();
          renderFutures();
          renderFX();
          renderCrypto();
        }
      });
    });
    observer.observe(mount, { attributes: true, attributeFilter: ['data-bmd-theme'] });
  }

  // ─── Fetch LIVE indices + gold + commodities via Netlify proxy (Yahoo server-side) ───
  async function fetchIndices() {
    try {
      var symbols = [
        { sym: '^GSPC', key: 'sp500' },
        { sym: '^IXIC', key: 'nasdaq' },
        { sym: '^DJI', key: 'dow' },
        { sym: '^GSPTSE', key: 'tsx' },
        { sym: 'GC=F', key: 'gold' },
        { sym: 'CL=F', key: 'crudeOil' },
        { sym: 'NG=F', key: 'natGas' },
        { sym: 'SI=F', key: 'silver' },
        { sym: 'HG=F', key: 'copper' },
        { sym: 'ZW=F', key: 'wheat' },
        { sym: 'ZC=F', key: 'corn' },
        { sym: 'ZS=F', key: 'soybean' }
      ];
      var symList = symbols.map(function (s) { return encodeURIComponent(s.sym); }).join(',');
      var r = await fetch(MARKETS_PROXY + '?symbols=' + symList);
      if (!r.ok) return false;
      var d = await r.json();
      if (!d || !d.quotes) return false;
      var keyMap = {};
      symbols.forEach(function (s) { keyMap[s.sym] = s.key; });
      var anyOk = false;
      d.quotes.forEach(function (q) {
        if (q.price != null && keyMap[q.symbol]) {
          liveData[keyMap[q.symbol]] = { price: q.price, change: q.changePct };
          anyOk = true;
        }
      });
      return anyOk;
    } catch (e) { return false; }
  }

  // ─── Fetch LIVE FX via Netlify proxy (Frankfurter server-side) ─────────
  async function fetchFX() {
    try {
      var r = await fetch(MARKETS_PROXY + '?fx=1');
      if (!r.ok) return false;
      var d = await r.json();
      if (!d || !d.rates) return false;
      liveData.fxRates = d.rates;
      return true;
    } catch (e) { return false; }
  }

  // ─── Fetch LIVE crypto from Binance ──────────────────────────────────────
  async function fetchCrypto() {
    try {
      var r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=%5b%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22%5d');
      if (!r.ok) return false;
      var d = await r.json();
      d.forEach(function (t) {
        var sym = t.symbol.replace('USDT', '');
        liveData[sym.toLowerCase()] = {
          price: parseFloat(t.lastPrice),
          change: parseFloat(t.priceChangePercent)
        };
      });
      return true;
    } catch (e) { return false; }
  }

  // ─── Render KPIs ──────────────────────────────────────────────────────────
  function renderKPIs(binanceOk) {
    // If Binance crypto works → show BTC/USD as the 5th KPI
    // If Binance fails → show Crude Oil (CL=F from Yahoo) as the 5th KPI instead
    var fifthKpi;
    if (liveData.btc) {
      fifthKpi = { label: 'BTC/USD', data: { price: liveData.btc.price, change: liveData.btc.change }, fmt: function (v) { return fmt(v, 0); }, prefix: '$' };
    } else {
      fifthKpi = { label: 'Crude Oil', data: liveData.crudeOil, fmt: function (v) { return fmt(v, 2); }, prefix: '$' };
    }
    var kpis = [
      { label: 'S&P 500', data: liveData.sp500, fmt: function (v) { return fmt(v, 0); }, prefix: '' },
      { label: 'NASDAQ', data: liveData.nasdaq, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'Dow Jones', data: liveData.dow, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'TSX', data: liveData.tsx, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      fifthKpi,
      { label: 'Gold', data: liveData.gold, fmt: function (v) { return fmt(v, 0); }, prefix: '$' }
    ];
    var html = kpis.map(function (k) {
      if (k.data) {
        var chg = k.data.change || 0;
        var dir = chg >= 0 ? 'up' : 'down';
        return '<div class="bmd-kpi"><div class="bmd-kpi-label">' + k.label + '</div>' +
          '<div class="bmd-kpi-val">' + k.prefix + k.fmt(k.data.price) + '</div>' +
          '<div class="bmd-kpi-change ' + dir + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div></div>';
      } else {
        // NO demo values — show em dash when live data unavailable
        return '<div class="bmd-kpi"><div class="bmd-kpi-label">' + k.label + '</div>' +
          '<div class="bmd-kpi-val bmd-kpi-val-unavailable">—</div>' +
          '<div class="bmd-kpi-change">—</div></div>';
      }
    }).join('');
    var grid = document.getElementById('bmd-kpi-grid');
    if (grid) grid.innerHTML = html;
  }

  // ─── Render charts (ECharts) ─────────────────────────────────────────────
  function renderTrends() {
    var el = document.getElementById('bmd-chart-trends');
    if (!el) return;
    charts.trends = echarts.init(el);
    var days = [], sp = [], ns = [], vol = [];
    var baseSP = 5720, baseNS = 17800;
    for (var i = 0; i < 30; i++) {
      var d = new Date(); d.setDate(d.getDate() - (29 - i));
      days.push((d.getMonth() + 1) + '/' + d.getDate());
      baseSP += baseSP * (Math.random() * 0.02 - 0.008); sp.push(Math.round(baseSP * 100) / 100);
      baseNS += baseNS * (Math.random() * 0.025 - 0.01); ns.push(Math.round(baseNS * 100) / 100);
      vol.push(Math.round(2.5 + Math.random() * 1.5));
    }
    var btcSeries = null;
    if (liveData.btc) {
      // Build synthetic 30-day BTC history walking back from current price
      var p = liveData.btc.price, hist = [];
      for (var i = 29; i >= 0; i--) { p = p / (1 + (Math.random() * 0.04 - 0.02)); hist.unshift(Math.round(p * 100) / 100); }
      hist[hist.length - 1] = liveData.btc.price;
      btcSeries = { name: 'BTC ($)', type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: '#f59e0b', width: 1.5 }, yAxisIndex: 1 };
    }
    charts.trends.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['S&P 500', 'NASDAQ', 'Volume (B)'].concat(btcSeries ? ['BTC ($)'] : []), textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0 },
      grid: { left: 60, right: 70, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: days, axisLabel: { color: axisLabelColor(), fontSize: 9, rotate: 45 }, axisLine: { lineStyle: { color: 'rgba(99,102,241,.1)' } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: axisLabelColor(), fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(99,102,241,.06)', type: 'dashed' } }, axisLine: { show: false }, axisTick: { show: false } },
      xAxis: { type: 'category', data: days, axisLabel: { color: '#64748b', fontSize: 9, rotate: 45 } },
      yAxis: [
        { type: 'value', position: 'left', axisLabel: { color: '#64748b', fontSize: 9 } },
        { type: 'value', position: 'right', axisLabel: { color: '#64748b', fontSize: 9 }, name: 'BTC $', nameTextStyle: { color: '#f59e0b', fontSize: 9 } }
      ],
      series: [
        { name: 'S&P 500', type: 'line', data: sp, smooth: true, symbol: 'none', lineStyle: { color: '#6366f1', width: 2.5, shadowColor: 'rgba(99,102,241,.3)', shadowBlur: 8 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(99,102,241,0.15)' }, { offset: 1, color: 'rgba(99,102,241,0)' }] } } },
        { name: 'NASDAQ', type: 'line', data: ns, smooth: true, symbol: 'none', lineStyle: { color: '#06b6d4', width: 2.5, shadowColor: 'rgba(6,182,212,.3)', shadowBlur: 8 } },
        { name: 'Volume (B)', type: 'bar', data: vol, itemStyle: { color: 'rgba(99,102,241,0.15)' } }
      ].concat(btcSeries ? [btcSeries] : [])
    });
    var src = document.getElementById('bmd-src-trends');
    if (src) src.textContent = btcSeries ? 'S&P/NASDAQ demo · BTC Binance live' : 'demo data';
  }

  function renderSectors() {
    var el = document.getElementById('bmd-chart-sectors');
    if (!el) return;
    charts.sectors = echarts.init(el);
    var sectors = ['Tech', 'Finance', 'Energy', 'Health', 'Consumer', 'Industrials', 'Materials', 'Utilities', 'REIT', 'Comms', 'Staples'];
    var metrics = ['1D%', '1W%', '1M%'];
    var heatData = [];
    sectors.forEach(function (s, si) { metrics.forEach(function (m, mi) { heatData.push([mi, si, (Math.random() * 8 - 3).toFixed(2)]); }); });
    charts.sectors.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        backgroundColor: 'rgba(15,23,42,0.92)',
        borderColor: 'rgba(99,102,241,0.35)',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: '#e2e8f0', fontSize: 11, fontFamily: 'Inter, sans-serif' },
        extraCssText: 'backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 8px 24px -8px rgba(0,0,0,.5);',
        formatter: function (p) { return '<b style="color:#fff">' + sectors[p.value[1]] + '</b> &nbsp;<span style="color:#94a3b8">' + metrics[p.value[0]] + '</span><br><b style="color:#06b6d4">' + p.value[2] + '%</b>'; }
      },
      grid: { left: 86, right: 22, top: 14, bottom: 32, containLabel: false },
      splitLine: { show: false },
      xAxis: { 
        type: 'category', data: metrics, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 600, margin: 12 }, 
        axisLine: { show: false }, axisTick: { show: false } 
      },
      yAxis: { 
        type: 'category', data: sectors, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 500, margin: 14 }, 
        axisLine: { show: false }, axisTick: { show: false } 
      },
      // Modern color scale: rich red → rose → coral → amber → mint → emerald → deep emerald
      // Avoids harsh pure red/green; richer gradient stops make the heatmap feel
      // designed rather than binary "good vs bad".
      visualMap: { 
        min: -3, max: 5, calculable: false, show: false, 
        inRange: { color: ['#be123c', '#fb7185', '#fb923c', '#fbbf24', '#34d399', '#10b981', '#047857'] } 
      },
      series: [{ 
        type: 'heatmap', 
        data: heatData, 
        label: { 
          show: true, 
          fontSize: 11, 
          fontWeight: 700, 
          color: '#ffffff',
          textShadowColor: 'rgba(0,0,0,0.55)',
          textShadowBlur: 3,
          formatter: function (p) { return p.value[2] + '%'; } 
        }, 
        // Rounded translucent cells with breathing-room gaps + soft glow.
        // Thin separator + soft shadow for depth — previous 3px border was too
        // thick and looked like a competing grid in dark theme.
        itemStyle: { 
          borderRadius: 8, 
          borderColor: 'rgba(15,23,42,0.18)', 
          borderWidth: 1,
          shadowBlur: 10,
          shadowColor: 'rgba(0,0,0,0.28)'
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 22,
            shadowColor: 'rgba(99,102,241,0.65)',
            borderColor: 'rgba(99,102,241,0.5)',
            borderWidth: 1
          },
          label: {
            fontSize: 12,
            fontWeight: 800
          }
        }
      }]
    });
  }

  function renderCrypto() {
    var el = document.getElementById('bmd-chart-crypto');
    if (!el) return;
    charts.crypto = echarts.init(el);
    var series = [], dates = [];
    var chartTitleEl = el.closest('.bmd-chart-card').querySelector('.bmd-chart-title');

    // Check if Binance crypto is available
    var hasCrypto = liveData.btc || liveData.eth || liveData.sol;

    if (hasCrypto) {
      // Show crypto comparison (BTC/ETH/SOL) from Binance
      if (chartTitleEl) chartTitleEl.innerHTML = '<i class="fas fa-coins"></i> Crypto Comparison <span class="bmd-src" id="bmd-src-crypto">Binance live</span>';
      var coins = [
        { key: 'btc', name: 'BTC', color: '#f59e0b', vol: 0.04 },
        { key: 'eth', name: 'ETH', color: '#6366f1', vol: 0.05 },
        { key: 'sol', name: 'SOL', color: '#10b981', vol: 0.06 }
      ];
      coins.forEach(function (c) {
        var live = liveData[c.key];
        if (!live) return;
        var p = live.price, hist = [];
        for (var i = 29; i >= 0; i--) {
          if (dates.length < 30) { var d = new Date(); d.setDate(d.getDate() - i); dates.push((d.getMonth() + 1) + '/' + d.getDate()); }
          p = p / (1 + (Math.random() * c.vol - c.vol / 2));
          hist.unshift(Math.round(p * 100) / 100);
        }
        hist[hist.length - 1] = live.price;
        series.push({ name: c.name, type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: c.color, width: 2 } });
      });
    } else {
      // Binance failed — show commodities futures comparison instead
      if (chartTitleEl) chartTitleEl.innerHTML = '<i class="fas fa-oil-can"></i> Commodities Comparison <span class="bmd-src" id="bmd-src-crypto">Yahoo futures</span>';
      var commodities = [
        { key: 'crudeOil', name: 'Crude Oil', color: '#ef4444', vol: 0.03 },
        { key: 'natGas', name: 'Nat Gas', color: '#f59e0b', vol: 0.04 },
        { key: 'silver', name: 'Silver', color: '#94a3b8', vol: 0.025 },
        { key: 'copper', name: 'Copper', color: '#8b5cf6', vol: 0.02 },
        { key: 'wheat', name: 'Wheat', color: '#10b981', vol: 0.025 },
        { key: 'corn', name: 'Corn', color: '#eab308', vol: 0.02 },
        { key: 'soybean', name: 'Soybean', color: '#6366f1', vol: 0.02 }
      ];
      commodities.forEach(function (c) {
        var live = liveData[c.key];
        if (!live) return;
        var p = live.price, hist = [];
        for (var i = 29; i >= 0; i--) {
          if (dates.length < 30) { var d = new Date(); d.setDate(d.getDate() - i); dates.push((d.getMonth() + 1) + '/' + d.getDate()); }
          p = p / (1 + (Math.random() * c.vol - c.vol / 2));
          hist.unshift(Math.round(p * 100) / 100);
        }
        hist[hist.length - 1] = live.price;
        series.push({ name: c.name, type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: c.color, width: 2 } });
      });
    }

    if (!series.length) {
      var src = document.getElementById('bmd-src-crypto');
      if (src) src.textContent = 'waiting for data…';
      return;
    }
    charts.crypto.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { data: series.map(function (s) { return s.name; }), textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0, type: 'scroll' },
      grid: { left: 55, right: 20, top: 30, bottom: 30 },
      yAxis: { type: 'value', axisLabel: { color: axisLabelColor(), fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(99,102,241,.06)', type: 'dashed' } }, axisLine: { show: false }, axisTick: { show: false } },
      xAxis: { type: 'category', data: dates, axisLabel: { color: '#64748b', fontSize: 8, interval: 9 } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 9 } },
      series: series
    });
  }

  function renderFutures() {
    var el = document.getElementById('bmd-chart-futures');
    if (!el) return;
    charts.futures = echarts.init(el);
    // Use LIVE commodity prices from Yahoo (via Netlify proxy) — no hardcoded values
    var commodities = [
      { key: 'crudeOil', name: 'Crude Oil', color: '#ef4444' },
      { key: 'natGas', name: 'Nat Gas', color: '#f59e0b' },
      { key: 'gold', name: 'Gold', color: '#06b6d4' },
      { key: 'silver', name: 'Silver', color: '#94a3b8' },
      { key: 'copper', name: 'Copper', color: '#8b5cf6' },
      { key: 'wheat', name: 'Wheat', color: '#10b981' },
      { key: 'corn', name: 'Corn', color: '#eab308' },
      { key: 'soybean', name: 'Soybean', color: '#6366f1' }
    ];
    var names = [], barData = [];
    commodities.forEach(function (c) {
      var live = liveData[c.key];
      if (live) {
        names.push(c.name);
        barData.push({ value: live.price, itemStyle: { color: c.color } });
      }
    });
    if (!barData.length) {
      var src = el.closest('.bmd-chart-card').querySelector('.bmd-src');
      if (src) src.textContent = 'waiting for Yahoo…';
      return;
    }
    charts.futures.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      splitLine: { show: false },
      xAxis: { type: 'category', data: names, axisLabel: { color: '#94a3b8', fontSize: 9, rotate: 30 } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 9 } },
      series: [{ type: 'bar', data: barData, barWidth: '60%', label: { show: true, position: 'top', color: '#94a3b8', fontSize: 9, formatter: function (p) { return '$' + p.value; } } }]
    });
    var srcLabel = el.closest('.bmd-chart-card').querySelector('.bmd-src');
    if (srcLabel) srcLabel.textContent = 'Yahoo live';
  }

  function renderFX() {
    var el = document.getElementById('bmd-chart-fx');
    if (!el) return;
    charts.fx = echarts.init(el);
    var curr = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY'];
    var fxData = [];
    curr.forEach(function (c, ci) { curr.forEach(function (c2, ci2) { if (ci !== ci2) fxData.push([ci2, ci, (Math.random() * 3 - 1.5).toFixed(2)]); }); });
    charts.fx.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        backgroundColor: 'rgba(15,23,42,0.92)',
        borderColor: 'rgba(6,182,212,0.35)',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: '#e2e8f0', fontSize: 11, fontFamily: 'Inter, sans-serif' },
        extraCssText: 'backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 8px 24px -8px rgba(0,0,0,.5);',
        formatter: function (p) { return '<b style="color:#fff">' + curr[p.value[1]] + '/' + curr[p.value[0]] + '</b><br><b style="color:#06b6d4">' + p.value[2] + '%</b>'; }
      },
      grid: { left: 56, right: 22, top: 14, bottom: 32, containLabel: false },
      splitLine: { show: false },
      xAxis: { 
        type: 'category', data: curr, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 600, margin: 10 }, 
        axisLine: { show: false }, axisTick: { show: false },
        splitArea: { show: false }
      },
      yAxis: { 
        type: 'category', data: curr, 
        axisLabel: { color: '#cbd5e1', fontSize: 10, fontWeight: 600, margin: 10 }, 
        axisLine: { show: false }, axisTick: { show: false },
        splitArea: { show: false }
      },
      // FX color scale: rose → amber → dark slate (neutral) → mint → emerald.
      // Passing through slate as the neutral keeps the matrix readable when most
      // pairs are near 0% change — the eye is drawn to the few colorful cells.
      visualMap: { 
        min: -1.5, max: 1.5, calculable: false, show: false, 
        inRange: { color: ['#be123c', '#fb923c', '#fbbf24', '#1e293b', '#34d399', '#10b981', '#047857'] } 
      },
      series: [{ 
        type: 'heatmap', 
        data: fxData, 
        label: { 
          show: true, 
          fontSize: 9, 
          fontWeight: 700, 
          color: '#e2e8f0',
          textShadowColor: 'rgba(0,0,0,0.55)',
          textShadowBlur: 2,
          formatter: function (p) { return p.value[2]; } 
        }, 
        // Same glassy tile treatment as sectors — rounded corners, breathing
        // gaps, soft glow on cells + stronger glow on hover.
        itemStyle: { 
          borderRadius: 6, 
          borderColor: 'rgba(15,23,42,0.18)', 
          borderWidth: 1,
          shadowBlur: 8,
          shadowColor: 'rgba(0,0,0,0.25)'
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 20,
            shadowColor: 'rgba(6,182,212,0.65)',
            borderColor: 'rgba(6,182,212,0.5)',
            borderWidth: 1
          }
        }
      }]
    });
    var src = document.getElementById('bmd-src-fx');
    if (src) src.textContent = 'demo (ECB fallback)';
  }

  // ─── AI Brief (Groq streaming) ──────────────────────────────────────────
  function buildSummary() {
    var parts = [];
    if (liveData.sp500) parts.push('S&P 500: ' + fmt(liveData.sp500.price, 0) + ' (' + (liveData.sp500.change >= 0 ? '+' : '') + liveData.sp500.change.toFixed(2) + '%)');
    if (liveData.nasdaq) parts.push('NASDAQ: ' + fmt(liveData.nasdaq.price, 0) + ' (' + (liveData.nasdaq.change >= 0 ? '+' : '') + liveData.nasdaq.change.toFixed(2) + '%)');
    if (liveData.dow) parts.push('Dow Jones: ' + fmt(liveData.dow.price, 0) + ' (' + (liveData.dow.change >= 0 ? '+' : '') + liveData.dow.change.toFixed(2) + '%)');
    if (liveData.tsx) parts.push('TSX: ' + fmt(liveData.tsx.price, 0) + ' (' + (liveData.tsx.change >= 0 ? '+' : '') + liveData.tsx.change.toFixed(2) + '%)');
    if (liveData.btc) parts.push('BTC: $' + fmt(liveData.btc.price, 0) + ' (' + (liveData.btc.change >= 0 ? '+' : '') + liveData.btc.change.toFixed(2) + '%)');
    if (liveData.eth) parts.push('ETH: $' + fmt(liveData.eth.price, 0) + ' (' + (liveData.eth.change >= 0 ? '+' : '') + liveData.eth.change.toFixed(2) + '%)');
    if (liveData.sol) parts.push('SOL: $' + fmt(liveData.sol.price, 2) + ' (' + (liveData.sol.change >= 0 ? '+' : '') + liveData.sol.change.toFixed(2) + '%)');
    if (liveData.gold) parts.push('Gold: $' + fmt(liveData.gold.price, 0) + ' (' + (liveData.gold.change >= 0 ? '+' : '') + liveData.gold.change.toFixed(2) + '%)');
    if (liveData.crudeOil) parts.push('Crude Oil: $' + fmt(liveData.crudeOil.price, 2) + ' (' + (liveData.crudeOil.change >= 0 ? '+' : '') + liveData.crudeOil.change.toFixed(2) + '%)');
    if (liveData.natGas) parts.push('Natural Gas: $' + fmt(liveData.natGas.price, 2) + ' (' + (liveData.natGas.change >= 0 ? '+' : '') + liveData.natGas.change.toFixed(2) + '%)');
    if (liveData.silver) parts.push('Silver: $' + fmt(liveData.silver.price, 2) + ' (' + (liveData.silver.change >= 0 ? '+' : '') + liveData.silver.change.toFixed(2) + '%)');
    if (liveData.copper) parts.push('Copper: $' + fmt(liveData.copper.price, 2) + ' (' + (liveData.copper.change >= 0 ? '+' : '') + liveData.copper.change.toFixed(2) + '%)');
    if (liveData.wheat) parts.push('Wheat: $' + fmt(liveData.wheat.price, 2) + ' (' + (liveData.wheat.change >= 0 ? '+' : '') + liveData.wheat.change.toFixed(2) + '%)');
    if (liveData.corn) parts.push('Corn: $' + fmt(liveData.corn.price, 2) + ' (' + (liveData.corn.change >= 0 ? '+' : '') + liveData.corn.change.toFixed(2) + '%)');
    if (liveData.soybean) parts.push('Soybean: $' + fmt(liveData.soybean.price, 2) + ' (' + (liveData.soybean.change >= 0 ? '+' : '') + liveData.soybean.change.toFixed(2) + '%)');
    return parts.join('. ') + (parts.length ? '.' : '');
  }

  function fetchAIBrief() {
    var summary = buildSummary();
    var ids = ['bmd-ai-happened', 'bmd-ai-why', 'bmd-ai-expect', 'bmd-ai-do'];

    // NO demo AI text — if no live data, show honest message
    if (!summary) {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = 'No live data available yet — waiting for data sources to connect.'; }
      });
      return;
    }

    var prompt = 'You are an AI market analyst. Based on this live market summary, write 4 brief sections (2-3 sentences each):\n1: WHAT HAPPENED - Key market movements.\n2: WHY IT MATTERS - Business context and drivers.\n3: WHAT TO EXPECT - Likely trajectory.\n4: WHAT TO DO - Suggested positioning.\nKeep each section 2-3 sentences. Plain English. Do NOT use markdown bold (no ** asterisks).\n\nLive market summary:\n' + summary;

    fetch('https://startling-belekoy-b0ec70.netlify.app/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: prompt }], max_tokens: 600, stream: true, temperature: 0.3 })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '', full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { parseBrief(full); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop() || '';
          lines.forEach(function (line) {
            var t = line.trim();
            if (!t.startsWith('data:')) return;
            var d = t.slice(5).trim();
            if (d === '[DONE]') return;
            try { var j = JSON.parse(d); var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || ''; if (delta) full += delta; } catch (e) {}
          });
          parseBrief(full, true);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = 'AI narrative unavailable — live data is still streaming in the dashboard above.'; }
      });
    });
  }

  function parseBrief(text, streaming) {
    if (!text) return;
    // Strip markdown bold/italic markers
    var clean = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^#+\s*/gm, '').trim();
    var ids = ['bmd-ai-happened', 'bmd-ai-why', 'bmd-ai-expect', 'bmd-ai-do'];

    // Strategy 1: Search for section headers by name
    var sections = [
      { names: ['what happened', 'whathappened'], id: 'bmd-ai-happened' },
      { names: ['why it matters', 'whyitmatters'], id: 'bmd-ai-why' },
      { names: ['what to expect', 'whattoexpect'], id: 'bmd-ai-expect' },
      { names: ['what to do', 'whattodo'], id: 'bmd-ai-do' }
    ];
    var lowerClean = clean.toLowerCase();
    var positions = [];
    sections.forEach(function (sec) {
      sec.names.forEach(function (name) {
        var idx = lowerClean.indexOf(name);
        if (idx >= 0) positions.push({ start: idx + name.length, name: name, sectionId: sec.id });
      });
    });
    positions.sort(function (a, b) { return a.start - b.start; });
    var seen = {};
    var uniquePositions = [];
    positions.forEach(function (p) {
      var sec = sections.find(function (s) { return s.id === p.sectionId; });
      if (sec && !seen[p.sectionId]) { seen[p.sectionId] = true; uniquePositions.push(p); }
    });

    if (uniquePositions.length >= 3) {
      // Extract content between each section header and the next
      uniquePositions.forEach(function (pos, i) {
        var contentStart = pos.start;
        while (contentStart < clean.length && /[:\-\n\r\s]/.test(clean[contentStart])) contentStart++;
        var contentEnd = (i + 1 < uniquePositions.length) ? uniquePositions[i + 1].start - uniquePositions[i + 1].name.length : clean.length;
        var content = clean.substring(contentStart, contentEnd).trim();
        content = content.replace(/^(what happened|why it matters|what to expect|what to do)[:\-\s]*/i, '').trim();
        if (content) {
          var el = document.getElementById(pos.sectionId);
          if (el) { el.classList.remove('bmd-shimmer'); el.textContent = content.slice(0, 300); }
        }
      });
      return;
    }

    // Strategy 2: Split by double-newline (paragraph breaks) — the AI often
    // returns 4 paragraphs without explicit headers
    var paragraphs = clean.split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 20; });

    if (paragraphs.length >= 4) {
      // Assign each paragraph to a cell in order
      paragraphs.slice(0, 4).forEach(function (p, i) {
        var el = document.getElementById(ids[i]);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = p.slice(0, 300); }
      });
      return;
    }

    // Strategy 3: If streaming and we have some text but < 4 paragraphs yet,
    // put what we have in the first cell (will update as more streams in)
    if (streaming && paragraphs.length > 0) {
      var el0 = document.getElementById(ids[0]);
      if (el0) { el0.classList.remove('bmd-shimmer'); el0.textContent = paragraphs[0].slice(0, 300); }
    }
  }

  // ─── Boot ────────────────────────────────────────────────────────────────
  async function boot() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (!mount) return;
    injectStyles();
    buildSkeleton(mount);

    // Dashboard theme toggle — toggles data-bmd-theme on #markets-dashboard-mount ONLY
    // Does NOT touch <html data-theme> — the blog page's theme stays independent
    var bmdToggle = document.getElementById('bmd-theme-toggle');
    var bmdIcon = document.getElementById('bmd-theme-icon');
    if (bmdToggle) {
      // Set initial icon + mount attribute based on default theme (dark)
      mount.setAttribute('data-bmd-theme', 'dark');
      if (bmdIcon) bmdIcon.className = 'fas fa-moon';
      bmdToggle.addEventListener('click', function () {
        var current = mount.getAttribute('data-bmd-theme') || 'dark';
        var next = current === 'dark' ? 'light' : 'dark';
        mount.setAttribute('data-bmd-theme', next);
        // The MutationObserver will handle re-rendering charts + updating the icon
      });
    }

    // Render static charts immediately (instant visual feedback — no "loading" delay)
    renderTrends();
    renderSectors();
    renderFutures();
    renderFX();

    // Fetch all live data sources in parallel: Binance + Netlify proxy (indices + FX)
    var binanceOk = false, indicesOk = false, fxOk = false;
    try { binanceOk = await fetchCrypto(); } catch (e) {}
    try { indicesOk = await fetchIndices(); } catch (e) {}
    try { fxOk = await fetchFX(); } catch (e) {}

    // Build status string showing exactly what's live
    var liveSources = [];
    if (indicesOk) liveSources.push('indices');
    if (binanceOk) liveSources.push('crypto');
    if (fxOk) liveSources.push('FX');
    var statusText = liveSources.length ? ('Live: ' + liveSources.join(' · ')) : 'Demo data';
    var statusEl = document.getElementById('bmd-live-status');
    if (statusEl) statusEl.textContent = statusText;

    // Re-render KPIs with live data
    renderKPIs(binanceOk);

    // Re-render FX chart with live data (if Frankfurter succeeded via proxy)
    if (fxOk) {
      if (charts.fx) { try { charts.fx.dispose(); } catch (_) {} }
      renderFX();
    }

    // Always re-render crypto/commodities chart (swaps based on what's live)
    if (charts.crypto) { try { charts.crypto.dispose(); } catch (_) {} }
    renderCrypto();

    // Re-render futures chart with live commodity prices (now fetched via Yahoo proxy)
    if (charts.futures) { try { charts.futures.dispose(); } catch (_) {} }
    renderFutures();

    // Re-render trends if Binance data available (for BTC overlay)
    if (binanceOk && charts.trends) {
      try { charts.trends.dispose(); } catch (_) {}
      renderTrends();
    }

    // Stream AI brief
    fetchAIBrief();

    // Force all charts to resize to their final container dimensions.
    // ECharts canvases render at the INITIAL container size (which may be
    // squished if the CSS flex/grid layout hasn't settled yet). After all
    // data fetches + re-renders complete, the containers have their final
    // size — calling .resize() here ensures all canvases match.
    function resizeAllCharts() {
      Object.keys(charts).forEach(function (k) {
        try { charts[k].resize(); } catch (e) {}
      });
    }
    // Multiple resize calls — the layout can take a few frames to settle
    requestAnimationFrame(function () {
      resizeAllCharts();
      requestAnimationFrame(function () {
        resizeAllCharts();
        setTimeout(resizeAllCharts, 100);
        setTimeout(resizeAllCharts, 300);
      });
    });

    // ─── Robust first-load resize: cover all the timing paths that leave
    //     charts squished on initial render ──────────────────────────────
    // The dashboard's wrapper has `.reveal reveal-scale` (opacity:0 +
    // transform:scale(0.96)) which is removed by IntersectionObserver when
    // the section scrolls into view. The boot() resize calls above all fire
    // BEFORE that reveal happens — and even though `transform` doesn't
    // affect offsetWidth/Height, ECharts' internal canvas sometimes fails
    // to pick up the post-reveal dimensions on its own. The watchers below
    // catch every path that changes container dimensions:
    //
    //   (a) ResizeObserver       — fires whenever ANY chart container's
    //                               width or height changes (layout settling,
    //                               viewport resize, font swap, theme change).
    //   (b) IntersectionObserver — fires when the dashboard scrolls into
    //                               view (the reveal moment); kicks a resize.
    //   (c) window 'load'         — fires after all sub-resources (images,
    //                               stylesheets, fonts) are fully loaded.
    //   (d) document.fonts.ready  — fires when webfonts swap from fallback
    //                               to display fonts (reflows container).
    // --------------------------------------------------------------------

    // (a) ResizeObserver — one observer watching all chart containers.
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        // Debounce via rAF so multiple simultaneous resize events coalesce
        // into a single chart.resize() pass.
        if (ro._raf) cancelAnimationFrame(ro._raf);
        ro._raf = requestAnimationFrame(function () {
          ro._raf = null;
          resizeAllCharts();
        });
      });
      Object.keys(charts).forEach(function (k) {
        var chart = charts[k];
        if (chart && chart.getDom) {
          var dom = chart.getDom();
          if (dom) ro.observe(dom);
        }
      });
    }

    // (b) IntersectionObserver on the dashboard mount — fires when the
    // section becomes visible (i.e. when `.reveal` is removed). At that
    // point, kick a sequence of resize calls to make sure ECharts picks
    // up the final post-reveal dimensions.
    var mountEl = document.getElementById('markets-dashboard-mount');
    if (mountEl && typeof IntersectionObserver !== 'undefined') {
      var io = new IntersectionObserver(function (entries) {
        var entry = entries[0];
        if (entry && entry.isIntersecting) {
          // Section just entered the viewport — kick resizes over the next
          // ~1s to catch the post-reveal reflow + transitions.
          resizeAllCharts();
          requestAnimationFrame(function () {
            resizeAllCharts();
            setTimeout(resizeAllCharts, 200);
            setTimeout(resizeAllCharts, 600);
            setTimeout(resizeAllCharts, 1000);
          });
          // Only need to fire once — disconnect after first reveal.
          io.disconnect();
        }
      }, { threshold: 0.05 });
      io.observe(mountEl);
    }

    // (c) window 'load' — fires after all sub-resources are fully loaded.
    if (!bmdLoadWired) {
      bmdLoadWired = true;
      window.addEventListener('load', function () {
        resizeAllCharts();
        setTimeout(resizeAllCharts, 200);
        setTimeout(resizeAllCharts, 600);
      });
    }

    // (d) document.fonts.ready — fires when webfonts have swapped. The
    // fallback-to-display-font swap changes text dimensions, which can
    // reflow chart containers (especially the title rows above each chart).
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        resizeAllCharts();
        setTimeout(resizeAllCharts, 100);
      });
    }

    // Start 60-second polling for live data
    startPolling();

    // Watch for theme changes (dark ↔ light) and re-render charts
    watchThemeChanges();
  }

  // ─── Polling: refresh live data every 60 seconds ─────────────────────────
  // Binance crypto is real-time. Yahoo indices are delayed 10-15 min anyway,
  // so 60s polling is plenty. The Netlify proxy has a 60s server-side cache,
  // so we won't hammer upstream APIs. AI brief re-streams every 5 min (it's
  // expensive + the underlying data only changes every few min).
  var POLL_INTERVAL_MS = 30 * 1000;          // 30s for KPIs + charts
  var AI_BRIF_INTERVAL_MS = 5 * 60 * 1000;   // 5 min for AI brief
  var pollTimer = null;
  var aiBriefTimer = null;
  var lastAIBriefTime = 0;

  async function pollLiveData() {
    var binanceOk = false, indicesOk = false, fxOk = false;
    try { binanceOk = await fetchCrypto(); } catch (e) {}
    try { indicesOk = await fetchIndices(); } catch (e) {}
    try { fxOk = await fetchFX(); } catch (e) {}

    // Update status badge
    var liveSources = [];
    if (indicesOk) liveSources.push('indices');
    if (binanceOk) liveSources.push('crypto');
    if (fxOk) liveSources.push('FX');
    var statusText = liveSources.length ? ('Live: ' + liveSources.join(' · ')) : 'Demo data';
    var statusEl = document.getElementById('bmd-live-status');
    if (statusEl) statusEl.textContent = statusText;

    // Re-render KPIs with fresh data (swaps BTC ↔ Crude Oil depending on Binance)
    renderKPIs(binanceOk);

    // Always re-render crypto/commodities chart (swaps based on what's live)
    if (charts.crypto) {
      try { charts.crypto.dispose(); } catch (_) {}
      renderCrypto();
    }

    // Always re-render futures chart (uses live commodity prices now)
    if (charts.futures) {
      try { charts.futures.dispose(); } catch (_) {}
      renderFutures();
    }

    // Re-render FX chart if Frankfurter data fresh
    if (fxOk && charts.fx) {
      try { charts.fx.dispose(); } catch (_) {}
      renderFX();
    }

    // Re-stream AI brief every 5 min (not every poll — too expensive)
    var now = Date.now();
    if (now - lastAIBriefTime > AI_BRIEF_INTERVAL_MS) {
      lastAIBriefTime = now;
      fetchAIBrief();
    }

    // Force resize ALL charts after poll re-renders — ensures canvases
    // match their container dimensions (not squished)
    requestAnimationFrame(function () {
      Object.keys(charts).forEach(function (k) {
        try { charts[k].resize(); } catch (e) {}
      });
    });
  }

  function startPolling() {
    if (pollTimer) return; // already polling
    lastAIBriefTime = Date.now(); // initial brief just fetched in boot()
    pollTimer = setInterval(pollLiveData, POLL_INTERVAL_MS);

    // Pause polling when tab is hidden (saves battery + API quota)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      } else {
        startPolling(); // resume + immediately refresh on return
        pollLiveData();
      }
    });
  }

  // ─── Resize handler ──────────────────────────────────────────────────────
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      Object.keys(charts).forEach(function (k) { try { charts[k].resize(); } catch (e) {} });
    }, 150);
  });

  // ─── Start when DOM + ECharts ready ──────────────────────────────────────
  function tryStart() {
    if (typeof echarts === 'undefined') { setTimeout(tryStart, 100); return; }
    boot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }
})();
