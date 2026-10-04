/* ════════════════════════════════════════════════════════════════════════════
   exec-ai-brief.js — Runtime Groq-powered AI brief for executive dashboard pages
   - Watches for the [data-ai-brief] card rendered by dash-suite.js
   - Fetches the dashboard's JSON payload (same JSON dash-suite used to render)
   - Calls Groq with the SAME honest 4-part brief system prompt as visual-chat.js
   - Streams the response into the 4 cells (what / why / next / do)
   - Falls back to the static notes if no Groq key or on error
   - Sets the AI-wired badge state: streaming -> live, or fallback
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Config (mirror visual-chat.js + contact-chat.js) ────────────────────
  var CONFIG = {
    provider: localStorage.getItem('docchat.provider') || 'demo',
    proxyUrl: localStorage.getItem('docchat.groq.proxyUrl') || '',
    groqModel: localStorage.getItem('docchat.groq.model') || 'qwen/qwen3.8-27b'
  };

  // Expose a promise so callers can wait for the config to load before
  // deciding whether Groq is truly available. This prevents premature
  // fallback to static content while the async config fetch is in flight.
  var configPromise = (function () {
    return fetch('../data/groq-config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        if (cfg.provider && !localStorage.getItem('docchat.provider'))
          CONFIG.provider = cfg.provider;
        if (cfg.proxyUrl) {
          CONFIG.proxyUrl = cfg.proxyUrl;
          try { localStorage.setItem('docchat.groq.proxyUrl', cfg.proxyUrl); } catch (_) {}
        }
        if (cfg.groqModel) CONFIG.groqModel = cfg.groqModel;
      })
      .catch(function () {});
  })();

  // ─── Detect the JSON path for the current page ───────────────────────────
  function detectJsonPath() {
    var suite = document.body.dataset.suite;
    if (!suite) return null;
    // Executive suites use data/executive/<suite>.json
    var execKeys = ['ar', 'payments', 'disconnects', 'ebill', 'finalbill', 'chatters'];
    if (execKeys.indexOf(suite) >= 0) return '../data/executive/' + suite + '.json';
    // CSR + ITS suites use data/versions/<suite>.json
    if (suite.indexOf('csr-') === 0 || suite.indexOf('its-') === 0) {
      return '../data/versions/' + suite + '.json';
    }
    return null;
  }

  // ─── Build the visual context from the JSON payload ─────────────────────
  // Handles two formats: executive (metrics + charts + notes) and CSR/ITS
  // (per-visual data objects with rows, keyed by visual ID)
  function buildVisualContext(d) {
    if (!d) return '';
    var parts = [];

    // Executive format: has 'metrics' and 'charts' arrays
    if (d.metrics || d.charts) {
      parts.push('Dashboard: ' + (d.title || ''));
      parts.push('Version: ' + (d.key || ''));
      if (d.asOfLabel) parts.push('Period: ' + d.asOfLabel);
      parts.push('');

      if (d.metrics && d.metrics.length) {
        parts.push('KPIs:');
        d.metrics.forEach(function(m, i) {
          parts.push('  [' + (i + 1) + '] ' + m.label + ': ' + m.value +
            (m.format === 'currency' ? ' CAD' : '') +
            (m.format === 'percent' || m.format === 'percent2' ? '%' : '') +
            (m.mom != null ? ' (MoM: ' + (m.mom > 0 ? '+' : '') + m.mom + (m.deltaMode === 'points' ? ' pts' : '%') + ')' : '') +
            (m.yoy != null ? ' (YoY: ' + (m.yoy > 0 ? '+' : '') + m.yoy + (m.deltaMode === 'points' ? ' pts' : '%') + ')' : ''));
        });
        parts.push('');
      }

      if (d.charts && d.charts.length) {
        parts.push('Charts:');
        d.charts.forEach(function(c, i) {
          parts.push('  [' + (i + 1) + '] ' + c.title + ' (' + c.kind + ')');
          if (c.categories && c.categories.length) parts.push('      Categories: ' + c.categories.join(', '));
          if (c.series && c.series.length) {
            c.series.forEach(function(s) {
              var dataStr = (s.data || []).map(function(v) {
                if (v === null || v === undefined) return '—';
                return typeof v === 'number' ? v.toLocaleString() : v;
              }).join(', ');
              parts.push('      ' + s.name + ': [' + dataStr + ']');
            });
          }
        });
        parts.push('');
      }

      if (d.tables && d.tables.length) {
        parts.push('Tables:');
        d.tables.forEach(function(t, i) {
          parts.push('  [' + (i + 1) + '] ' + t.title);
          if (t.columns && t.columns.length) parts.push('      Columns: ' + t.columns.join(', '));
          if (t.rows && t.rows.length) {
            parts.push('      Rows: ' + t.rows.length);
            t.rows.slice(0, 3).forEach(function(r, j) {
              var rowStr = t.columns.map(function(col) { return col + '=' + (r[col] != null ? r[col] : '—'); }).join(', ');
              parts.push('      Row ' + (j + 1) + ': ' + rowStr);
            });
            if (t.rows.length > 3) parts.push('      ... (' + (t.rows.length - 3) + ' more rows)');
          }
        });
        parts.push('');
      }

      return parts.join('\n');
    }

    // CSR/ITS format: per-visual data objects keyed by visual ID
    var meta = d._meta || {};
    parts.push('Dashboard: ' + (meta.title || ''));
    parts.push('Version: ' + (meta.version || ''));
    parts.push('');

    var visualKeys = Object.keys(d).filter(function(k) { return k !== '_meta'; });
    if (visualKeys.length) {
      parts.push('Visuals on this canvas:');
      visualKeys.forEach(function(vk, i) {
        var vd = d[vk];
        var rows = vd.rows || vd.data || [];
        if (rows && rows.length) {
          parts.push('  [' + (i + 1) + '] ' + vk + ' (' + rows.length + ' rows)');
          // Show first 3 rows
          rows.slice(0, 3).forEach(function(r, j) {
            if (typeof r === 'object') {
              var rowStr = Object.keys(r).map(function(k) { return k + '=' + r[k]; }).join(', ');
              parts.push('      Row ' + (j + 1) + ': ' + rowStr);
            } else {
              parts.push('      Row ' + (j + 1) + ': ' + r);
            }
          });
          if (rows.length > 3) parts.push('      ... (' + (rows.length - 3) + ' more rows)');
        }
      });
    }

    return parts.join('\n');
  }

  // ─── Honest system prompt — identical rules to visual-chat.js ────────────
  function buildSystemPrompt(visualContext) {
    return [
      'You are Dashboards Studio, an analytics assistant producing an executive brief for a specific dashboard.',
      'You have access to the dashboard\'s data payload below. Your job is to produce an honest, structured analysis.',
      '',
      'OUTPUT FORMAT — exactly 4 lines, each starting with the section header in uppercase followed by a colon:',
      '  WHAT HAPPENED: <one or two sentences stating the factual change, citing actual metric labels and delta values from the data>',
      '  WHY: <one or two sentences of real business reasoning about what likely drove the change. Use the data signals visible in the payload — KPI deltas, chart series trends, table breakdowns, period-over-period comparisons, segment splits — to form a hypothesis. Use language like "the pattern suggests...", "likely drivers include...", "this likely reflects...", or "the disparity between X and Y points to...". NEVER say "Driver not isolated in this payload" — that is a non-answer. If the payload has ANY signal (one segment growing faster than another, capacity saturation, seasonality, a divergence between two KPIs, a step-change in a chart series), use it to form a business hypothesis. Only if the payload is genuinely empty of any signal may you say so — but that is rare.>',
      '  WHAT TO EXPECT: <one sentence describing the direction the trend points IF IT CONTINUES. Do NOT produce a specific forecast number. Do NOT attach a confidence percentage. Use phrases like "if the current trend continues" or "the trajectory suggests">',
      '  WHAT TO DO: <one or two sentences of actionable recommendation grounded in the data pattern. If the data lacks the granularity to recommend a specific action, say what additional breakdown would be needed>',
      '',
      'HARD RULES (non-negotiable):',
      '1. Every number you cite MUST come from the provided data. Do not invent metrics, percentages, or dollar figures.',
      '2. NEVER produce a calibrated confidence percentage (e.g., "82% confidence"). You are not a statistical model.',
      '3. NEVER produce a specific point forecast (e.g., "next-month revenue +3.9%"). Direction only.',
      '4. NEVER attribute to specific stores, regions, or units unless the payload contains that granularity. If asked, say the payload is aggregated.',
      '5. NEVER compute "annualized opportunity" or "$X opportunity" unless the payload contains the full unit-economics chain.',
      '6. Keep the entire response under 200 words. Tight prose, no filler, no preamble before WHAT HAPPENED.',
      '',
      'DASHBOARD DATA:',
      visualContext || '(no visual data loaded)'
    ].join('\n');
  }

  // ─── Groq streaming (via Netlify edge function proxy) ────────────────────
  async function groqChat(messages, onToken) {
    if (!CONFIG.proxyUrl) throw new Error('Groq proxy URL not configured');
    var res = await fetch(CONFIG.proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CONFIG.groqModel,
        messages: messages,
        temperature: 0.3,
        max_tokens: 1200,
        stream: true,
      })
    });
    if (!res.ok) {
      var err = await res.text();
      throw new Error('Groq API error (' + res.status + '): ' + err.slice(0, 200));
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '', fullText = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (trimmed.indexOf('data:') !== 0) continue;
        var data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          var evt = JSON.parse(data);
          if (evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content) {
            fullText += evt.choices[0].delta.content;
            if (onToken) onToken(evt.choices[0].delta.content);
          }
        } catch (_) {}
      }
    }
    return fullText;
  }

  // ─── Parse the streamed brief into 4 sections ───────────────────────────
  // Expected: each line starts with one of "WHAT HAPPENED:", "WHY:",
  // "WHAT TO EXPECT:", "WHAT TO DO:". Returns {what, why, next, do}.
  function parseBrief(text) {
    var out = { what: '', why: '', next: '', do: '' };
    if (!text) return out;
    var lines = text.split('\n');
    var current = null;
    // Strip leading markdown/list prefixes before matching the section header.
    // Handles: **WHAT HAPPENED:**, - WHAT HAPPENED:, 1. WHAT HAPPENED:, ## WHAT HAPPENED:
    function stripPrefix(line) {
      return line.replace(/^[\s\*#\-\.\d]+:?/, '').trim();
    }
    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var stripped = stripPrefix(line);
      var upper = stripped.toUpperCase();
      // Strip trailing ** too (e.g., "**WHY:**" → after stripPrefix → "WHY:**" → upper "WHY:**")
      // Match header at start, allow trailing : or :** or whitespace
      var headerMatch = upper.match(/^(WHAT HAPPENED|WHY|WHAT TO EXPECT|WHAT TO DO)\s*[:\*]*/);
      if (headerMatch) {
        var header = headerMatch[1];
        // Find where the header ends in the original stripped line + skip past colons/stars
        var headerEnd = stripped.toUpperCase().indexOf(header) + header.length;
        var rest = stripped.slice(headerEnd).replace(/^[:\*\s\#]+/, '').trim();
        if (header === 'WHAT HAPPENED') { current = 'what'; out.what += rest + ' '; }
        else if (header === 'WHY') { current = 'why'; out.why += rest + ' '; }
        else if (header === 'WHAT TO EXPECT') { current = 'next'; out.next += rest + ' '; }
        else if (header === 'WHAT TO DO') { current = 'do'; out.do += rest + ' '; }
      } else if (current) {
        out[current] += line + ' ';
      }
    });
    Object.keys(out).forEach(function (k) { out[k] = out[k].trim(); });
    return out;
  }

  // ─── Render streamed tokens into the 4 cells in real time ────────────────
  // As tokens arrive, we re-parse the partial text and update only the
  // currently-filling cell, so the user sees each section build live.
  function streamIntoCells(partialText, briefHost) {
    var parsed = parseBrief(partialText);
    var sectionMap = { what: 'what', why: 'why', next: 'next', do: 'do' };
    Object.keys(sectionMap).forEach(function (key) {
      var cell = briefHost.querySelector('[data-section="' + key + '"] [data-brief-body]');
      if (cell) {
        cell.textContent = parsed[key] || '';
        // Show shimmer cursor on the currently-filling cell
        cell.setAttribute('data-loading', parsed[key] ? 'false' : 'true');
      }
    });
    // Mark the last non-empty cell as still streaming
    var lastFilled = ['what', 'why', 'next', 'do'].filter(function (k) {
      return parsed[k];
    }).pop();
    if (lastFilled) {
      var cell = briefHost.querySelector('[data-section="' + lastFilled + '"] [data-brief-body]');
      if (cell) cell.setAttribute('data-loading', 'true');
    }
  }

  function clearShimmer(briefHost) {
    briefHost.querySelectorAll('[data-brief-body]').forEach(function (cell) {
      cell.removeAttribute('data-loading');
    });
  }

  function setBadgeState(briefHost, state) {
    var badge = briefHost.querySelector('[data-ai-badge]');
    if (!badge) return;
    if (state) badge.setAttribute('data-state', state);
    else badge.removeAttribute('data-state');
    var txt = badge.querySelector('.exec-ai-brief-badge-text');
    if (!txt) return;
    if (state === 'streaming') txt.textContent = 'AI generating…';
    else if (state === 'cached') txt.textContent = 'AI-wired · cached';
    else if (state === 'fallback') txt.textContent = 'Static (AI offline)';
    else txt.textContent = 'AI-wired';
  }

  // ─── 1-hour localStorage cache for the AI Brief ─────────────────────────
  // The AI Brief auto-fires on every Chatters page load (~2400 tokens per
  // call). Without caching, 50 page refreshes = ~120K tokens = 60% of the
  // free-tier daily TPD budget just for one user. With a 1-hour cache:
  //   - First visit: 1 Groq call (2400 tokens)
  //   - Refreshes within 1hr: 0 Groq calls (cached)
  //   - Visit after 1hr: 1 fresh Groq call, then cached again
  // Net: ~80% reduction in token usage for normal demo traffic.
  // Keyed by version (so chatters.json != ar.json) + payload hash (so a
  // new period invalidates the cache automatically).
  var BRIEF_CACHE_PREFIX = 'exec-ai-brief:v1:';
  var BRIEF_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour

  function payloadHash(payload) {
    // Cheap hash: title + asOfLabel + first 3 metric values + first 3 chart titles
    // — enough to invalidate when period data changes, but not sensitive to
    // every byte (which would invalidate on every reload due to timestamps)
    if (!payload) return '0';
    var parts = [
      payload.title || '',
      payload.asOfLabel || '',
      payload.generatedUtc || '',
      (payload.metrics || []).slice(0, 3).map(function(m) {
        return m.label + '=' + m.value + '|' + (m.mom != null ? m.mom : '') + '|' + (m.yoy != null ? m.yoy : '');
      }).join(';'),
      (payload.charts || []).slice(0, 3).map(function(c) { return c.id + ':' + (c.categories || []).length; }).join(';')
    ];
    var s = parts.join('||');
    // FNV-1a 32-bit — fast, no deps
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function getCachedBrief(versionKey, payload) {
    try {
      var raw = localStorage.getItem(BRIEF_CACHE_PREFIX + versionKey + ':' + payloadHash(payload));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || !entry.ts || !entry.parsed) return null;
      if (Date.now() - entry.ts > BRIEF_CACHE_TTL_MS) {
        localStorage.removeItem(BRIEF_CACHE_PREFIX + versionKey + ':' + payloadHash(payload));
        return null;
      }
      return entry.parsed;
    } catch (_) { return null; }
  }

  function setCachedBrief(versionKey, payload, parsed) {
    try {
      localStorage.setItem(BRIEF_CACHE_PREFIX + versionKey + ':' + payloadHash(payload), JSON.stringify({
        ts: Date.now(),
        parsed: parsed
      }));
    } catch (_) {
      // localStorage might be full (private mode, etc.) — silently skip
    }
  }

  // ─── Run the brief generation for the current page ───────────────────────
  async function runBrief() {
    var briefHost = document.querySelector('[data-ai-brief]');
    if (!briefHost) return; // page has no brief card

    var jsonPath = detectJsonPath();
    if (!jsonPath) return;

    // Show shimmer + 'AI generating…' immediately — no static content shown
    // upfront. Static notes are ONLY revealed if Groq is truly offline.
    briefHost.querySelectorAll('[data-brief-body]').forEach(function (cell) {
      cell.textContent = '';
      cell.setAttribute('data-loading', 'true');
    });
    setBadgeState(briefHost, 'streaming');

    // Wait for the async Groq config to finish loading before deciding
    // whether to use Groq or fall back. This avoids the premature fallback
    // that happened when CONFIG.proxyUrl was checked before the fetch resolved.
    await configPromise;

    // Fetch the dashboard JSON in parallel with the config wait
    var payload;
    try {
      var res = await fetch(jsonPath, { cache: 'no-store' });
      if (!res.ok) { restoreStaticBrief(briefHost, null); return; }
      payload = await res.json();
    } catch (e) {
      console.warn('exec-ai-brief: payload fetch failed', e);
      restoreStaticBrief(briefHost, null);
      return;
    }

    // Truly no Groq proxy configured (not in localStorage, not in config JSON)
    if (CONFIG.provider !== 'groq' || !CONFIG.proxyUrl) {
      restoreStaticBrief(briefHost, payload);
      return;
    }

    // ─── CACHE CHECK ──────────────────────────────────────────────────────
    // If we have a cached brief for this version + payload hash from the
    // last hour, populate the cells from cache and skip the Groq call
    // entirely. This is the single biggest token-saver — without it, every
    // page load burns ~2400 tokens even if the user just refreshed.
    var versionKey = document.body.dataset.suite || 'unknown';
    var cached = getCachedBrief(versionKey, payload);
    if (cached) {
      ['what', 'why', 'next', 'do'].forEach(function (sec) {
        var cell = briefHost.querySelector('[data-section="' + sec + '"] [data-brief-body]');
        if (cell) cell.textContent = cached[sec] || '';
      });
      clearShimmer(briefHost);
      setBadgeState(briefHost, 'cached');
      return;
    }

    // ─── NO CACHE — call Groq and stream the response ─────────────────────
    var visualContext = buildVisualContext(payload);
    var messages = [
      { role: 'system', content: buildSystemPrompt(visualContext) },
      { role: 'user', content: 'Produce the 4-part brief (WHAT HAPPENED / WHY / WHAT TO EXPECT / WHAT TO DO) based strictly on the dashboard data. Respect every hard rule in the system prompt.' }
    ];

    // Cells already cleared + shimmer on. Stream the response.
    var partial = '';
    try {
      await groqChat(messages, function (token) {
        partial += token;
        streamIntoCells(partial, briefHost);
      });
      clearShimmer(briefHost);
      setBadgeState(briefHost, null); // back to default "AI-wired"
      // Cache the parsed result for next time (1-hour TTL)
      setCachedBrief(versionKey, payload, parseBrief(partial));
    } catch (e) {
      console.warn('exec-ai-brief: Groq call failed, falling back to static notes', e);
      restoreStaticBrief(briefHost, payload);
    }
  }

  // ─── Restore the brief from static notes (only on true Groq offline) ─────
  function restoreStaticBrief(briefHost, payload) {
    clearShimmer(briefHost);
    setBadgeState(briefHost, 'fallback');
    if (!payload || !payload.notes || !payload.notes.length) {
      // No static notes either — show a clean "AI offline" message in each cell
      var offlineMsg = 'AI is offline — refresh in a moment, or open Visual Chat below to ask directly.';
      ['what', 'why', 'next', 'do'].forEach(function (sec) {
        var cell = briefHost.querySelector('[data-section="' + sec + '"] [data-brief-body]');
        if (cell) cell.textContent = sec === 'what' ? offlineMsg : '';
      });
      return;
    }
    // Re-populate the 4 cells with the honest static notes
    var sectionOrder = ['what', 'why', 'next', 'do'];
    sectionOrder.forEach(function (sec, i) {
      if (!payload.notes[i]) return;
      var cell = briefHost.querySelector('[data-section="' + sec + '"] [data-brief-body]');
      if (cell) cell.textContent = payload.notes[i].replace(/^[A-Z ]+:/, '').trim();
    });
  }

  // ─── Init — wait for dash-suite.js to render the brief card ──────────────
  function init() {
    // Mark ourselves active so dash-suite.js knows NOT to pre-populate the
    // brief cells with static notes — we'll stream Groq tokens in instead
    // (and only fall back to static if Groq is truly offline).
    window.__execAiBriefActive = true;

    // dash-suite.js renders asynchronously; poll briefly for the brief host
    var tries = 0;
    function check() {
      var briefHost = document.querySelector('[data-ai-brief]');
      if (briefHost) {
        runBrief();
        return;
      }
      tries++;
      if (tries < 30) setTimeout(check, 200); // up to 6s
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check);
    } else {
      check();
    }
  }

  if (document.body.dataset.suite) init();

})();
