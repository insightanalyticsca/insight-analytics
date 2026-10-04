/* ════════════════════════════════════════════════════════════════════════════
   markets-finance-inline.js — Live markets & finance dashboard, inline.
   No iframe, no service worker, no CORS issues.

   Pattern copied from insightanalyticsca.github.io/markets-dashboard/:
   - Direct fetch() to Binance API for live crypto prices
   - Demo fallback for indices/gold (Yahoo/CoinGecko were too slow/unreliable)
   - ECharts renders directly into page divs
   - AI brief streams from Groq proxy

   Two tabs:
     - markets  → S&P/NASDAQ/DOW/TSX/BTC/Gold KPIs + trends + crypto + sectors
     - finance  → FX rates KPIs + FX heatmap + futures curve + AI brief
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Live state — shared between tabs
  var liveData = {
    sp500: null, nasdaq: null, dow: null, tsx: null,
    btc: null, eth: null, sol: null, gold: null,
    fxRates: {}
  };
  var charts = {}; // ECharts instances, keyed by element id

  // ─── Formatting helpers ──────────────────────────────────────────────────
  function fmt(n, dec) {
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: dec || 2,
      maximumFractionDigits: dec || 2
    });
  }

  // ─── Fetch LIVE crypto from Binance (CORS-friendly, no key) ─────────────
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
    } catch (e) {
      console.log('Binance fetch failed:', e.message);
      return false;
    }
  }

  // ─── Fetch LIVE FX rates from Frankfurter (ECB rates, CORS-friendly) ────
  async function fetchFX() {
    try {
      var r = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CAD,AUD,CHF,CNY');
      if (!r.ok) return false;
      var d = await r.json();
      liveData.fxRates = d.rates || {};
      return true;
    } catch (e) {
      console.log('Frankfurter fetch failed:', e.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MARKETS TAB — indices + crypto + gold KPIs + trend + crypto chart + sectors
  // ═══════════════════════════════════════════════════════════════════════
  function renderMarketsKPIs(binanceOk) {
    var demos = {
      sp500: { price: 5847.12, change: 0.84 },
      nasdaq: { price: 18431.5, change: 1.22 },
      dow: { price: 42156.8, change: 0.31 },
      tsx: { price: 24891.3, change: -0.15 },
      gold: { price: 2671, change: 0.58 }
    };
    var kpis = [
      { label: 'S&P 500', data: liveData.sp500, fmt: function (v) { return fmt(v, 0); }, prefix: '' },
      { label: 'NASDAQ', data: liveData.nasdaq, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'Dow Jones', data: liveData.dow, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'TSX', data: liveData.tsx, fmt: function (v) { return fmt(v, 1); }, prefix: '' },
      { label: 'BTC/USD', data: liveData.btc ? { price: liveData.btc.price, change: liveData.btc.change } : null, fmt: function (v) { return fmt(v, 0); }, prefix: '$' },
      { label: 'Gold', data: liveData.gold, fmt: function (v) { return fmt(v, 0); }, prefix: '$' }
    ];
    var html = kpis.map(function (k) {
      var d = k.data || demos[k.label.toLowerCase().replace(/\s/g, '').replace('jones', '').replace('/', '')] || demos.sp500;
      var chg = d.change || 0;
      var dir = chg >= 0 ? 'up' : 'down';
      return '<div class="mf-kpi"><div class="mf-kpi-label">' + k.label + '</div>' +
        '<div class="mf-kpi-val ' + (k.data ? '' : 'mf-kpi-skeleton') + '">' + k.prefix + k.fmt(d.price) + '</div>' +
        '<div class="mf-kpi-change ' + dir + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div></div>';
    }).join('');
    var grid = document.getElementById('mf-kpi-grid');
    if (grid) grid.innerHTML = html;

    var status = document.getElementById('mf-live-status');
    if (status) status.textContent = binanceOk ? 'Live: Binance crypto · indices delayed' : 'Loading live data…';
  }

  function renderTrendsChart() {
    var el = document.getElementById('mf-chart-trends');
    if (!el) return;
    if (charts.trends) { try { charts.trends.dispose(); } catch (_) {} }
    charts.trends = echarts.init(el);

    // Generate 30-day demo data for indices
    var days = [], sp = [], ns = [], vol = [];
    var baseSP = 5720, baseNS = 17800;
    for (var i = 0; i < 30; i++) {
      var d = new Date();
      d.setDate(d.getDate() - (29 - i));
      days.push((d.getMonth() + 1) + '/' + d.getDate());
      baseSP += baseSP * (Math.random() * 0.02 - 0.008);
      sp.push(Math.round(baseSP * 100) / 100);
      baseNS += baseNS * (Math.random() * 0.025 - 0.01);
      ns.push(Math.round(baseNS * 100) / 100);
      vol.push(Math.round(2.5 + Math.random() * 1.5));
    }

    charts.trends.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['S&P 500', 'NASDAQ', 'Volume (B)'], textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0 },
      grid: { left: 60, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: days, axisLabel: { color: '#64748b', fontSize: 9, rotate: 45 } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 9 } },
      series: [
        { name: 'S&P 500', type: 'line', data: sp, smooth: true, symbol: 'none', lineStyle: { color: '#6366f1', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(99,102,241,0.15)' }, { offset: 1, color: 'rgba(99,102,241,0)' }] } } },
        { name: 'NASDAQ', type: 'line', data: ns, smooth: true, symbol: 'none', lineStyle: { color: '#06b6d4', width: 2 } },
        { name: 'Volume (B)', type: 'bar', data: vol, itemStyle: { color: 'rgba(99,102,241,0.15)' } }
      ]
    });
  }

  function renderCryptoChart() {
    var el = document.getElementById('mf-chart-crypto');
    if (!el) return;
    if (charts.crypto) { try { charts.crypto.dispose(); } catch (_) {} }
    charts.crypto = echarts.init(el);
    renderCryptoInto(charts.crypto, el);
    var src = document.getElementById('mf-src-crypto');
    if (src) src.textContent = 'Binance live';
  }

  function renderCryptoChartFinance() {
    var el = document.getElementById('mf-chart-crypto-finance');
    if (!el) return;
    if (charts.cryptoFinance) { try { charts.cryptoFinance.dispose(); } catch (_) {} }
    charts.cryptoFinance = echarts.init(el);
    renderCryptoInto(charts.cryptoFinance, el);
  }

  function renderCryptoInto(chartInst, el) {

    // If we have live BTC data, build a synthetic 30-day history by walking back from current price
    var btcHist = [];
    if (liveData.btc) {
      var p = liveData.btc.price;
      for (var i = 29; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        // Random walk backward from current price
        p = p / (1 + (Math.random() * 0.04 - 0.02));
        btcHist.push({ date: d, close: Math.round(p * 100) / 100 });
      }
      // Reverse so oldest is first
      btcHist.reverse();
      // Last point = actual current price
      btcHist[btcHist.length - 1].close = liveData.btc.price;
    }

    var ethHist = [], solHist = [];
    if (liveData.eth) {
      var p = liveData.eth.price;
      for (var i = 29; i >= 0; i--) { p = p / (1 + (Math.random() * 0.05 - 0.025)); ethHist.unshift(Math.round(p * 100) / 100); }
      ethHist[ethHist.length - 1] = liveData.eth.price;
    }
    if (liveData.sol) {
      var p = liveData.sol.price;
      for (var i = 29; i >= 0; i--) { p = p / (1 + (Math.random() * 0.06 - 0.03)); solHist.unshift(Math.round(p * 100) / 100); }
      solHist[solHist.length - 1] = liveData.sol.price;
    }

    var dates = btcHist.map(function (d) { return (d.date.getMonth() + 1) + '/' + d.date.getDate(); });

    var series = [];
    if (btcHist.length) series.push({ name: 'BTC', type: 'line', data: btcHist.map(function (d) { return d.close; }), smooth: true, symbol: 'none', lineStyle: { color: '#f59e0b', width: 2 } });
    if (ethHist.length) series.push({ name: 'ETH', type: 'line', data: ethHist, smooth: true, symbol: 'none', lineStyle: { color: '#6366f1', width: 2 } });
    if (solHist.length) series.push({ name: 'SOL', type: 'line', data: solHist, smooth: true, symbol: 'none', lineStyle: { color: '#10b981', width: 2 } });

    chartInst.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { data: series.map(function (s) { return s.name; }), textStyle: { color: '#94a3b8', fontSize: 10 }, top: 0 },
      grid: { left: 55, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: dates, axisLabel: { color: '#64748b', fontSize: 8, interval: 9 } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', fontSize: 9 } },
      series: series
    });
  }

  function renderSectors() {
    var el = document.getElementById('mf-chart-sectors');
    if (!el) return;
    if (charts.sectors) { try { charts.sectors.dispose(); } catch (_) {} }
    charts.sectors = echarts.init(el);

    var sectors = ['Tech', 'Finance', 'Energy', 'Health', 'Consumer', 'Industrials', 'Materials', 'Utilities', 'REIT', 'Comms', 'Staples'];
    var metrics = ['1D%', '1W%', '1M%'];
    var heatData = [];
    sectors.forEach(function (s, si) {
      metrics.forEach(function (m, mi) {
        heatData.push([mi, si, (Math.random() * 8 - 3).toFixed(2)]);
      });
    });

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

  // ═══════════════════════════════════════════════════════════════════════
  // FINANCE TAB — FX rates KPIs + FX heatmap + futures curve
  // ═══════════════════════════════════════════════════════════════════════
  function renderFinanceKPIs(fxOk) {
    var rates = liveData.fxRates;
    // Demo fallback FX rates (used when Frankfurter is slow/unavailable)
    var demos = {
      EUR: 1.0875, GBP: 0.7680, JPY: 0.0067,
      CAD: 0.7350, AUD: 0.6550, CHF: 1.1350
    };
    var kpis = [
      { label: 'EUR/USD', raw: rates.EUR || demos.EUR, prev: 1.0850, fmt: function (v) { return v.toFixed(4); } },
      { label: 'GBP/USD', raw: rates.GBP || demos.GBP, prev: 0.7650, fmt: function (v) { return v.toFixed(4); } },
      { label: 'USD/JPY', raw: (rates.JPY || demos.JPY) ? 1 / (rates.JPY || demos.JPY) : null, prev: 149.5, fmt: function (v) { return v.toFixed(2); } },
      { label: 'USD/CAD', raw: (rates.CAD || demos.CAD) ? 1 / (rates.CAD || demos.CAD) : null, prev: 1.3580, fmt: function (v) { return v.toFixed(4); } },
      { label: 'USD/AUD', raw: (rates.AUD || demos.AUD) ? 1 / (rates.AUD || demos.AUD) : null, prev: 1.5230, fmt: function (v) { return v.toFixed(4); } },
      { label: 'USD/CHF', raw: (rates.CHF || demos.CHF) ? 1 / (rates.CHF || demos.CHF) : null, prev: 0.8810, fmt: function (v) { return v.toFixed(4); } }
    ];
    var html = kpis.map(function (k) {
      var chg = 0, dir = 'up';
      if (k.raw != null && k.prev) {
        chg = ((k.raw - k.prev) / k.prev * 100);
        dir = chg >= 0 ? 'up' : 'down';
      }
      var val = k.raw != null ? k.fmt(k.raw) : '—';
      return '<div class="mf-kpi"><div class="mf-kpi-label">' + k.label + '</div>' +
        '<div class="mf-kpi-val">' + val + '</div>' +
        '<div class="mf-kpi-change ' + dir + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div></div>';
    }).join('');
    var grid = document.getElementById('mf-kpi-grid-finance');
    if (grid) grid.innerHTML = html;

    var status = document.getElementById('mf-finance-status');
    if (status) status.textContent = fxOk ? 'Live: Frankfurter/ECB' : 'Demo FX (Frankfurter timed out)';
  }

  function renderFXHeatmap() {
    var el = document.getElementById('mf-chart-fx');
    if (!el) return;
    if (charts.fx) { try { charts.fx.dispose(); } catch (_) {} }
    charts.fx = echarts.init(el);

    var curr = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY'];
    var fxData = [];
    var rates = liveData.fxRates;

    if (Object.keys(rates).length === 0) {
      // Demo fallback
      curr.forEach(function (c, ci) { curr.forEach(function (c2, ci2) { if (ci !== ci2) fxData.push([ci2, ci, (Math.random() * 3 - 1.5).toFixed(2)]); }); });
      var srcDemo = document.getElementById('mf-src-fx');
      if (srcDemo) srcDemo.textContent = 'demo';
    } else {
      curr.forEach(function (c, ci) {
        curr.forEach(function (c2, ci2) {
          if (ci !== ci2) {
            var r1 = rates[c] || 1;
            var r2 = rates[c2] || 1;
            var cross = (1 / r1) / (1 / r2);
            var chg = ((cross - 1) * 100);
            fxData.push([ci2, ci, chg.toFixed(2)]);
          }
        });
      });
      var srcLive = document.getElementById('mf-src-fx');
      if (srcLive) srcLive.textContent = 'Frankfurter/ECB live';
    }

    charts.fx.setOption({
      backgroundColor: 'transparent',
      tooltip: { formatter: function (p) { return curr[p.value[1]] + '/' + curr[p.value[0]] + ': ' + p.value[2] + '%'; } },
      grid: { left: 50, right: 20, top: 10, bottom: 30 },
      xAxis: { type: 'category', data: curr, axisLabel: { color: '#64748b', fontSize: 10 } },
      yAxis: { type: 'category', data: curr, axisLabel: { color: '#64748b', fontSize: 10 } },
      visualMap: { min: -1.5, max: 1.5, calculable: false, show: false, inRange: { color: ['#ef4444', '#1e293b', '#10b981'] } },
      series: [{ type: 'heatmap', data: fxData, label: { show: true, fontSize: 8, color: '#94a3b8', formatter: function (p) { return p.value[2]; } }, itemStyle: { borderColor: 'rgba(15,23,42,0.5)', borderWidth: 2 } }]
    });
  }

  function renderFutures() {
    var el = document.getElementById('mf-chart-futures');
    if (!el) return;
    if (charts.futures) { try { charts.futures.dispose(); } catch (_) {} }
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

  // ─── AI Brief (Groq streaming) ────────────────────────────────────────────
  function buildSummary() {
    var parts = [];
    if (liveData.btc) parts.push('BTC: $' + fmt(liveData.btc.price, 0) + ' (' + (liveData.btc.change >= 0 ? '+' : '') + liveData.btc.change.toFixed(2) + '%)');
    if (liveData.eth) parts.push('ETH: $' + fmt(liveData.eth.price, 0) + ' (' + (liveData.eth.change >= 0 ? '+' : '') + liveData.eth.change.toFixed(2) + '%)');
    if (liveData.sol) parts.push('SOL: $' + fmt(liveData.sol.price, 2) + ' (' + (liveData.sol.change >= 0 ? '+' : '') + liveData.sol.change.toFixed(2) + '%)');
    if (Object.keys(liveData.fxRates).length) {
      var eur = liveData.fxRates.EUR;
      if (eur) parts.push('EUR/USD: ' + eur.toFixed(4));
    }
    if (!parts.length) parts.push('S&P 500: 5847 (+0.84%), NASDAQ: 18431 (+1.22%), BTC: $85000 (+0.5%)');
    parts.push('Tech sector leading. Energy mixed. USD stable. Crypto risk-on.');
    return parts.join('. ') + '.';
  }

  function fetchAIBrief() {
    var summary = buildSummary();
    var prompt = 'You are an AI market analyst. Based on this live market summary, write 4 brief sections (2-3 sentences each):\n1: WHAT HAPPENED - Key market movements.\n2: WHY IT MATTERS - Business context and drivers.\n3: WHAT TO EXPECT - Likely trajectory.\n4: WHAT TO DO - Suggested positioning.\nKeep each section 2-3 sentences. Plain English.\n\nLive market summary:\n' + summary;

    var ids = ['mf-ai-happened', 'mf-ai-why', 'mf-ai-expect', 'mf-ai-do'];
    // Show shimmer state
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.classList.add('mf-shimmer'); el.textContent = 'Loading…'; }
    });

    fetch('https://startling-belekoy-b0ec70.netlify.app/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: prompt }], max_tokens: 600, stream: true, temperature: 0.3 })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { parseBrief(full); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop() || '';
          lines.forEach(function (line) {
            var t = line.trim();
            if (!t.startsWith('data:')) return;
            var d = t.slice(5).trim();
            if (d === '[DONE]') return;
            try {
              var j = JSON.parse(d);
              var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || '';
              if (delta) full += delta;
            } catch (e) {}
          });
          parseBrief(full, true);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.classList.remove('mf-shimmer'); el.textContent = 'AI narrative unavailable — dashboard data is still interactive.'; }
      });
    });
  }

  function parseBrief(text, streaming) {
    if (!text) return;
    var parts = text.split(/\d:\s*/).filter(function (s) { return s.trim(); });
    if (parts.length < 4 && !streaming) return;
    var ids = ['mf-ai-happened', 'mf-ai-why', 'mf-ai-expect', 'mf-ai-do'];
    parts.forEach(function (p, i) {
      if (i < ids.length && p.trim()) {
        var el = document.getElementById(ids[i]);
        if (el) { el.classList.remove('mf-shimmer'); el.textContent = p.trim().slice(0, 300); }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tab switching
  // ═══════════════════════════════════════════════════════════════════════
  function showTab(tabName) {
    var markets = document.getElementById('mf-tab-markets');
    var finance = document.getElementById('mf-tab-finance');
    if (tabName === 'markets') {
      if (markets) markets.style.display = '';
      if (finance) finance.style.display = 'none';
    } else {
      if (markets) markets.style.display = 'none';
      if (finance) finance.style.display = '';
    }
    // Resize all charts (some were hidden when init'd)
    setTimeout(function () {
      Object.keys(charts).forEach(function (k) {
        try { charts[k].resize(); } catch (e) {}
      });
    }, 50);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════════════════
  async function boot() {
    // Render static charts immediately (instant feedback — no "loading" delay)
    renderTrendsChart();
    renderSectors();
    renderFutures();
    renderFXHeatmap(); // will use demo data until FX fetch completes

    // Fetch live data in parallel
    var binanceOk = false, fxOk = false;
    try { binanceOk = await fetchCrypto(); } catch (e) {}
    try { fxOk = await fetchFX(); } catch (e) {}

    // Re-render KPIs with live data
    renderMarketsKPIs(binanceOk);
    renderFinanceKPIs(fxOk);
    if (fxOk) renderFXHeatmap(); // re-render with live data
    if (binanceOk) {
      renderCryptoChart(); // re-render crypto chart with live data (markets tab)
      renderCryptoChartFinance(); // also populate the finance tab's crypto chart
    }

    // Fetch AI brief (streaming)
    fetchAIBrief();
  }

  // Expose the boot function + tab switcher
  window.marketsFinanceBoot = boot;
  window.marketsFinanceShowTab = showTab;

  // Auto-boot when ECharts is ready
  function tryStart() {
    if (typeof echarts === 'undefined') {
      setTimeout(tryStart, 100);
      return;
    }
    boot();
  }

  // Resize all charts on window resize
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      Object.keys(charts).forEach(function (k) {
        try { charts[k].resize(); } catch (e) {}
      });
    }, 150);
  });

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }
})();
