/**
 * ai-search.js — AI-powered search with voice input + suggested questions
 *
 * Features:
 * - Floating gradient button (bottom-right)
 * - Glassmorphic panel with text input + mic button
 * - Voice input via Web Speech API (Chrome, Safari, Edge, mobile)
 * - Pre-built suggested questions appear as clickable pills
 * - Groq streaming response with clickable link cards
 * - Theme-aware (light/dark)
 * - Replaces old assistant.js
 */

(function () {
  'use strict';

  var GROQ_PROXY = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
  var GROQ_MODEL = 'qwen/qwen3.8-27b';
  var SITE_URL = 'https://insight-analytics.ca';

  // Pre-built suggested questions
  // Default suggestions (shown when panel opens, before typing)
  var DEFAULT_SUGGESTIONS = [
    'Do you build dashboards for supply chain?',
    'Can I see a live dashboard demo?',
    'What AI capabilities do you offer?',
    'Do you work with IT service management?'
  ];

  // Keyword → suggestion map. As user types, matching keywords trigger
  // contextual question pills that help them ask better questions.
  var KEYWORD_MAP = [
    { keys: ['dashboard', 'dash', 'visual'], questions: [
      'Can you build a dashboard for my data?',
      'What types of dashboards do you build?',
      'Can I see a live dashboard demo?',
      'What is the universal dashboard constructor?'
    ]},
    { keys: ['supply', 'chain', 'logistic', 'otif', 'freight', 'ship'], questions: [
      'Do you build dashboards for supply chain?',
      'Can I see the supply chain dashboard?',
      'How does OTIF tracking work?'
    ]},
    { keys: ['ai', 'artificial', 'groq', 'llm', 'chatbot', 'brief', 'intelligen'], questions: [
      'What AI capabilities do you offer?',
      'How do your AI briefs work?',
      'Can AI analyze my dashboard data?',
      'Do you use Groq for AI?'
    ]},
    { keys: ['it', 'service', 'ticket', 'sla', 'uptime', 'inciden'], questions: [
      'Do you work with IT service management?',
      'Can I see the IT service health dashboard?',
      'How does SLA tracking work?'
    ]},
    { keys: ['ticker', 'stock', 'market', 'finance', 'portfolio', 'invest', 'trading', 'crypto', 'bitcoin', 'btc', 'eth', 'forex', 'fx', 'commodity', 'oil', 'gold', 'bond', 'yield'], questions: [
      'Can you build a financial markets dashboard?',
      'Do you have a live markets dashboard?',
      'Can you show crypto prices and FX rates?',
      'Do you track S&P 500 and NASDAQ?',
      'Can you build a portfolio analytics dashboard?'
    ]},
    { keys: ['payment', 'finance', 'billing', 'ebill', 'invoic', 'cash'], questions: [
      'Do you have a customer payments dashboard?',
      'How does eBill performance tracking work?',
      'Can you track payment methods?'
    ]},
    { keys: ['risk', 'treasury', 'credit', 'fraud', 'var', 'liquidity'], questions: [
      'Can you build a risk and treasury dashboard?',
      'How does fraud detection work?',
      'What is credit risk heatmap?'
    ]},
    { keys: ['data', 'pipeline', 'etl', 'integration', 'database', 'sql'], questions: [
      'Do you offer data pipeline automation?',
      'Can you integrate my database with dashboards?',
      'What is database archaeology?',
      'How does fuzzy address matching work?'
    ]},
    { keys: ['predict', 'forecast', 'time series', 'model', 'ml', 'machine'], questions: [
      'Do you offer predictive analytics?',
      'Can you forecast from my data?',
      'What is universal time series prediction?',
      'How does weather-driven forecasting work?'
    ]},
    { keys: ['retail', 'store', 'revenue', 'customer', 'ltv', 'segment'], questions: [
      'Do you build retail operations dashboards?',
      'How does customer segmentation work?',
      'Can you track revenue per store?'
    ]},
    { keys: ['demo', 'try', 'test', 'example', 'sample'], questions: [
      'Can I see a live dashboard demo?',
      'What demos are available?',
      'Can I try the dashboard builder?'
    ]},
    { keys: ['power', 'automate', 'workflow', 'pipeline'], questions: [
      'What is personalized Power Automate?',
      'Can you automate my data workflows?'
    ]},
    { keys: ['price', 'cost', 'how much', 'budget', 'quote'], questions: [
      'How much does a dashboard cost?',
      'What is your pricing model?',
      'Can I book a demo?'
    ]},
    { keys: ['theme', 'color', 'design', 'dark', 'light', 'pastel'], questions: [
      'Do your dashboards support dark mode?',
      'What is the pastel palette rotation?',
      'Can I customize dashboard themes?'
    ]},
    { keys: ['edit', 'drag', 'resize', 'move', 'custom', 'layout'], questions: [
      'Can I customize dashboard layouts?',
      'Can I drag and resize dashboard tiles?',
      'Does it work on mobile?'
    ]}
  ];

  var PAGES = [
    { url: '/', title: 'Home — Insight Analytics', desc: 'Executive operating dashboards, AI-assisted briefs, automated data pipelines. 8-step methodology, 50+ production deployments.' },
    { url: '/#services', title: 'Services', desc: 'Dashboard development, AI integration, data pipelines, predictive analytics, .NET web applications.' },
    { url: '/#dashboard', title: 'Live Dashboard Demo', desc: 'Interactive executive dashboards: supply chain, retail operations, IT service health, customer payments, eBill performance.' },
    { url: '/#cases', title: 'Case Studies', desc: '5 production deployments: supply chain OTIF, retail revenue mix, field operations, eBill adoption, IT service operations.' },
    { url: '/blog/', title: 'Live Demos — Blog', desc: 'Production-ready demos: universal dashboard builder, weather load forecast, fuzzy address matching, power automate, database archaeology, time series prediction.' },
    { url: '/insights/', title: 'AI Insights', desc: 'Auto-generated AI analysis on applied AI in business, logistics, supply chain. Updated twice daily.' },
    { url: '/blog/universal-dashboard-builder', title: 'Universal Dashboard Builder', desc: 'A dashboard builder that takes any data source and produces interactive, AI-assisted executive dashboards. 50+ production deployments.' },
    { url: '/blog/weather-load-forecast', title: 'Weather-Driven Load Forecasting', desc: 'Real weather data, interpretable OLS model, 14-day forecast with operational recommendations.' },
    { url: '/blog/fuzzy-address-matching', title: 'Fuzzy Address Matching', desc: 'Fuzzy-matches customer records to service orders by address, validates against Geo API.' },
    { url: '/blog/personalized-power-automate', title: 'Personalized Power Automate', desc: 'Upload a file, describe what to do in plain English, system constructs an executable pipeline.' },
    { url: '/blog/database-archaeology', title: 'Database Archaeology', desc: 'Automated archaeologist that walks through legacy databases, mapping dependencies and explaining logic.' },
    { url: '/blog/universal-time-series-prediction', title: 'Universal Time Series Prediction', desc: 'A predictor that takes any time series — earthquakes, crypto, climate — and produces forecasts.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'Supply Chain Dashboard — Meridian', desc: 'OTIF trend, carrier scorecard, lane heatmap, freight spend, disruption feed. AI brief with save plays.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'SaaS Growth Dashboard — Velocity', desc: 'ARR bridge, cohort retention heatmap, customer health, growth funnel, rule of 40, NRR vs GRR trend.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'Risk & Treasury Dashboard — Sentinel', desc: 'LCR trend, VaR distribution, counterparty exposure, credit risk heatmap, liquidity position, fraud detection.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'Retail Operations Dashboard', desc: 'Revenue mix, store productivity, appointment capacity heatmap, customer segmentation, revenue forecast.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'IT Service Health Dashboard', desc: 'Uptime by service vs SLA, SLA heatmap, ticket volume trend, service status matrix.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'Customer Payments Dashboard', desc: 'Payments volume, payment methods, average days to pay, payment performance table.' },
    { url: 'https://insight-analytics.ca/#dashboard', title: 'eBill Performance Dashboard', desc: 'Adoption rate trend, adoption drivers, Q4 target progress, eBill delivery performance.' },
    { url: 'https://insight-analytics.ca/blog/universal-dashboard-builder', title: 'Markets Markets and Finance Dashboard - Live Finance Dashboard (Live Demo)', desc: 'Live crypto prices (BTC ETH SOL), FX rates heatmap, S&P 500 and NASDAQ trends, sector performance heatmap, futures prices, AI market brief with Groq streaming analysis.' },
  ];

  var CONTEXT = PAGES.map(function (p) {
    return 'URL: ' + p.url + '\nTitle: ' + p.title + '\nDescription: ' + p.desc;
  }).join('\n---\n');

  function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  function initSearch() {
    // Floating button
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ai-search-btn';
    btn.setAttribute('aria-label', 'Ask AI');
    btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>';
    btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;width:56px;height:56px;border-radius:50%;border:none;background:linear-gradient(135deg,#6366f1,#06b6d4);color:#fff;cursor:pointer;box-shadow:0 4px 20px rgba(99,102,241,0.4);display:grid;place-items:center;transition:transform 200ms,box-shadow 200ms';
    btn.onmouseenter = function () { btn.style.transform = 'scale(1.08)'; };
    btn.onmouseleave = function () { btn.style.transform = 'scale(1)'; };

    // Panel
    var panel = document.createElement('div');
    panel.id = 'ai-search-panel';
    panel.style.cssText = 'position:fixed;bottom:96px;right:24px;width:420px;max-width:calc(100vw - 48px);max-height:560px;backdrop-filter:blur(14px) saturate(160%);-webkit-backdrop-filter:blur(14px) saturate(160%);border:1px solid rgba(99,102,241,0.25);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.4);z-index:9999;display:none;flex-direction:column;overflow:hidden;font-family:Inter,sans-serif';

    panel.innerHTML =
      '<div style="padding:14px 18px;border-bottom:1px solid rgba(99,102,241,0.15);display:flex;align-items:center;gap:10px">' +
        '<span style="display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#06b6d4);color:#fff;font-size:13px;font-weight:800">AI</span>' +
        '<span style="color:#e2e8f0;font-size:14px;font-weight:700;font-family:Space Grotesk,sans-serif">Ask Insight Analytics</span>' +
        '<button id="ai-search-close" style="margin-left:auto;background:none;border:none;color:#64748b;cursor:pointer;font-size:20px;padding:4px;line-height:1">&times;</button>' +
      '</div>' +
      // Suggested questions area
      '<div id="ai-suggestions" style="padding:12px 16px 4px;display:flex;flex-wrap:wrap;gap:6px"></div>' +
      // Results area
      '<div id="ai-search-results" style="flex:1;overflow-y:auto;padding:4px 18px 16px;font-size:14px;line-height:1.6;min-height:60px"></div>' +
      // Input bar
      '<div style="padding:10px 14px;border-top:1px solid rgba(99,102,241,0.15);display:flex;gap:6px;align-items:center">' +
        '<input id="ai-search-input" type="text" placeholder="Ask anything..." style="flex:1;background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.2);border-radius:8px;padding:9px 12px;color:#e2e8f0;font-size:14px;font-family:Inter,sans-serif;outline:none" />' +
        '<button id="ai-search-mic" type="button" style="background:rgba(30,41,59,0.8);border:1px solid rgba(99,102,241,0.2);border-radius:8px;padding:9px;width:38px;color:#94a3b8;cursor:pointer;display:grid;place-items:center" title="Voice input">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
        '</button>' +
        '<button id="ai-search-send" style="background:linear-gradient(135deg,#6366f1,#06b6d4);border:none;border-radius:8px;padding:0 14px;height:38px;color:#fff;cursor:pointer;font-weight:700;font-size:13px;display:flex;align-items:center;gap:4px">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '</button>' +
      '</div>';

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // Inject styles
    var style = document.createElement('style');
    style.textContent =
      '#ai-search-panel { background:rgba(15,23,42,0.96) }' +
      '#ai-search-results { color:#cbd5e1 }' +
      '#ai-suggestions .suggestion-pill { display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600;color:#94a3b8;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);cursor:pointer;transition:all 150ms;font-family:Inter,sans-serif }' +
      '#ai-suggestions .suggestion-pill:hover { background:rgba(99,102,241,0.2);color:#06b6d4;border-color:rgba(6,182,212,0.4) }' +
      '#ai-search-results a { color:#06b6d4;text-decoration:none;font-weight:600;border-bottom:1px solid rgba(6,182,212,0.3) }' +
      '#ai-search-results a:hover { border-color:#06b6d4 }' +
      '#ai-search-results .ai-link-card { display:block;margin:6px 0;padding:10px 12px;border-radius:8px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.15);text-decoration:none;color:#e2e8f0;transition:background 150ms }' +
      '#ai-search-results .ai-link-card:hover { background:rgba(99,102,241,0.15);border-color:rgba(6,182,212,0.4) }' +
      '#ai-search-results .ai-link-card .ai-link-title { font-weight:700;color:#06b6d4;font-size:13px;margin-bottom:2px }' +
      '#ai-search-results .ai-link-card .ai-link-desc { font-size:11px;color:#94a3b8;line-height:1.4 }' +
      '#ai-search-results .ai-streaming { color:#06b6d4 }' +
      '#ai-search-results .ai-section-label { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin:10px 0 4px }' +
      '#ai-search-mic.recording { background:rgba(239,68,68,0.2)!important;border-color:rgba(239,68,68,0.5)!important;color:#ef4444!important;animation:micPulse 1.5s ease-in-out infinite }' +
      '@keyframes micPulse { 0%,100%{opacity:1}50%{opacity:0.5} }' +
      '[data-theme="light"] #ai-search-panel { background:rgba(255,255,255,0.98) }' +
      '[data-theme="light"] #ai-search-results { color:#1e293b }' +
      '[data-theme="light"] #ai-search-results .ai-link-card { background:rgba(99,102,241,0.04);border-color:rgba(99,102,241,0.1);color:#1e293b }' +
      '[data-theme="light"] #ai-search-results .ai-link-desc { color:#475569 }' +
      '[data-theme="light"] #ai-search-panel span { color:#1e293b }' +
      '[data-theme="light"] #ai-search-results .ai-streaming { color:#4338ca }' +
      '[data-theme="light"] #ai-suggestions .suggestion-pill { color:#475569;background:rgba(99,102,241,0.06) }' +
      
      '[data-theme="light"] #ai-search-input { background:rgba(241,243,248,0.8);color:#1e293b }' +
      '[data-theme="light"] #ai-search-mic { background:rgba(241,243,248,0.8);color:#64748b }' +
      '[data-theme="light"] #ai-search-panel { background:rgba(255,255,255,0.98);box-shadow:0 12px 40px rgba(0,0,0,0.15) }' +
      '[data-theme="light"] #ai-search-results { color:#1e293b }';
    document.head.appendChild(style);

    var input = document.getElementById('ai-search-input');
    var sendBtn = document.getElementById('ai-search-send');
    var micBtn = document.getElementById('ai-search-mic');
    var closeBtn = document.getElementById('ai-search-close');
    var results = document.getElementById('ai-search-results');
    var suggestionsEl = document.getElementById('ai-suggestions');

    // Show suggested questions
    function showSuggestions(query) {
      query = (query || '').toLowerCase().trim();
      var questions = [];

      if (!query) {
        // No input — show defaults
        questions = DEFAULT_SUGGESTIONS.slice();
      } else {
        // Find matching keywords
        var used = {};
        KEYWORD_MAP.forEach(function (group) {
          var matches = group.keys.some(function (k) { return query.indexOf(k) >= 0 || k.indexOf(query) >= 0; });
          if (matches) {
            group.questions.forEach(function (q) {
              if (!used[q]) { used[q] = true; questions.push(q); }
            });
          }
        });
        // If no matches, show contextual defaults based on first letter
        if (questions.length === 0 && query.length >= 2) {
          // Show generic "can you..." suggestions
          questions = [
            'Can you build a dashboard for ' + query + '?',
            'Do you have experience with ' + query + '?',
            'Can I see a demo related to ' + query + '?'
          ];
        }
      }

      // Show up to 5
      questions = questions.slice(0, 5);
      suggestionsEl.innerHTML = '';
      questions.forEach(function (q) {
        var pill = document.createElement('span');
        pill.className = 'suggestion-pill';
        pill.textContent = q;
        pill.addEventListener('click', function () {
          input.value = q;
          doSearch();
        });
        suggestionsEl.appendChild(pill);
      });
    }

    // Toggle panel
    btn.addEventListener('click', function () {
      var isOpen = panel.style.display === 'flex';
      panel.style.display = isOpen ? 'none' : 'flex';
      if (!isOpen) {
        showSuggestions();
        results.innerHTML = '<div style="color:#64748b;text-align:center;padding:20px 0;font-size:13px">Ask about dashboards, AI, data pipelines, or tap a suggestion above.</div>';
        setTimeout(function () { input.focus(); }, 100);
      }
    });

    closeBtn.addEventListener('click', function () { panel.style.display = 'none'; });

    // Voice input
    var recognition = null;
    var isRecording = false;

    function initRecognition() {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return null;
      var r = new SR();
      r.continuous = false;
      r.interimResults = true;
      r.lang = 'en-US';
      return r;
    }

    micBtn.addEventListener('click', function () {
      if (isRecording) {
        if (recognition) recognition.stop();
        return;
      }
      recognition = initRecognition();
      if (!recognition) {
        results.innerHTML = '<div style="color:#ef4444;text-align:center;padding:12px">Voice input not supported in this browser. Try Chrome or Safari.</div>';
        return;
      }
      isRecording = true;
      micBtn.classList.add('recording');
      input.value = '';
      input.placeholder = 'Listening...';

      recognition.onresult = function (e) {
        var transcript = '';
        for (var i = 0; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        input.value = transcript;
      };

      recognition.onerror = function (e) {
        isRecording = false;
        micBtn.classList.remove('recording');
        input.placeholder = 'Ask anything...';
        if (e.error !== 'no-speech') {
          results.innerHTML = '<div style="color:#ef4444;text-align:center;padding:8px">Voice error: ' + escHtml(e.error) + '</div>';
        }
      };

      recognition.onend = function () {
        isRecording = false;
        micBtn.classList.remove('recording');
        input.placeholder = 'Ask anything...';
        if (input.value.trim().length > 0) {
          doSearch();
        }
      };

      recognition.start();
    });

    // Search function
    function doSearch() {
      var query = input.value.trim();
      if (!query) return;
      input.value = '';
      sendBtn.disabled = true;
      suggestionsEl.innerHTML = '';
      results.innerHTML = '<div class="ai-streaming">Searching...</div>';

      var prompt = 'You are a helpful assistant for Insight Analytics, a Canadian analytics consultancy. ' +
        'Answer the user\'s question based ONLY on the content below. ' +
        'If relevant, include 1-2 links using markdown: [link text](url). ' +
        'Keep the answer under 150 words. Be conversational and executive-oriented. ' +
        'Do not mention that you are an AI or that you are searching content.\n\n' +
        'SITE CONTENT:\n' + CONTEXT + '\n\n' +
        'USER QUESTION: ' + query;

      // Try streaming first
      fetch(GROQ_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 600, stream: true })
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        var full = '';

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { renderResults(full); return; }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(function (line) {
              if (line.startsWith('data: ')) {
                var data = line.slice(6).trim();
                if (data === '[DONE]') return;
                try {
                  var json = JSON.parse(data);
                  var delta = json.choices && json.choices[0] && json.choices[0].delta;
                  if (delta && delta.content) {
                    full += delta.content;
                    results.innerHTML = '<div class="ai-streaming">' + escHtml(full) + '<span style="opacity:0.5">▋</span></div>';
                    results.scrollTop = results.scrollHeight;
                  }
                } catch (e) {}
              }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function () {
        // Fallback: non-streaming
        return fetch(GROQ_PROXY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 600, stream: false })
        }).then(function (res) { return res.json(); }).then(function (data) {
          return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        }).then(renderResults);
      }).catch(function (e) {
        results.innerHTML = '<div style="color:#ef4444">Search failed. Please try again.</div>';
      }).finally(function () { sendBtn.disabled = false; });
    }

    // Dynamic suggestions as user types
    var debounceTimer = null;
    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        showSuggestions(input.value);
      }, 150);
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    sendBtn.addEventListener('click', doSearch);

    function renderResults(text) {
      if (!text || text.length < 10) {
        results.innerHTML = '<div style="color:#64748b;text-align:center;padding:12px">No results found. Try rephrasing.</div>';
        return;
      }
      var linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      var links = [];
      var match;
      while ((match = linkRegex.exec(text)) !== null) links.push({ text: match[1], url: match[2] });

      var cleanText = text.replace(linkRegex, function (m, label, url) {
        return '<a href="' + escAttr(url) + '" target="_blank" rel="noopener">' + escHtml(label) + '</a>';
      });
      cleanText = cleanText.split('\n\n').map(function (p) {
        return '<p style="margin:0 0 10px">' + p.replace(/\n/g, '<br>') + '</p>';
      }).join('');

      var cardsHtml = '';
      if (links.length > 0) {
        cardsHtml = '<div class="ai-section-label">Relevant Pages</div>';
        links.slice(0, 3).forEach(function (link) {
          var page = PAGES.find(function (p) { return p.url === link.url || link.url.indexOf(p.url) >= 0 || p.url.indexOf(link.url) >= 0; });
          var title = page ? page.title : link.text;
          var desc = page ? page.desc : '';
          cardsHtml += '<a href="' + escAttr(link.url) + '" class="ai-link-card" target="_blank" rel="noopener">' +
            '<div class="ai-link-title">' + escHtml(title) + '</div>' +
            (desc ? '<div class="ai-link-desc">' + escHtml(desc.slice(0, 100)) + '</div>' : '') + '</a>';
        });
      }
      results.innerHTML = cleanText + cardsHtml;
      results.scrollTop = 0;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }
})();
