/* ════════════════════════════════════════════════════════════════════════════
   blog-ai-dashboard-builder.js — AI-assisted dashboard builder (live demo)

   Mounts INTO <div id="ai-dashboard-builder-mount"></div> when DOM is ready.
   Pure vanilla JS, no framework. Wrapped in an IIFE — no globals.

   Flow
   ----
     1. User picks a preset template chip OR types a brief description
        ("build me a SaaS churn dashboard") into the textarea.
     2. On "Build Dashboard", we POST a strict JSON-spec system prompt to
        Groq (via the Netlify proxy — never direct). Groq returns a single
        JSON object: { title, description, kpis:[4], charts:[4] }.
     3. The spec renders as a review card (parsed JSON + a "Render Live"
        button). User can regenerate, edit the prompt, or view raw JSON.
     4. On "Render Live", we render the spec as an actual dashboard with
        ECharts — 4 KPI cards across the top, 2×2 grid of charts below.
     5. User can "Save layout" (localStorage), "Export JSON", "Load saved",
        or "Regenerate" with a different prompt.

   Engine
   -----
     • ECharts 5.5.0 via CDN (same engine as production dashboards).
     • Palette matches the production site (PALETTE constant).
     • All chart types supported by the universal renderer: bar / line /
       area / stacked / pie / heatmap / gauge / scatter.
     • AI-provided sample data is synthetic but plausible-looking.

   Anti-footguns
   -------------
     • Groq calls rate-limited to MAX_GROQ_CALLS (10) per browser session
       (sessionStorage-tracked, resets on tab close).
     • All user-provided + AI-provided text HTML-escaped before insertion.
     • No eval / Function — synthetic data is generated via plain JS.
     • AbortController + timeout on every Groq call.
     • No alert/confirm/prompt — inline modals + inline inputs only.
     • Robust JSON parsing: strips ```json fences, finds first { and last }
       in case the model adds prose before/after the JSON.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  var MOUNT_ID         = 'ai-dashboard-builder-mount';
  var GROQ_PROXY       = 'https://dashboards-groq-proxy.netlify.app/groq-proxy';
  var GROQ_MODEL       = 'qwen/qwen3.8-27b';
  var STORAGE_KEY      = 'aiDashboardBuilder.saved.v1';
  var RATE_KEY         = 'aiDashboardBuilder.rate.v1';
  var SESSION_KEY      = 'aiDashboardBuilder.sessionId.v1';
  var MAX_GROQ_CALLS   = 10;
  var GROQ_TIMEOUT_MS  = 35000;     // dashboard spec is larger; allow up to 35s
  var LIB_ECHARTS     = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js';

  // Same palette as production dashboards (universal-dashboard.js).
  var PALETTE = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#a78bfa', '#f472b6', '#38bdf8', '#94a3b8'];

  // Preset templates — clickable chips that prefill the textarea.
  // Each chip sets a different starting prompt so the demo is usable
  // even if the user has no idea what to type.
  var PRESET_TEMPLATES = [
    { id: 'saas-growth', label: 'SaaS Growth & Retention',
      prompt: 'Build a SaaS growth & retention dashboard. Show MRR, NRR, churn rate, and ARR. Include a 6-month MRR trend (line chart), ARR waterfall from new/expanded/churned (stacked bar), cohort retention heatmap by signup month × months-since-signup, and a customer-health gauge.' },
    { id: 'utility-load', label: 'Utility Load Forecasting',
      prompt: 'Build a utility load forecasting dashboard. Show peak load (MW), energy delivered (GWh), forecast error (%), and reserve margin (%). Include a 24-hour load curve (line chart), 7-day peak load by day (bar chart), temperature vs load scatter, and a generation-mix pie chart.' },
    { id: 'customer-service', label: 'Customer Service Performance',
      prompt: 'Build a customer service performance dashboard. Show tickets opened, tickets closed, average resolution time (hours), CSAT score. Include ticket volume by day (line chart), tickets by channel (pie chart), avg resolution time by queue (horizontal bar), and a backlog-by-priority gauge.' },
    { id: 'inventory-supply', label: 'Inventory & Supply Chain',
      prompt: 'Build an inventory & supply chain dashboard. Show OTIF %, in-stock %, inventory turns, days-of-supply. Include a 12-week OTIF trend (line chart), lane performance heatmap (origin × destination), stockout risk by SKU category (bar chart), and an inventory health gauge.' },
    { id: 'banking-risk', label: 'Banking Risk & Treasury',
      prompt: 'Build a banking risk & treasury dashboard. Show LCR (%), NSFR (%), VaR ($M), and CET1 ratio (%). Include a 30-day liquidity waterfall (stacked bar), sector exposure heatmap (sector × rating), VaR trend by day (line chart), and a regulatory capital gauge.' },
    { id: 'it-operations', label: 'IT Operations Center',
      prompt: 'Build an IT operations center dashboard. Show uptime %, MTTR (mins), open P1 tickets, SLA compliance %. Include ticket volume by day (line chart), tickets by service (pie chart), MTTR by priority (bar chart), and an SLA-breach-risk gauge.' }
  ];

  // ─── Module-scope state ────────────────────────────────────────────────────
  // Single source of truth. render() re-paints the whole mount from this.
  var state = {
    prompt:             '',     // textarea value (kept out of re-render so typing doesn't lose focus)
    spec:               null,   // parsed dashboard spec from Groq
    specLoading:        false,
    specError:          null,
    rawResponse:        '',     // raw Groq response for debugging
    showRawResponse:    false,
    showSpecJson:       false,
    rendered:           false,  // has spec been rendered as live dashboard?
    savedDashboards:    [],     // localStorage history
    chartRegistry:      []      // active ECharts instances (re-created on each render)
  };

  // ─── Small DOM helpers ─────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function fmtNumber(n) {
    if (n === null || n === undefined || n === '') return '';
    var num = Number(n);
    if (isNaN(num)) return String(n);
    var abs = Math.abs(num);
    if (abs >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (abs >= 1e4) return (num / 1e3).toFixed(1) + 'K';
    var isInt = Math.abs(num - Math.round(num)) < 1e-9 && String(n).indexOf('.') < 0;
    return num.toLocaleString('en-US', {
      minimumFractionDigits: isInt ? 0 : 2,
      maximumFractionDigits: 2
    });
  }
  function fmtDelta(n, dir) {
    if (n === null || n === undefined || n === '') return '';
    var arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·';
    return arrow + ' ' + Math.abs(Number(n) || 0).toFixed(1) + '%';
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleDateString('en-CA'); } catch (e) { return ''; }
  }

  // ─── Lazy CDN script loader ────────────────────────────────────────────────
  var libCache = {};
  function loadScript(url) {
    if (libCache[url]) return libCache[url];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
    libCache[url] = p;
    return p;
  }

  // ─── Groq rate limiter (per browser session) ───────────────────────────────
  function getSessionId() {
    var sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  }
  function getRateState() {
    try {
      var raw = localStorage.getItem(RATE_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (!s || s.sessionId !== getSessionId()) return { sessionId: getSessionId(), count: 0 };
      return s;
    } catch (e) { return { sessionId: getSessionId(), count: 0 }; }
  }
  function canCallGroq() { return getRateState().count < MAX_GROQ_CALLS; }
  function remainingGroqCalls() { return Math.max(0, MAX_GROQ_CALLS - getRateState().count); }
  function bumpGroqCount() {
    var s = getRateState();
    s.count = (s.count || 0) + 1;
    try { localStorage.setItem(RATE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  // ─── Groq API helper ───────────────────────────────────────────────────────
  // POSTs to the Netlify proxy. Resolves to the assistant message content string.
  function callGroq(messages, opts) {
    opts = opts || {};
    if (!canCallGroq()) {
      return Promise.reject(new Error('Demo rate limit reached — ' + MAX_GROQ_CALLS +
        ' AI calls this session. Refresh the page to try again.'));
    }
    var body = {
      model: GROQ_MODEL,
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.4,
      max_tokens: opts.max_tokens != null ? opts.max_tokens : 2200,
      stream: false
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, GROQ_TIMEOUT_MS);
    return fetch(GROQ_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('Groq proxy returned HTTP ' + res.status + ': ' + t.slice(0, 200));
        });
      }
      return res.json();
    }).then(function (data) {
      bumpGroqCount();
      var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('Empty response from Groq.');
      return content;
    }).catch(function (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Groq took longer than ' + (GROQ_TIMEOUT_MS / 1000) + 's. Try again.');
      throw err;
    });
  }

  // ─── System prompt (strict JSON spec) ──────────────────────────────────────
  // This is the contract the model must return. We deliberately constrain to
  // 4 KPIs + 4 charts so the dashboard layout is deterministic and renders
  // cleanly in a 2×2 grid. The model also synthesizes plausible-looking
  // sample data (no real data sources — pure demo).
  function buildSystemPrompt() {
    return [
      'You are a dashboard architect. Given a brief from the user, design a complete executive dashboard as a single JSON object. The dashboard must contain exactly 4 KPI cards (top row) and exactly 4 chart tiles (2×2 grid below the KPIs). Use synthetic but plausible-looking numeric data driven by the brief — do NOT say "insert data here". Return ONLY the JSON object — no markdown fences, no commentary, no prose before or after.',
      '',
      'JSON schema (every field is required unless noted):',
      '{',
      '  "title": string,                       // dashboard title, <= 60 chars',
      '  "description": string,                  // 1-2 sentence description of what the dashboard shows',
      '  "kpis": [                               // EXACTLY 4 entries',
      '    {',
      '      "label": string,                    // e.g. "Monthly Recurring Revenue"',
      '      "value": number,                    // the headline number',
      '      "unit": string,                     // e.g. "$", "%", "MW", "hours", or "" if none',
      '      "delta": number,                    // percentage change vs prior period, can be negative',
      '      "deltaDirection": "up" | "down"     // "up" = good news arrow, "down" = bad news arrow',
      '    }',
      '  ],',
      '  "charts": [                              // EXACTLY 4 entries',
      '    {',
      '      "title": string,                    // chart title, <= 60 chars',
      '      "type": "bar" | "line" | "area" | "stacked" | "pie" | "heatmap" | "gauge" | "scatter",',
      '      "description": string,              // 1 sentence describing what the chart shows',
      '      "xAxisLabel": string,               // for non-pie/heatmap/gauge charts',
      '      "yAxisLabel": string,               // for non-pie/heatmap/gauge charts',
      '      "categories": [string, ...],        // x-axis labels for bar/line/area/stacked/scatter (4-12 entries)',
      '      "series": [                          // for bar/line/area/stacked/scatter: 1-3 series',
      '        { "name": string, "values": [number, ...] }',
      '      ],',
      '      "slices": [                          // for pie only: 3-6 slices',
      '        { "name": string, "value": number }',
      '      ],',
      '      "heatmapRows": [string, ...],        // for heatmap only: 4-8 row labels',
      '      "heatmapCols": [string, ...],        // for heatmap only: 4-8 col labels',
      '      "heatmapValues": [[number, ...], ...],  // for heatmap only: matrix matching rows × cols',
      '      "gaugeValue": number,                // for gauge only: 0-100',
      '      "gaugeLabel": string,                // for gauge only: e.g. "Healthy"',
      '      "scatterPoints": [                   // for scatter only: 10-30 points',
      '        { "x": number, "y": number, "name": string }',
      '      ]',
      '    }',
      '  ]',
      '}',
      '',
      'Rules:',
      '- Pick chart types that BEST match the brief — don\'t use all 4 of the same type.',
      '- For "stacked" type: each series\' values should be non-negative (they stack).',
      '- For "gauge" type: gaugeValue must be 0-100. Use it for KPI-like ratios (% compliance, health score, etc.).',
      '- For "heatmap" type: heatmapValues must be a 2D array matching heatmapRows.length × heatmapCols.length.',
      '- For "pie" type: slices must have 3-6 entries. Don\'t use pie for >6 categories.',
      '- All numeric values must be realistic-looking (not round numbers like 100.0 or 50.0).',
      '- Use a variety of KPIs — don\'t repeat the same metric across all 4 cards.',
      '- Output STRICT JSON. No trailing commas, no comments, no markdown fences.',
      '- The JSON must be parseable by JSON.parse with no preprocessing.'
    ].join('\n');
  }

  function buildUserPrompt(brief) {
    return 'Brief: "' + brief + '"\n\nReturn the JSON object now.';
  }

  // ─── Robust JSON parser ────────────────────────────────────────────────────
  // Groq sometimes wraps JSON in ```json fences or adds prose before/after.
  // We strip fences, then find the outermost { ... } and parse that.
  function extractJsonObject(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    var firstBrace = cleaned.indexOf('{');
    var lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) return null;
    var jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(jsonStr); } catch (e) { return null; }
  }

  function validateSpec(spec) {
    var errors = [];
    if (!spec || typeof spec !== 'object') { errors.push('Spec is not an object.'); return errors; }
    if (typeof spec.title !== 'string' || !spec.title.trim()) errors.push('Missing or empty "title".');
    if (typeof spec.description !== 'string') errors.push('Missing "description".');
    if (!Array.isArray(spec.kpis) || spec.kpis.length !== 4) errors.push('"kpis" must have exactly 4 entries (got ' + (Array.isArray(spec.kpis) ? spec.kpis.length : 'non-array') + ').');
    if (!Array.isArray(spec.charts) || spec.charts.length !== 4) errors.push('"charts" must have exactly 4 entries (got ' + (Array.isArray(spec.charts) ? spec.charts.length : 'non-array') + ').');
    return errors;
  }

  // ─── Main entry: build dashboard from brief ────────────────────────────────
  function buildDashboard() {
    var brief = (state.prompt || '').trim();
    if (!brief) {
      state.specError = 'Type a brief description, or pick a preset template above.';
      render();
      return;
    }
    if (brief.length > 800) {
      state.specError = 'Brief is too long (max 800 characters). Truncate and try again.';
      render();
      return;
    }
    if (!canCallGroq()) {
      state.specError = 'Demo rate limit reached — ' + MAX_GROQ_CALLS + ' AI calls this session. Refresh the page to try again.';
      render();
      return;
    }
    state.specLoading = true;
    state.specError = null;
    state.spec = null;
    state.rawResponse = '';
    state.rendered = false;
    render();
    callGroq([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(brief) }
    ], { temperature: 0.4, max_tokens: 2200 })
      .then(function (content) {
        state.rawResponse = content;
        var parsed = extractJsonObject(content);
        if (!parsed) {
          state.specError = 'Could not parse Groq response as JSON. Click "Show raw response" to inspect.';
          state.specLoading = false;
          render();
          return;
        }
        var errs = validateSpec(parsed);
        if (errs.length > 0) {
          state.specError = 'Spec validation failed:\n• ' + errs.join('\n• ') + '\n\nTry regenerating or rephrasing the brief.';
          state.specLoading = false;
          render();
          return;
        }
        state.spec = parsed;
        state.specLoading = false;
        render();
      })
      .catch(function (err) {
        state.specError = err.message || String(err);
        state.specLoading = false;
        render();
      });
  }

  // ─── Saved dashboards (localStorage) ───────────────────────────────────────
  function loadSavedDashboards() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      state.savedDashboards = Array.isArray(arr) ? arr : [];
    } catch (e) { state.savedDashboards = []; }
  }
  function persistSavedDashboards() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedDashboards)); } catch (e) {}
  }
  function saveCurrentDashboard() {
    if (!state.spec) return;
    var entry = {
      id: 'db-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      title: state.spec.title,
      brief: state.prompt,
      spec: state.spec,
      savedAt: new Date().toISOString()
    };
    state.savedDashboards.unshift(entry);
    if (state.savedDashboards.length > 20) state.savedDashboards = state.savedDashboards.slice(0, 20);
    persistSavedDashboards();
    render();
  }
  function loadSavedDashboard(id) {
    var entry = state.savedDashboards.find(function (d) { return d.id === id; });
    if (!entry) return;
    state.prompt = entry.brief || '';
    state.spec = entry.spec;
    state.specError = null;
    state.rawResponse = '';
    state.rendered = false;
    render();
  }
  function deleteSavedDashboard(id) {
    state.savedDashboards = state.savedDashboards.filter(function (d) { return d.id !== id; });
    persistSavedDashboards();
    render();
  }
  function exportCurrentSpec() {
    if (!state.spec) return;
    var blob = new Blob([JSON.stringify(state.spec, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    var slug = (state.spec.title || 'dashboard').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    a.download = slug + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ─── Render: top-level dispatcher ──────────────────────────────────────────
  function render() {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    // Inner HTML is rebuilt on every render. Event handlers are re-bound
    // via the button helper below. State.prompt is preserved because
    // it lives outside of innerHTML — we only write back to the textarea
    // on initial mount or on explicit preset click.
    mount.innerHTML = renderShell();
    bindEvents(mount);
    if (state.rendered && state.spec) renderLiveDashboard();
  }

  function renderShell() {
    return [
      '<div class="adb-app">',
      renderHeader(),
      renderInputPanel(),
      renderSpecReview(),
      renderSavedPanel(),
      '</div>'
    ].join('');
  }

  function renderHeader() {
    var remaining = remainingGroqCalls();
    var rateBadge = remaining > 0
      ? '<span class="adb-rate-ok">' + remaining + ' / ' + MAX_GROQ_CALLS + ' AI calls left this session</span>'
      : '<span class="adb-rate-zero">Rate limit reached — refresh the page</span>';
    return '<div class="adb-header">' +
      '<h2>AI-Assisted Dashboard Builder</h2>' +
      '<p>Pick a preset, or describe your own dashboard in plain English. Groq generates a complete spec — 4 KPI cards + 4 chart tiles — and renders it live in your browser using the same ECharts engine as our production deployments.</p>' +
      '<div class="adb-rate-badge">' + rateBadge + '</div>' +
      '</div>';
  }

  function renderInputPanel() {
    var chips = PRESET_TEMPLATES.map(function (t) {
      return '<button type="button" class="adb-chip" data-preset-id="' + esc(t.id) + '" title="' + esc(t.prompt) + '">' + esc(t.label) + '</button>';
    }).join('');
    var disabled = state.specLoading ? ' disabled' : '';
    var btnLabel = state.specLoading ? 'Building…' : 'Build Dashboard';
    return '<div class="adb-input-panel">' +
      '<div class="adb-chips-label">Pick a preset template:</div>' +
      '<div class="adb-chips">' + chips + '</div>' +
      '<label class="adb-textarea-label" for="adb-prompt">Or describe your own dashboard:</label>' +
      '<textarea id="adb-prompt" class="adb-textarea" rows="3" maxlength="800" placeholder="e.g. Build a fintech onboarding funnel dashboard — show conversion by step, drop-off reasons, time-to-verify, and a 90-day trend. Include a funnel chart, a drop-off-by-reason pie, a step-duration bar, and a conversion-rate gauge.">' + esc(state.prompt) + '</textarea>' +
      '<div class="adb-textarea-foot">' +
      '<span class="adb-char-count" id="adb-char-count">' + (state.prompt || '').length + ' / 800</span>' +
      '<button type="button" id="adb-build-btn" class="adb-btn adb-btn-primary"' + disabled + '>' +
      '<i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> ' + esc(btnLabel) +
      '</button>' +
      '</div>' +
      '</div>';
  }

  function renderSpecReview() {
    if (state.specLoading) {
      return '<div class="adb-loading-panel">' +
        '<div class="adb-spinner" role="status" aria-label="Building dashboard"></div>' +
        '<div class="adb-loading-text">Groq is designing your dashboard…</div>' +
        '<div class="adb-loading-hint">This usually takes 5–15 seconds. The model is generating a complete JSON spec with KPIs, chart configurations, and synthetic data.</div>' +
        '</div>';
    }
    if (state.specError) {
      return '<div class="adb-error-panel">' +
        '<div class="adb-error-title"><i class="fas fa-circle-exclamation" aria-hidden="true"></i> Couldn\'t build the dashboard</div>' +
        '<pre class="adb-error-text">' + esc(state.specError) + '</pre>' +
        (state.rawResponse
          ? '<button type="button" id="adb-toggle-raw" class="adb-btn adb-btn-ghost">' +
            (state.showRawResponse ? 'Hide raw response' : 'Show raw response') + '</button>' +
            (state.showRawResponse ? '<pre class="adb-raw-response">' + esc(state.rawResponse) + '</pre>' : '')
          : '') +
        '</div>';
    }
    if (!state.spec) {
      return '<div class="adb-empty-state">' +
        '<i class="fas fa-chart-column" aria-hidden="true"></i>' +
        '<p>Your dashboard spec will appear here.</p>' +
        '</div>';
    }
    // Spec is loaded — show the review card
    var kpiList = (state.spec.kpis || []).map(function (k, i) {
      return '<div class="adb-review-kpi">' +
        '<div class="adb-review-kpi-label">' + esc(k.label || '') + '</div>' +
        '<div class="adb-review-kpi-value">' + esc(k.unit || '') + esc(fmtNumber(k.value || 0)) + '</div>' +
        (k.delta !== undefined && k.delta !== null
          ? '<div class="adb-review-kpi-delta ' + (k.deltaDirection === 'up' ? 'adb-delta-up' : 'adb-delta-down') + '">' + esc(fmtDelta(k.delta, k.deltaDirection)) + '</div>'
          : '') +
        '</div>';
    }).join('');
    var chartList = (state.spec.charts || []).map(function (c, i) {
      return '<div class="adb-review-chart">' +
        '<div class="adb-review-chart-num">' + (i + 1) + '</div>' +
        '<div class="adb-review-chart-meta">' +
        '<div class="adb-review-chart-title">' + esc(c.title || '') + '</div>' +
        '<div class="adb-review-chart-type"><span class="adb-tag">' + esc(c.type || '') + '</span></div>' +
        '<div class="adb-review-chart-desc">' + esc(c.description || '') + '</div>' +
        '</div>' +
        '</div>';
    }).join('');
    return '<div class="adb-spec-review">' +
      '<div class="adb-spec-head">' +
      '<div class="adb-spec-title">' + esc(state.spec.title || '') + '</div>' +
      '<div class="adb-spec-desc">' + esc(state.spec.description || '') + '</div>' +
      '</div>' +
      '<div class="adb-spec-section-label">KPI Cards (4)</div>' +
      '<div class="adb-review-kpi-grid">' + kpiList + '</div>' +
      '<div class="adb-spec-section-label">Chart Tiles (4)</div>' +
      '<div class="adb-review-chart-list">' + chartList + '</div>' +
      '<div class="adb-spec-actions">' +
      '<button type="button" id="adb-render-btn" class="adb-btn adb-btn-primary"><i class="fas fa-play" aria-hidden="true"></i> Render Live Dashboard</button>' +
      '<button type="button" id="adb-regenerate-btn" class="adb-btn adb-btn-ghost"><i class="fas fa-rotate" aria-hidden="true"></i> Regenerate</button>' +
      '<button type="button" id="adb-save-btn" class="adb-btn adb-btn-ghost"><i class="fas fa-bookmark" aria-hidden="true"></i> Save</button>' +
      '<button type="button" id="adb-export-btn" class="adb-btn adb-btn-ghost"><i class="fas fa-download" aria-hidden="true"></i> Export JSON</button>' +
      '<button type="button" id="adb-toggle-json" class="adb-btn adb-btn-ghost"><i class="fas fa-code" aria-hidden="true"></i> ' + (state.showSpecJson ? 'Hide JSON' : 'Show JSON') + '</button>' +
      '</div>' +
      (state.showSpecJson ? '<pre class="adb-spec-json">' + esc(JSON.stringify(state.spec, null, 2)) + '</pre>' : '') +
      '</div>';
  }

  function renderSavedPanel() {
    if (state.savedDashboards.length === 0) return '';
    var items = state.savedDashboards.map(function (d) {
      return '<div class="adb-saved-item">' +
        '<div class="adb-saved-item-main">' +
        '<div class="adb-saved-item-title">' + esc(d.title || '(untitled)') + '</div>' +
        '<div class="adb-saved-item-meta">' + esc(fmtDate(d.savedAt)) + (d.brief ? ' · ' + esc(d.brief.slice(0, 80)) + (d.brief.length > 80 ? '…' : '') : '') + '</div>' +
        '</div>' +
        '<div class="adb-saved-item-actions">' +
        '<button type="button" class="adb-btn adb-btn-tiny" data-load-id="' + esc(d.id) + '">Load</button>' +
        '<button type="button" class="adb-btn adb-btn-tiny adb-btn-danger" data-del-id="' + esc(d.id) + '"><i class="fas fa-trash" aria-hidden="true"></i></button>' +
        '</div>' +
        '</div>';
    }).join('');
    return '<details class="adb-saved-panel" open>' +
      '<summary><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> Saved dashboards (' + state.savedDashboards.length + ')</summary>' +
      '<div class="adb-saved-list">' + items + '</div>' +
      '</details>';
  }

  // ─── Live dashboard renderer (ECharts) ────────────────────────────────────
  function renderLiveDashboard() {
    var host = document.getElementById('adb-live-host');
    if (!host || !state.spec) return;
    // Dispose any existing chart instances
    state.chartRegistry.forEach(function (c) { try { c.dispose(); } catch (e) {} });
    state.chartRegistry = [];
    host.innerHTML = renderLiveShell();
    // Render each chart tile
    var tiles = host.querySelectorAll('[data-chart-idx]');
    Array.prototype.forEach.call(tiles, function (tile, idx) {
      var chart = state.spec.charts[idx];
      if (!chart) return;
      var el = tile.querySelector('.adb-chart-canvas');
      if (!el) return;
      var inst = window.echarts.init(el, null, { renderer: 'canvas' });
      var option = buildEChartsOption(chart);
      if (option) inst.setOption(option);
      state.chartRegistry.push(inst);
    });
    // KPI cards are static HTML — already in renderLiveShell
  }

  function renderLiveShell() {
    var spec = state.spec;
    var kpiCards = (spec.kpis || []).map(function (k, i) {
      var deltaClass = k.deltaDirection === 'up' ? 'adb-kpi-delta-up' : 'adb-kpi-delta-down';
      var deltaHtml = (k.delta !== undefined && k.delta !== null)
        ? '<div class="adb-kpi-delta ' + deltaClass + '">' + esc(fmtDelta(k.delta, k.deltaDirection)) + '</div>'
        : '';
      return '<div class="adb-kpi-card" style="border-top-color:' + PALETTE[i % PALETTE.length] + '">' +
        '<div class="adb-kpi-label">' + esc(k.label || '') + '</div>' +
        '<div class="adb-kpi-value">' + esc(k.unit || '') + esc(fmtNumber(k.value || 0)) + '</div>' +
        deltaHtml +
        '</div>';
    }).join('');
    var chartTiles = (spec.charts || []).map(function (c, i) {
      return '<div class="adb-chart-tile" data-chart-idx="' + i + '">' +
        '<div class="adb-chart-tile-head">' +
        '<div class="adb-chart-tile-title">' + esc(c.title || '') + '</div>' +
        '<div class="adb-chart-tile-type"><span class="adb-tag">' + esc(c.type || '') + '</span></div>' +
        '</div>' +
        '<div class="adb-chart-canvas"></div>' +
        (c.description ? '<div class="adb-chart-tile-desc">' + esc(c.description) + '</div>' : '') +
        '</div>';
    }).join('');
    return '<div class="adb-live">' +
      '<div class="adb-live-head">' +
      '<div class="adb-live-title">' + esc(spec.title || '') + '</div>' +
      '<div class="adb-live-desc">' + esc(spec.description || '') + '</div>' +
      '</div>' +
      '<div class="adb-kpi-row">' + kpiCards + '</div>' +
      '<div class="adb-chart-grid">' + chartTiles + '</div>' +
      '<div class="adb-live-foot">' +
      '<button type="button" id="adb-back-to-review" class="adb-btn adb-btn-ghost"><i class="fas fa-arrow-left" aria-hidden="true"></i> Back to spec</button>' +
      '<span class="adb-live-hint">Live ECharts render · synthetic data · same engine as production</span>' +
      '</div>' +
      '</div>';
  }

  // ─── ECharts option builder per chart type ────────────────────────────────
  function buildEChartsOption(chart) {
    if (!chart || !chart.type) return null;
    var base = {
      animation: true,
      animationDuration: 600,
      color: PALETTE,
      textStyle: { fontFamily: 'Inter, Segoe UI, sans-serif' },
      tooltip: { trigger: 'item', confine: true, extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;' },
      legend: { textStyle: { fontSize: 11 } }
    };
    switch (chart.type) {
      case 'bar': return buildBarOption(chart, base, false);
      case 'line': return buildBarOption(chart, base, true);
      case 'area': return buildBarOption(chart, base, true, true);
      case 'stacked': return buildBarOption(chart, base, false, false, true);
      case 'pie': return buildPieOption(chart, base);
      case 'heatmap': return buildHeatmapOption(chart, base);
      case 'gauge': return buildGaugeOption(chart, base);
      case 'scatter': return buildScatterOption(chart, base);
      default: return buildBarOption(chart, base, false);
    }
  }

  function buildBarOption(chart, base, isLine, isArea, isStack) {
    var cats = chart.categories || [];
    var series = (chart.series || []).map(function (s, i) {
      var item = {
        name: s.name || ('Series ' + (i + 1)),
        type: isLine ? 'line' : 'bar',
        data: s.values || [],
        itemStyle: { color: PALETTE[i % PALETTE.length] },
        smooth: isLine ? true : false
      };
      if (isArea) { item.areaStyle = { opacity: 0.18 }; item.smooth = true; }
      if (isStack) { item.stack = 'total'; item.itemStyle = { color: PALETTE[i % PALETTE.length] }; }
      return item;
    });
    return Object.assign({}, base, {
      tooltip: { trigger: 'axis', axisPointer: { type: isLine ? 'line' : 'shadow' } },
      legend: { data: series.map(function (s) { return s.name; }), top: 6, textStyle: { fontSize: 10 } },
      grid: { left: 50, right: 16, top: 36, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: cats,
        name: chart.xAxisLabel || '',
        nameTextStyle: { fontSize: 10, color: '#94a3b8' },
        axisLabel: { fontSize: 10, color: '#94a3b8', interval: 0 },
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }
      },
      yAxis: {
        type: 'value',
        name: chart.yAxisLabel || '',
        nameTextStyle: { fontSize: 10, color: '#94a3b8' },
        axisLabel: { fontSize: 10, color: '#94a3b8' },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)', type: 'dashed' } }
      },
      series: series
    });
  }

  function buildPieOption(chart, base) {
    var slices = (chart.slices || []).map(function (s, i) {
      return { name: s.name, value: s.value, itemStyle: { color: PALETTE[i % PALETTE.length] } };
    });
    return Object.assign({}, base, {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { fontSize: 10 } },
      series: [{
        type: 'pie',
        radius: ['42%', '70%'],
        center: ['38%', '52%'],
        avoidLabelOverlap: true,
        label: { show: true, formatter: '{b}\n{d}%', fontSize: 10 },
        labelLine: { length: 8, length2: 8 },
        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.15)' } },
        data: slices
      }]
    });
  }

  function buildHeatmapOption(chart, base) {
    var rows = chart.heatmapRows || [];
    var cols = chart.heatmapCols || [];
    var vals = chart.heatmapValues || [];
    var data = [];
    var max = -Infinity, min = Infinity;
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < cols.length; c++) {
        var v = vals[r] && typeof vals[r][c] === 'number' ? vals[r][c] : 0;
        data.push([c, r, v]);
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    if (!isFinite(max)) { max = 100; min = 0; }
    return Object.assign({}, base, {
      tooltip: { position: 'top', formatter: function (p) {
        return '<b>' + esc(rows[p.value[1]] || '') + ' × ' + esc(cols[p.value[0]] || '') + '</b><br>Value: ' + fmtNumber(p.value[2]);
      } },
      grid: { left: 90, right: 24, top: 28, bottom: 60, containLabel: true },
      xAxis: { type: 'category', data: cols, splitArea: { show: true }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
      yAxis: { type: 'category', data: rows, splitArea: { show: true }, axisLabel: { fontSize: 10, color: '#94a3b8' } },
      visualMap: {
        min: min, max: max, calculable: true, orient: 'horizontal', left: 'center', bottom: 8,
        textStyle: { fontSize: 10, color: '#94a3b8' },
        inRange: { color: ['#e0f2fe', '#7dd3fc', '#06b6d4', '#0891b2', '#155e75'] }
      },
      series: [{
        type: 'heatmap', data: data,
        label: { show: true, fontSize: 9, formatter: function (p) { return fmtNumber(p.value[2]); } },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } }
      }]
    });
  }

  function buildGaugeOption(chart, base) {
    var val = typeof chart.gaugeValue === 'number' ? chart.gaugeValue : 0;
    return Object.assign({}, base, {
      series: [{
        type: 'gauge',
        startAngle: 200, endAngle: -20,
        min: 0, max: 100,
        progress: { show: true, width: 12, itemStyle: { color: '#06b6d4' } },
        axisLine: { lineStyle: { width: 12, color: [[0.5, '#f59e0b'], [0.8, '#10b981'], [1, '#06b6d4']] } },
        pointer: { itemStyle: { color: '#6366f1' }, length: '60%', width: 4 },
        axisTick: { distance: -16, length: 4, lineStyle: { color: '#fff' } },
        splitLine: { distance: -16, length: 12, lineStyle: { color: '#fff', width: 2 } },
        axisLabel: { distance: 22, color: '#94a3b8', fontSize: 9 },
        anchor: { show: true, size: 12, itemStyle: { color: '#6366f1' } },
        title: { show: false },
        detail: { valueAnimation: true, offsetCenter: [0, '32%'], fontSize: 22, fontWeight: 700, formatter: '{value}%', color: '#1e293b' },
        data: [{ value: val, name: chart.gaugeLabel || '' }]
      }]
    });
  }

  function buildScatterOption(chart, base) {
    var pts = (chart.scatterPoints || []).map(function (p) { return [p.x, p.y, p.name]; });
    return Object.assign({}, base, {
      tooltip: { trigger: 'item', formatter: function (p) { return '<b>' + esc(p.value[2] || '') + '</b><br>x: ' + fmtNumber(p.value[0]) + '<br>y: ' + fmtNumber(p.value[1]); } },
      grid: { left: 50, right: 16, top: 28, bottom: 36, containLabel: true },
      xAxis: {
        type: 'value', name: chart.xAxisLabel || '', nameTextStyle: { fontSize: 10, color: '#94a3b8' },
        axisLabel: { fontSize: 10, color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)', type: 'dashed' } }
      },
      yAxis: {
        type: 'value', name: chart.yAxisLabel || '', nameTextStyle: { fontSize: 10, color: '#94a3b8' },
        axisLabel: { fontSize: 10, color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)', type: 'dashed' } }
      },
      series: [{
        type: 'scatter', data: pts,
        symbolSize: function (val) { return Math.max(6, Math.min(20, Math.abs(val[1]) / 4 + 6)); },
        itemStyle: { color: '#6366f1', opacity: 0.65, borderColor: '#fff', borderWidth: 1 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(99,102,241,0.4)' } }
      }]
    });
  }

  // ─── Event binding ─────────────────────────────────────────────────────────
  function bindEvents(mount) {
    // Prompt textarea — keep state.prompt in sync but don't re-render on every
    // keystroke (which would steal focus from the textarea). Only update state
    // and the char counter.
    var textarea = mount.querySelector('#adb-prompt');
    if (textarea) {
      textarea.addEventListener('input', function (e) {
        state.prompt = e.target.value;
        var counter = mount.querySelector('#adb-char-count');
        if (counter) counter.textContent = state.prompt.length + ' / 800';
      });
    }
    // Build button
    var buildBtn = mount.querySelector('#adb-build-btn');
    if (buildBtn) buildBtn.addEventListener('click', buildDashboard);
    // Preset chips
    var chips = mount.querySelectorAll('.adb-chip');
    Array.prototype.forEach.call(chips, function (chip) {
      chip.addEventListener('click', function () {
        var id = chip.getAttribute('data-preset-id');
        var preset = PRESET_TEMPLATES.find(function (t) { return t.id === id; });
        if (!preset) return;
        state.prompt = preset.prompt;
        render();
        // Refocus the textarea so the user can edit if they want
        var ta = mount.querySelector('#adb-prompt');
        if (ta) ta.focus();
      });
    });
    // Spec review actions
    var renderBtn = mount.querySelector('#adb-render-btn');
    if (renderBtn) renderBtn.addEventListener('click', function () {
      state.rendered = true;
      // Inject the live dashboard host after the spec review panel
      var review = mount.querySelector('.adb-spec-review');
      if (review) {
        var host = document.createElement('div');
        host.id = 'adb-live-host';
        review.insertAdjacentElement('afterend', host);
      }
      // Lazy-load ECharts if needed, then render
      if (window.echarts) {
        renderLiveDashboard();
      } else {
        loadScript(LIB_ECHARTS).then(renderLiveDashboard).catch(function (err) {
          var host = document.getElementById('adb-live-host');
          if (host) host.innerHTML = '<div class="adb-error-panel"><div class="adb-error-title">Failed to load ECharts</div><pre class="adb-error-text">' + esc(err.message) + '</pre></div>';
        });
      }
      // Scroll to the live dashboard
      var liveHost = document.getElementById('adb-live-host');
      if (liveHost) liveHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    var regenBtn = mount.querySelector('#adb-regenerate-btn');
    if (regenBtn) regenBtn.addEventListener('click', function () {
      state.spec = null;
      state.specError = null;
      state.rawResponse = '';
      state.rendered = false;
      var liveHost = document.getElementById('adb-live-host');
      if (liveHost) liveHost.remove();
      render();
      buildDashboard();
    });
    var saveBtn = mount.querySelector('#adb-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveCurrentDashboard);
    var exportBtn = mount.querySelector('#adb-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportCurrentSpec);
    var toggleJsonBtn = mount.querySelector('#adb-toggle-json');
    if (toggleJsonBtn) toggleJsonBtn.addEventListener('click', function () {
      state.showSpecJson = !state.showSpecJson;
      render();
    });
    var toggleRawBtn = mount.querySelector('#adb-toggle-raw');
    if (toggleRawBtn) toggleRawBtn.addEventListener('click', function () {
      state.showRawResponse = !state.showRawResponse;
      render();
    });
    // Back to review button (in live dashboard)
    var backBtn = mount.querySelector('#adb-back-to-review');
    if (backBtn) backBtn.addEventListener('click', function () {
      state.rendered = false;
      state.chartRegistry.forEach(function (c) { try { c.dispose(); } catch (e) {} });
      state.chartRegistry = [];
      var liveHost = document.getElementById('adb-live-host');
      if (liveHost) liveHost.remove();
      render();
      var review = mount.querySelector('.adb-spec-review');
      if (review) review.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // Saved dashboard actions
    var loadBtns = mount.querySelectorAll('[data-load-id]');
    Array.prototype.forEach.call(loadBtns, function (btn) {
      btn.addEventListener('click', function () {
        loadSavedDashboard(btn.getAttribute('data-load-id'));
      });
    });
    var delBtns = mount.querySelectorAll('[data-del-id]');
    Array.prototype.forEach.call(delBtns, function (btn) {
      btn.addEventListener('click', function () {
        deleteSavedDashboard(btn.getAttribute('data-del-id'));
      });
    });
    // Window resize → resize all chart instances
    if (state.chartRegistry.length > 0) {
      // Debounced resize
      var resizeTimer = null;
      if (!window.__adbResizeBound) {
        window.__adbResizeBound = true;
        window.addEventListener('resize', function () {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            state.chartRegistry.forEach(function (c) { try { c.resize(); } catch (e) {} });
          }, 150);
        });
      }
    }
  }

  // ─── Bootstrap on DOM ready ──────────────────────────────────────────────
  function init() {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    // Inject the demo's CSS if it isn't already present
    if (!document.getElementById('adb-styles')) {
      var style = document.createElement('style');
      style.id = 'adb-styles';
      style.textContent = ADB_CSS;
      document.head.appendChild(style);
    }
    loadSavedDashboards();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── Demo CSS (inlined so the JS is self-contained) ──────────────────────
  // Matches the visual language of the other blog demos (clean, light,
  // generous whitespace, rounded cards, subtle borders).
  var ADB_CSS = `
.adb-app { max-width: 1080px; margin: 0 auto; padding: 0 16px 48px; font-family: Inter, "Segoe UI", sans-serif; color: #1e293b; }
[data-theme="dark"] .adb-app { color: #e2e8f0; }

.adb-header { text-align: center; margin-bottom: 32px; }
.adb-header h2 { font-size: 1.6rem; font-weight: 700; margin: 0 0 12px; letter-spacing: -0.01em; }
.adb-header p { font-size: 0.95rem; line-height: 1.6; color: #64748b; max-width: 720px; margin: 0 auto; }
[data-theme="dark"] .adb-header p { color: #94a3b8; }

.adb-rate-badge { margin-top: 16px; font-size: 0.78rem; font-weight: 600; }
.adb-rate-ok { color: #10b981; background: rgba(16,185,129,0.1); padding: 4px 12px; border-radius: 999px; }
.adb-rate-zero { color: #ef4444; background: rgba(239,68,68,0.1); padding: 4px 12px; border-radius: 999px; }

.adb-input-panel { background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 14px; padding: 24px; margin-bottom: 20px; }
[data-theme="dark"] .adb-input-panel { background: #0f172a; border-color: #1e293b; }
.adb-chips-label, .adb-textarea-label { font-size: 0.78rem; font-weight: 600; color: #64748b; margin-bottom: 10px; display: block; text-transform: uppercase; letter-spacing: 0.04em; }
[data-theme="dark"] .adb-chips-label, [data-theme="dark"] .adb-textarea-label { color: #94a3b8; }

.adb-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.adb-chip { font-family: inherit; font-size: 0.84rem; font-weight: 600; padding: 8px 14px; border-radius: 999px; background: linear-gradient(135deg, rgba(99,102,241,0.08), rgba(6,182,212,0.05)); border: 1px solid rgba(99,102,241,0.18); color: #4f46e5; cursor: pointer; transition: all 180ms ease; }
.adb-chip:hover { background: linear-gradient(135deg, rgba(99,102,241,0.16), rgba(6,182,212,0.10)); transform: translateY(-1px); box-shadow: 0 4px 12px -4px rgba(99,102,241,0.25); }
[data-theme="dark"] .adb-chip { color: #c7d2fe; border-color: rgba(99,102,241,0.3); }

.adb-textarea { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 0.95rem; line-height: 1.55; padding: 14px 16px; border: 1px solid var(--border, #e2e8f0); border-radius: 10px; background: var(--surface-2, #f8fafc); color: inherit; resize: vertical; min-height: 80px; transition: border-color 180ms ease; }
.adb-textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
[data-theme="dark"] .adb-textarea { background: #1e293b; border-color: #334155; }

.adb-textarea-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; gap: 12px; flex-wrap: wrap; }
.adb-char-count { font-size: 0.78rem; color: #94a3b8; font-variant-numeric: tabular-nums; }

.adb-btn { font-family: inherit; font-size: 0.88rem; font-weight: 600; padding: 9px 18px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: all 160ms ease; }
.adb-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.adb-btn-primary { background: linear-gradient(135deg, #6366f1, #06b6d4); color: #fff; border: none; box-shadow: 0 6px 18px -6px rgba(99,102,241,0.45); }
.adb-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(99,102,241,0.55); }
.adb-btn-ghost { background: transparent; color: #64748b; border: 1px solid var(--border, #e2e8f0); }
.adb-btn-ghost:hover:not(:disabled) { color: #4f46e5; border-color: #6366f1; background: rgba(99,102,241,0.06); }
[data-theme="dark"] .adb-btn-ghost { color: #94a3b8; border-color: #334155; }
[data-theme="dark"] .adb-btn-ghost:hover:not(:disabled) { color: #c7d2fe; border-color: #6366f1; background: rgba(99,102,241,0.12); }
.adb-btn-tiny { padding: 4px 10px; font-size: 0.78rem; }
.adb-btn-danger { color: #ef4444; border-color: rgba(239,68,68,0.3); }
.adb-btn-danger:hover { background: rgba(239,68,68,0.08); }

.adb-loading-panel { text-align: center; padding: 48px 24px; background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 14px; }
[data-theme="dark"] .adb-loading-panel { background: #0f172a; border-color: #1e293b; }
.adb-spinner { width: 36px; height: 36px; margin: 0 auto 16px; border: 3px solid rgba(99,102,241,0.18); border-top-color: #6366f1; border-radius: 50%; animation: adb-spin 0.9s linear infinite; }
@keyframes adb-spin { to { transform: rotate(360deg); } }
.adb-loading-text { font-size: 1.05rem; font-weight: 600; margin-bottom: 8px; }
.adb-loading-hint { font-size: 0.86rem; color: #94a3b8; max-width: 480px; margin: 0 auto; line-height: 1.6; }

.adb-error-panel { background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.2); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
.adb-error-title { font-size: 1rem; font-weight: 700; color: #dc2626; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.adb-error-text { font-family: "JetBrains Mono", "Courier New", monospace; font-size: 0.82rem; color: #7f1d1d; background: rgba(239,68,68,0.04); padding: 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; margin: 10px 0; max-height: 300px; overflow-y: auto; }
[data-theme="dark"] .adb-error-text { color: #fca5a5; background: rgba(239,68,68,0.08); }
.adb-raw-response { font-family: "JetBrains Mono", "Courier New", monospace; font-size: 0.78rem; background: #f8fafc; padding: 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; max-height: 400px; overflow-y: auto; margin-top: 10px; color: #475569; }
[data-theme="dark"] .adb-raw-response { background: #1e293b; color: #cbd5e1; }

.adb-empty-state { text-align: center; padding: 64px 24px; background: var(--surface, #fff); border: 1px dashed var(--border, #cbd5e1); border-radius: 14px; }
.adb-empty-state i { font-size: 2.4rem; color: #94a3b8; margin-bottom: 12px; }
.adb-empty-state p { font-size: 0.95rem; color: #64748b; margin: 0; }
[data-theme="dark"] .adb-empty-state { background: #0f172a; border-color: #334155; }
[data-theme="dark"] .adb-empty-state p { color: #94a3b8; }

.adb-spec-review { background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 14px; padding: 24px; margin-bottom: 20px; }
[data-theme="dark"] .adb-spec-review { background: #0f172a; border-color: #1e293b; }
.adb-spec-head { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border, #e2e8f0); }
[data-theme="dark"] .adb-spec-head { border-bottom-color: #1e293b; }
.adb-spec-title { font-size: 1.25rem; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.01em; }
.adb-spec-desc { font-size: 0.92rem; color: #64748b; line-height: 1.6; }
[data-theme="dark"] .adb-spec-desc { color: #94a3b8; }
.adb-spec-section-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; margin: 18px 0 10px; }

.adb-review-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.adb-review-kpi { background: var(--surface-2, #f8fafc); border-radius: 8px; padding: 12px; border-left: 3px solid #6366f1; }
[data-theme="dark"] .adb-review-kpi { background: #1e293b; }
.adb-review-kpi-label { font-size: 0.74rem; color: #64748b; margin-bottom: 4px; font-weight: 600; line-height: 1.3; min-height: 2.4em; }
[data-theme="dark"] .adb-review-kpi-label { color: #94a3b8; }
.adb-review-kpi-value { font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.adb-review-kpi-delta { font-size: 0.74rem; font-weight: 600; margin-top: 4px; }
.adb-delta-up { color: #10b981; }
.adb-delta-down { color: #ef4444; }

.adb-review-chart-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 640px) { .adb-review-chart-list { grid-template-columns: 1fr; } }
.adb-review-chart { display: flex; gap: 10px; padding: 10px; background: var(--surface-2, #f8fafc); border-radius: 8px; }
[data-theme="dark"] .adb-review-chart { background: #1e293b; }
.adb-review-chart-num { width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #06b6d4); color: #fff; font-size: 0.78rem; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.adb-review-chart-title { font-size: 0.88rem; font-weight: 600; margin-bottom: 2px; }
.adb-review-chart-type { margin-bottom: 4px; }
.adb-tag { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 4px; background: rgba(99,102,241,0.12); color: #4f46e5; }
[data-theme="dark"] .adb-tag { background: rgba(99,102,241,0.2); color: #c7d2fe; }
.adb-review-chart-desc { font-size: 0.78rem; color: #64748b; line-height: 1.5; }
[data-theme="dark"] .adb-review-chart-desc { color: #94a3b8; }

.adb-spec-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border, #e2e8f0); }
[data-theme="dark"] .adb-spec-actions { border-top-color: #1e293b; }

.adb-spec-json { font-family: "JetBrains Mono", "Courier New", monospace; font-size: 0.76rem; background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; max-height: 400px; overflow-y: auto; margin-top: 14px; }

.adb-saved-panel { background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 14px; padding: 16px 20px; margin-bottom: 20px; }
[data-theme="dark"] .adb-saved-panel { background: #0f172a; border-color: #1e293b; }
.adb-saved-panel summary { cursor: pointer; font-weight: 600; font-size: 0.92rem; color: #64748b; display: flex; align-items: center; gap: 8px; }
[data-theme="dark"] .adb-saved-panel summary { color: #94a3b8; }
.adb-saved-list { margin-top: 14px; display: grid; gap: 8px; }
.adb-saved-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: var(--surface-2, #f8fafc); border-radius: 8px; }
[data-theme="dark"] .adb-saved-item { background: #1e293b; }
.adb-saved-item-main { flex: 1; min-width: 0; }
.adb-saved-item-title { font-size: 0.88rem; font-weight: 600; }
.adb-saved-item-meta { font-size: 0.74rem; color: #94a3b8; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adb-saved-item-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* Live dashboard render */
.adb-live { background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 14px; padding: 24px; margin-bottom: 20px; }
[data-theme="dark"] .adb-live { background: #0f172a; border-color: #1e293b; }
.adb-live-head { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border, #e2e8f0); }
[data-theme="dark"] .adb-live-head { border-bottom-color: #1e293b; }
.adb-live-title { font-size: 1.45rem; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 6px; }
.adb-live-desc { font-size: 0.92rem; color: #64748b; line-height: 1.6; }
[data-theme="dark"] .adb-live-desc { color: #94a3b8; }

.adb-kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
@media (max-width: 880px) { .adb-kpi-row { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 480px) { .adb-kpi-row { grid-template-columns: 1fr; } }
.adb-kpi-card { background: linear-gradient(135deg, rgba(99,102,241,0.04), rgba(6,182,212,0.03)); border: 1px solid var(--border, #e2e8f0); border-top: 3px solid #6366f1; border-radius: 10px; padding: 14px 16px; }
[data-theme="dark"] .adb-kpi-card { background: linear-gradient(135deg, rgba(99,102,241,0.10), rgba(6,182,212,0.06)); border-color: #1e293b; }
.adb-kpi-label { font-size: 0.74rem; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; line-height: 1.3; min-height: 2.4em; }
[data-theme="dark"] .adb-kpi-label { color: #94a3b8; }
.adb-kpi-value { font-size: 1.5rem; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.adb-kpi-delta { font-size: 0.82rem; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }

.adb-chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 880px) { .adb-chart-grid { grid-template-columns: 1fr; } }
.adb-chart-tile { background: var(--surface-2, #f8fafc); border: 1px solid var(--border, #e2e8f0); border-radius: 10px; padding: 14px; min-height: 280px; display: flex; flex-direction: column; }
[data-theme="dark"] .adb-chart-tile { background: #1e293b; border-color: #334155; }
.adb-chart-tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.adb-chart-tile-title { font-size: 0.92rem; font-weight: 700; }
.adb-chart-canvas { flex: 1; width: 100%; min-height: 220px; }
.adb-chart-tile-desc { font-size: 0.76rem; color: #94a3b8; line-height: 1.5; margin-top: 6px; }

.adb-live-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border, #e2e8f0); flex-wrap: wrap; }
[data-theme="dark"] .adb-live-foot { border-top-color: #1e293b; }
.adb-live-hint { font-size: 0.78rem; color: #94a3b8; }
`;
})();
