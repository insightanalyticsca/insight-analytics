/* ════════════════════════════════════════════════════════════════════════════
   exec-dashboard-inline.js — Inline renderer for the executive dashboard
   showcase on the marketing site.

   Pattern: same as markets-dashboard — NO IFRAME, NO service worker, NO
   cross-origin issues. Direct fetch() to the dashboard's JSON data,
   ECharts renders directly into divs on the page. Works on every browser
   including iOS Safari + PWA where iframe-based loading was stalling.

   Dashboards:
     - chatters  → Executive Operating (markets)
     - payments  → Customer Payments (finance)
     - ebill     → eBill Performance

   Chart kinds supported: pie, donut, bar, line, combo, heatmap
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const DATA_BASE = './dashboards-preview/data/executive/';
  const charts = new Map(); // id → ECharts instance, for resize-on-switch

  // Format helpers
  function fmtValue(v, format) {
    if (v == null || isNaN(v)) return '—';
    if (format === 'currency') {
      if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
      return '$' + v.toFixed(0);
    }
    if (format === 'compact') {
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return v.toLocaleString('en-US');
    }
    if (format === 'percent') return (v * 100).toFixed(1) + '%';
    if (format === 'bps') return (v * 10000).toFixed(0) + 'bps';
    return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }

  function fmtDelta(v, mode, positiveIsGood) {
    if (v == null) return { text: '—', cls: '' };
    const sign = v >= 0 ? '+' : '';
    const text = mode === 'percent'
      ? sign + v.toFixed(1) + '%'
      : sign + v.toLocaleString('en-US', { maximumFractionDigits: 1 });
    // positiveIsGood determines whether + is "good" (green) or "bad" (red)
    const isGood = positiveIsGood ? v >= 0 : v < 0;
    return { text: text, cls: isGood ? 'up' : 'down' };
  }

  // ─── Render metrics row ─────────────────────────────────────────────────
  function renderMetrics(metrics, container) {
    const html = metrics.map(m => {
      const val = fmtValue(m.value, m.format);
      const mom = fmtDelta(m.mom, m.deltaMode, m.positiveIsGood !== false);
      const yoy = fmtDelta(m.yoy, m.deltaMode, m.positiveIsGood !== false);
      return `
        <div class="exec-metric">
          <div class="exec-metric-label">${m.label}</div>
          <div class="exec-metric-value">${val}</div>
          <div class="exec-metric-period">${m.period || ''}</div>
          <div class="exec-metric-deltas">
            <span class="exec-delta ${mom.cls}">${(m.momLabel || 'MoM')}: ${mom.text}</span>
            <span class="exec-delta ${yoy.cls}">${(m.yoyLabel || 'YoY')}: ${yoy.text}</span>
          </div>
        </div>`;
    }).join('');
    container.innerHTML = html;
  }

  // ─── Render a single chart ──────────────────────────────────────────────
  function renderChart(chart, container) {
    const card = document.createElement('div');
    card.className = 'exec-chart-card exec-width-' + (chart.width || 'half');
    card.innerHTML = `<div class="exec-chart-title">${chart.title}</div><div class="exec-chart-body" id="exec-chart-${chart.id}"></div>`;
    container.appendChild(card);

    const el = card.querySelector('.exec-chart-body');
    const chart_inst = echarts.init(el, null, { renderer: 'canvas' });
    charts.set(chart.id, chart_inst);

    const opt = buildChartOption(chart);
    chart_inst.setOption(opt);
  }

  // ─── Build ECharts option from the dashboard chart spec ─────────────────
  function buildChartOption(c) {
    const cats = c.categories || [];
    const series = c.series || [];

    // PIE / DONUT
    if (c.kind === 'pie' || c.kind === 'donut') {
      const data = cats.map((cat, i) => ({
        name: cat,
        value: series[0] ? series[0].data[i] : 0
      }));
      return {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { bottom: 0, textStyle: { color: '#94a3b8', fontSize: 10 }, type: 'scroll' },
        series: [{
          type: 'pie',
          radius: c.kind === 'donut' ? ['42%', '70%'] : '70%',
          center: ['50%', '45%'],
          data: data,
          label: { color: '#cbd5e1', fontSize: 10 },
          labelLine: { length: 8, length2: 6 }
        }],
        color: ['#0b5b72', '#22d3ee', '#a3e635', '#4c6fff', '#fbbf24', '#f87171']
      };
    }

    // HEATMAP
    if (c.kind === 'heatmap') {
      // series[0].data is array of [x, y, value] triples
      const data = (series[0] && series[0].data) || [];
      // Derive x-categories and y-categories from the data
      const xCats = [];
      const yCats = [];
      data.forEach(row => {
        if (xCats.indexOf(row[0]) === -1) xCats.push(row[0]);
        if (yCats.indexOf(row[1]) === -1) yCats.push(row[1]);
      });
      // Re-map data with indices
      const mapped = data.map(row => [xCats.indexOf(row[0]), yCats.indexOf(row[1]), row[2]]);
      return {
        backgroundColor: 'transparent',
        tooltip: { formatter: p => `${yCats[p.value[1]]} ${xCats[p.value[0]]}: ${p.value[2]}%` },
        grid: { left: 60, right: 20, top: 10, bottom: 30 },
        xAxis: { type: 'category', data: xCats, axisLabel: { color: '#94a3b8', fontSize: 9 } },
        yAxis: { type: 'category', data: yCats, axisLabel: { color: '#94a3b8', fontSize: 9 } },
        visualMap: {
          min: 0, max: 100, calculable: false, show: true,
          orient: 'horizontal', bottom: 0, left: 'center',
          textStyle: { color: '#94a3b8', fontSize: 9 },
          inRange: { color: ['#1e3a5f', '#22d3ee', '#a3e635'] }
        },
        series: [{
          type: 'heatmap', data: mapped,
          label: { show: true, color: '#0f172a', fontSize: 9, formatter: p => p.value[2] + '%' },
          itemStyle: { borderColor: '#0a0e1a', borderWidth: 1 }
        }]
      };
    }

    // Default: bar / line / combo (axis-based charts)
    const isCombo = c.kind === 'combo';
    const yLeft = { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 9 } };
    const yRight = isCombo ? { type: 'value', axisLabel: { color: '#94a3b8', fontSize: 9 }, position: 'right' } : null;

    const series_out = series.map((s, i) => {
      const type = s.type === 'bar' ? 'bar' : 'line';
      // If combo and axis === 'right', use y-index 1
      const yAxisIndex = (isCombo && s.axis === 'right') ? 1 : 0;
      return {
        name: s.name,
        type: type,
        data: s.data,
        yAxisIndex: yAxisIndex,
        smooth: !!s.smooth,
        symbol: type === 'line' ? 'none' : undefined,
        itemStyle: s.color ? { color: s.color } : undefined,
        lineStyle: s.color ? { color: s.color, width: 2 } : { width: 2 },
        barGap: '10%'
      };
    });

    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: series.length > 1 ? {
        data: series.map(s => s.name),
        textStyle: { color: '#94a3b8', fontSize: 10 },
        top: 0
      } : undefined,
      grid: { left: 50, right: isCombo ? 50 : 20, top: 25, bottom: 30 },
      xAxis: { type: 'category', data: cats, axisLabel: { color: '#94a3b8', fontSize: 9 } },
      yAxis: isCombo ? [yLeft, yRight] : yLeft,
      series: series_out,
      color: ['#0b5b72', '#22d3ee', '#a3e635', '#4c6fff', '#fbbf24']
    };
  }

  // ─── Render the AI brief notes ──────────────────────────────────────────
  function renderNotes(notes, container) {
    if (!notes || !notes.length) { container.innerHTML = ''; return; }
    const labels = ['What happened', 'Why', 'What to expect', 'What to do'];
    const html = notes.map((n, i) => {
      const label = labels[i] || ('Note ' + (i + 1));
      return `
        <div class="exec-note">
          <div class="exec-note-label">${label}</div>
          <div class="exec-note-body">${n}</div>
        </div>`;
    }).join('');
    container.innerHTML = html;
  }

  // ─── Public API: load a dashboard by suite key ──────────────────────────
  async function loadDashboard(suite) {
    const mount = document.getElementById('exec-dashboard-mount');
    if (!mount) return;
    mount.innerHTML = '<div class="exec-loading">Loading dashboard…</div>';

    try {
      const url = DATA_BASE + suite + '.json';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      // Dispose existing chart instances
      charts.forEach(c => { try { c.dispose(); } catch (_) {} });
      charts.clear();

      // Build the layout
      mount.innerHTML = `
        <div class="exec-page">
          <div class="exec-header">
            <h3 class="exec-title">${data.title}</h3>
            <span class="exec-asof">${data.asOfLabel || ''}</span>
          </div>
          <div class="exec-metrics" id="exec-metrics"></div>
          <div class="exec-charts" id="exec-charts"></div>
          <div class="exec-ai-brief">
            <div class="exec-ai-brief-head">
              <i class="fas fa-robot"></i>
              <span>AI Brief — auto-generated from this dashboard's data</span>
            </div>
            <div class="exec-notes" id="exec-notes"></div>
          </div>
        </div>`;

      renderMetrics(data.metrics || [], mount.querySelector('#exec-metrics'));
      const chartsContainer = mount.querySelector('#exec-charts');
      (data.charts || []).forEach(c => renderChart(c, chartsContainer));
      renderNotes(data.notes || [], mount.querySelector('#exec-notes'));

      // Resize charts after layout settles
      setTimeout(() => {
        charts.forEach(c => { try { c.resize(); } catch (_) {} });
      }, 100);

      // Update the masked URL bar
      const urlBar = document.getElementById('browser-url-text');
      if (urlBar) {
        const map = {
          'chatters': 'insight-analytics.ca/dashboards/executive-operating',
          'payments': 'insight-analytics.ca/dashboards/customer-payments',
          'ebill': 'insight-analytics.ca/dashboards/ebill-performance'
        };
        urlBar.textContent = map[suite] || 'insight-analytics.ca/dashboards/executive-operating';
      }

      // Update the "Open live dashboard" link
      const live = document.getElementById('browserFallback');
      if (live) {
        const liveMap = {
          'chatters': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-chatters-portfolio.html',
          'payments': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-customer-payments.html',
          'ebill': 'https://insightanalyticsca.github.io/dashboards/custom-html/executive-ebill-performance.html'
        };
        live.setAttribute('href', liveMap[suite]);
      }
    } catch (err) {
      mount.innerHTML = '<div class="exec-error">Dashboard data failed to load: ' + (err.message || err) + '</div>';
    }
  }

  // Expose the loader globally
  window.loadExecDashboard = loadDashboard;

  // Resize all charts on window resize
  let resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      charts.forEach(c => { try { c.resize(); } catch (_) {} });
    }, 150);
  });
})();
