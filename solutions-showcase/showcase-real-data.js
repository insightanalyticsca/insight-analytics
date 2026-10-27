/* ════════════════════════════════════════════════════════════════════════════
   showcase-real-data.js — Override generic chart data with plausible
   industry-specific data for the top 6 showcase projects.

   This file monkey-patches the showcase's hydrateVisuals() function to
   intercept chart.setOption() calls and replace the generic data
   ("Group A", "Sample B") with project-specific real data.

   The showcase's own visualOption() and baseVisualOption() are local
   functions inside an IIFE — they can't be overridden via window. So
   instead we override the ECharts instance's setOption method on
   each chart container after it's been initialized by the showcase.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Detect which project is currently open in the dialog
  function getActiveProjectId() {
    var dialog = document.getElementById('project-dialog');
    if (!dialog || !dialog.hasAttribute('open')) return null;
    var content = document.getElementById('dialog-content');
    if (!content) return null;
    // Look for the data-preview-project attribute on the mockup
    var mockup = content.querySelector('[data-preview-project]');
    return mockup ? mockup.dataset.previewProject : null;
  }

  // ─── Real data for each of the 6 priority projects ────────────────────────
  var REAL_DATA = {
    // ── CX Dashboard: call center metrics ──────────────────────────────────
    'cx-dashboard': {
      kpis: [
        { label: 'Calls Answered', value: '2,847', delta: '+12%', dir: 'up' },
        { label: 'Avg Handle Time', value: '4m 32s', delta: '-8s', dir: 'up' },
        { label: 'Abandoned Rate', value: '6.2%', delta: '-1.4%', dir: 'up' },
        { label: 'E-Bill Adoption', value: '82.5%', delta: '+3.1%', dir: 'up' },
        { label: 'SLA Compliance', value: '94.7%', delta: '+0.8%', dir: 'up' },
        { label: 'Outbound Dials', value: '1,203', delta: '+89', dir: 'up' }
      ],
      charts: {
        // Call volume by day (area chart)
        area: {
          xAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          series: [
            { name: 'Inbound', data: [412, 467, 389, 503, 445, 218, 163] },
            { name: 'Outbound', data: [198, 223, 187, 241, 214, 89, 51] }
          ]
        },
        // Call handling breakdown (bar chart)
        bar: {
          xAxis: ['<30s', '30-60s', '60-120s', '>120s', 'Abandoned'],
          series: [
            { name: 'Answered', data: [1864, 542, 298, 143, 0] },
            { name: 'Abandoned', data: [0, 0, 0, 0, 189] }
          ]
        },
        // E-Bill adoption (donut chart)
        donut: {
          data: [
            { name: 'E-Bill', value: 2812 },
            { name: 'Paper', value: 596 }
          ]
        },
        // Call volume heatmap by hour × day
        heatmap: {
          xAxis: ['6am', '8am', '10am', '12pm', '2pm', '4pm', '6pm', '8pm'],
          yAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          data: function() {
            var d = [];
            for (var day = 0; day < 6; day++) {
              for (var hr = 0; hr < 8; hr++) {
                var peak = (hr >= 2 && hr <= 5) ? 1 : 0.4;
                var weekend = (day >= 5) ? 0.5 : 1;
                var val = Math.round(15 + Math.random() * 45 * peak * weekend);
                d.push([hr, day, val]);
              }
            }
            return d;
          }
        }
      },
      // Pipeline trace
      pipeline: {
        stages: [
          { name: 'Genesys API', rows: 12450, cols: ['callId', 'direction', 'duration', 'queueTime', 'abandonedFlag'] },
          { name: 'Staging', rows: 12450, cols: ['callId', 'answered', 'handleSeconds', 'queueSeconds', 'abandoned'] },
          { name: 'Business Rules', rows: 11832, cols: ['callId', 'answered30s', 'answered60s', 'answered120s', 'abandonedCorrected'] },
          { name: 'SQL Reporting', rows: 11832, cols: ['date', 'callVolume', 'answered', 'abandoned', 'avgHandleTime'] }
        ]
      }
    },

    // ── ITS Performance: ticket SLA + uptime + security ────────────────────
    'its-performance': {
      kpis: [
        { label: 'Open Tickets', value: '147', delta: '-23', dir: 'up' },
        { label: 'MTTR', value: '2h 14m', delta: '-18m', dir: 'up' },
        { label: 'SLA Compliance', value: '96.3%', delta: '+1.2%', dir: 'up' },
        { label: 'Uptime', value: '99.94%', delta: '+0.03%', dir: 'up' }
      ],
      charts: {
        // Ticket volume trend (area)
        area: {
          xAxis: ['Wk 1', 'Wk 2', 'Wk 3', 'Wk 4', 'Wk 5', 'Wk 6', 'Wk 7', 'Wk 8'],
          series: [
            { name: 'P1 Critical', data: [3, 5, 2, 7, 4, 3, 6, 2] },
            { name: 'P2 High', data: [12, 18, 14, 22, 16, 19, 15, 11] }
          ]
        },
        // Ticket by priority (bar)
        bar: {
          xAxis: ['P1', 'P2', 'P3', 'P4', 'P5'],
          series: [
            { name: 'Open', data: [8, 34, 67, 28, 10] },
            { name: 'Closed (7d)', data: [12, 41, 89, 52, 23] }
          ]
        },
        // Security posture (radar)
        radar: {
          indicators: [
            { name: 'Phishing', max: 100 },
            { name: 'Training', max: 100 },
            { name: 'Patching', max: 100 },
            { name: 'Access Ctrl', max: 100 },
            { name: 'Incident Resp', max: 100 }
          ],
          series: [
            { name: 'Current', value: [82, 91, 76, 88, 94] },
            { name: 'Last Qtr', value: [71, 83, 68, 79, 86] }
          ]
        },
        // Uptime by service (gauge)
        gauge: { value: 99.94, name: 'Uptime (30d)' }
      },
      pipeline: {
        stages: [
          { name: 'Service Desk API', rows: 3284, cols: ['ticketId', 'priority', 'status', 'createdTime', 'resolvedTime'] },
          { name: 'SLA Engine', rows: 3284, cols: ['ticketId', 'slaTarget', 'slaBreached', 'responseMins', 'resolutionMins'] },
          { name: 'Security Feed', rows: 847, cols: ['alertId', 'severity', 'source', 'mitigated', 'mitigationTime'] },
          { name: 'Dashboard JSON', rows: 1, cols: ['openTickets', 'mttr', 'slaCompliance', 'uptime'] }
        ]
      }
    },

    // ── AI Load Forecast: weather + load regression ─────────────────────────
    'gridshare-forecast': {
      kpis: [
        { label: 'Peak Load (MW)', value: '18,420', delta: '+340', dir: 'down' },
        { label: 'Forecast Error', value: '2.1%', delta: '-0.4%', dir: 'up' },
        { label: 'Reserve Margin', value: '12.8%', delta: '+0.6%', dir: 'up' },
        { label: 'Change-Point', value: '18°C', delta: '—', dir: 'neutral' }
      ],
      charts: {
        // Load vs temperature (scatter)
        scatter: {
          series: [
            { name: 'Historical', data: Array.from({length: 30}, function(_, i) {
              var temp = -5 + i * 1.5 + Math.random() * 3;
              var load = temp < 18 ? 14000 + (18 - temp) * 280 : 14000 + (temp - 18) * 420;
              return [Math.round(temp * 10) / 10, Math.round(load + Math.random() * 800 - 400), 8 + Math.random() * 12];
            }) }
          ]
        },
        // 14-day forecast (area)
        area: {
          xAxis: Array.from({length: 14}, function(_, i) { return 'D' + (i + 1); }),
          series: [
            { name: 'Forecast', data: [16200, 17400, 18100, 18900, 17600, 16800, 17200, 18400, 19100, 17800, 16500, 15900, 16300, 17100] },
            { name: 'P95 Upper', data: [17100, 18400, 19200, 20100, 18700, 17800, 18300, 19600, 20400, 19000, 17600, 17000, 17400, 18300] }
          ]
        },
        // Temperature forecast (area)
        bar: {
          xAxis: Array.from({length: 14}, function(_, i) { return 'D' + (i + 1); }),
          series: [
            { name: 'High °C', data: [8, 12, 15, 19, 14, 10, 11, 17, 21, 15, 9, 6, 7, 11] },
            { name: 'Low °C', data: [2, 5, 7, 11, 6, 3, 4, 9, 13, 7, 2, -1, 0, 4] }
          ]
        },
        // Model coefficients (heatmap)
        heatmap: {
          xAxis: ['Temp', 'Temp²', 'Humidity', 'Wind', 'Solar', 'Hour', 'Weekday'],
          yAxis: ['Coefficient', 'P-value'],
          data: function() {
            var d = [];
            var coefs = [428.3, 12.7, -89.4, 34.2, -156.8, 847.1, -213.5];
            var pvals = [0.001, 0.003, 0.012, 0.089, 0.005, 0.000, 0.021];
            for (var i = 0; i < 7; i++) {
              d.push([i, 0, Math.abs(coefs[i])]);
              d.push([i, 1, 1 - pvals[i]]);
            }
            return d;
          }
        }
      },
      pipeline: {
        stages: [
          { name: 'Open-Meteo API', rows: 8760, cols: ['timestamp', 'tempC', 'humidity', 'windMs', 'solarRad', 'precip'] },
          { name: 'Feature Engine', rows: 8760, cols: ['hour', 'weekday', 'tempC', 'tempSquared', 'hdh', 'cdh', 'lag24h'] },
          { name: 'OLS Regression', rows: 1, cols: ['intercept', 'tempCoef', 'temp2Coef', 'humidityCoef', 'windCoef', 'solarCoef', 'R²=0.94'] },
          { name: 'Forecast', rows: 336, cols: ['timestamp', 'predictedMW', 'p80Upper', 'p95Upper', 'riskLevel'] }
        ]
      }
    },

    // ── Arrears Reporting: AR aging ─────────────────────────────────────────
    'arrears-reporting': {
      kpis: [
        { label: 'Total AR', value: '$12.4M', delta: '+$340K', dir: 'down' },
        { label: 'Current %', value: '68.2%', delta: '-1.8%', dir: 'down' },
        { label: '30+ Days', value: '$2.1M', delta: '+$180K', dir: 'down' },
        { label: '90+ Days', value: '$847K', delta: '+$92K', dir: 'down' },
        { label: 'Collections', value: '$1.8M', delta: '+$210K', dir: 'up' },
        { label: 'Recovery Rate', value: '44.1%', delta: '+2.3%', dir: 'up' }
      ],
      charts: {
        // AR aging buckets (stacked bar)
        bar: {
          xAxis: ['Residential', 'Commercial', 'Industrial', 'Agricultural', 'Other'],
          series: [
            { name: 'Current', data: [3200, 2800, 1900, 420, 180] },
            { name: '1-30', data: [680, 520, 340, 89, 42] },
            { name: '31-60', data: [320, 410, 180, 56, 28] },
            { name: '61-90', data: [180, 280, 120, 34, 15] },
            { name: '90+', data: [140, 220, 89, 21, 12] }
          ]
        },
        // Payment trend (area)
        area: {
          xAxis: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
          series: [
            { name: 'Collected', data: [1420, 1580, 1340, 1690, 1520, 1780, 1640, 1820] },
            { name: 'New AR', data: [1680, 1540, 1720, 1480, 1660, 1390, 1580, 1450] }
          ]
        },
        // Recovery funnel
        funnel: {
          data: [
            { name: 'AR Balance', value: 12400 },
            { name: 'Contacted', value: 8900 },
            { name: 'Promise to Pay', value: 5200 },
            { name: 'Collected', value: 3800 },
            { name: 'Closed', value: 2400 }
          ]
        },
        // Customer type breakdown (donut)
        donut: {
          data: [
            { name: 'Residential', value: 4520 },
            { name: 'Commercial', value: 4230 },
            { name: 'Industrial', value: 2629 },
            { name: 'Agricultural', value: 620 },
            { name: 'Other', value: 277 }
          ]
        }
      },
      pipeline: {
        stages: [
          { name: 'Aging Cube', rows: 8473, cols: ['accountId', 'balance', 'agingBucket', 'accountStatus', 'sector'] },
          { name: 'CIS Enrichment', rows: 8473, cols: ['accountId', 'customerName', 'dueDate', 'lastPayment', 'depositHeld'] },
          { name: 'Dashboard Loader', rows: 8473, cols: ['sector', 'agingBucket', 'totalBalance', 'accountCount', 'pctOfTotal'] },
          { name: 'Excel Export', rows: 8473, cols: ['accountId', 'customer', 'sector', 'balance', 'bucket', 'dueDate', 'lastPayment'] }
        ]
      }
    },

    // ── AI Work Desk: Outlook intelligence + task board ──────────────────────
    'ai-work-desk': {
      kpis: [
        { label: 'New Requests', value: '34', delta: '+8', dir: 'down' },
        { name: 'AI Triaged', value: '28', delta: '+6', dir: 'up' },
        { label: 'Avg Response', value: '12m', delta: '-4m', dir: 'up' },
        { label: 'Auto-Routed', value: '19', delta: '+5', dir: 'up' }
      ],
      charts: {
        // Request categories (donut)
        donut: {
          data: [
            { name: 'Password Reset', value: 12 },
            { name: 'Access Request', value: 8 },
            { name: 'Bug Report', value: 6 },
            { name: 'Info Request', value: 5 },
            { name: 'Other', value: 3 }
          ]
        },
        // Response time trend (area)
        area: {
          xAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
          series: [
            { name: 'AI Response', data: [2, 3, 2, 4, 3] },
            { name: 'Human Response', data: [18, 22, 15, 19, 14] }
          ]
        },
        // Task distribution by priority (bar)
        bar: {
          xAxis: ['P1', 'P2', 'P3', 'P4'],
          series: [
            { name: 'Open', data: [3, 8, 15, 8] },
            { name: 'Resolved', data: [5, 12, 22, 14] }
          ]
        },
        // Inbox heatmap (hour × day)
        heatmap: {
          xAxis: ['6am', '8am', '10am', '12pm', '2pm', '4pm', '6pm'],
          yAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
          data: function() {
            var d = [];
            for (var day = 0; day < 5; day++) {
              for (var hr = 0; hr < 7; hr++) {
                var peak = (hr >= 1 && hr <= 4) ? 1 : 0.3;
                var val = Math.round(3 + Math.random() * 18 * peak);
                d.push([hr, day, val]);
              }
            }
            return d;
          }
        }
      },
      pipeline: {
        stages: [
          { name: 'Outlook Connector', rows: 34, cols: ['messageId', 'sender', 'subject', 'receivedAt', 'bodyText'] },
          { name: 'AI Triage', rows: 34, cols: ['messageId', 'category', 'priority', 'suggestedAction', 'confidence'] },
          { name: 'Task Router', rows: 28, cols: ['taskId', 'assignee', 'priority', 'dueDate', 'source'] },
          { name: 'Dashboard', rows: 1, cols: ['openTasks', 'aiTriaged', 'avgResponseMin', 'autoRouted'] }
        ]
      }
    },

    // ── Contact Center Pipeline: Genesys ETL ────────────────────────────────
    'genesys-pipeline': {
      kpis: [
        { label: 'Records Processed', value: '12,450', delta: '+1,820', dir: 'up' },
        { label: 'Answered Calls', value: '11,832', delta: '+1,647', dir: 'up' },
        { label: 'Abandoned', value: '618', delta: '+173', dir: 'down' },
        { label: 'Avg Handle Time', value: '4m 32s', delta: '-8s', dir: 'up' }
      ],
      charts: {
        // Call volume by day (area)
        area: {
          xAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          series: [
            { name: 'Inbound', data: [1842, 2103, 1768, 2245, 1987, 892, 613] },
            { name: 'Outbound', data: [798, 912, 734, 1023, 847, 312, 178] }
          ]
        },
        // Call handling by queue (bar)
        bar: {
          xAxis: ['Billing', 'Tech Support', 'Sales', 'Retention', 'General'],
          series: [
            { name: 'Answered', data: [3420, 2890, 1980, 1470, 2072] },
            { name: 'Abandoned', data: [142, 198, 89, 67, 122] }
          ]
        },
        // Response time distribution (funnel)
        funnel: {
          data: [
            { name: 'Total Calls', value: 12450 },
            { name: 'Answered', value: 11832 },
            { name: 'Within 30s', value: 8640 },
            { name: 'Within 60s', value: 10240 },
            { name: 'Within 120s', value: 11289 }
          ]
        },
        // Call volume heatmap (hour × day)
        heatmap: {
          xAxis: ['6am', '8am', '10am', '12pm', '2pm', '4pm', '6pm', '8pm'],
          yAxis: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          data: function() {
            var d = [];
            for (var day = 0; day < 7; day++) {
              for (var hr = 0; hr < 8; hr++) {
                var peak = (hr >= 2 && hr <= 5) ? 1 : 0.35;
                var weekend = (day >= 5) ? 0.4 : 1;
                var val = Math.round(20 + Math.random() * 80 * peak * weekend);
                d.push([hr, day, val]);
              }
            }
            return d;
          }
        }
      },
      pipeline: {
        stages: [
          { name: 'Genesys Cloud API', rows: 12450, cols: ['conversationId', 'direction', 'queueName', 'durationSec', 'abandoned'] },
          { name: 'Staging Table', rows: 12450, cols: ['conversationId', 'answered', 'handleSec', 'queueSec', 'abandonedFlag'] },
          { name: 'Business Rules', rows: 11832, cols: ['conversationId', 'answered30s', 'answered60s', 'answered120s', 'abandonedCorrected'] },
          { name: 'Reporting Table', rows: 11832, cols: ['reportDate', 'queueName', 'callVolume', 'answered', 'abandoned', 'avgHandleSec'] }
        ]
      }
    }
  };

  // ─── Monkey-patch echarts.init to intercept chart creation ────────────────
  // The showcase loads ECharts asynchronously (via a script loader), so
  // window.echarts may not exist yet when this file runs. We use a polling
  // check + Object.defineProperty to intercept echarts.init as soon as the
  // library is loaded.
  function patchEcharts() {
    if (!window.echarts || !window.echarts.init || window.echarts.__realDataPatched) {
      return false;
    }

    var originalEchartsInit = window.echarts.init;
    window.echarts.__realDataPatched = true;

    window.echarts.init = function() {
      var chart = originalEchartsInit.apply(window.echarts, arguments);
      var originalSetOption = chart.setOption.bind(chart);

      chart.setOption = function(option, opts) {
        // Check if we have real data for the currently-open project
        var projectId = getActiveProjectId();
        var projectData = projectId ? REAL_DATA[projectId] : null;

        if (projectData && projectData.charts) {
          var kind = detectChartKind(option);
          var realChart = projectData.charts[kind];

          if (realChart) {
            var realOption = buildRealOption(kind, realChart, option);
            return originalSetOption(realOption, opts);
          }
        }

        return originalSetOption(option, opts);
      };

      return chart;
    };

    return true;
  }

  // Try immediately, then poll every 200ms until ECharts is loaded
  if (!patchEcharts()) {
    var patchInterval = setInterval(function() {
      if (patchEcharts()) {
        clearInterval(patchInterval);
      }
    }, 200);
    // Give up after 30 seconds
    setTimeout(function() { clearInterval(patchInterval); }, 30000);
  }

  // ─── Detect chart kind from an ECharts option object ─────────────────────
  function detectChartKind(option) {
    if (!option || !option.series || !option.series.length) return null;
    var series = option.series[0];
    var type = series.type;

    // Map ECharts series types to our chart kinds
    if (type === 'line') return 'area';
    if (type === 'bar') {
      // Check if it's a stacked bar (multiple series) or a dumbbell (custom render)
      if (option.series.length > 2 && option.series[0].renderItem) return 'bar'; // dumbbell → bar
      return 'bar';
    }
    if (type === 'pie') return 'donut';
    if (type === 'heatmap') return 'heatmap';
    if (type === 'scatter') return 'scatter';
    if (type === 'radar') return 'radar';
    if (type === 'funnel') return 'funnel';
    if (type === 'gauge') return 'gauge';
    if (type === 'custom') return 'bar'; // dumbbell uses custom renderItem → map to bar
    if (type === 'treemap') return 'treemap';
    if (type === 'sankey') return 'sankey';
    if (type === 'boxplot') return 'boxplot';
    if (type === 'graph') return 'graph';
    return type;
  }

  // ─── Build a real-data ECharts option from our data ──────────────────────
  function buildRealOption(kind, chartData, originalOption) {
    // Start from the original option (preserves colors, fonts, theme)
    var opt = JSON.parse(JSON.stringify(originalOption));
    var color = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#a78bfa', '#f472b6'];
    opt.color = color;
    opt.animation = true;
    opt.animationDuration = 600;

    if (kind === 'area' || (kind === 'line' && chartData.series)) {
      opt.legend = { show: true, top: 2, textStyle: { fontSize: 9 } };
      if (chartData.xAxis) opt.xAxis.data = chartData.xAxis;
      opt.tooltip = Object.assign(opt.tooltip || {}, { trigger: 'axis' });
      opt.series = chartData.series.map(function(s, i) {
        return {
          name: s.name,
          type: 'line',
          smooth: true,
          symbolSize: 5,
          data: s.data,
          lineStyle: { width: 3 },
          areaStyle: { opacity: 0.18 }
        };
      });
    } else if (kind === 'bar' && chartData.series) {
      opt.legend = { show: true, top: 2, textStyle: { fontSize: 9 } };
      if (chartData.xAxis) opt.xAxis.data = chartData.xAxis;
      opt.series = chartData.series.map(function(s) {
        return {
          name: s.name,
          type: 'bar',
          stack: 'total',
          data: s.data,
          itemStyle: { borderRadius: [0, 0, 4, 4] },
          barMaxWidth: 32
        };
      });
    } else if (kind === 'donut' && chartData.data) {
      opt.series = [{
        name: 'Distribution',
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '49%'],
        padAngle: 3,
        itemStyle: { borderRadius: 6 },
        label: { fontSize: 9, formatter: '{b}\n{d}%' },
        data: chartData.data
      }];
    } else if (kind === 'heatmap' && chartData.xAxis) {
      var hmData = typeof chartData.data === 'function' ? chartData.data() : chartData.data;
      opt.xAxis.data = chartData.xAxis;
      opt.yAxis.data = chartData.yAxis;
      opt.visualMap = { show: false, min: 0, max: 100, inRange: { color: ['#e7edfb', '#b9d8ea', '#6366f1', '#4338ca'] } };
      opt.series = [{
        type: 'heatmap',
        data: hmData,
        itemStyle: { borderWidth: 4, borderColor: '#eef1fb', borderRadius: 5 }
      }];
    } else if (kind === 'scatter' && chartData.series) {
      opt.xAxis = { type: 'value', name: 'Temperature (°C)', axisLabel: { fontSize: 9 } };
      opt.yAxis = { type: 'value', name: 'Load (MW)', axisLabel: { fontSize: 9 } };
      opt.series = chartData.series.map(function(s) {
        return {
          name: s.name,
          type: 'scatter',
          symbolSize: function(point) { return point[2]; },
          itemStyle: { opacity: 0.65 },
          data: s.data
        };
      });
    } else if (kind === 'radar' && chartData.indicators) {
      opt.radar = {
        radius: '68%',
        indicator: chartData.indicators,
        axisName: { fontSize: 9 },
        splitArea: { show: false }
      };
      opt.legend = { show: true, top: 2, textStyle: { fontSize: 9 } };
      opt.series = [{
        type: 'radar',
        symbolSize: 4,
        data: chartData.series.map(function(s) {
          return { name: s.name, value: s.value, areaStyle: { opacity: 0.18 } };
        })
      }];
    } else if (kind === 'funnel' && chartData.data) {
      opt.series = [{
        name: 'Flow',
        type: 'funnel',
        left: '16%', right: '16%', top: 16, bottom: 20, gap: 6,
        label: { position: 'inside', fontSize: 10 },
        itemStyle: { borderWidth: 0, borderRadius: 5 },
        data: chartData.data
      }];
    } else if (kind === 'gauge' && chartData.value != null) {
      opt.series = [{
        type: 'gauge',
        startAngle: 210, endAngle: -30, min: 0, max: 100,
        radius: '88%', center: ['50%', '57%'],
        progress: { show: true, width: 16 },
        pointer: { show: false },
        detail: { fontSize: 32, formatter: '{value}%' },
        title: { fontSize: 10 },
        data: [{ value: chartData.value, name: chartData.name }]
      }];
    }

    return opt;
  }

  // ─── Override sampleRows with real pipeline data ──────────────────────────
  // sampleRows is a local function in the showcase's IIFE — we can't override
  // it directly. Instead, the MutationObserver below replaces the rendered
  // table content after the dialog opens.

  // ─── Replace KPI cards with real data ──────────────────────────────────────
  function injectRealKPIs() {
    var projectId = getActiveProjectId();
    if (!projectId) return;
    var projectData = REAL_DATA[projectId];
    if (!projectData || !projectData.kpis) return;

    // Find KPI cards in the dialog and replace their values
    var dialog = document.getElementById('dialog-content');
    if (!dialog) return;

    var kpiElements = dialog.querySelectorAll('.mock-metrics strong, .preview-hero-number strong, .reporting-stats strong');
    projectData.kpis.forEach(function(kpi, i) {
      if (kpiElements[i]) {
        kpiElements[i].textContent = kpi.value;
      }
    });
  }

  // Run after dialog content is rendered
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        setTimeout(injectRealKPIs, 50);
      }
    });
  });

  // Start observing the dialog content container
  var dialogContent = document.getElementById('dialog-content');
  if (dialogContent) {
    observer.observe(dialogContent, { childList: true, subtree: true });
  }

  // Also observe when the dialog opens
  var dialog = document.getElementById('project-dialog');
  if (dialog) {
    var dialogObserver = new MutationObserver(function() {
      if (dialog.hasAttribute('open')) {
        setTimeout(injectRealKPIs, 100);
      }
    });
    dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }

})();
