/* ════════════════════════════════════════════════════════════════════════════
   visual-chat.js — Floating chat widget for version canvas pages
   - Detects which version is open (executive / CSR / ITS)
   - Fetches the corresponding JSON payload
   - Adds visual data to the Groq system prompt as context
   - Streams answers from Groq with visual data citations
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Config (same as api.js) ──────────────────────────────────────────────
  var CONFIG = {
    provider: localStorage.getItem('docchat.provider') || 'demo',
    proxyUrl: localStorage.getItem('docchat.groq.proxyUrl') || '',
    groqModel: localStorage.getItem('docchat.groq.model') || 'qwen/qwen3.8-27b'
  };

  // Expose a promise so ask() can wait for the config to finish loading
  // before deciding whether Groq is truly offline. Without this, the first
  // message a user sends (before the async fetch resolves) would get a
  // canned offline message even though the proxy IS configured in
  // data/groq-config.json.
  var configPromise = (function autoLoad() {
    return fetch('../data/groq-config.json', { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(cfg) {
        if (!cfg) return;
        if (cfg.provider && !localStorage.getItem('docchat.provider'))
          CONFIG.provider = cfg.provider;
        if (cfg.proxyUrl) {
          CONFIG.proxyUrl = cfg.proxyUrl;
          try { localStorage.setItem('docchat.groq.proxyUrl', cfg.proxyUrl); } catch(_){}
        }
        if (cfg.groqModel) CONFIG.groqModel = cfg.groqModel;
      })
      .catch(function() {});
  })();

  // ─── State ────────────────────────────────────────────────────────────────
  var state = {
    visualData: null,       // the JSON payload for this version
    versionKey: '',         // e.g. 'ar', 'ebill', 'csr-aging-overview'
    versionTitle: '',       // e.g. 'AR Portfolio Executive Summary'
    isOpen: false,
    isStreaming: false,
    messages: []
  };

  // ─── Detect which version we're on ────────────────────────────────────────
  function detectVersion() {
    var suite = document.body.dataset.suite || '';
    var path = window.location.pathname;
    var filename = path.split('/').pop().replace('.html', '');

    // Executive versions: data-suite="ar" → data/executive/ar.json
    var execKeys = ['ar', 'payments', 'disconnects', 'ebill', 'finalbill'];
    if (execKeys.indexOf(suite) >= 0) {
      return { key: suite, title: suite.toUpperCase() + ' Executive', jsonPath: '../data/executive/' + suite + '.json' };
    }

    // CSR + ITS canvas versions: data-suite="csr-aging-overview"
    if (suite.indexOf('csr-') === 0 || suite.indexOf('its-') === 0) {
      return { key: suite, title: suite, jsonPath: '../data/versions/' + suite + '.json' };
    }

    // Executive by filename
    if (filename.indexOf('executive-') === 0) {
      var key = filename.replace('executive-', '').replace('-portfolio', '').replace('-payments', '')
        .replace('-bankruptcies', '').replace('-performance', '').replace('-recovery', '');
      // Map back to exec keys
      var keyMap = { 'ar': 'ar', 'customer': 'payments', 'disconnects': 'disconnects', 'ebill': 'ebill', 'final-bill': 'finalbill' };
      var mapped = keyMap[key] || key;
      return { key: mapped, title: filename, jsonPath: '../data/executive/' + mapped + '.json' };
    }

    return null;
  }

  // ─── Load visual data for context ────────────────────────────────────────
  async function loadVisualData() {
    var info = detectVersion();
    if (!info) return;

    state.versionKey = info.key;
    state.versionTitle = info.title;

    try {
      var res = await fetch(info.jsonPath, { cache: 'no-store' });
      if (!res.ok) return;
      state.visualData = await res.json();
    } catch (e) {
      console.warn('Visual chat: could not load visual data', e);
    }
  }

  // ─── Build context from visual data ──────────────────────────────────────
  function buildVisualContext() {
    if (!state.visualData) return '';

    var d = state.visualData;
    var parts = [];

    // Title + version
    parts.push('Dashboard: ' + (d.title || state.versionTitle));
    parts.push('Version: ' + (d.key || state.versionKey));
    if (d.asOfLabel) parts.push('Period: ' + d.asOfLabel);
    parts.push('');

    // Metrics (KPIs)
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

    // Charts summary
    if (d.charts && d.charts.length) {
      parts.push('Charts:');
      d.charts.forEach(function(c, i) {
        parts.push('  [' + (i + 1) + '] ' + c.title + ' (' + c.kind + ')');
        if (c.categories && c.categories.length) {
          parts.push('      Categories: ' + c.categories.join(', '));
        }
        if (c.series && c.series.length) {
          c.series.forEach(function(s, j) {
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

    // Tables summary
    if (d.tables && d.tables.length) {
      parts.push('Tables:');
      d.tables.forEach(function(t, i) {
        parts.push('  [' + (i + 1) + '] ' + t.title);
        if (t.columns && t.columns.length) {
          parts.push('      Columns: ' + t.columns.join(', '));
        }
        if (t.rows && t.rows.length) {
          parts.push('      Rows: ' + t.rows.length);
          // Include first 3 rows as sample
          t.rows.slice(0, 3).forEach(function(r, j) {
            var rowStr = t.columns.map(function(col) {
              return col + '=' + (r[col] != null ? r[col] : '—');
            }).join(', ');
            parts.push('      Row ' + (j + 1) + ': ' + rowStr);
          });
          if (t.rows.length > 3) parts.push('      ... (' + (t.rows.length - 3) + ' more rows)');
        }
      });
      parts.push('');
    }

    // Notes
    if (d.notes && d.notes.length) {
      parts.push('Notes:');
      d.notes.forEach(function(n) { parts.push('  - ' + n); });
    }

    // For canvas versions (CSR + ITS), also include individual visual data
    if (state.visualData._meta || (state.visualData && !state.visualData.metrics)) {
      // This is a canvas payload — data is keyed by visual ID
      var visualKeys = Object.keys(state.visualData).filter(function(k) { return k !== '_meta'; });
      if (visualKeys.length && !d.metrics) {
        parts = ['Dashboard: ' + state.versionTitle, 'Version: ' + state.versionKey, ''];
        parts.push('Visuals on this canvas:');
        visualKeys.forEach(function(vk, i) {
          var vd = state.visualData[vk];
          var rows = vd.data || vd.rows || [];
          if (rows.length) {
            parts.push('  [' + (i + 1) + '] ' + vk + ' (' + rows.length + ' rows)');
            // Include first 2 rows as sample
            rows.slice(0, 2).forEach(function(r, j) {
              var rowStr = Object.keys(r).map(function(k) {
                return k + '=' + r[k];
              }).join(', ');
              parts.push('      Row ' + (j + 1) + ': ' + rowStr);
            });
            if (rows.length > 2) parts.push('      ... (' + (rows.length - 2) + ' more rows)');
          }
        });
      }
    }

    return parts.join('\n');
  }

  // ─── Groq streaming chat (via Netlify edge function proxy) ───────────────
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
    var buffer = '';
    var fullText = '';

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

  // ─── System prompt — honest structured analysis ──────────────────────────
  // Demands a 4-part brief (WHAT HAPPENED / WHY / WHAT TO EXPECT / WHAT TO DO)
  // but explicitly forbids invented confidence %s, fabricated forecasts, and
  // store-level attribution when the payload is aggregated. Only produces
  // statements that can be derived directly from the provided JSON.
  function buildSystemPrompt(visualContext) {
    return [
      'You are Dashboards Studio, an analytics assistant that answers questions about a specific dashboard.',
      'You have access to the dashboard\'s data payload below. Your job is to produce an honest, structured analysis.',
      '',
      'OUTPUT FORMAT — always use these 4 sections, each on its own line, with the section header in uppercase followed by a colon:',
      '  WHAT HAPPENED: <one or two sentences stating the factual change, citing actual metric labels and delta values from the data>',
      '  WHY: <one or two sentences of real business reasoning about what likely drove the change. Use the data signals visible in the payload — KPI deltas, chart series trends, table breakdowns, period-over-period comparisons, segment splits — to form a hypothesis. Use language like "the pattern suggests...", "likely drivers include...", "this likely reflects...", or "the disparity between X and Y points to...". NEVER say "Driver not isolated in this payload" — that is a non-answer. If the payload has ANY signal (one segment growing faster than another, capacity saturation, seasonality, a divergence between two KPIs, a step-change in a chart series), use it to form a business hypothesis. Only if the payload is genuinely empty of any signal may you say so — but that is rare.>',
      '  WHAT TO EXPECT: <one sentence describing the direction the trend points IF IT CONTINUES. Do NOT produce a specific forecast number. Do NOT attach a confidence percentage. Use phrases like "if the current trend continues" or "the trajectory suggests">',
      '  WHAT TO DO: <one or two sentences of actionable recommendation grounded in the data pattern. If the data lacks the granularity to recommend a specific action, say what additional breakdown would be needed>',
      '',
      'HARD RULES (these are non-negotiable):',
      '1. Every number you cite MUST come from the provided data. Do not invent metrics, percentages, or dollar figures.',
      '2. NEVER produce a calibrated confidence percentage (e.g., "82% confidence", "P=0.9"). You are not a statistical model. If you want to express certainty, use qualitative language ("strong signal", "weak signal", "mixed").',
      '3. NEVER produce a specific point forecast (e.g., "next-month revenue +3.9%"). You may describe direction only.',
      '4. NEVER attribute to specific stores, regions, or units unless the data payload actually contains that granularity. If asked, state that the payload is aggregated and store-level attribution is not available.',
      '5. NEVER compute "annualized opportunity" or "$X opportunity" unless the payload contains the full unit-economics chain (unit count × rate × frequency × time). If the chain is missing, say the figure cannot be derived.',
      '6. If the user\'s question cannot be answered from the data, say so directly. Do not extrapolate beyond what the JSON shows.',
      '7. Keep the entire response under 200 words. Tight prose, no filler, no preamble before WHAT HAPPENED.',
      '8. If the user asks a general question about Insight Analytics, the platform, the tech stack, the PWA, the theming, the Netlify proxy, or any other non-dashboard-data topic (e.g., "what is this site?", "how does the AI work?", "is this a PWA?"), do NOT try to produce a 4-part brief. Instead, briefly note what you can see on this page and suggest they use the Contact bot in the footer for platform-level questions — it has the full knowledge base of implemented solutions.',
      '',
      'DASHBOARD DATA:',
      visualContext || '(no visual data loaded — if no data is shown, tell the user the dashboard payload could not be loaded)'
    ].join('\n');
  }

  // ─── 30-min localStorage cache for repeat questions ─────────────────────
  // Keyed by (version + question) so the same question on different
  // dashboards gets different cached answers.
  var QA_CACHE_PREFIX = 'visual-qa:v1:';
  var QA_CACHE_TTL_MS = 30 * 60 * 1000;

  function qaHash(versionKey, question) {
    var s = (versionKey || '') + '|' + question.toLowerCase().trim().replace(/\s+/g, ' ');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function getCachedAnswer(versionKey, question) {
    try {
      var raw = localStorage.getItem(QA_CACHE_PREFIX + qaHash(versionKey, question));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || !entry.ts || !entry.answer) return null;
      if (Date.now() - entry.ts > QA_CACHE_TTL_MS) {
        localStorage.removeItem(QA_CACHE_PREFIX + qaHash(versionKey, question));
        return null;
      }
      return entry.answer;
    } catch (_) { return null; }
  }

  function setCachedAnswer(versionKey, question, answer) {
    try {
      localStorage.setItem(QA_CACHE_PREFIX + qaHash(versionKey, question), JSON.stringify({
        ts: Date.now(),
        answer: answer
      }));
    } catch (_) {}
  }

  // ─── Platform-question deflection ───────────────────────────────────────
  // The visual chat's job is dashboard-data Q&A. When users ask platform-level
  // questions (about IA, PWA, Netlify, theming, the 8-step methodology, etc.),
  // the LLM should deflect to the contact bot (which has the full IA_FACTS KB).
  // BUT poolside/laguna-s-2.1 is a coding model that inconsistently follows
  // that instruction — sometimes it deflects, sometimes it produces a brief
  // instead. This keyword detector is 100% reliable: if the question matches
  // platform keywords, we return a canned deflection WITHOUT calling Groq
  // (saves tokens + guarantees the right behavior).
  var PLATFORM_PATTERNS = [
    /\b(your|you|yours|insight analytics|ia\b|the company|the firm|the team)\b/i,
    /\b(consulting|approach|methodology|8-step|5-part|philosophy|deck|brief format)\b/i,
    /\b(pwa|progressive web app|installable|offline|service worker|manifest)\b/i,
    /\b(netlify|proxy|edge function|server-side|cloudflare)\b/i,
    /\b(groq|openrouter|api key|ai-wired|ai wired|llm|model|qwen|poolside|gemini)\b/i,
    /\b(theme|dark mode|light mode|vivid|css variables|responsive|mobile)\b/i,
    /\b(safari|cache|drag|resize|layout persistence|localstorage)\b/i,
    /\b(what is this site|what do you do|what kind of work|what services|what can you)\b/i,
    /\b(how does the ai work|how does the bot work|how does this work)\b/i,
    /\b(dashboard platform|dashboard studio|github pages|static site)\b/i,
    /\b(data → understanding|data to understanding|prediction → action)\b/i,
    /\b(connect what|automate|govern|ai first reader|close the loop)\b/i,
  ];

  // Dashboard-data keywords — if these are present, it's a dashboard question
  // and should go through the normal Grok brief path (not be deflected).
  // NOTE: keep these specific to dashboard data — don't include common words
  // like "do", "why", "expect" (those are part of the 4-part brief format
  // but also appear in platform questions like "What do you do?").
  var DASHBOARD_KEYWORDS = /\b(revenue|kpi|metric|chart|data|trend|period|mom|yoy|growth|decline|driver|happened|segment|breakdown|performance|utilization|capacity|retail|site|ontario|attachment|churn|arrears|disconnects|tickets|sla)\b/i;

  function isPlatformQuestion(question) {
    var q = question.toLowerCase().trim();
    // If the question contains dashboard-data keywords, it's a dashboard question
    if (DASHBOARD_KEYWORDS.test(q)) return false;
    // Otherwise, check if it matches any platform pattern
    return PLATFORM_PATTERNS.some(function(p) { return p.test(q); });
  }

  function deflectToContactBot(onToken) {
    var msg = "I'm the visual chat for this dashboard — I answer questions about the data on this page (KPIs, charts, trends).\n\n" +
      "For platform-level questions about Insight Analytics (the 8-step methodology, PWA features, Netlify proxy, theming, etc.), open the **Contact bot** in the footer — it has the full knowledge base of all implemented solutions.\n\n" +
      "Or reach out directly:\n" +
      "  • Email: dev@insight-analytics.ca\n" +
      "  • Phone: (289) 635-9915";
    if (onToken) {
      var tokens = msg.match(/\S+\s*/g) || [msg];
      var i = 0;
      function nextToken() {
        if (i >= tokens.length) return;
        onToken(tokens[i]);
        i++;
        setTimeout(nextToken, 12);
      }
      nextToken();
    }
    return msg;
  }

  async function ask(question, onToken) {
    // ─── PLATFORM-QUESTION DEFLECTION (before any Grok call) ──────────────
    // If the question is clearly about the platform/IA/tech stack rather than
    // the dashboard data, deflect to the contact bot immediately. Saves tokens
    // + guarantees consistent behavior regardless of LLM compliance.
    if (isPlatformQuestion(question)) {
      return deflectToContactBot(onToken);
    }

    var visualContext = buildVisualContext();

    var userPrompt = 'Question: ' + question + '\n\n' +
      'Produce the 4-part brief (WHAT HAPPENED / WHY / WHAT TO EXPECT / WHAT TO DO) based strictly on the dashboard data. ' +
      'Respect every hard rule in the system prompt.';

    // Wait for the Groq config to finish loading before deciding whether
    // Groq is truly offline. Without this, the first message a user sends
    // (before the async fetch from data/groq-config.json resolves) would
    // get a canned demo answer even though Groq IS configured.
    await configPromise;

    if (CONFIG.provider === 'groq' && CONFIG.proxyUrl) {
      // ─── CACHE CHECK ──────────────────────────────────────────────────
      var versionKey = state.versionKey || 'unknown';
      var cached = getCachedAnswer(versionKey, question);
      if (cached) {
        if (onToken) {
          var cachedTokens = cached.match(/\S+\s*/g) || [cached];
          for (var ci = 0; ci < cachedTokens.length; ci++) {
            await new Promise(function(r) { setTimeout(r, 12); });
            onToken(cachedTokens[ci]);
          }
        }
        return cached;
      }

      var messages = [
        { role: 'system', content: buildSystemPrompt(visualContext) },
        { role: 'user', content: userPrompt }
      ];
      var answer = await groqChat(messages, onToken);
      setCachedAnswer(versionKey, question, answer);
      return answer;
    }

    // Groq is truly offline (no key in localStorage AND no key in
    // data/groq-config.json). Stream a graceful message that's honest
    // about the AI being offline — not a canned "demo answer" pretending
    // to be a real response.
    var offlineMsg = 'AI is offline — Groq is not configured on this deployment.\n\n' +
      'I can\'t produce a live brief without the AI backend. ' +
      (state.visualData && state.visualData.title
        ? 'This dashboard (' + state.visualData.title + ') still has its charts and KPIs visible — explore them directly, or refresh the page in a moment if this is a temporary outage.'
        : 'Refresh the page in a moment if this is a temporary outage.');
    if (onToken) {
      var tokens = offlineMsg.match(/\S+\s*/g) || [offlineMsg];
      for (var i = 0; i < tokens.length; i++) {
        await new Promise(function(r) { setTimeout(r, 18); });
        onToken(tokens[i]);
      }
    }
    return offlineMsg;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI — floating chat widget
  // ══════════════════════════════════════════════════════════════════════════

  function createWidget() {
    // Inject keyframes for the AI-wired pulse dot (once per page)
    if (!document.getElementById('visualChatAiKeyframes')) {
      var ks = document.createElement('style');
      ks.id = 'visualChatAiKeyframes';
      ks.textContent = '@keyframes visualChatAiPulse{0%,100%{opacity:0.7;transform:scale(1)}50%{opacity:1;transform:scale(1.25)}}';
      document.head.appendChild(ks);
    }

    // Launcher button (bottom-left, above theme toggle)
    var launcher = document.createElement('button');
    launcher.id = 'visualChatLauncher';
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Open visual chat');
    launcher.title = 'Ask about this dashboard';
    launcher.style.cssText = [
      'position:fixed', 'bottom:14px', 'left:14px', 'z-index:9998',
      'width:30px', 'height:30px', 'border-radius:8px',
      'border:1px solid var(--toggle-border, rgba(99,102,241,0.25))',
      'background:var(--toggle-bg, rgba(99,102,241,0.15))',
      'color:var(--toggle-color, #6366f1)',
      'font-size:12px', 'cursor:pointer',
      'display:grid', 'place-items:center',
      'transition:all 220ms cubic-bezier(.22,1,.36,1)',
      'backdrop-filter:blur(10px) saturate(160%)',
      '-webkit-backdrop-filter:blur(10px) saturate(160%)',
      'box-shadow:0 4px 14px rgba(0,0,0,0.18)'
    ].join(';');

    launcher.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    launcher.addEventListener('mouseenter', function() {
      launcher.style.transform = 'translateY(-2px) scale(1.05)';
      launcher.style.boxShadow = '0 8px 24px rgba(99,102,241,0.35)';
    });
    launcher.addEventListener('mouseleave', function() {
      launcher.style.transform = '';
      launcher.style.boxShadow = '0 4px 14px rgba(0,0,0,0.18)';
    });
    launcher.addEventListener('click', toggleChat);

    document.body.appendChild(launcher);

    // Chat panel
    var panel = document.createElement('div');
    panel.id = 'visualChatPanel';
    panel.style.cssText = [
      'position:fixed', 'bottom:52px', 'left:14px', 'z-index:9998',
      'width:380px', 'max-width:calc(100vw - 28px)',
      'height:480px', 'max-height:calc(100vh - 80px)',
      'border-radius:14px',
      'border:1px solid var(--theme-border, rgba(99,102,241,0.20))',
      'background:var(--theme-panel, rgba(255,255,255,0.95))',
      'backdrop-filter:blur(18px) saturate(160%)',
      '-webkit-backdrop-filter:blur(18px) saturate(160%)',
      'box-shadow:0 24px 64px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.15)',
      'display:none', 'flex-direction:column',
      'overflow:hidden',
      'transition:all 220ms cubic-bezier(.22,1,.36,1)'
    ].join(';');

    panel.innerHTML = '' +
      '<div style="padding:8px 12px;border-bottom:1px solid var(--theme-border,rgba(0,0,0,0.08));display:flex;align-items:center;gap:6px;">' +
        '<span style="font-size:11px;font-weight:700;color:var(--theme-text,#171777);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          'Visual Chat' +
        '</span>' +
        '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px 2px 5px;border-radius:9px;border:1px solid rgba(16,185,129,0.35);background:rgba(16,185,129,0.10);color:#10b981;font-size:8px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;" title="Powered by Groq AI">' +
          '<span style="width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor;animation:visualChatAiPulse 1.8s ease-in-out infinite;"></span>' +
          '<span>AI-wired</span>' +
        '</span>' +
        '<button id="visualChatClose" style="width:20px;height:20px;border:0;border-radius:5px;background:transparent;color:var(--theme-muted,#94a3b8);cursor:pointer;font-size:12px;display:grid;place-items:center;">✕</button>' +
      '</div>' +
      '<div id="visualChatMessages" style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;"></div>' +
      '<div style="padding:8px 12px;border-top:1px solid var(--theme-border,rgba(0,0,0,0.08));display:flex;gap:6px;">' +
        '<input id="visualChatInput" type="text" placeholder="Ask about this dashboard…" style="flex:1;background:var(--theme-panel,rgba(255,255,255,0.04));border:1px solid var(--theme-border,rgba(0,0,0,0.10));border-radius:8px;padding:6px 10px;font-size:11px;color:var(--theme-text,#171777);outline:none;">' +
        '<button id="visualChatSend" style="width:30px;height:30px;border:0;border-radius:8px;background:linear-gradient(135deg,var(--theme-primary,#6366f1),var(--theme-accent,#06b6d4));color:#fff;cursor:pointer;display:grid;place-items:center;font-size:11px;flex-shrink:0;">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '</button>' +
      '</div>';

    document.body.appendChild(panel);

    // Wire events
    document.getElementById('visualChatClose').addEventListener('click', toggleChat);
    document.getElementById('visualChatSend').addEventListener('click', handleSend);
    var input = document.getElementById('visualChatInput');
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') handleSend();
    });
  }

  function toggleChat() {
    state.isOpen = !state.isOpen;
    var panel = document.getElementById('visualChatPanel');
    var launcher = document.getElementById('visualChatLauncher');
    if (state.isOpen) {
      panel.style.display = 'flex';
      launcher.style.background = 'var(--theme-primary, #6366f1)';
      launcher.style.color = '#fff';
      // Add welcome message if empty
      var msgs = document.getElementById('visualChatMessages');
      if (msgs.children.length === 0) {
        addMessage('assistant', 'Hi! Ask about this dashboard and I\'ll give you a structured brief: WHAT HAPPENED, WHY, WHAT TO EXPECT, and WHAT TO DO — based strictly on the data on this page. No invented confidence %s or fabricated forecasts.');
      }
      setTimeout(function() { document.getElementById('visualChatInput').focus(); }, 100);
    } else {
      panel.style.display = 'none';
      launcher.style.background = '';
      launcher.style.color = '';
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function(c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function addMessage(role, text) {
    var msgs = document.getElementById('visualChatMessages');
    var div = document.createElement('div');
    div.style.cssText = 'max-width:90%;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.5;' +
      (role === 'user'
        ? 'align-self:flex-end;background:linear-gradient(135deg,var(--theme-primary,#6366f1),var(--theme-accent,#06b6d4));color:#fff;'
        : 'align-self:flex-start;background:var(--theme-panel-hover,rgba(0,0,0,0.04));border:1px solid var(--theme-border,rgba(0,0,0,0.06));color:var(--theme-text,#171777);');
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  async function handleSend() {
    var input = document.getElementById('visualChatInput');
    var text = input.value.trim();
    if (!text || state.isStreaming) return;
    input.value = '';

    addMessage('user', text);
    var assistantDiv = addMessage('assistant', '…');
    state.isStreaming = true;

    try {
      var firstToken = true;
      await ask(text, function(token) {
        if (firstToken) { assistantDiv.textContent = ''; firstToken = false; }
        assistantDiv.textContent += token;
        var msgs = document.getElementById('visualChatMessages');
        msgs.scrollTop = msgs.scrollHeight;
      });
    } catch (e) {
      assistantDiv.textContent = '⚠ ' + e.message;
      assistantDiv.style.color = 'var(--theme-danger, #ef4444)';
    } finally {
      state.isStreaming = false;
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    // Only show on version canvas pages (executive, CSR, ITS)
    var suite = document.body.dataset.suite;
    if (!suite) return;

    createWidget();
    loadVisualData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
