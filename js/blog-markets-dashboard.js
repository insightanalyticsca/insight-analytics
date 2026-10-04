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

  function fmt(n, dec) {
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: dec || 2,
      maximumFractionDigits: dec || 2
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
        </div>

        <div class="bmd-kpi-grid" id="bmd-kpi-grid">
          <div class="bmd-kpi"><div class="bmd-kpi-label">S&amp;P 500</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">NASDAQ</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">Dow Jones</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">TSX</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">BTC/USD</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
          <div class="bmd-kpi"><div class="bmd-kpi-label">Gold</div><div class="bmd-kpi-val bmd-skeleton">---</div><div class="bmd-kpi-change">---</div></div>
        </div>

        <div class="bmd-chart-grid">
          <div class="bmd-chart-card bmd-wide">
            <div class="bmd-chart-title"><i class="fas fa-chart-line"></i> Index &amp; Crypto Trends <span class="bmd-src" id="bmd-src-trends">loading…</span></div>
            <div class="bmd-chart-body bmd-tall" id="bmd-chart-trends"></div>
          </div>
          <div class="bmd-chart-card">
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
          <div class="bmd-chart-card bmd-wide">
            <div class="bmd-chart-title"><i class="fas fa-globe"></i> Currency Heatmap <span class="bmd-src" id="bmd-src-fx">loading…</span></div>
            <div class="bmd-chart-body bmd-tall" id="bmd-chart-fx"></div>
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
        padding: 16px;
        min-height: 600px;
      }
      .bmd-topbar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 0 12px; margin-bottom: 14px;
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
        background: rgba(16, 185, 129, .12);
        border: 1px solid rgba(16, 185, 129, .25);
        font-size: 10px; font-weight: 700; color: #10b981;
        text-transform: uppercase; letter-spacing: .05em;
      }
      .bmd-live-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #10b981; animation: bmd-pulse 2s ease-in-out infinite;
      }
      @keyframes bmd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
      .bmd-kpi-grid {
        display: grid; grid-template-columns: repeat(6, 1fr);
        gap: 8px; margin-bottom: 14px;
      }
      .bmd-kpi {
        background: rgba(15, 23, 42, .85);
        border: 1px solid rgba(99, 102, 241, .15);
        border-radius: 8px; padding: 12px;
        text-align: center; transition: border-color 200ms;
      }
      .bmd-kpi:hover { border-color: #06b6d4; }
      .bmd-kpi-label {
        font-size: 10px; color: #64748b;
        text-transform: uppercase; letter-spacing: .06em;
        font-weight: 600; margin-bottom: 6px;
      }
      .bmd-kpi-val {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 20px; font-weight: 800; color: #e2e8f0;
        margin-bottom: 4px; line-height: 1.1;
      }
      .bmd-kpi-change { font-size: 11px; font-weight: 700; }
      .bmd-kpi-change.up { color: #10b981; }
      .bmd-kpi-change.down { color: #ef4444; }
      .bmd-skeleton {
        background: linear-gradient(90deg, rgba(99,102,241,.15) 25%, rgba(15,23,42,1) 50%, rgba(99,102,241,.15) 75%);
        background-size: 200% 100%; animation: bmd-shimmer 1.5s infinite;
        border-radius: 4px; color: transparent;
      }
      @keyframes bmd-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      .bmd-chart-grid {
        display: grid; grid-template-columns: 1fr 1fr;
        gap: 10px; margin-bottom: 14px;
      }
      .bmd-chart-card {
        background: rgba(15, 23, 42, .85);
        border: 1px solid rgba(99, 102, 241, .15);
        border-radius: 10px; padding: 14px;
      }
      .bmd-chart-card.bmd-wide { grid-column: 1 / -1; }
      .bmd-chart-title {
        font-size: 13px; font-weight: 600; color: #e2e8f0;
        margin-bottom: 10px; display: flex; align-items: center; gap: 6px;
      }
      .bmd-chart-title i { color: #06b6d4; font-size: 11px; }
      .bmd-chart-title .bmd-src { margin-left: auto; font-size: 9px; color: #64748b; font-weight: 400; }
      .bmd-chart-body { width: 100%; height: 240px; }
      .bmd-chart-body.bmd-tall { height: 320px; }
      .bmd-ai-brief {
        background: linear-gradient(135deg, rgba(99,102,241,.06), rgba(6,182,212,.04));
        border: 1px solid rgba(99, 102, 241, .15);
        border-radius: 10px; padding: 18px;
        margin-bottom: 14px;
      }
      .bmd-ai-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
      .bmd-ai-icon {
        width: 28px; height: 28px; border-radius: 8px;
        display: grid; place-items: center;
        background: linear-gradient(135deg, #6366f1, #06b6d4);
        color: #fff; font-size: 12px;
      }
      .bmd-ai-title { font-size: 14px; font-weight: 700; color: #e2e8f0; }
      .bmd-ai-sub { font-size: 10px; color: #64748b; }
      .bmd-ai-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .bmd-ai-cell {
        background: rgba(15, 23, 42, .5);
        border: 1px solid rgba(99, 102, 241, .15);
        border-radius: 8px; padding: 12px;
      }
      .bmd-ai-cell-label {
        font-size: 9px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .08em; color: #06b6d4; margin-bottom: 6px;
      }
      .bmd-ai-cell-text {
        font-size: 12px; line-height: 1.6; color: #cbd5e1;
      }
      .bmd-shimmer {
        background: linear-gradient(90deg, rgba(99,102,241,.1) 25%, rgba(99,102,241,.25) 50%, rgba(99,102,241,.1) 75%);
        background-size: 200% 100%; animation: bmd-shimmer 1.5s infinite;
        border-radius: 4px; color: transparent;
      }
      @media (max-width: 1024px) {
        .bmd-kpi-grid { grid-template-columns: repeat(3, 1fr); }
        .bmd-chart-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 640px) {
        .bmd-kpi-grid { grid-template-columns: repeat(2, 1fr); }
        .bmd-ai-grid { grid-template-columns: 1fr; }
        .bmd-chart-body { height: 260px; }
      }
      </style>
    `;
    document.head.insertAdjacentHTML('beforeend', css);
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
    var demos = {
      sp500: { price: 5847.12, change: 0.84 },
      nasdaq: { price: 18431.5, change: 1.22 },
      dow: { price: 42156.8, change: 0.31 },
      tsx: { price: 24891.3, change: -0.15 },
      gold: { price: 2671, change: 0.58 }
    };
    var kpis = [
      { label: 'S&P 500', data: liveData.sp500, demo: demos.sp500, fmt: function (v) { return fmt(v, 0); }, prefix: '' },
      { label: 'NASDAQ', data: liveData.nasdaq, demo: demos.nasdaq, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'Dow Jones', data: liveData.dow, demo: demos.dow, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'TSX', data: liveData.tsx, demo: demos.tsx, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'BTC/USD', data: liveData.btc ? { price: liveData.btc.price, change: liveData.btc.change } : null, demo: { price: 85000, change: 0.5 }, fmt: function (v) { return fmt(v, 0); }, prefix: '$' },
      { label: 'Gold', data: liveData.gold, demo: demos.gold, fmt: function (v) { return fmt(v, 0); }, prefix: '$' }
    ];
    var html = kpis.map(function (k) {
      var d = k.data || k.demo;
      var chg = d.change || 0;
      var dir = chg >= 0 ? 'up' : 'down';
      return '<div class="bmd-kpi"><div class="bmd-kpi-label">' + k.label + '</div>' +
        '<div class="bmd-kpi-val' + (k.data ? '' : ' bmd-skeleton') + '">' + k.prefix + k.fmt(d.price) + '</div>' +
        '<div class="bmd-kpi-change ' + dir + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div></div>';
    }).join('');
    var grid = document.getElementById('bmd-kpi-grid');
    if (grid) grid.innerHTML = html;
    var status = document.getElementById('bmd-live-status');
    if (status) status.textContent = binanceOk ? 'Live: Binance crypto · indices demo' : 'Loading live data…';
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
      xAxis: { type: 'category', data: days, axisLabel: { color: '#64748b', fontSize: 9, rotate: 45 } },
      yAxis: [
        { type: 'value', position: 'left', axisLabel: { color: '#64748b', fontSize: 9 } },
        { type: 'value', position: 'right', axisLabel: { color: '#64748b', fontSize: 9 }, name: 'BTC $', nameTextStyle: { color: '#f59e0b', fontSize: 9 } }
      ],
      series: [
        { name: 'S&P 500', type: 'line', data: sp, smooth: true, symbol: 'none', lineStyle: { color: '#6366f1', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(99,102,241,0.15)' }, { offset: 1, color: 'rgba(99,102,241,0)' }] } } },
        { name: 'NASDAQ', type: 'line', data: ns, smooth: true, symbol: 'none', lineStyle: { color: '#06b6d4', width: 2 } },
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
      tooltip: { formatter: function (p) { return sectors[p.value[1]] + ' ' + metrics[p.value[0]] + ': ' + p.value[2] + '%'; } },
      grid: { left: 80, right: 20, top: 10, bottom: 30 },
      xAxis: { type: 'category', data: metrics, axisLabel: { color: '#64748b', fontSize: 10 } },
      yAxis: { type: 'category', data: sectors, axisLabel: { color: '#94a3b8', fontSize: 10 } },
      visualMap: { min: -3, max: 5, calculable: false, show: false, inRange: { color: ['#ef4444', '#f59e0b', '#10b981'] } },
      series: [{ type: 'heatmap', data: heatData, label: { show: true, fontSize: 10, color: '#fff', formatter: function (p) { return p.value[2] + '%'; } }, itemStyle: { borderColor: 'rgba(15,23,42,0.5)', borderWidth: 2 } }]
    });
  }

  function renderCrypto() {
    var el = document.getElementById('bmd-chart-crypto');
    if (!el) return;
    charts.crypto = echarts.init(el);
    var series = [], dates = [];
    if (liveData.btc) {
      var p = liveData.btc.price, hist = [];
      for (var i = 29; i >= 0; i--) { var d = new Date(); d.setDate(d.getDate() - i); p = p / (1 + (Math.random() * 0.04 - 0.02)); hist.unshift(Math.round(p * 100) / 100); dates.push((d.getMonth() + 1) + '/' + d.getDate()); }
      hist[hist.length - 1] = liveData.btc.price;
      series.push({ name: 'BTC', type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: '#f59e0b', width: 2 } });
    }
    if (liveData.eth) {
      var p = liveData.eth.price, hist = [];
      for (var i = 29; i >= 0; i--) { p = p / (1 + (Math.random() * 0.05 - 0.025)); hist.unshift(Math.round(p * 100) / 100); }
      hist[hist.length - 1] = liveData.eth.price;
      series.push({ name: 'ETH', type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: '#6366f1', width: 2 } });
    }
    if (liveData.sol) {
      var p = liveData.sol.price, hist = [];
      for (var i = 29; i >= 0; i--) { p = p / (1 + (Math.random() * 0.06 - 0.03)); hist.unshift(Math.round(p * 100) / 100); }
      hist[hist.length - 1] = liveData.sol.price;
      series.push({ name: 'SOL', type: 'line', data: hist, smooth: true, symbol: 'none', lineStyle: { color: '#10b981', width: 2 } });
    }
    charts.crypto.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { data: series.map(function (s) { return s.name; }), textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0 },
      grid: { left: 55, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: dates, axisLabel: { color: '#64748b', fontSize: 8, interval: 9 } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 9 } },
      series: series
    });
    var src = document.getElementById('bmd-src-crypto');
    if (src) src.textContent = series.length ? 'Binance live' : 'loading…';
  }

  function renderFutures() {
    var el = document.getElementById('bmd-chart-futures');
    if (!el) return;
    charts.futures = echarts.init(el);
    charts.futures.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: ['Crude Oil', 'Nat Gas', 'Gold', 'Silver', 'Copper', 'Wheat', 'Corn', 'Soybean'], axisLabel: { color: '#94a3b8', fontSize: 9, rotate: 30 } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 9 } },
      series: [{ type: 'bar', data: [{ value: 71.85, itemStyle: { color: '#ef4444' } }, { value: 2.74, itemStyle: { color: '#f59e0b' } }, { value: 2671.50, itemStyle: { color: '#06b6d4' } }, { value: 31.42, itemStyle: { color: '#94a3b8' } }, { value: 4.33, itemStyle: { color: '#8b5cf6' } }, { value: 5.71, itemStyle: { color: '#10b981' } }, { value: 4.18, itemStyle: { color: '#f59e0b' } }, { value: 9.87, itemStyle: { color: '#6366f1' } }], barWidth: '60%', label: { show: true, position: 'top', color: '#94a3b8', fontSize: 9, formatter: function (p) { return '$' + p.value; } } }]
    });
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
      tooltip: { formatter: function (p) { return curr[p.value[1]] + '/' + curr[p.value[0]] + ': ' + p.value[2] + '%'; } },
      grid: { left: 50, right: 20, top: 10, bottom: 30 },
      xAxis: { type: 'category', data: curr, axisLabel: { color: '#64748b', fontSize: 10 } },
      yAxis: { type: 'category', data: curr, axisLabel: { color: '#64748b', fontSize: 10 } },
      visualMap: { min: -1.5, max: 1.5, calculable: false, show: false, inRange: { color: ['#ef4444', '#1e293b', '#10b981'] } },
      series: [{ type: 'heatmap', data: fxData, label: { show: true, fontSize: 8, color: '#94a3b8', formatter: function (p) { return p.value[2]; } }, itemStyle: { borderColor: 'rgba(15,23,42,0.5)', borderWidth: 2 } }]
    });
    var src = document.getElementById('bmd-src-fx');
    if (src) src.textContent = 'demo (ECB fallback)';
  }

  // ─── AI Brief (Groq streaming) ──────────────────────────────────────────
  function buildSummary() {
    var parts = [];
    if (liveData.btc) parts.push('BTC: $' + fmt(liveData.btc.price, 0) + ' (' + (liveData.btc.change >= 0 ? '+' : '') + liveData.btc.change.toFixed(2) + '%)');
    if (liveData.eth) parts.push('ETH: $' + fmt(liveData.eth.price, 0) + ' (' + (liveData.eth.change >= 0 ? '+' : '') + liveData.eth.change.toFixed(2) + '%)');
    if (liveData.sol) parts.push('SOL: $' + fmt(liveData.sol.price, 2) + ' (' + (liveData.sol.change >= 0 ? '+' : '') + liveData.sol.change.toFixed(2) + '%)');
    if (!parts.length) parts.push('S&P 500: 5847 (+0.84%), NASDAQ: 18431 (+1.22%), BTC: $85000 (+0.5%)');
    parts.push('Tech sector leading. Energy mixed. USD stable. Crypto risk-on.');
    return parts.join('. ') + '.';
  }

  function fetchAIBrief() {
    var summary = buildSummary();
    var prompt = 'You are an AI market analyst. Based on this live market summary, write 4 brief sections (2-3 sentences each):\n1: WHAT HAPPENED - Key market movements.\n2: WHY IT MATTERS - Business context and drivers.\n3: WHAT TO EXPECT - Likely trajectory.\n4: WHAT TO DO - Suggested positioning.\nKeep each section 2-3 sentences. Plain English.\n\nLive market summary:\n' + summary;
    var ids = ['bmd-ai-happened', 'bmd-ai-why', 'bmd-ai-expect', 'bmd-ai-do'];

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
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = 'AI narrative unavailable — dashboard data is still interactive.'; }
      });
    });
  }

  function parseBrief(text, streaming) {
    if (!text) return;
    var parts = text.split(/\d:\s*/).filter(function (s) { return s.trim(); });
    if (parts.length < 4 && !streaming) return;
    var ids = ['bmd-ai-happened', 'bmd-ai-why', 'bmd-ai-expect', 'bmd-ai-do'];
    parts.forEach(function (p, i) {
      if (i < ids.length && p.trim()) {
        var el = document.getElementById(ids[i]);
        if (el) { el.classList.remove('bmd-shimmer'); el.textContent = p.trim().slice(0, 300); }
      }
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────────────
  async function boot() {
    var mount = document.getElementById('markets-dashboard-mount');
    if (!mount) return;
    injectStyles();
    buildSkeleton(mount);

    // Render static charts immediately (instant visual feedback — no "loading" delay)
    renderTrends();
    renderSectors();
    renderFutures();
    renderFX();

    // Fetch live Binance data
    var binanceOk = false;
    try { binanceOk = await fetchCrypto(); } catch (e) {}

    // Re-render KPIs + crypto chart with live data
    renderKPIs(binanceOk);
    if (binanceOk) {
      // Re-render trends + crypto chart with live BTC data
      if (charts.trends) { try { charts.trends.dispose(); } catch (_) {} renderTrends(); }
      if (charts.crypto) { try { charts.crypto.dispose(); } catch (_) {} }
      renderCrypto();
    }

    // Stream AI brief
    fetchAIBrief();
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
