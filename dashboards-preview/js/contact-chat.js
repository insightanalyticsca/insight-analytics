/* ════════════════════════════════════════════════════════════════════════════
   contact-chat.js — Insight Analytics contact + info bot
   - Auto-opens a minimal hint bubble on page load to convey purpose
   - Full panel: tappable contact card (mailto: + tel:) + Groq Q&A
   - System prompt keeps bot honest: only known IA facts, no invented services
   - Only loaded on pages that include the script + have <footer data-contact-footer>
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Contact facts (single source of truth) ──────────────────────────────
  var CONTACT = {
    email: 'dev@insight-analytics.ca',
    phone: '(289) 635-9915',
    phoneTel: '+12896359915',
    brand: 'Insight Analytics',
    lead: 'Innovative dashboards & AI-integrated analytics for utilities and operations.'
  };

  // ─── Known facts about Insight Analytics (for the system prompt) ─────────
  // These are the ONLY capabilities the bot may speak to. Anything else must
  // be deflected to "reach out via email/phone". Grouped by topic so the LLM
  // can produce coherent answers when asked "what do you do?" or "tell me
  // about your X".
  var IA_FACTS = [
    '═══ CORE PLATFORM ═══',
    'Insight Analytics builds corporate dashboard platforms for utilities, telecom, and operations sectors.',
    'Core product: a static site (HTML5 + vanilla JS + ECharts 5) — free hosting, no server required.',
    'Original platform was a .NET MVC Core app; the deployed demo is a faithful static clone of that app\'s logic, look, and feel (not a reimplementation — the .NET cshtml templates were converted to static HTML shells that load shared JS).',
    'JSON file backend: data/executive/*.json + data/versions/*.json. No database, no API server — every "query" is a fetch against a static JSON file.',
    'Source repo: not publicly disclosed',

    '═══ DASHBOARD SECTORS ═══',
    'Executive dashboards: 6 versions — AR portfolio, customer payments, disconnects/bankruptcies, e-bill performance, final-bill recovery, and the Executive Operating Dashboard (multi-location retail + services chain — revenue mix, capacity heatmap, store performance).',
    'CSR (Customer Service Representative) dashboards: 11 canvas versions — aging overview, aging dynamics, AR tabular, electric arrears, top arrears, bankruptcies report, collection emails, monthly moves, multi-unit conditions map, queue spectrum, request service layout map.',
    'ITS (IT Service) dashboards: 6 canvas versions — service health, security posture, security training, SLA performance, ticket management, ticket operations.',
    'Custom HTML visuals: 45+ individual visual files cloned verbatim from the .NET app (no patches except fetch URL rewrites), combined into 23 canvas/executive versions.',

    '═══ AI INTEGRATION (multiple Groq-powered bots) ═══',
    'AI Brief card: a dazzling 4-section card on each executive dashboard page. On page load, fetches the dashboard JSON, calls Groq with an honest 4-part system prompt, and streams tokens live into the 4 cells (What happened / Why / What to expect / What to do) with shimmer state.',
    'Visual chat: floating chat widget on every version page. Answers questions about the dashboard\'s JSON data using the same honest 4-part brief format. Includes an "AI-wired" badge with a green pulse dot.',
    'Contact bot: footer-resident widget on the Executive Operating Dashboard page. Conveys contact info (email + phone, clickable mailto:/tel:) and answers basic questions about Insight Analytics\' solutions. Inline compact form by default — tiny icons + Ask pill + close — collapses to a single Contact pill.',
    'Honest status pill: lander page topbar pill that actually pings Groq with a real API call (max_tokens=1) to verify the key works. Shows green "Groq · live" only on HTTP 200, amber "Groq · checking…" during verification, red "Groq · offline" on 401/403/network error. 5-minute in-memory cache to avoid pinging on every page nav.',

    '═══ HONEST AI PRINCIPLES ═══',
    'All AI summaries and answers are pure Groq streams — no static content shown unless Groq is truly unreachable.',
    'The 4-part brief system prompt forbids: invented confidence percentages (e.g., "82% confidence"), specific point forecasts (e.g., "next-month revenue +3.9%"), store-level attribution when the payload is aggregated, dollar-opportunity figures without the full unit-economics chain (unit count × rate × frequency × time).',
    'No canned "demo answer" anywhere — if Groq is offline, the bot says "AI is offline" honestly and points to the contact info.',
    'Configuration loading is awaited before deciding fallback — prevents premature "offline" messages when the async config fetch is still in flight.',

    '═══ NETLIFY PROXY ARCHITECTURE (key never reaches client) ═══',
    'The Groq API key is held server-side as the GROQ_API_KEY environment variable on a Netlify Edge Function (Deno runtime).',
    'The static site on GitHub Pages calls the proxy URL (https://dashboards-groq-proxy.netlify.app/groq-proxy) instead of api.groq.com directly — the key never appears in client JS, never lives in the GitHub repo, never gets blocked by GitHub secret scanning.',
    'The proxy streams SSE pass-through (ReadableStream) so token-by-token streaming still works in the browser.',
    'CORS restricted to the GitHub Pages origin + localhost for dev.',
    'Bonus: GET /groq-proxy?op=models endpoint forwards to Groq /v1/models for listing available models from the browser.',
    'Rotating the key is a one-line `netlify env:set GROQ_API_KEY=...` + redeploy — no repo changes needed.',
    'Previously the key was obfuscated as split+reversed keyParts in data/groq-config.json (bypassed GitHub secret scanning) — that hack is now retired in favor of the server-side proxy.',

    '═══ PWA + THEMING ═══',
    'Site is installable as a PWA: manifest.json, service worker (network-first caching strategy), translucent sleek icons (192/512/maskable/apple-touch/favicon).',
    'Theme system: light/dark toggle with custom "vivid" light and "vivid-dark" ECharts themes (registered against echarts.registerTheme). Toggle broadcasts to all iframes via postMessage + injects CSS overrides for cross-frame consistency (CSR runtime listens for csr-dashboard-theme:apply events).',
    'CSS variables for theming: --theme-bg, --theme-text, --theme-primary, --theme-accent, --theme-border, --theme-panel, --theme-muted — single source of truth across the site.',
    'Hero canvas animation on the lander: animated node network (50 nodes, glow 20, opacity 0.50, cubic-bezier transitions) rendered on an ECharts graph.',

    '═══ MOBILE + UX ═══',
    'Pull-to-refresh on all pages — custom JS implementation (no library), integrates with the service worker cache.',
    'Layout persistence: drag/resize positions of visuals saved per-version in localStorage (keyed by version ID) — restores on page reload. Reset button on each executive page.',
    'Mobile-responsive: canvas tiles, footer wraps, contact widget collapses to single Contact pill on small screens, executive dashboards shrink fonts + padding (no transform, no piling).',
    'Safari aggressive caching handled by renaming JS files (e.g., executive-dashboard-suite.js → dash-suite.js) and bumping cache version strings (e.g., v=20260813) on every release.',
    'Cross-iframe layout sync: canvas pages use postMessage to broadcast drag/resize positions to the parent, which persists them.',

    '═══ DEMO CONTENT (not real client data) ═══',
    'All dashboard data is synthetic demo data — real customer data is never shipped to the browser.',
    'The Executive Operating Dashboard uses a realistic operating model for a multi-location retail + services chain — revenue mix, capacity utilization, store performance matrix, and a 4-week revenue forecast. All numbers are illustrative demo data, not real client financials.',
    'Period labels are real "today" — Week 32 / Aug 2026 — so the demo doesn\'t look stale.',
    'Use cases demonstrated: AR portfolio, payments, disconnects, e-bill performance, final-bill recovery, CSR aging overview, IT service health, security posture, ticket operations, SLA performance.',

    '═══ PHILOSOPHY (Insight Analytics executive brief story — from the IA deck) ═══',
    'Tagline: "FROM REPORTING TO PREDICTIVE BUSINESS INTELLIGENCE" — The business already has the answers. Leadership should not have to hunt for them. Instead of asking leadership to find the story in the data, let the system bring the story to leadership.',
    'Problem statement: Most organizations already have the information they need. It is scattered across systems, spreadsheets, reports, presentations and operational updates — so people still spend hours collecting, reconciling and interpreting it before a decision can be made.',
    'The 8-step story (Part 1 — From reporting to predictive BI):',
    '  1. CONNECT WHAT ALREADY EXISTS — Existing databases, business applications, spreadsheets, websites and external information become one connected information environment. Secure database connections, system interfaces, file imports and scheduled connectors retrieve information without forcing replacement of systems already in place.',
    '  2. STOP MAKING PEOPLE COLLECT THE SAME INFORMATION REPEATEDLY — Routine collection and preparation happen automatically, so recurring reports no longer begin with someone gathering files and rebuilding the same calculations. Scheduled data pipelines pull, validate, standardize and combine information using repeatable business rules.',
    '  3. CREATE ONE RELIABLE PICTURE OF THE BUSINESS — The same governed numbers can feed dashboards, management reports, Excel, PowerPoint, operational applications and AI — reducing competing versions of the truth. A shared reporting layer stores clean current and historical data with common definitions, calculations, mappings and quality checks.',
    '  4. MAKE AI THE FIRST READER — Before the meeting, the system has already compared current performance with history and identified what changed, what looks unusual and what deserves attention. Analytics detect trends, exceptions and relationships; AI turns those findings into concise management language grounded in the trusted data.',
    'The 8-step story (Part 2 — From understanding to foresight and action):',
    '  5. ASK THE BUSINESS QUESTIONS DIRECTLY — A static report becomes interactive. Management can ask follow-up questions instead of waiting for another analysis cycle. A natural-language interface queries governed business data and returns answers with the relevant numbers, trends and context.',
    '  6. DO NOT JUST EXPLAIN THE PAST — PREDICT THE FUTURE — Historical information can be used to forecast demand, revenue, activity or cost; flag unusual behaviour; and identify situations that resemble known outcomes. Predictive models use the historical data already collected — forecasting, likelihood scoring, pattern grouping and unusual-behaviour detection are selected according to the business problem.',
    '  7. PUT THE INSIGHT WHERE PEOPLE ALREADY WORK — The same information can refresh dashboards, management packs and presentations automatically instead of being rebuilt separately for each audience. Power BI or web dashboards, Excel, PowerPoint, PDF and email become delivery channels fed from the same trusted source.',
    '  8. CLOSE THE LOOP FROM INSIGHT TO ACTION — When something important happens, the organization does not have to wait for someone to notice it manually. Alerts, approvals, notifications and workflow rules can route the issue, update the system of record and record the response.',
    'The 5-part executive brief format (the output, not another 40-page report — the five things that matter):',
    '  OVERALL — Performance is stable, with one material change requiring attention. (one-line status)',
    '  CHANGE — Customer activity moved sharply versus the previous period. (what changed)',
    '  CONCERN — One area is now outside its normal historical pattern. (what is unusual)',
    '  OUTLOOK — If the trend continues, the related indicator may weaken next quarter. (direction only, no point forecast)',
    '  ACTION — Review the underlying drivers now rather than at the next reporting cycle. (what to do)',
    'Then the report becomes a conversation: Why did this happen? Is it temporary or a trend? Has it happened before? What happens if it continues? Where should attention go now?',
    'Why this is realistic now: The architecture is platform-agnostic. It can work with various databases, core business systems, spreadsheets, websites, system interfaces, Power BI, Excel, PowerPoint and custom web applications. Modern development platforms, reusable components, mature connectors, cloud and on-premises options, and AI-assisted development have shortened implementation and learning curves dramatically.',
    'The important constraints are business priority, data access, security, quality and governance — not whether the technology can be learned or integrated. Workload size is not the limiting factor: the same design can be sized for a focused process or an enterprise-scale information flow.',
    'Insight Analytics positioning: designs and builds end-to-end data, analytics, automation and AI solutions around the systems an organization already uses — from collection and transformation through dashboards, management reporting, prediction and workflow automation. The goal is not to force a particular platform; it is to make information move automatically and turn it into decisions faster.',
    'The IA value chain in one line: Data → understanding → prediction → action.'
  ].join('\n');

  // ─── Config (mirror visual-chat.js) ──────────────────────────────────────
  var CONFIG = {
    provider: localStorage.getItem('docchat.provider') || 'demo',
    proxyUrl: localStorage.getItem('docchat.groq.proxyUrl') || '',
    groqModel: localStorage.getItem('docchat.groq.model') || 'qwen/qwen3.8-27b'
  };

  // Expose a promise so ask() can wait for the config to finish loading
  // before deciding whether Groq is truly offline. Without this, a user
  // who sends a message in the first ~200ms (before the async fetch
  // resolves) would get a canned offline message even though the proxy
  // IS configured in data/groq-config.json.
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

  var state = { isOpen: false, isStreaming: false };

  // ─── System prompt — honest contact bot ──────────────────────────────────
  function buildSystemPrompt() {
    return [
      'You are the contact assistant for ' + CONTACT.brand + '.',
      'Your role has two parts, in this priority order:',
      '',
      'PART 1 — CONVEY CONTACT INFO. When the user opens the chat, and again whenever they ask how to reach us, present the contact info clearly:',
      '  Email: ' + CONTACT.email,
      '  Phone: ' + CONTACT.phone,
      'Tell the user both the email and phone are clickable in the panel above the chat input. Mention that email opens their mail client and phone opens their dialer.',
      '',
      'PART 2 — ANSWER BASIC QUESTIONS. The user may ask about our services, capabilities, or approach. Answer ONLY using the known facts below. If a question asks about something not covered in the known facts (pricing, contracts, custom integrations we haven\'t built, named clients, timelines), do NOT invent an answer — say "That\'s outside what I can speak to here. Reach out to us at ' + CONTACT.email + ' or ' + CONTACT.phone + ' and we\'ll get you a real answer."',
      '',
      'HARD RULES:',
      '1. Never invent services, capabilities, pricing, or client names that aren\'t in the known facts.',
      '2. Never claim certifications, partnerships, or awards — Insight Analytics has not disclosed any in this prompt.',
      '3. Keep answers under 120 words. Tight prose.',
      '4. Always end your answer with one of:',
      '   - If contact-relevant: "— " + CONTACT.email + " · " + CONTACT.phone',
      '   - If deflecting: the deflection phrase above.',
      '5. Do not produce code, JSON, or technical specs. You are a contact bot, not an engineer.',
      '6. If asked about competitors, decline: "I can only speak to what Insight Analytics offers. For comparisons, please reach out directly."',
      '',
      'KNOWN FACTS ABOUT ' + CONTACT.brand.toUpperCase() + ':',
      IA_FACTS
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
        max_tokens: 500,
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

  // ─── 30-min localStorage cache for repeat questions ─────────────────────
  // Most users ask the same handful of questions (what do you do? is this a
  // PWA? how does the proxy work?). Caching by question hash saves tokens
  // for repeat questions within a 30-min window.
  var QA_CACHE_PREFIX = 'contact-qa:v1:';
  var QA_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 minutes

  function qaHash(question) {
    var s = question.toLowerCase().trim().replace(/\s+/g, ' ');
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function getCachedAnswer(question) {
    try {
      var raw = localStorage.getItem(QA_CACHE_PREFIX + qaHash(question));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || !entry.ts || !entry.answer) return null;
      if (Date.now() - entry.ts > QA_CACHE_TTL_MS) {
        localStorage.removeItem(QA_CACHE_PREFIX + qaHash(question));
        return null;
      }
      return entry.answer;
    } catch (_) { return null; }
  }

  function setCachedAnswer(question, answer) {
    try {
      localStorage.setItem(QA_CACHE_PREFIX + qaHash(question), JSON.stringify({
        ts: Date.now(),
        answer: answer
      }));
    } catch (_) {}
  }

  async function ask(question, onToken) {
    // Wait for the Groq config to finish loading before deciding whether
    // to use Groq or report offline. The config fetch from
    // data/groq-config.json is async and may still be in flight on
    // first user interaction.
    await configPromise;

    if (CONFIG.provider === 'groq' && CONFIG.proxyUrl) {
      // ─── CACHE CHECK ──────────────────────────────────────────────────
      // If we've answered this exact question in the last 30 min, replay
      // the cached answer token-by-token (preserves the streaming feel)
      // and skip the Groq call entirely.
      var cached = getCachedAnswer(question);
      if (cached) {
        if (onToken) {
          var cachedTokens = cached.match(/\S+\s*/g) || [cached];
          for (var ci = 0; ci < cachedTokens.length; ci++) {
            await new Promise(function (r) { setTimeout(r, 12); });
            onToken(cachedTokens[ci]);
          }
        }
        return cached;
      }

      var messages = [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: question }
      ];
      var answer = await groqChat(messages, onToken);
      // Cache the answer for next time (30-min TTL)
      setCachedAnswer(question, answer);
      return answer;
    }

    // Groq is truly offline (no key in localStorage AND no key in
    // data/groq-config.json). Stream a graceful message pointing to the
    // tappable email/phone in the panel. This is the ONLY static content
    // and it makes clear the AI is offline — not a fake "demo answer".
    var offlineMsg = 'AI is offline — Groq is not configured on this deployment.\n\n' +
      'For a real answer, reach out directly:\n' +
      '  • Email: ' + CONTACT.email + ' (clickable above)\n' +
      '  • Phone: ' + CONTACT.phone + ' (clickable above)\n\n' +
      'Or refresh the page in a moment if this is a temporary outage.';
    if (onToken) {
      var tokens = offlineMsg.match(/\S+\s*/g) || [offlineMsg];
      for (var i = 0; i < tokens.length; i++) {
        await new Promise(function (r) { setTimeout(r, 18); });
        onToken(tokens[i]);
      }
    }
    return offlineMsg;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI
  // ══════════════════════════════════════════════════════════════════════════

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ─── Inline SVG icons ────────────────────────────────────────────────────
  var ICONS = {
    contact: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    mail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    send: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    close: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    chat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  };

  // ─── Build the inline footer compact widget + floating panel ─────────────
  // Compact widget = small inline strip in the footer, right of the IA logo:
  //   [tiny mail icon → mailto:] [tiny phone icon → tel:] [Ask pill] [X close]
  //   - Visible by default on page load (minimal state, exposes contact info)
  //   - Close X collapses to a single Contact pill that re-opens compact
  //   - Ask pill opens the full floating chat panel for Q&A
  function buildUI() {
    var footer = document.querySelector('[data-contact-footer]');
    if (!footer) return; // only render on pages with the footer marker

    // Inject keyframes once for the AI-wired pulse dot
    if (!document.getElementById('contactAiKeyframes')) {
      var ks = document.createElement('style');
      ks.id = 'contactAiKeyframes';
      ks.textContent = '@keyframes contactAiPulse{0%,100%{opacity:0.7;transform:scale(1)}50%{opacity:1;transform:scale(1.25)}}';
      document.head.appendChild(ks);
    }

    // Compact widget host (inline in footer, right side)
    var host = document.createElement('div');
    host.id = 'contactCompactHost';
    host.className = 'contact-compact-host';
    host.setAttribute('data-state', 'open'); // open | collapsed

    // --- Compact (open) state ---
    var compact = document.createElement('div');
    compact.className = 'contact-compact';
    compact.innerHTML =
      // Tiny email icon → mailto:
      '<a class="contact-compact-iconbtn contact-compact-mail" href="mailto:' + escapeHtml(CONTACT.email) + '" ' +
        'aria-label="Email ' + escapeHtml(CONTACT.brand) + '" title="' + escapeHtml(CONTACT.email) + '">' +
        ICONS.mail +
      '</a>' +
      // Tiny phone icon → tel:
      '<a class="contact-compact-iconbtn contact-compact-phone" href="tel:' + escapeHtml(CONTACT.phoneTel) + '" ' +
        'aria-label="Call ' + escapeHtml(CONTACT.brand) + '" title="' + escapeHtml(CONTACT.phone) + '">' +
        ICONS.phone +
      '</a>' +
      // Ask pill → opens full chat panel
      '<button type="button" class="contact-compact-ask" id="contactAskBtn" ' +
        'aria-label="Ask the contact bot a question" title="Ask a question">' +
        '<span class="contact-compact-ask-icon">' + ICONS.chat + '</span>' +
        '<span class="contact-compact-ask-text">Ask</span>' +
      '</button>' +
      // Close X → collapses compact
      '<button type="button" class="contact-compact-close" id="contactCompactClose" ' +
        'aria-label="Collapse contact widget" title="Close">' +
        ICONS.close +
      '</button>';

    host.appendChild(compact);

    // --- Collapsed state (single Contact pill, hidden when compact is open) ---
    var collapsed = document.createElement('button');
    collapsed.type = 'button';
    collapsed.className = 'contact-collapsed-pill';
    collapsed.id = 'contactCollapsedPill';
    collapsed.setAttribute('aria-label', 'Open contact widget');
    collapsed.title = 'Show contact info';
    collapsed.innerHTML = '<span class="contact-collapsed-icon">' + ICONS.contact + '</span>' +
      '<span class="contact-collapsed-text">Contact</span>';

    host.appendChild(collapsed);

    // Append to footer's inner container (right of IA logo, same line)
    var footerInner = footer.querySelector('.contact-footer-inner');
    if (footerInner) {
      footerInner.appendChild(host);
    } else {
      footer.appendChild(host);
    }

    // Wire events
    document.getElementById('contactAskBtn').addEventListener('click', openPanel);
    document.getElementById('contactCompactClose').addEventListener('click', collapseCompact);
    collapsed.addEventListener('click', expandCompact);

    // Build the floating chat panel (hidden by default)
    var panel = document.createElement('div');
    panel.id = 'contactPanel';
    panel.style.cssText = [
      'position:fixed', 'bottom:52px', 'right:14px',
      'z-index:9998', 'width:380px', 'max-width:calc(100vw - 28px)',
      'max-height:calc(100vh - 80px)',
      'border-radius:16px',
      'border:1px solid var(--theme-border, rgba(99,102,241,0.20))',
      'background:var(--theme-panel, rgba(255,255,255,0.95))',
      'backdrop-filter:blur(20px) saturate(160%)',
      '-webkit-backdrop-filter:blur(20px) saturate(160%)',
      'box-shadow:0 24px 64px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.15)',
      'display:none', 'flex-direction:column',
      'overflow:hidden',
      'transition:all 220ms cubic-bezier(.22,1,.36,1)'
    ].join(';');

    panel.innerHTML = '' +
      // Header
      '<div style="padding:10px 14px;border-bottom:1px solid var(--theme-border,rgba(0,0,0,0.08));display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,var(--theme-primary,#6366f1),var(--theme-accent,#06b6d4));color:#fff;">' +
        '<span style="display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:rgba(255,255,255,0.18);">' + ICONS.contact + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12px;font-weight:700;letter-spacing:0.02em;">' + escapeHtml(CONTACT.brand) + '</div>' +
          '<div style="font-size:10px;opacity:0.85;font-weight:500;">Contact & info bot</div>' +
        '</div>' +
        '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px 3px 6px;border-radius:11px;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.12);color:#fff;font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;" title="Powered by Groq AI">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;animation:contactAiPulse 1.8s ease-in-out infinite;"></span>' +
          '<span>AI-wired</span>' +
        '</span>' +
        '<button id="contactClose" style="width:22px;height:22px;border:0;border-radius:6px;background:rgba(255,255,255,0.12);color:#fff;cursor:pointer;display:grid;place-items:center;transition:background 150ms;">' + ICONS.close + '</button>' +
      '</div>' +
      // Contact card (clickable email + phone)
      '<div style="padding:10px 12px 6px;border-bottom:1px solid var(--theme-border,rgba(0,0,0,0.08));background:var(--theme-panel,rgba(255,255,255,0.04));">' +
        '<div style="font-size:10px;font-weight:600;color:var(--theme-muted,#94a3b8);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Reach out directly</div>' +
        '<a href="mailto:' + escapeHtml(CONTACT.email) + '" id="contactEmailRow" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;text-decoration:none;color:var(--theme-text,#171777);background:var(--theme-panel-hover,rgba(0,0,0,0.03));border:1px solid var(--theme-border,rgba(0,0,0,0.06));margin-bottom:6px;transition:all 150ms;">' +
          '<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;flex-shrink:0;">' + ICONS.mail + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:9px;color:var(--theme-muted,#94a3b8);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Email</div>' +
            '<div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(CONTACT.email) + '</div>' +
          '</div>' +
        '</a>' +
        '<a href="tel:' + escapeHtml(CONTACT.phoneTel) + '" id="contactPhoneRow" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;text-decoration:none;color:var(--theme-text,#171777);background:var(--theme-panel-hover,rgba(0,0,0,0.03));border:1px solid var(--theme-border,rgba(0,0,0,0.06));transition:all 150ms;">' +
          '<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#06b6d4,#10b981);color:#fff;flex-shrink:0;">' + ICONS.phone + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:9px;color:var(--theme-muted,#94a3b8);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Phone</div>' +
            '<div style="font-size:12px;font-weight:600;">' + escapeHtml(CONTACT.phone) + '</div>' +
          '</div>' +
        '</a>' +
      '</div>' +
      // Messages
      '<div id="contactMessages" style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:140px;max-height:280px;"></div>' +
      // Input
      '<div style="padding:8px 12px;border-top:1px solid var(--theme-border,rgba(0,0,0,0.08));display:flex;gap:6px;background:var(--theme-panel,rgba(255,255,255,0.04));">' +
        '<input id="contactInput" type="text" placeholder="Ask about our services…" style="flex:1;background:var(--theme-panel,rgba(255,255,255,0.04));border:1px solid var(--theme-border,rgba(0,0,0,0.10));border-radius:8px;padding:7px 10px;font-size:12px;color:var(--theme-text,#171777);outline:none;">' +
        '<button id="contactSend" style="width:30px;height:30px;border:0;border-radius:8px;background:linear-gradient(135deg,var(--theme-primary,#6366f1),var(--theme-accent,#06b6d4));color:#fff;cursor:pointer;display:grid;place-items:center;flex-shrink:0;transition:transform 150ms;">' + ICONS.send + '</button>' +
      '</div>';

    document.body.appendChild(panel);

    // Wire events
    document.getElementById('contactClose').addEventListener('click', closePanel);
    document.getElementById('contactSend').addEventListener('click', handleSend);
    var input = document.getElementById('contactInput');
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleSend(); });

    // Hover affordances on contact rows
    [document.getElementById('contactEmailRow'), document.getElementById('contactPhoneRow')].forEach(function (row) {
      if (!row) return;
      row.addEventListener('mouseenter', function () {
        row.style.transform = 'translateY(-1px)';
        row.style.boxShadow = '0 4px 12px rgba(99,102,241,0.18)';
        row.style.borderColor = 'var(--theme-primary, rgba(99,102,241,0.35))';
      });
      row.addEventListener('mouseleave', function () {
        row.style.transform = '';
        row.style.boxShadow = '';
        row.style.borderColor = '';
      });
    });
  }

  // ─── Compact widget state (open by default on page load) ────────────────
  // data-state="open" → compact widget visible (tiny mail + phone icons + Ask + X)
  // data-state="collapsed" → only Contact pill visible
  function collapseCompact() {
    var host = document.getElementById('contactCompactHost');
    if (host) host.setAttribute('data-state', 'collapsed');
  }

  function expandCompact() {
    var host = document.getElementById('contactCompactHost');
    if (host) host.setAttribute('data-state', 'open');
  }

  function openPanel() {
    state.isOpen = true;
    var panel = document.getElementById('contactPanel');
    if (panel) panel.style.display = 'flex';

    var msgs = document.getElementById('contactMessages');
    if (msgs && msgs.children.length === 0) {
      addMessage('assistant',
        'Hi! I\'m the ' + CONTACT.brand + ' contact bot. ' + CONTACT.lead + '\n\n' +
        'The email and phone in the footer (and above) are clickable — they\'ll launch your mail client or dialer.\n\n' +
        'I can also answer basic questions about our dashboard and AI integration work. What would you like to know?');
    }

    setTimeout(function () { var i = document.getElementById('contactInput'); if (i) i.focus(); }, 100);
  }

  function closePanel() {
    state.isOpen = false;
    var panel = document.getElementById('contactPanel');
    if (panel) panel.style.display = 'none';
  }

  function addMessage(role, text) {
    var msgs = document.getElementById('contactMessages');
    if (!msgs) return null;
    var div = document.createElement('div');
    div.style.cssText = 'max-width:92%;padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;' +
      (role === 'user'
        ? 'align-self:flex-end;background:linear-gradient(135deg,var(--theme-primary,#6366f1),var(--theme-accent,#06b6d4));color:#fff;'
        : 'align-self:flex-start;background:var(--theme-panel-hover,rgba(0,0,0,0.04));border:1px solid var(--theme-border,rgba(0,0,0,0.06));color:var(--theme-text,#171777);');
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }

  async function handleSend() {
    var input = document.getElementById('contactInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || state.isStreaming) return;
    input.value = '';
    addMessage('user', text);
    var assistantDiv = addMessage('assistant', '…');
    state.isStreaming = true;
    try {
      var firstToken = true;
      await ask(text, function (token) {
        if (firstToken) { assistantDiv.textContent = ''; firstToken = false; }
        assistantDiv.textContent += token;
        var msgs = document.getElementById('contactMessages');
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
    var hasFooter = !!document.querySelector('[data-contact-footer]');
    var hasOptIn = document.body.dataset.contactBot === 'true';
    if (!hasFooter && !hasOptIn) return;

    buildUI();
    // Compact widget is open by default on page load (no auto-open of full panel,
    // no floating hint bubble — the inline compact widget IS the minimal state).
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
