/* ════════════════════════════════════════════════════════════════════════════
   blog-fuzzy-match.js — AI-assisted fuzzy address matcher + geocoder (marketing demo)

   Mounts INTO <div id="fuzzy-match-mount"></div> when the DOM is ready.
   Pure vanilla JS, no framework. Everything wrapped in an IIFE — no globals
   leaked to window.

   Concept
   -------
     Two unrelated transactional tables — customers and service orders — both
     carry free-form addresses. Service orders use fuzzy VARIATIONS of the
     customer's address (e.g. "123 Main Street" vs "123 Main St" vs
     "123 main st"). The demo:

       1. Fuzzy-matches customer addresses to service-order addresses via
          Jaro-Winkler similarity (pure-JS implementation, no library).
       2. Geocodes each unique customer address via the free Nominatim
          (OpenStreetMap) API to validate it against real-world coordinates.
       3. Calls Groq LLM (via the existing Netlify proxy) to produce a
          4-section executive brief on the match + geocoding results.

   Flow
   ----
     1. User loads Table A (customers) and Table B (service orders). Two
        embedded sample datasets are pre-generated deterministically (no
        upload required). Drag-drop + .csv / .xlsx / .json upload supported.
     2. Tables preview — auto-detected address + city columns highlighted.
     3. Match configuration — auto-detected columns, overridable. Threshold
        slider 0.75-0.95 (default 0.85). "Run fuzzy match" button.
     4. Match results — summary stats + ECharts heatmap (customer × service
        order, cell colour = Jaro-Winkler score) + match table.
     5. Geocoding — Nominatim rate-limited (1.1s gap, sequential only),
        progress bar, results table, lat/lon, importance, match status.
     6. AI brief — Groq produces a 4-section executive brief rendered as a
        styled text card.
     7. Export — CSV / Excel / JSON downloads + email preview (mailto: link
        with HTML preview modal).

   Anti-footguns
   -------------
     • Files > 5 MB rejected with a friendly message.
     • Nominatim rate limit: 1.1s gap between requests, NEVER parallel
       (Nominatim's Usage Policy is 1/sec; the 100ms buffer is politeness).
       Results cached in memory so re-runs don't re-fetch (saves ~50s).
     • Groq calls rate-limited client-side to MAX_GROQ_CALLS (10) per browser
       session (session-tracked via sessionStorage so it resets on tab close).
     • No eval() / new Function() — fuzzy matching is hand-written JS.
     • No alert/confirm/prompt — modals / inline inputs only.
     • All user-provided + AI-provided text is HTML-escaped before insertion.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────
  var MOUNT_ID          = 'fuzzy-match-mount';
  var GROQ_PROXY        = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
  var GROQ_MODEL        = 'qwen/qwen3.8-27b';
  var NOMINATIM_URL     = 'https://nominatim.openstreetmap.org/search';
  var NOMINATIM_GAP_MS  = 1100;            // 1.1s — polite buffer over the 1/sec policy
  var RATE_KEY          = 'fuzzyMatch.rate';
  var SESSION_KEY       = 'fuzzyMatch.sessionId';
  var MAX_GROQ_CALLS    = 10;
  var MAX_FILE_SIZE     = 5 * 1024 * 1024;  // 5 MB demo cap
  var GROQ_TIMEOUT_MS  = 30000;            // Groq can be slow on cold starts
  var SAMPLE_SEED       = 20260417;        // deterministic sample data seed

  var LIB_URLS = {
    xlsx:    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    echarts: 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js'
  };

  // Promise cache for each library. Once a lib loads, subsequent loadScript
  // calls for the same lib return the cached promise (no second <script> tag).
  var libCache = {};

  // ─── Module-scope state ────────────────────────────────────────────────────
  // Single source of truth. render() re-paints the whole mount from this; each
  // sub-renderer no-ops when its slice of state is absent.
  var state = {
    tableA:           null,   // unified table object for customers
    tableB:           null,   // unified table object for service orders
    customers:        null,   // alias for tableA.rows (post-parse)
    serviceOrders:    null,   // alias for tableB.rows (post-parse)
    tableALoading:    false,
    tableBLoading:    false,
    tableAError:      null,
    tableBError:      null,
    config: {
      aAddress:   null,
      bAddress:   null,
      cityColA:   null,
      cityColB:   null,
      threshold:  0.85
    },
    matches:          null,   // { rows, summary }
    matchError:       null,
    matchLoading:     false,
    geocodes:         null,   // array of geocode result objects
    geocoding: {
      active:         false,
      current:        0,
      total:          0,
      address:        '',
      error:          null,
      aborted:        false
    },
    aiBrief:          null,
    aiBriefLoading:   false,
    aiBriefError:     null,
    chart:            null,
    nominatimCache:   {}      // in-memory cache, key=normalized base address
  };

  // ─── Small DOM helpers ─────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    // HTML-escape any value before inserting into innerHTML. Used for every
    // user-provided or AI-provided string. Non-strings get String()'d.
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
    var isInt = Math.abs(num - Math.round(num)) < 1e-9 && String(n).indexOf('.') < 0;
    return num.toLocaleString('en-US', {
      minimumFractionDigits: isInt ? 0 : 2,
      maximumFractionDigits: 2
    });
  }
  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleDateString('en-CA'); } catch (e) { return ''; }
  }
  function fmtScore(s) {
    if (s == null || s === '') return '—';
    return Number(s).toFixed(3);
  }

  // ─── Theme helpers ──────────────────────────────────────────────────────────
  // Read the site's data-theme attribute on <html>. Also honor a per-mount
  // data-fm-theme override (mirrors the .pb- pattern from blog-pipeline-builder).
  function getTheme() {
    var mount = $(MOUNT_ID);
    if (mount) {
      var t = mount.getAttribute('data-fm-theme');
      if (t === 'light' || t === 'dark') return t;
    }
    var html = document.documentElement.getAttribute('data-theme');
    return html === 'light' ? 'light' : 'dark';
  }
  function axisLabelColor()  { return getTheme() === 'dark' ? '#a8b3c7' : '#475569'; }
  function tooltipBgColor() { return getTheme() === 'dark' ? 'rgba(15,23,42,.95)' : 'rgba(255,255,255,.97)'; }
  function tooltipTextColor() { return getTheme() === 'dark' ? '#e6edf7' : '#0f172a'; }
  function chartGridColor() { return getTheme() === 'dark' ? 'rgba(255,255,255,.07)' : 'rgba(15,23,42,.07)'; }

  // ─── Lazy CDN script loader ────────────────────────────────────────────────
  // Injects a <script src> tag and resolves when it loads. Caches by lib key
  // so a second request returns the same promise (no duplicate tags).
  function loadScript(libKey) {
    if (libCache[libKey]) return libCache[libKey];
    var url = LIB_URLS[libKey];
    if (!url) return Promise.reject(new Error('Unknown library: ' + libKey));
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + libKey + ' from ' + url)); };
      document.head.appendChild(s);
    });
    libCache[libKey] = p;
    return p;
  }

  // ─── Groq call rate limiter ────────────────────────────────────────────────
  // Tracks call count per browser session (sessionStorage resets on tab close).
  // localStorage holds { sessionId, count } — if sessionId differs from the
  // current sessionStorage value, the counter resets to 0 for the new session.
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
  // POSTs { model, messages, temperature, max_tokens, stream:false } to the
  // Netlify proxy. Resolves to the assistant message content string. Throws
  // friendly errors on network failure / non-JSON / rate-limit.
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
      max_tokens: opts.max_tokens != null ? opts.max_tokens : 1000,
      stream: false
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, GROQ_TIMEOUT_MS);
    return fetch(GROQ_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          throw new Error('AI service returned ' + r.status + '. Please try again.');
        }
        return r.json();
      })
      .then(function (data) {
        bumpGroqCount();
        if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error('AI returned an unexpected response. Please try again.');
        }
        return data.choices[0].message.content || '';
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          throw new Error('The AI service took too long to respond. Please try again.');
        }
        if (e.message && e.message.indexOf('AI service') === 0) throw e;
        if (e.message && e.message.indexOf('Demo rate limit') === 0) throw e;
        // Network / DNS / CORS error. Browsers report CORS failures as generic
        // TypeError("Failed to fetch") — surface an actionable hint.
        if (e.name === 'TypeError' || (e.message && e.message.indexOf('Failed to fetch') >= 0)) {
          throw new Error('Couldn\u2019t reach the AI service (CORS or network error). ' +
            'The Groq proxy may be cold-starting — please try again in a few seconds.');
        }
        throw new Error('Couldn\u2019t reach the AI service. Please try again.');
      });
  }

  // ─── Mulberry32 PRNG (deterministic sample data) ───────────────────────────
  // Tiny, fast, well-distributed. Seeded with SAMPLE_SEED so the demo is
  // reproducible — every refresh produces the same 50 customers + ~150 SOs.
  function mulberry32(seed) {
    return function () {
      var t = (seed = (seed + 0x6D2B79F5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ─── Sample data — Canadian cities + streets ────────────────────────────────
  var CITIES = [
    { name: 'Toronto',   region: 'ON', streets: ['King Street','Queen Street','Yonge Street','Bay Street','Bloor Street','College Street','Spadina Avenue','Front Street','Wellington Street','Adelaide Street','Dundas Street','King West'] },
    { name: 'Montreal',  region: 'QC', streets: ['Sainte-Catherine','Sherbrooke','Saint-Laurent','Rene-Levesque','Maisonneuve','Peel','Drummond','University','Guy Street','Dr Penfield','Peel Street','Avenue du Mont-Royal'] },
    { name: 'Vancouver', region: 'BC', streets: ['Hastings Street','Granville Street','Robson Street','Davie Street','Burrard Street','Howe Street','Smithe Street','Homer Street','Bute Street','Denman Street','Davie','Thurlow Street'] },
    { name: 'Calgary',   region: 'AB', streets: ['8 Avenue','17 Avenue','4 Street','Macleod Trail','Centre Street','1 Street','5 Avenue','12 Avenue','6 Street','9 Avenue','Bow Trail','Memorial Drive'] },
    { name: 'Halifax',   region: 'NS', streets: ['Barrington Street','Spring Garden Road','Quinpool Road','Robie Street','Gottingen Street','Agricola Street','Dresden Row','Birmingham Street','Hollis Street','Water Street','Young Street','Cunard Street'] }
  ];
  var FIRST_NAMES = ['Aisha','Marcus','Priya','Ethan','Sofia','Liam','Mei','Noah','Zara','Owen',
    'Fatima','Caleb','Ingrid','Yusuf','Hana','Diego','Anya','Tomas','Lena','Ravi',
    'Greta','Sami','Nia','Bjorn','Vera','Arjun','Lucia','Khalid','Mira','Jonas'];
  var LAST_NAMES  = ['Patel','Chen','Williams','Muller','Okafor','Garcia','Singh','Nguyen','Schmidt','Rossi',
    'Kim','Andersen','Khan','Dubois','Silva','Hassan','Novak','Costa','Reyes','Ito',
    'Larsen','Mehta','Sato','Petrov','Mansour','Olsen','Ferreira','Tan','Yamamoto','Bauer'];
  var CUSTOMER_TYPES   = ['Enterprise', 'Mid-Market', 'SMB', 'Strategic'];
  var SERVICE_TYPES    = ['Installation', 'Repair', 'Inspection', 'Maintenance', 'Upgrade'];
  var SERVICE_STATUSES = ['Completed', 'Completed', 'Completed', 'In Progress', 'Scheduled', 'Cancelled'];

  // ─── Fuzzy address variation generators ─────────────────────────────────────
  // Each function takes an address string and returns a slightly mangled version.
  // Composing 1-3 random non-repeating transformations per service order address
  // produces realistic free-form variation: "123 Main Street" → "123 main st",
  // "123 Main St Unit 4" → "123 Main Str apt 4", etc.
  function fxAbbreviateStreet(a) {
    return a.replace(/\bStreet\b/g, 'St').replace(/\bAvenue\b/g, 'Ave')
            .replace(/\bBoulevard\b/g, 'Blvd').replace(/\bRoad\b/g, 'Rd')
            .replace(/\bDrive\b/g, 'Dr').replace(/\bLane\b/g, 'Ln')
            .replace(/\bCourt\b/g, 'Ct').replace(/\bCircle\b/g, 'Cir')
            .replace(/\bPlace\b/g, 'Pl').replace(/\bCrescent\b/g, 'Cres');
  }
  function fxLowercase(a)       { return a.toLowerCase(); }
  function fxDropPunctuation(a) { return a.replace(/[.]/g, ''); }
  function fxSwapUnitIndicator(a) {
    return a.replace(/\bApt\b/i, 'Unit').replace(/#(\d+)/i, 'Unit $1').replace(/\bSuite\b/i, 'Unit');
  }
  function fxDropUnit(a) {
    return a.replace(/\s+(Apt|Unit|Suite|#)\s*\d+/gi, '').replace(/\s+#\s*\d+/gi, '').trim();
  }
  function fxAddPeriod(a) {
    return a.replace(/\bSt\b/g, 'St.').replace(/\bAve\b/g, 'Ave.').replace(/\bRd\b/g, 'Rd.');
  }
  function fxStrAbbrev(a) {
    return a.replace(/\bSt\b/g, 'Str').replace(/\bAve\b/g, 'Av');
  }
  function fxShuffleUnit(a) {
    // "123 Main St Unit 4" → "Unit 4 123 Main St" — moves the unit to the front.
    var m = a.match(/^(.+?)\s+(Apt|Unit|Suite|#)\s*(\d+)$/i);
    if (m) return (m[2] + ' ' + m[3] + ' ' + m[1]).replace(/^#/i, 'Unit ');
    return a;
  }
  var FX_TRANSFORMS = [
    fxAbbreviateStreet, fxLowercase, fxDropPunctuation, fxSwapUnitIndicator,
    fxDropUnit, fxAddPeriod, fxStrAbbrev, fxShuffleUnit
  ];

  // Apply 1-3 random non-repeating transformations to produce a fuzzy variation.
  function makeFuzzyVariation(addr, rng) {
    var result = addr;
    var n = 1 + Math.floor(rng() * 3); // 1-3 transforms
    var applied = [];
    var tries = 0;
    while (applied.length < n && tries < 10) {
      var t = FX_TRANSFORMS[Math.floor(rng() * FX_TRANSFORMS.length)];
      if (applied.indexOf(t) < 0) { applied.push(t); result = t(result); }
      tries++;
    }
    return result;
  }

  // Generate the full sample dataset (50 customers + ~150 service orders).
  // Seeded with SAMPLE_SEED so it's reproducible.
  function generateSampleData() {
    var rng = mulberry32(SAMPLE_SEED);
    var pickR = function (arr) { return arr[Math.floor(rng() * arr.length)]; };
    var randIntR = function (min, max) { return Math.floor(rng() * (max - min + 1)) + min; };
    var customers = [];
    var serviceOrders = [];
    var soCounter = 1000;
    for (var i = 0; i < 50; i++) {
      var city = CITIES[i % 5];
      var street = pickR(city.streets);
      var bldgNo = randIntR(50, 9999);
      var unitRoll = rng();
      var unit = '';
      if (unitRoll < 0.22)       unit = 'Apt ' + randIntR(1, 30);
      else if (unitRoll < 0.42) unit = 'Unit ' + randIntR(1, 30);
      else if (unitRoll < 0.50) unit = '#' + randIntR(1, 30);
      var baseAddr = bldgNo + ' ' + street + (unit ? ' ' + unit : '');
      var customerName = pickR(FIRST_NAMES) + ' ' + pickR(LAST_NAMES);
      customers.push({
        customer_id:    'CUST-' + String(i + 1).padStart(4, '0'),
        customer_name:  customerName,
        address:        baseAddr,
        city:           city.name,
        region:         city.region,
        customer_type:  pickR(CUSTOMER_TYPES)
      });
      // 2-5 service orders per customer.
      var numOrders = randIntR(2, 5);
      for (var j = 0; j < numOrders; j++) {
        var fuzzyAddr = makeFuzzyVariation(baseAddr, rng);
        var daysOut = randIntR(-220, 90);
        var dt = new Date(Date.now() + daysOut * 86400000);
        var status = pickR(SERVICE_STATUSES);
        // Occasionally format the city as "Toronto, ON" — fuzzy variation.
        var cityVal = city.name;
        if (rng() < 0.18) cityVal = city.name + ', ' + city.region;
        serviceOrders.push({
          service_order_id: 'SO-' + String(++soCounter),
          service_type:     pickR(SERVICE_TYPES),
          address:          fuzzyAddr,
          city:             cityVal,
          scheduled_date:   dt.toISOString().slice(0, 10),
          status:           status
        });
      }
    }
    return { customers: customers, serviceOrders: serviceOrders };
  }

  // ─── Unified table object factory ──────────────────────────────────────────
  // Mirrors the pipeline-builder's makeDoc so all downstream renderers can
  // count on a consistent shape regardless of input format.
  function makeTable(opts) {
    var columns = opts.columns || (opts.rows && opts.rows.length ? Object.keys(opts.rows[0]) : []);
    return {
      type:        opts.type,
      name:        opts.name || 'untitled',
      fileSize:    opts.fileSize || 0,
      rows:        opts.rows || [],
      columns:     columns,
      rowCount:    (opts.rows || []).length,
      columnCount: columns.length,
      warnings:    opts.warnings || []
    };
  }

  // ─── File parsers (CSV / Excel / JSON) ──────────────────────────────────────
  // Each returns a Promise<makeTable>. All async, all try/catch — failures
  // throw a friendly error that the caller surfaces as an inline error card.

  // CSV — native parse, RFC 4180 compliant (quoted fields with embedded
  // commas, newlines, doubled-quote escapes). No library needed.
  function parseCSV(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Couldn\u2019t read this file.')); };
      reader.onload = function () {
        try {
          var parsed = csvToRows(reader.result);
          if (!parsed.rows.length) {
            reject(new Error('This CSV appears to be empty.'));
            return;
          }
          resolve(makeTable({
            type: 'csv', name: file.name, fileSize: file.size,
            rows: parsed.rows, columns: parsed.columns
          }));
        } catch (e) {
          reject(new Error('Couldn\u2019t parse this CSV. Make sure it\u2019s a valid .csv and try again.'));
        }
      };
      reader.readAsText(file);
    });
  }
  // Minimal RFC-4180 CSV parser → { rows: [{...}], columns: [...] }
  function csvToRows(text) {
    var records = [];
    var field = '';
    var row = [];
    var i = 0;
    var inQuotes = false;
    while (i < text.length) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); records.push(row); }
    if (!records.length) return { rows: [], columns: [] };
    var headers = records[0].map(function (h, idx) { return (h || '').trim() || ('col_' + (idx + 1)); });
    var objRows = records.slice(1).filter(function (r) {
      return r.some(function (v) { return v !== '' && v != null; });
    }).map(function (r) {
      var o = {};
      headers.forEach(function (h, idx) {
        var v = r[idx];
        // Auto-coerce numeric strings — keeps match scoring consistent.
        if (v != null && v !== '' && !isNaN(v) && /^-?\d+(\.\d+)?$/.test(v.trim())) o[h] = Number(v);
        else o[h] = v != null ? v : '';
      });
      return o;
    });
    return { rows: objRows, columns: headers };
  }

  // Excel (.xlsx/.xls) via SheetJS. Loaded lazily on first parse only.
  function parseExcel(file) {
    return loadScript('xlsx').then(function () {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('Couldn\u2019t read this Excel file.')); };
        reader.onload = function () {
          try {
            var wb = XLSX.read(reader.result, { type: 'array' });
            var warnings = [];
            if (wb.SheetNames.length > 1) {
              warnings.push('Detected ' + wb.SheetNames.length + ' sheets — using the first ("' + wb.SheetNames[0] + '").');
            }
            var sheet = wb.Sheets[wb.SheetNames[0]];
            var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
            if (!aoa.length) { reject(new Error('This Excel file has no rows in its first sheet.')); return; }
            var headers = aoa[0].map(function (h, idx) { return h != null && h !== '' ? String(h) : 'col_' + (idx + 1); });
            var rows = aoa.slice(1).filter(function (r) {
              return r.some(function (v) { return v !== '' && v != null; });
            }).map(function (r) {
              var o = {};
              headers.forEach(function (h, idx) { o[h] = r[idx] != null ? r[idx] : ''; });
              return o;
            });
            resolve(makeTable({
              type: 'excel', name: file.name, fileSize: file.size,
              rows: rows, columns: headers, warnings: warnings
            }));
          } catch (e) {
            reject(new Error('Couldn\u2019t parse this Excel file. Make sure it\u2019s a valid .xlsx/.xls and try again.'));
          }
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }

  // JSON — native parse. Accepts either an array of row objects OR an object
  // containing { rows: [...] } / { customers: [...] } / { serviceOrders: [...] }.
  function parseJSON(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Couldn\u2019t read this file.')); };
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          var rows;
          if (Array.isArray(data)) rows = data;
          else if (data && Array.isArray(data.rows)) rows = data.rows;
          else if (data && Array.isArray(data.customers)) rows = data.customers;
          else if (data && Array.isArray(data.serviceOrders)) rows = data.serviceOrders;
          else if (data && Array.isArray(data.data)) rows = data.data;
          else { reject(new Error('JSON must be an array of row objects, or an object with a "rows" / "customers" / "serviceOrders" array.')); return; }
          if (!rows.length) { reject(new Error('This JSON file contains no rows.')); return; }
          if (Object.prototype.toString.call(rows[0]) !== '[object Object]') {
            reject(new Error('JSON rows must be objects (e.g. { "address": "..." }).'));
            return;
          }
          resolve(makeTable({ type: 'json', name: file.name, fileSize: file.size, rows: rows }));
        } catch (e) {
          reject(new Error('Couldn\u2019t parse this JSON. ' + (e.message || 'Invalid JSON.')));
        }
      };
      reader.readAsText(file);
    });
  }

  // Dispatcher — picks the right parser by file extension.
  function parseFile(file) {
    var name = (file.name || '').toLowerCase();
    var ext = name.split('.').pop() || '';
    if (ext === 'csv')  return parseCSV(file);
    if (ext === 'xlsx' || ext === 'xls') return parseExcel(file);
    if (ext === 'json') return parseJSON(file);
    return Promise.reject(new Error('Unsupported file type. Please use .csv, .xlsx, or .json.'));
  }

  // ─── Auto-detect address + city + name columns ──────────────────────────────
  // Tries exact column name matches first, then contains. Returns null if no
  // candidate found — the user can override via the dropdowns.
  function detectAddressColumn(table) {
    if (!table || !table.columns) return null;
    var exact = ['address','addr','street','street_address','address1','address_line_1','customer_address','service_address','site_address','location'];
    var cols = table.columns;
    for (var i = 0; i < cols.length; i++) {
      if (exact.indexOf(cols[i].toLowerCase()) >= 0) return cols[i];
    }
    for (var j = 0; j < cols.length; j++) {
      var lc = cols[j].toLowerCase();
      if (lc.indexOf('address') >= 0 || lc.indexOf('addr') >= 0 || lc.indexOf('street') >= 0) return cols[j];
    }
    return null;
  }
  function detectCityColumn(table) {
    if (!table || !table.columns) return null;
    var exact = ['city','town','municipality','locality'];
    var cols = table.columns;
    for (var i = 0; i < cols.length; i++) {
      if (exact.indexOf(cols[i].toLowerCase()) >= 0) return cols[i];
    }
    for (var j = 0; j < cols.length; j++) {
      var lc = cols[j].toLowerCase();
      if (lc.indexOf('city') >= 0 || lc.indexOf('town') >= 0) return cols[j];
    }
    return null;
  }
  function detectNameColumn(table) {
    if (!table || !table.columns) return null;
    var exact = ['customer_name','name','customer','client','company','account'];
    var cols = table.columns;
    for (var i = 0; i < cols.length; i++) {
      if (exact.indexOf(cols[i].toLowerCase()) >= 0) return cols[i];
    }
    for (var j = 0; j < cols.length; j++) {
      var lc = cols[j].toLowerCase();
      if (lc.indexOf('name') >= 0 || lc.indexOf('customer') >= 0) return cols[j];
    }
    return null;
  }

  // ─── Address normalization ──────────────────────────────────────────────────
  // Returns { base: "123 main street", unit: "4" }. The base string is what we
  // actually compare via Jaro-Winkler; the unit is kept around for the geocode
  // display but stripped from the match comparison (apartments are noisy).
  function normalizeAddress(addr) {
    if (!addr) return { base: '', unit: '' };
    var s = String(addr).toLowerCase().trim();
    // Replace punctuation with spaces (period, comma, hash).
    s = s.replace(/[.,#]/g, ' ');
    var tokens = s.split(/\s+/).filter(Boolean);
    // Expand common abbreviations — but only when the token is exactly the
    // abbreviation AND not followed by a number ("St 4" stays as "St").
    var expanded = tokens.map(function (tok, i) {
      var nextIsDigit = i + 1 < tokens.length && /^\d/.test(tokens[i + 1]);
      if (tok === 'st'  && !nextIsDigit) return 'street';
      if (tok === 'str')                 return 'street';
      if (tok === 'ave' || tok === 'av') return 'avenue';
      if (tok === 'rd')                  return 'road';
      if (tok === 'blvd'|| tok === 'blv')return 'boulevard';
      if (tok === 'dr')                  return 'drive';
      if (tok === 'ln')                  return 'lane';
      if (tok === 'ct')                  return 'court';
      if (tok === 'cir')                 return 'circle';
      if (tok === 'cres')                return 'crescent';
      if (tok === 'pl')                  return 'place';
      if (tok === 'apt')                 return 'apartment';
      if (tok === 'ste')                 return 'suite';
      if (tok === 'bldg')                return 'building';
      return tok;
    });
    // Split out unit suffixes — anything after "unit"/"apartment"/"suite"/
    // "building" goes into the unit field (kept for geocoding, not used in the
    // Jaro-Winkler comparison).
    var baseTokens = [];
    var unitTokens = [];
    var inUnit = false;
    for (var i = 0; i < expanded.length; i++) {
      var t = expanded[i];
      if (t === 'unit' || t === 'apartment' || t === 'suite' || t === 'building') {
        inUnit = true;
        continue;
      }
      if (inUnit) unitTokens.push(t);
      else baseTokens.push(t);
    }
    return {
      base: baseTokens.join(' ').replace(/\s+/g, ' ').trim(),
      unit: unitTokens.join(' ').replace(/\s+/g, ' ').trim()
    };
  }
  // Strip ", ON" / ", QC" suffixes and lowercase so "Toronto, ON" matches "Toronto".
  function normalizeCity(c) {
    if (!c) return '';
    return String(c).toLowerCase().trim().replace(/,\s*[a-z]{2}\s*$/i, '').trim();
  }

  // ─── Jaro similarity (helper for Jaro-Winkler) ───────────────────────────────
  // Pure-JS implementation. Returns 0-1, where 1 = identical. Correctly
  // handles the match-window and transposition count.
  function jaro(s1, s2) {
    if (s1 === s2) return 1;
    var l1 = s1.length, l2 = s2.length;
    if (l1 === 0 && l2 === 0) return 1;
    if (l1 === 0 || l2 === 0) return 0;
    // Match window: floor(max(|s1|,|s2|)/2) - 1, clamped to >= 0.
    var matchDist = Math.floor(Math.max(l1, l2) / 2) - 1;
    if (matchDist < 0) matchDist = 0;
    var s1Matches = new Array(l1);
    var s2Matches = new Array(l2);
    var matches = 0;
    // Pass 1: count matches within the window.
    for (var i = 0; i < l1; i++) {
      var start = Math.max(0, i - matchDist);
      var end = Math.min(l2 - 1, i + matchDist);
      for (var j = start; j <= end; j++) {
        if (s2Matches[j]) continue;
        if (s1.charAt(i) !== s2.charAt(j)) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
    if (matches === 0) return 0;
    // Pass 2: count transpositions.
    var t = 0;
    var k = 0;
    for (var ii = 0; ii < l1; ii++) {
      if (!s1Matches[ii]) continue;
      while (!s2Matches[k]) k++;
      if (s1.charAt(ii) !== s2.charAt(k)) t++;
      k++;
    }
    t = t / 2;
    var m = matches;
    return ((m / l1) + (m / l2) + ((m - t) / m)) / 3;
  }

  // ─── Jaro-Winkler similarity ─────────────────────────────────────────────────
  // Jaro + a common-prefix bonus (max 4 chars, scaled by p=0.1). Better than
  // plain Jaro for short strings with common prefixes — like addresses, where
  // "123 main street" vs "123 main st" share a long leading run.
  function jaroWinkler(s1, s2) {
    if (s1 == null) s1 = '';
    if (s2 == null) s2 = '';
    s1 = String(s1); s2 = String(s2);
    if (s1 === s2) return 1;
    var j = jaro(s1, s2);
    // Common-prefix length, capped at 4 chars.
    var prefixLen = 0;
    var maxPrefix = 4;
    var minLen = Math.min(s1.length, s2.length, maxPrefix);
    for (var i = 0; i < minLen; i++) {
      if (s1.charAt(i) === s2.charAt(i)) prefixLen++;
      else break;
    }
    // Winkler scaling factor p = 0.1.
    return j + (prefixLen * 0.1 * (1 - j));
  }

  // ─── Fuzzy match algorithm ───────────────────────────────────────────────────
  // For each customer:
  //   1. Hard city filter — only consider service orders in the same city
  //      (after normalizeCity strips ", ON" suffixes etc.).
  //   2. Jaro-Winkler score on the normalized base address (unit stripped).
  //   3. Best match = highest score. Threshold ≥0.85 = high confidence,
  //      0.75-0.85 = ambiguous, <0.75 = no match (we still keep matches above
  //      a low pre-filter cut so the heatmap can show "almost-matches").
  //   4. Return ALL service orders above the low threshold, sorted by score
  //      descending — a customer may have 2-5 service orders.
  function runFuzzyMatch(customers, serviceOrders, config) {
    var aAddrCol = config.aAddress;
    var bAddrCol = config.bAddress;
    var cityColA = config.cityColA;
    var cityColB = config.cityColB;
    var threshold = config.threshold;
    var LOW_THRESHOLD = 0.65;  // pre-filter cut — drops obvious non-matches early

    // Pre-normalize + bucket service orders by normalized city.
    var soByCity = {};
    serviceOrders.forEach(function (so) {
      var soCity = cityColB && so[cityColB] != null ? normalizeCity(so[cityColB]) : '';
      if (!soByCity[soCity]) soByCity[soCity] = [];
      var norm = normalizeAddress(so[bAddrCol] || '');
      soByCity[soCity].push({ so: so, norm: norm });
    });

    var rows = [];
    var matchedCount = 0, ambiguousCount = 0, unmatchedCount = 0;
    var totalMatchedOrders = 0;
    var bestScoreSum = 0;

    customers.forEach(function (cust) {
      var custCity = cityColA && cust[cityColA] != null ? normalizeCity(cust[cityColA]) : '';
      var custNorm = normalizeAddress(cust[aAddrCol] || '');
      var candidates = soByCity[custCity] || [];
      var scored = [];
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var score = jaroWinkler(custNorm.base, c.norm.base);
        if (score >= LOW_THRESHOLD) scored.push({ so: c.so, score: score, norm: c.norm });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      var matches = scored.slice(0, 20); // cap at 20 per customer for UI sanity
      var bestScore = matches.length ? matches[0].score : 0;
      var status;
      if (matches.length === 0 || bestScore < LOW_THRESHOLD) {
        status = 'unmatched';
        unmatchedCount++;
        matches = [];
      } else if (bestScore >= threshold) {
        status = 'matched';
        matchedCount++;
        totalMatchedOrders += matches.length;
        bestScoreSum += bestScore;
      } else {
        status = 'ambiguous';
        ambiguousCount++;
        totalMatchedOrders += matches.length;
        bestScoreSum += bestScore;
      }
      rows.push({
        customer_id:      cust.customer_id || cust.id || '',
        customer_name:    cust.customer_name || cust.name || '',
        customer_address: cust[aAddrCol] || '',
        city:             (cityColA && cust[cityColA]) || '',
        matches: matches.map(function (m) {
          return {
            service_order_id: m.so.service_order_id || m.so.id || '',
            service_type:     m.so.service_type || m.so.type || '',
            address:          m.so[bAddrCol] || '',
            score:            m.score,
            status:           m.so.status || '',
            scheduled_date:   m.so.scheduled_date || m.so.date || ''
          };
        }),
        matched_count: matches.length,
        best_score:    bestScore,
        status:        status
      });
    });

    var avgOrdersPerMatched = matchedCount > 0 ? totalMatchedOrders / matchedCount : 0;
    var avgBestScore = (matchedCount + ambiguousCount) > 0
      ? bestScoreSum / (matchedCount + ambiguousCount) : 0;

    return {
      rows: rows,
      summary: {
        totalCustomers:      customers.length,
        totalServiceOrders:  serviceOrders.length,
        matchedCount:        matchedCount,
        ambiguousCount:      ambiguousCount,
        unmatchedCount:      unmatchedCount,
        totalMatchedOrders:  totalMatchedOrders,
        avgOrdersPerMatched: avgOrdersPerMatched,
        avgBestScore:        avgBestScore,
        threshold:           threshold
      }
    };
  }

  // ─── Nominatim geocoder ──────────────────────────────────────────────────────
  // Free, CORS-enabled, no API key. CRITICAL rate limit: 1 request per second
  // (Nominatim's Usage Policy). We use 1.1s gap as a polite buffer and run
  // requests SEQUENTIALLY — never in parallel, or Nominatim will block the IP.
  // Results cached in state.nominatimCache so re-runs don't re-fetch (saves
  // ~50 seconds on the demo's 50-address dataset).
  function geocodeAddress(addr) {
    if (!addr) return Promise.resolve({ ok: false, originalAddress: addr || '', error: 'Empty address' });
    var key = normalizeAddress(addr).base || addr;
    if (state.nominatimCache[key]) {
      return Promise.resolve(state.nominatimCache[key]);
    }
    var url = NOMINATIM_URL + '?format=json&q=' + encodeURIComponent(addr) + '&limit=1&addressdetails=1';
    return fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Nominatim returned ' + r.status);
        return r.json();
      })
      .then(function (arr) {
        var result;
        if (!arr || !arr.length) {
          result = { ok: false, originalAddress: addr, error: 'No match — address may be invalid' };
        } else {
          var top = arr[0];
          result = {
            ok:             true,
            originalAddress:addr,
            matchedAddress: top.display_name || '',
            lat:            top.lat,
            lon:            top.lon,
            place_id:       top.place_id,
            importance:     top.importance,
            type:           top.type,
            class:          top.class,
            address:        top.address || {}
          };
        }
        state.nominatimCache[key] = result;
        return result;
      })
      .catch(function (e) {
        // Don't cache network errors — might be transient. Cache the "no
        // match" case so we don't burn rate-limit budget re-asking Nominatim
        // for an address it already told us it doesn't recognize.
        return { ok: false, originalAddress: addr, error: e.message || 'Network error' };
      });
  }

  // Sequential geocoder with rate limit + progress callback + abort support.
  // Resolves to an array of geocode results, same length + order as addresses.
  // NEVER fires requests in parallel — Nominatim will block the IP.
  function geocodeAddresses(addresses, onProgress, isAborted) {
    var total = addresses.length;
    var results = new Array(total);
    var i = 0;
    function next() {
      if (isAborted()) return Promise.resolve(results);
      if (i >= total) return Promise.resolve(results);
      if (onProgress) onProgress(i + 1, total, addresses[i]);
      return geocodeAddress(addresses[i]).then(function (r) {
        results[i] = r;
        i++;
        // Wait NOMINATIM_GAP_MS before the next request, except after the last.
        if (i < total && !isAborted()) {
          return new Promise(function (resolve) { setTimeout(resolve, NOMINATIM_GAP_MS); })
            .then(next);
        }
        return next();
      });
    }
    return next();
  }

  // ─── AI brief generator (Groq) ───────────────────────────────────────────────
  // Builds a summary-stats + sample-records prompt, calls Groq, returns the
  // plain-text 4-section executive brief (What happened / Why it matters /
  // What to expect / What to do).
  function generateAIBrief(matches, geocodes) {
    var s = matches.summary;
    var top5 = matches.rows.filter(function (r) { return r.status === 'matched'; })
                   .sort(function (a, b) { return b.best_score - a.best_score; })
                   .slice(0, 5);
    var ambiguous = matches.rows.filter(function (r) { return r.status === 'ambiguous'; }).slice(0, 5);
    var geoOk = 0, geoFail = 0;
    (geocodes || []).forEach(function (g) { if (g && g.ok) geoOk++; else geoFail++; });
    var cityCounts = {};
    matches.rows.forEach(function (r) {
      if (r.status === 'matched' || r.status === 'ambiguous') {
        cityCounts[r.city] = (cityCounts[r.city] || 0) + r.matched_count;
      }
    });
    var cityLines = Object.keys(cityCounts).map(function (c) {
      return '  - ' + c + ': ' + cityCounts[c] + ' matched service orders';
    }).join('\n');

    var userPrompt =
      'FUZZY ADDRESS MATCHING — EXECUTIVE BRIEF REQUEST\n\n' +
      'MATCH SUMMARY:\n' +
      '  - Total customers: ' + s.totalCustomers + '\n' +
      '  - Total service orders in pool: ' + s.totalServiceOrders + '\n' +
      '  - Customers matched (high confidence, score >= ' + s.threshold.toFixed(2) + '): ' + s.matchedCount + '\n' +
      '  - Customers with ambiguous matches (manual review): ' + s.ambiguousCount + '\n' +
      '  - Customers unmatched: ' + s.unmatchedCount + '\n' +
      '  - Total service orders matched: ' + s.totalMatchedOrders + '\n' +
      '  - Average service orders per matched customer: ' + s.avgOrdersPerMatched.toFixed(2) + '\n' +
      '  - Average best-match score: ' + s.avgBestScore.toFixed(3) + '\n\n' +
      'MATCHES BY CITY:\n' + (cityLines || '  (none)') + '\n\n' +
      'GEOCODING (Nominatim / OpenStreetMap):\n' +
      '  - Total addresses geocoded: ' + (geocodes ? geocodes.length : 0) + '\n' +
      '  - Successfully geocoded: ' + geoOk + '\n' +
      '  - Failed (likely data entry errors): ' + geoFail + '\n\n' +
      'TOP 5 MATCHED CUSTOMERS:\n' +
      (top5.length ? top5.map(function (r) {
        return '  - ' + r.customer_name + ' (' + r.city + '): "' + r.customer_address +
               '" -> ' + r.matched_count + ' service orders, best score ' + r.best_score.toFixed(3);
      }).join('\n') : '  (no high-confidence matches)') + '\n\n' +
      (ambiguous.length
        ? 'AMBIGUOUS MATCHES (sample of ' + ambiguous.length + '):\n' +
          ambiguous.map(function (r) {
            return '  - ' + r.customer_name + ' (' + r.city + '): "' + r.customer_address +
                   '" -> best score ' + r.best_score.toFixed(3) + ' — manual review recommended';
          }).join('\n') + '\n\n'
        : 'No ambiguous matches.\n\n') +
      'Write the 4-section executive brief now. Plain text only — no markdown, no headers, ' +
      'just four paragraphs (one per section). Reference actual numbers, cities, and customer names from above.';

    var messages = [
      {
        role: 'system',
        content: 'You are an analyst writing a plain-English executive brief on fuzzy address matching results. ' +
                 'Four sections: (1) What happened — concrete summary stats. ' +
                 '(2) Why it matters — patterns + anomalies in the data. ' +
                 '(3) What to expect — operational implications. ' +
                 '(4) What to do — recommended actions. ' +
                 'Plain text, no markdown, no headers, just paragraphs. ' +
                 'Be specific to the data — reference actual numbers, regions, customer names from the summary.'
      },
      { role: 'user', content: userPrompt }
    ];
    return callGroq(messages, { temperature: 0.45, max_tokens: 1100 });
  }

  // ─── Download helpers ──────────────────────────────────────────────────────
  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 200);
  }
  function downloadCSV(rows, columns, filename) {
    if (!rows.length) rows = [{}];
    var cols = columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
    var escCsv = function (v) {
      var s = v == null ? '' : String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    var lines = [cols.map(escCsv).join(',')];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) { return escCsv(r[c]); }).join(','));
    });
    downloadBlob(filename || 'fuzzy-match.csv',
      new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  }
  function downloadExcel(rows, columns, filename) {
    return loadScript('xlsx').then(function () {
      var cols = columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
      var data = [cols];
      rows.forEach(function (r) { data.push(cols.map(function (c) { return r[c]; })); });
      var ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = cols.map(function (c) {
        var maxLen = String(c).length;
        for (var j = 0; j < Math.min(rows.length, 200); j++) {
          var v = rows[j][c];
          var l = (v == null ? '' : String(v)).length;
          if (l > maxLen) maxLen = l;
        }
        return { wch: Math.min(40, Math.max(10, maxLen + 2)) };
      });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fuzzy Match');
      var arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      downloadBlob(filename || 'fuzzy-match.xlsx',
        new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
  }
  function downloadJSON(obj, filename) {
    downloadBlob(filename || 'fuzzy-match.json',
      new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  }

  // Flatten the matches object into one row per (customer × service order) pair
  // — used by CSV/Excel/email exports. Unmatched customers get a single row
  // with empty service-order fields.
  function matchesToExportRows(matches) {
    var rows = [];
    matches.rows.forEach(function (r) {
      r.matches.forEach(function (m) {
        rows.push({
          customer_id:      r.customer_id,
          customer_name:    r.customer_name,
          customer_address: r.customer_address,
          city:             r.city,
          service_order_id: m.service_order_id,
          service_type:     m.service_type,
          service_address:  m.address,
          scheduled_date:   m.scheduled_date,
          service_status:   m.status,
          jaro_winkler:     Number(m.score).toFixed(4),
          match_status:     r.status
        });
      });
      if (!r.matches.length) {
        rows.push({
          customer_id:      r.customer_id,
          customer_name:    r.customer_name,
          customer_address: r.customer_address,
          city:             r.city,
          service_order_id: '',
          service_type:     '',
          service_address:  '',
          scheduled_date:   '',
          service_status:   '',
          jaro_winkler:     '',
          match_status:     'unmatched'
        });
      }
    });
    return rows;
  }
  function geocodesToExportRows(geocodes) {
    return (geocodes || []).map(function (g) {
      var a = (g && g.address) || {};
      return {
        original_address: g.originalAddress || '',
        matched_address:  g.ok ? g.matchedAddress : '',
        house_number:     a.house_number || '',
        road:             a.road || '',
        city:             a.city || '',
        state:            a.state || '',
        postcode:         a.postcode || '',
        country:          a.country || '',
        lat:              g.ok ? g.lat : '',
        lon:              g.ok ? g.lon : '',
        place_id:         g.ok ? g.place_id : '',
        importance:       g.ok ? g.importance : '',
        geocode_status:   g.ok ? 'OK' : ('Failed: ' + (g.error || ''))
      };
    });
  }

  // ─── Email body builders ──────────────────────────────────────────────────────
  // Plain text (Unicode box-drawing chars) for mailto:, branded HTML for the
  // preview modal. Mirrors the pipeline-builder pattern.
  function emailFooter() {
    return '\u2500'.repeat(60) + '\n\n' +
      'Insight Analytics  \u00b7  Live truth on every desk.\n' +
      'https://insight-analytics.ca';
  }

  function buildEmailBodyPlain() {
    var s = state.matches ? state.matches.summary : null;
    var gs = state.geocodes || [];
    var geoOk = gs.filter(function (g) { return g.ok; }).length;
    var generated = new Date().toLocaleString('en-CA', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    var bar = '\u2550'.repeat(60);
    var lines = [
      bar,
      '  INSIGHT ANALYTICS  \u00b7  FUZZY ADDRESS MATCHER + GEOCODER',
      bar,
      '',
      'Generated: ' + generated,
      '',
      '\u2500'.repeat(60),
      '  MATCH SUMMARY',
      '\u2500'.repeat(60)
    ];
    if (s) {
      lines.push('  Customers:               ' + s.totalCustomers);
      lines.push('  Service orders in pool:  ' + s.totalServiceOrders);
      lines.push('  Matched (high conf.):    ' + s.matchedCount);
      lines.push('  Ambiguous (review):      ' + s.ambiguousCount);
      lines.push('  Unmatched:               ' + s.unmatchedCount);
      lines.push('  Service orders matched:  ' + s.totalMatchedOrders);
      lines.push('  Avg orders/customer:     ' + s.avgOrdersPerMatched.toFixed(2));
      lines.push('  Avg best-match score:    ' + s.avgBestScore.toFixed(3));
      lines.push('  Match threshold:         ' + s.threshold.toFixed(2));
    }
    lines.push('');
    lines.push('\u2500'.repeat(60));
    lines.push('  GEOCODING (Nominatim / OpenStreetMap)');
    lines.push('\u2500'.repeat(60));
    lines.push('  Addresses geocoded:      ' + gs.length);
    lines.push('  Successfully geocoded:  ' + geoOk);
    lines.push('  Failed:                  ' + (gs.length - geoOk));
    if (state.aiBrief) {
      lines.push('');
      lines.push('\u2500'.repeat(60));
      lines.push('  AI EXECUTIVE BRIEF');
      lines.push('\u2500'.repeat(60));
      lines.push('');
      lines.push(state.aiBrief.trim());
    }
    lines.push('');
    lines.push(emailFooter());
    return lines.join('\n');
  }

  // HTML email — branded gradient header + summary table + AI brief block.
  // Inline CSS so it renders in any email client that supports HTML.
  function buildEmailBodyHTML() {
    var s = state.matches ? state.matches.summary : null;
    var gs = state.geocodes || [];
    var geoOk = gs.filter(function (g) { return g.ok; }).length;
    var generated = new Date().toLocaleString('en-CA', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    var briefHTML = state.aiBrief ? esc(state.aiBrief)
      .replace(/\r?\n\r?\n/g, '</p><p style="margin:0 0 14px;color:#0f172a;font-size:14px;line-height:1.7;">')
      .replace(/\r?\n/g, '<br>') : '';
    var summaryRows = s ? [
      ['Customers', s.totalCustomers],
      ['Service orders in pool', s.totalServiceOrders],
      ['Matched (high confidence)', s.matchedCount],
      ['Ambiguous (manual review)', s.ambiguousCount],
      ['Unmatched', s.unmatchedCount],
      ['Total service orders matched', s.totalMatchedOrders],
      ['Avg service orders per matched customer', s.avgOrdersPerMatched.toFixed(2)],
      ['Match threshold', s.threshold.toFixed(2)]
    ] : [];
    var summaryCells = summaryRows.map(function (r, idx) {
      var bg = idx % 2 === 0 ? '#ffffff' : '#f1f5f9';
      return '<tr><td style="padding:8px 14px;font-size:13px;color:#475569;border-bottom:1px solid #e2e8f0;background:' + bg + ';">' + esc(r[0]) + '</td>' +
        '<td style="padding:8px 14px;font-size:13px;color:#0f172a;text-align:right;border-bottom:1px solid #e2e8f0;background:' + bg + ';font-variant-numeric:tabular-nums;font-weight:600;">' + esc(String(r[1])) + '</td></tr>';
    }).join('');
    return '' +
      '<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;background:#f8fafc;padding:24px;">' +
        '<div style="background:linear-gradient(135deg,#4338ca 0%,#0e7490 100%);padding:24px 28px;border-radius:12px 12px 0 0;">' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:0.16em;color:#cbd5e1;text-transform:uppercase;">INSIGHT ANALYTICS</div>' +
          '<div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px;">Fuzzy Address Matcher + Geocoder</div>' +
          '<div style="font-size:12px;color:#cbd5e1;margin-top:4px;">Generated ' + esc(generated) + '</div>' +
        '</div>' +
        '<div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-top:0;">' +
          (summaryRows.length
            ? '<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;color:#64748b;text-transform:uppercase;margin:0 0 8px;">Match summary</div>' +
              '<table style="width:100%;border-collapse:collapse;font-family:Inter,Helvetica,Arial,sans-serif;margin-bottom:18px;">' +
              '<tbody>' + summaryCells + '</tbody></table>'
            : '') +
          '<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;color:#64748b;text-transform:uppercase;margin:0 0 8px;">Geocoding (Nominatim / OSM)</div>' +
          '<p style="margin:0 0 18px;color:#475569;font-size:14px;line-height:1.6;">' + geoOk + ' of ' + gs.length + ' addresses successfully geocoded.</p>' +
          (briefHTML
            ? '<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;color:#64748b;text-transform:uppercase;margin:0 0 8px;">AI executive brief</div>' +
              '<div style="padding:18px 20px;background:linear-gradient(135deg,rgba(99,102,241,0.04),rgba(6,182,212,0.03));border:1px solid #e2e8f0;border-radius:8px;">' +
              '<p style="margin:0 0 14px;color:#0f172a;font-size:14px;line-height:1.7;">' + briefHTML + '</p></div>'
            : '') +
        '</div>' +
        '<div style="background:#0b1120;padding:18px 28px;border-radius:0 0 12px 12px;text-align:center;">' +
          '<div style="font-size:13px;font-weight:600;color:#e6edf7;">Insight Analytics &middot; <em style="font-style:italic;color:#06b6d4;">Live truth on every desk.</em></div>' +
          '<div style="font-size:11px;color:#64748b;margin-top:4px;"><a href="https://insight-analytics.ca" style="color:#06b6d4;text-decoration:none;">insight-analytics.ca</a></div>' +
        '</div>' +
      '</div>';
  }

  // ─── Reusable modal ─────────────────────────────────────────────────────────
  // Mirror of pipeline-builder's modal — but scoped to .fm- prefix.
  function openModal(title, bodyHTML, buttons) {
    closeModal();
    var back = document.createElement('div');
    back.className = 'fm-modal-backdrop';
    back.id = 'fm-modal';
    var actionsHTML = '';
    (buttons || []).forEach(function (b, idx) {
      actionsHTML += '<button class="btn ' + (b.primary ? 'btn-primary' : 'btn-ghost') +
        ' fm-btn-sm" data-fm-modal-action="' + idx + '">' + esc(b.label) + '</button>';
    });
    back.innerHTML =
      '<div class="fm-modal" role="dialog" aria-modal="true">' +
        '<h3 class="fm-modal-title">' + esc(title) + '</h3>' +
        '<div class="fm-modal-body">' + bodyHTML + '</div>' +
        '<div class="fm-modal-actions">' + actionsHTML + '</div>' +
      '</div>';
    document.body.appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back) { closeModal(); return; }
      var btn = e.target.closest('[data-fm-modal-action]');
      if (btn) {
        var idx = parseInt(btn.getAttribute('data-fm-modal-action'), 10);
        var handler = (buttons || [])[idx];
        if (handler && handler.action) handler.action();
      }
    });
    document.addEventListener('keydown', modalEscHandler);
  }
  function modalEscHandler(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    var m = $('fm-modal');
    if (m) m.remove();
    document.removeEventListener('keydown', modalEscHandler);
  }

  // ─── CSS injection ──────────────────────────────────────────────────────────
  // All fuzzy-match-specific CSS lives in a single injected <style> block,
  // scoped with the .fm- prefix so it can't clash with the site stylesheet or
  // the .pb- styles from blog-pipeline-builder.js. Reuses the site's design
  // tokens (--bg, --surface, --border, --text, etc.) and the site's .btn /
  // .btn-primary / .btn-ghost classes (defined globally).
  function injectCSS() {
    if ($('fm-style')) return;
    var css = [
'.fm-app { font-family: var(--font-body); color: var(--text); max-width: 1040px; margin: 0 auto; padding: 0; }',
'.fm-app * { box-sizing: border-box; }',
'.fm-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 20px; box-shadow: var(--shadow-sm); }',
'.fm-card-title { font-family: var(--font-head); font-size: 1.15rem; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; color: var(--text); }',
'.fm-card-sub { color: var(--text-soft); font-size: 0.88rem; margin: 0 0 18px; }',
'.fm-card-step { display: inline-block; font-family: var(--font-head); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--indigo); margin-bottom: 6px; }',
'.fm-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }',
'@media (max-width: 720px) { .fm-grid-2 { grid-template-columns: 1fr; } }',
'.fm-drop { border: 2px dashed var(--border-strong); border-radius: var(--radius); padding: 28px 18px; text-align: center; cursor: pointer; transition: border-color 0.2s var(--ease), background 0.2s var(--ease); background: var(--bg-alt); }',
'.fm-drop:hover, .fm-drop.fm-dragover { border-color: var(--indigo); background: linear-gradient(135deg, rgba(99,102,241,0.06), rgba(6,182,212,0.06)); }',
'.fm-drop-icon { font-size: 1.6rem; color: var(--indigo); margin-bottom: 6px; }',
'.fm-drop-text { color: var(--text); font-weight: 600; margin-bottom: 4px; font-size: 0.9rem; }',
'.fm-drop-hint { color: var(--text-soft); font-size: 0.78rem; }',
'.fm-divider { display: flex; align-items: center; gap: 12px; color: var(--text-soft); font-size: 0.82rem; margin: 18px 0 12px; }',
'.fm-divider::before, .fm-divider::after { content: ""; flex: 1; height: 1px; background: var(--border); }',
'.fm-sample { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; cursor: pointer; text-align: left; transition: transform 0.2s var(--ease), border-color 0.2s var(--ease), box-shadow 0.2s var(--ease); font-family: inherit; color: var(--text); width: 100%; }',
'.fm-sample:hover { transform: translateY(-2px); border-color: var(--indigo); box-shadow: 0 12px 26px -14px rgba(99,102,241,0.5); }',
'.fm-sample-icon { color: var(--indigo); font-size: 1rem; margin-bottom: 4px; }',
'.fm-sample-name { font-weight: 600; font-size: 0.9rem; }',
'.fm-sample-meta { color: var(--text-soft); font-size: 0.76rem; margin-top: 2px; }',
'.fm-table-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; }',
'.fm-table-card-title { font-family: var(--font-head); font-size: 0.95rem; font-weight: 600; color: var(--text); margin: 0 0 4px; }',
'.fm-table-card-meta { color: var(--text-soft); font-size: 0.78rem; margin: 0 0 10px; }',
'.fm-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 280px; background: var(--surface); }',
'.fm-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }',
'.fm-table th, .fm-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }',
'.fm-table th { background: var(--bg-alt); color: var(--text-muted); font-family: var(--font-head); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; z-index: 1; }',
'.fm-table td.num { text-align: right; font-variant-numeric: tabular-nums; }',
'.fm-table tbody tr:hover { background: rgba(99,102,241,0.04); }',
'.fm-table th.col-address, .fm-table th.col-city { background: linear-gradient(135deg, rgba(99,102,241,0.14), rgba(6,182,212,0.08)); color: var(--indigo); }',
'.fm-table td.col-address, .fm-table td.col-city { background: rgba(99,102,241,0.04); }',
'.fm-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }',
'.fm-field-label { font-family: var(--font-head); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-soft); }',
'.fm-select { width: 100%; background: var(--bg-alt); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text); font-family: inherit; font-size: 0.9rem; }',
'.fm-select:focus { outline: none; border-color: var(--indigo); box-shadow: var(--ring); }',
'.fm-slider-row { display: flex; align-items: center; gap: 14px; margin-top: 6px; }',
'.fm-slider { flex: 1; -webkit-appearance: none; appearance: none; height: 6px; background: var(--border-strong); border-radius: 3px; outline: none; }',
'.fm-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #4338ca, #0e7490); cursor: pointer; box-shadow: 0 2px 8px -2px rgba(67,56,202,0.5); }',
'.fm-slider::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #4338ca, #0e7490); cursor: pointer; border: none; }',
'.fm-slider-value { font-family: var(--font-head); font-weight: 700; font-size: 0.95rem; color: var(--indigo); min-width: 56px; text-align: right; font-variant-numeric: tabular-nums; }',
'.fm-btn-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; }',
'.fm-btn-sm { min-height: 38px; padding: 8px 16px; font-size: 0.85rem; border-radius: 999px; }',
'.fm-btn-row .fm-spacer { flex: 1; }',
'.fm-link { background: none; border: none; color: var(--indigo); cursor: pointer; font-size: 0.85rem; padding: 0; text-decoration: underline; font-family: inherit; }',
'.fm-link:hover { color: var(--cyan); }',
'.fm-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }',
'@media (max-width: 720px) { .fm-stats { grid-template-columns: repeat(2, 1fr); } }',
'.fm-stat { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; }',
'.fm-stat-value { font-family: var(--font-head); font-size: 1.4rem; font-weight: 700; color: var(--text); line-height: 1.1; }',
'.fm-stat-value.ok    { color: #16a34a; }',
'.fm-stat-value.warn  { color: #d97706; }',
'.fm-stat-value.bad   { color: #dc2626; }',
'[data-theme="dark"] .fm-stat-value.ok    { color: #4ade80; }',
'[data-theme="dark"] .fm-stat-value.warn  { color: #fbbf24; }',
'[data-theme="dark"] .fm-stat-value.bad   { color: #f87171; }',
'.fm-stat-label { color: var(--text-soft); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px; font-family: var(--font-head); }',
'.fm-map-btn { display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--accent);cursor:pointer;font-size:0.7rem;padding:0;margin:0 0 0 4px;vertical-align:middle;transition:all 180ms ease; }',
'.fm-map-btn:hover { background:var(--accent);color:#fff;border-color:var(--accent);transform:scale(1.1); }',
'[data-theme="dark"] .fm-map-btn { background:rgba(255,255,255,0.06);color:var(--accent); }',
'[data-theme="dark"] .fm-map-btn:hover { background:var(--accent);color:#fff; }',
'.fm-status-pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; font-family: var(--font-head); letter-spacing: 0.04em; }',
'.fm-status-pill.matched   { background: rgba(22,163,74,0.14); color: #16a34a; }',
'.fm-status-pill.ambiguous { background: rgba(217,119,6,0.14); color: #d97706; }',
'.fm-status-pill.unmatched { background: rgba(220,38,38,0.12); color: #dc2626; }',
'[data-theme="dark"] .fm-status-pill.matched   { background: rgba(74,222,128,0.14); color: #4ade80; }',
'[data-theme="dark"] .fm-status-pill.ambiguous { background: rgba(251,191,36,0.16); color: #fbbf24; }',
'[data-theme="dark"] .fm-status-pill.unmatched { background: rgba(248,113,113,0.16); color: #f87171; }',
'.fm-progress { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 18px; margin-bottom: 16px; }',
'.fm-progress-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }',
'.fm-progress-title { font-family: var(--font-head); font-weight: 600; font-size: 0.88rem; color: var(--text); }',
'.fm-progress-pct { font-family: var(--font-head); font-weight: 700; font-size: 0.88rem; color: var(--indigo); }',
'.fm-progress-bar { height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }',
'.fm-progress-fill { height: 100%; background: linear-gradient(135deg, #4338ca, #0e7490); transition: width 0.4s var(--ease); }',
'.fm-progress-sub { color: var(--text-soft); font-size: 0.78rem; margin-top: 8px; font-family: var(--font-body); word-break: break-word; }',
'.fm-chart-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; margin-top: 18px; }',
'.fm-chart-title { font-family: var(--font-head); font-size: 0.82rem; font-weight: 600; color: var(--text-muted); margin: 0 0 6px; }',
'.fm-chart-body { width: 100%; height: 440px; }',
'.fm-chart-empty { padding: 36px; text-align: center; color: var(--text-soft); font-size: 0.85rem; }',
'.fm-ai-result-card { padding: 20px 24px; border-radius: var(--radius); background: linear-gradient(135deg, rgba(99,102,241,0.04), rgba(6,182,212,0.03)); border: 1px solid var(--border); margin-top: 8px; }',
'.fm-ai-result-text { font-size: 0.96rem; line-height: 1.75; color: var(--text); white-space: normal; }',
'.fm-ai-result-text br + br { margin-top: 8px; }',
'.fm-error { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-sm); padding: 12px 16px; color: #b91c1c; margin-top: 12px; font-size: 0.88rem; }',
'[data-theme="dark"] .fm-error { color: #fca5a5; }',
'.fm-warn { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.28); border-radius: var(--radius-sm); padding: 10px 14px; color: #b45309; margin-top: 12px; font-size: 0.82rem; }',
'[data-theme="dark"] .fm-warn { color: #fcd34d; }',
'.fm-loading { display: flex; align-items: center; gap: 10px; color: var(--text-soft); font-size: 0.88rem; padding: 14px 0; }',
'.fm-loading-block { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 16px; text-align: center; color: var(--text-soft); font-size: 0.95rem; }',
'.fm-loading-sub { font-size: 0.78rem; color: var(--text-soft); opacity: 0.7; }',
'.fm-spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--indigo); border-radius: 50%; animation: fm-spin 0.8s linear infinite; flex-shrink: 0; }',
'@keyframes fm-spin { to { transform: rotate(360deg); } }',
'.fm-rate-note { color: var(--text-soft); font-size: 0.74rem; margin-top: 10px; text-align: right; }',
'.fm-download-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; align-items: center; }',
'.fm-email-html-preview { max-height: 480px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; padding: 0; background: #f8fafc; }',
'.fm-email-html-preview > div { margin: 0 !important; }',
'.fm-modal-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.55); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px; }',
'.fm-modal { background: var(--bg-elevated, var(--surface)); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 24px; max-width: 640px; width: 100%; max-height: 80vh; overflow: auto; box-shadow: var(--shadow-lg); }',
'.fm-modal-title { font-family: var(--font-head); font-size: 1.1rem; font-weight: 700; margin: 0 0 14px; }',
'.fm-modal-body { color: var(--text); font-size: 0.9rem; }',
'.fm-modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }',
'.fm-modal-pre { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; white-space: pre-wrap; word-break: break-word; font-size: 0.78rem; color: var(--text-muted); max-height: 320px; overflow: auto; font-family: "SFMono-Regular", Consolas, monospace; }',
'.fm-input { width: 100%; background: var(--bg-alt); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 10px 12px; color: var(--text); font-family: inherit; font-size: 0.92rem; }',
'.fm-input:focus { outline: none; border-color: var(--indigo); box-shadow: var(--ring); }',
'.fm-analysis-section { margin-top: 12px; }',
'.fm-analysis-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-soft); margin: 0 0 4px; font-family: var(--font-head); }',
'.fm-coords { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.78rem; color: var(--text-muted); }'
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'fm-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── HTML table renderer (reusable) ─────────────────────────────────────────
  // Returns an HTML string for a scrollable table. Highlights the auto-detected
  // address + city columns by adding col-address / col-city classes.
  function renderTableHTML(rows, columns, opts) {
    opts = opts || {};
    var addressCol = opts.addressCol;
    var cityCol = opts.cityCol;
    var maxRows = opts.maxRows != null ? opts.maxRows : 5;
    if (!rows.length) return '<div class="fm-chart-empty">No rows.</div>';
    var shown = rows.slice(0, maxRows);
    var html = '<div class="fm-table-wrap"><table class="fm-table"><thead><tr>';
    columns.forEach(function (c) {
      var cls = '';
      if (c === addressCol) cls = ' col-address';
      else if (c === cityCol) cls = ' col-city';
      html += '<th class="' + cls + '">' + esc(c) + '</th>';
    });
    html += '</tr></thead><tbody>';
    shown.forEach(function (r) {
      html += '<tr>';
      columns.forEach(function (c) {
        var v = r[c];
        var cls = '';
        if (c === addressCol) cls = ' col-address';
        else if (c === cityCol) cls = ' col-city';
        html += '<td class="' + cls + '">' + esc(v == null ? '' : v) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    if (rows.length > maxRows) {
      html += '<div style="color:var(--text-soft);font-size:0.78rem;margin-top:6px;font-style:italic;">… ' +
        (rows.length - maxRows) + ' more rows not shown.</div>';
    }
    return html;
  }

  // ─── ECharts heatmap renderer ─────────────────────────────────────────────────
  // rows = customers (top 20 by best_score, desc), cols = "Order 1" … "Order 10".
  // Cell colour = Jaro-Winkler score: red (≤0.65) → amber (0.65-0.85) → green (≥0.85).
  function renderHeatmap(mount) {
    var body = mount.querySelector('.fm-chart-body');
    if (!body) return;
    if (!state.matches || !state.matches.rows || !state.matches.rows.length) {
      body.innerHTML = '<div class="fm-chart-empty">Run the fuzzy match to see the heatmap.</div>';
      return;
    }
    loadScript('echarts').then(function () {
      try {
        if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
        var inst = echarts.init(body, null, { renderer: 'canvas' });
        inst.setOption(buildHeatmapConfig(state.matches));
        state.chart = inst;
        // Resize handler — only bound once.
        if (!renderHeatmap._resizeBound) {
          window.addEventListener('resize', function () {
            if (state.chart) try { state.chart.resize(); } catch (e) {}
          });
          renderHeatmap._resizeBound = true;
        }
      } catch (e) {
        body.innerHTML = '<div class="fm-chart-empty">Heatmap rendering failed.</div>';
      }
    }).catch(function () {
      body.innerHTML = '<div class="fm-chart-empty">Couldn\u2019t load the chart library.</div>';
    });
  }
  function buildHeatmapConfig(matches) {
    var sorted = matches.rows.slice().sort(function (a, b) { return b.best_score - a.best_score; })
                            .slice(0, 20);
    var maxCols = 10;
    var yLabels = sorted.map(function (r) {
      var n = r.customer_name || r.customer_id || '?';
      return n.length > 22 ? n.slice(0, 20) + '…' : n;
    });
    var xLabels = [];
    for (var i = 1; i <= maxCols; i++) xLabels.push('Order ' + i);
    var data = [];
    for (var yi = 0; yi < sorted.length; yi++) {
      var c = sorted[yi];
      for (var xi = 0; xi < maxCols; xi++) {
        var m = c.matches[xi];
        var score = m ? Number(m.score) : 0;
        data.push({
          value: [xi, yi, score],
          // Attach service-order metadata for the tooltip.
          so: m ? (m.service_order_id + ' · ' + (m.service_type || '') + ' · "' + (m.address || '') + '"') : ''
        });
      }
    }
    return {
      tooltip: {
        position: 'top',
        backgroundColor: tooltipBgColor(),
        textStyle: { color: tooltipTextColor() },
        borderColor: 'rgba(99,102,241,0.2)',
        formatter: function (p) {
          var v = p.data;
          if (!v) return '';
          var score = v.value[2];
          var so = v.so || '(no service order in this slot)';
          var cust = yLabels[v.value[1]] || '';
          return '<div style="font-size:11px;line-height:1.6;">' +
            '<b>' + esc(cust) + '</b><br>' +
            esc(so) + '<br>' +
            'Jaro-Winkler: <b>' + score.toFixed(3) + '</b>' +
            '</div>';
        }
      },
      grid: { left: 140, right: 30, top: 20, bottom: 80 },
      xAxis: {
        type: 'category', data: xLabels, splitArea: { show: true },
        axisLabel: { color: axisLabelColor(), fontSize: 10, interval: 0, rotate: 35 },
        axisLine: { lineStyle: { color: chartGridColor() } }
      },
      yAxis: {
        type: 'category', data: yLabels, splitArea: { show: true },
        axisLabel: { color: axisLabelColor(), fontSize: 10 },
        axisLine: { lineStyle: { color: chartGridColor() } }
      },
      visualMap: {
        min: 0, max: 1, calculable: true, orient: 'horizontal',
        left: 'center', bottom: 6,
        textStyle: { color: axisLabelColor(), fontSize: 10 },
        inRange: { color: ['#dc2626', '#f59e0b', '#fbbf24', '#84cc16', '#16a34a'] }
      },
      series: [{
        name: 'Jaro-Winkler', type: 'heatmap', data: data,
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(99,102,241,0.5)' } },
        label: { show: false },
        progressive: 1000, animation: false
      }]
    };
  }

  // ─── Sub-renderers ──────────────────────────────────────────────────────────
  // Each writes into a fixed-id slot inside the mount. render() calls them in
  // order; each no-ops its slot when its slice of state is absent.

  function renderUploadCard() {
    var slot = $('fm-upload-slot');
    if (!slot) return;
    // Loading state — samples being generated (synchronous, ~5ms, but
    // showing the spinner keeps the UX consistent).
    if (state.tableALoading || state.tableBLoading) {
      slot.innerHTML =
        '<div class="fm-card">' +
          '<div class="fm-loading-block">' +
            '<div class="fm-spinner"></div>' +
            '<div>Loading sample data…</div>' +
            '<div class="fm-loading-sub">Generating deterministic 50-customer / ~150-service-order dataset.</div>' +
          '</div>' +
        '</div>';
      return;
    }
    if (state.tableA && state.tableB) { slot.innerHTML = ''; return; }
    // Errors from a failed sample load (shouldn't happen for embedded data,
    // but a file upload might fail).
    var errHTML = '';
    if (state.tableAError) errHTML += '<div class="fm-error"><i class="fas fa-triangle-exclamation"></i> Table A: ' + esc(state.tableAError) + '</div>';
    if (state.tableBError) errHTML += '<div class="fm-error"><i class="fas fa-triangle-exclamation"></i> Table B: ' + esc(state.tableBError) + '</div>';

    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 1 — Load your data</div>' +
        '<h3 class="fm-card-title">Load the two transactional tables</h3>' +
        '<p class="fm-card-sub">Two unrelated tables — customers and service orders — both with free-form addresses. Pick the embedded samples (fastest) or upload your own CSV / Excel / JSON.</p>' +
        '<div class="fm-grid-2">' +
          renderUploadSide('A', 'Customers', 'fa-users', state.tableA, 'fm-drop-a', 'fm-file-a', 'fm-sample-a', 'fm-replace-a', 'Use sample customers', '50 records · 5 Canadian cities · generated') +
          renderUploadSide('B', 'Service Orders', 'fa-clipboard-list', state.tableB, 'fm-drop-b', 'fm-file-b', 'fm-sample-b', 'fm-replace-b', 'Use sample service orders', '~150 records · fuzzy address variants · generated') +
        '</div>' +
        errHTML +
      '</div>';
  }
  // Helper — one half of the upload grid (Table A or B).
  function renderUploadSide(letter, label, icon, table, dropId, fileId, sampleId, replaceId, sampleLabel, sampleMeta) {
    var inner;
    if (table) {
      inner = '<div class="fm-table-card">' +
        '<div class="fm-table-card-title"><i class="fas ' + icon + '" style="color:var(--indigo);margin-right:6px;"></i>' + esc(table.name) + '</div>' +
        '<div class="fm-table-card-meta">' + table.rowCount + ' rows × ' + table.columnCount + ' cols · ' + esc(table.type.toUpperCase()) + (table.fileSize ? ' · ' + fmtBytes(table.fileSize) : '') + '</div>' +
        '<button class="fm-link" id="' + replaceId + '" type="button">Replace</button>' +
      '</div>';
    } else {
      inner =
        '<div class="fm-drop" id="' + dropId + '" tabindex="0" role="button" aria-label="Upload ' + label + '">' +
          '<div class="fm-drop-icon"><i class="fas ' + icon + '"></i></div>' +
          '<div class="fm-drop-text">Drop .csv / .xlsx / .json</div>' +
          '<div class="fm-drop-hint">or click to browse · max 5 MB</div>' +
        '</div>' +
        '<input type="file" id="' + fileId + '" accept=".csv,.xlsx,.xls,.json" hidden />' +
        '<button class="fm-sample" id="' + sampleId + '" type="button" style="margin-top:10px;">' +
          '<div class="fm-sample-icon"><i class="fas fa-database"></i></div>' +
          '<div class="fm-sample-name">' + esc(sampleLabel) + '</div>' +
          '<div class="fm-sample-meta">' + esc(sampleMeta) + '</div>' +
        '</button>';
    }
    return '<div>' +
      '<div class="fm-analysis-label" style="margin-bottom:6px;">Table ' + letter + ' — ' + esc(label) + '</div>' +
      inner +
    '</div>';
  }

  function renderTablesPreviewCard() {
    var slot = $('fm-tables-slot');
    if (!slot) return;
    if (!state.tableA && !state.tableB) { slot.innerHTML = ''; return; }
    var aHTML = state.tableA
      ? '<div class="fm-table-card">' +
          '<div class="fm-table-card-title">Table A — Customers</div>' +
          '<div class="fm-table-card-meta">' + esc(state.tableA.name) + ' · ' + state.tableA.rowCount + ' rows × ' + state.tableA.columnCount + ' cols · ' + esc(state.tableA.type.toUpperCase()) + '</div>' +
          (state.tableA.warnings.length ? state.tableA.warnings.map(function (w) { return '<div class="fm-warn"><i class="fas fa-circle-exclamation"></i> ' + esc(w) + '</div>'; }).join('') : '') +
          renderTableHTML(state.tableA.rows, state.tableA.columns, {
            addressCol: state.config.aAddress,
            cityCol: state.config.cityColA,
            maxRows: 5
          }) +
        '</div>'
      : '<div class="fm-chart-empty">Table A not loaded yet.</div>';
    var bHTML = state.tableB
      ? '<div class="fm-table-card">' +
          '<div class="fm-table-card-title">Table B — Service Orders</div>' +
          '<div class="fm-table-card-meta">' + esc(state.tableB.name) + ' · ' + state.tableB.rowCount + ' rows × ' + state.tableB.columnCount + ' cols · ' + esc(state.tableB.type.toUpperCase()) + '</div>' +
          (state.tableB.warnings.length ? state.tableB.warnings.map(function (w) { return '<div class="fm-warn"><i class="fas fa-circle-exclamation"></i> ' + esc(w) + '</div>'; }).join('') : '') +
          renderTableHTML(state.tableB.rows, state.tableB.columns, {
            addressCol: state.config.bAddress,
            cityCol: state.config.cityColB,
            maxRows: 5
          }) +
        '</div>'
      : '<div class="fm-chart-empty">Table B not loaded yet.</div>';
    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 1 (preview)</div>' +
        '<h3 class="fm-card-title">Tables preview</h3>' +
        '<p class="fm-card-sub">First 5 rows of each table. The auto-detected <span style="color:var(--indigo);font-weight:600;">address</span> and <span style="color:var(--indigo);font-weight:600;">city</span> columns are highlighted. Override them in the next step if needed.</p>' +
        '<div class="fm-grid-2">' + aHTML + bHTML + '</div>' +
      '</div>';
  }

  function renderMatchConfigCard() {
    var slot = $('fm-config-slot');
    if (!slot) return;
    if (!state.tableA || !state.tableB) { slot.innerHTML = ''; return; }
    var err = state.matchError
      ? '<div class="fm-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.matchError) + '</div>'
      : '';
    // Build column dropdown options for Table A and Table B.
    var aCols = state.tableA.columns;
    var bCols = state.tableB.columns;
    function optList(cols, selected) {
      return cols.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('');
    }
    // City column dropdowns — independent per table (the city column might be
    // named differently in Table A vs Table B). Both default to the detected
    // city column for that table.
    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 2 — Configure the match</div>' +
        '<h3 class="fm-card-title">Match configuration</h3>' +
        '<p class="fm-card-sub">Auto-detected. Override if the wrong column was picked. The city column is a hard filter — service orders outside the customer\u2019s city are skipped before scoring.</p>' +
        '<div class="fm-grid-2">' +
          '<div>' +
            '<div class="fm-field">' +
              '<div class="fm-field-label">Table A — address column</div>' +
              '<select class="fm-select" id="fm-config-a-addr">' + optList(aCols, state.config.aAddress) + '</select>' +
            '</div>' +
            '<div class="fm-field">' +
              '<div class="fm-field-label">Table A — city column</div>' +
              '<select class="fm-select" id="fm-config-a-city">' + optList(aCols, state.config.cityColA) + '</select>' +
            '</div>' +
          '</div>' +
          '<div>' +
            '<div class="fm-field">' +
              '<div class="fm-field-label">Table B — address column</div>' +
              '<select class="fm-select" id="fm-config-b-addr">' + optList(bCols, state.config.bAddress) + '</select>' +
            '</div>' +
            '<div class="fm-field">' +
              '<div class="fm-field-label">Table B — city column</div>' +
              '<select class="fm-select" id="fm-config-b-city">' + optList(bCols, state.config.cityColB) + '</select>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="fm-field" style="margin-top:8px;">' +
          '<div class="fm-field-label">Match threshold (Jaro-Winkler score)</div>' +
          '<div class="fm-slider-row">' +
            '<input type="range" class="fm-slider" id="fm-threshold" min="0.75" max="0.95" step="0.01" value="' + state.config.threshold.toFixed(2) + '" />' +
            '<div class="fm-slider-value" id="fm-threshold-val">' + state.config.threshold.toFixed(2) + '</div>' +
          '</div>' +
          '<div style="color:var(--text-soft);font-size:0.76rem;margin-top:6px;">≥ threshold = matched · 0.65–threshold = ambiguous (manual review) · &lt; 0.65 = unmatched.</div>' +
        '</div>' +
        err +
        '<div class="fm-btn-row">' +
          '<button class="btn btn-primary fm-btn-sm" id="fm-run-match" type="button"' + (state.matchLoading ? ' disabled' : '') + '>' +
            '<i class="fas fa-wand-magic-sparkles"></i><span class="btn-text">' + (state.matchLoading ? 'Matching…' : 'Run fuzzy match') + '</span>' +
          '</button>' +
          (state.matchLoading ? '<div class="fm-loading"><div class="fm-spinner"></div>Scoring ' + state.customers.length + ' customers against ' + state.serviceOrders.length + ' service orders…</div>' : '') +
        '</div>' +
      '</div>';
  }

  function renderMatchResultsCard() {
    var slot = $('fm-results-slot');
    if (!slot) return;
    if (!state.matches) { slot.innerHTML = ''; return; }
    var m = state.matches;
    var s = m.summary;
    var err = state.matchError
      ? '<div class="fm-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.matchError) + '</div>'
      : '';
    // Summary stat tiles.
    var statsHTML =
      '<div class="fm-stats">' +
        statTile(s.matchedCount, 'Matched', 'ok') +
        statTile(s.ambiguousCount, 'Ambiguous', 'warn') +
        statTile(s.unmatchedCount, 'Unmatched', 'bad') +
        statTile(s.totalMatchedOrders, 'Orders matched', '') +
      '</div>';
    // Match table — one row per customer.
    var matchRows = m.rows.map(function (r) {
      var pillCls = r.status === 'matched' ? 'matched' : (r.status === 'ambiguous' ? 'ambiguous' : 'unmatched');
      var pillText = r.status.charAt(0).toUpperCase() + r.status.slice(1);
      return '<tr>' +
        '<td>' + esc(r.customer_name || r.customer_id) + '</td>' +
        '<td class="col-address">' + esc(r.customer_address) + '</td>' +
        '<td class="col-city">' + esc(r.city) + '</td>' +
        '<td class="num">' + r.matched_count + '</td>' +
        '<td class="num">' + fmtScore(r.best_score) + '</td>' +
        '<td><span class="fm-status-pill ' + pillCls + '">' + pillText + '</span></td>' +
      '</tr>';
    }).join('');
    var matchTableHTML =
      '<div class="fm-table-wrap" style="max-height:400px;"><table class="fm-table"><thead><tr>' +
        '<th>Customer</th><th>Customer address</th><th>City</th>' +
        '<th class="num">Orders</th><th class="num">Best score</th><th>Status</th>' +
      '</tr></thead><tbody>' + matchRows + '</tbody></table></div>';
    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 3 — Match results</div>' +
        '<h3 class="fm-card-title">Fuzzy match results</h3>' +
        '<p class="fm-card-sub">' + s.matchedCount + ' of ' + s.totalCustomers + ' customers matched to ' +
          s.totalMatchedOrders + ' service orders (avg ' + s.avgOrdersPerMatched.toFixed(2) +
          ' per matched customer). Best-match score avg: ' + s.avgBestScore.toFixed(3) + '.</p>' +
        err +
        statsHTML +
        '<div class="fm-chart-card">' +
          '<p class="fm-chart-title"><i class="fas fa-th"></i> Match heatmap (top 20 customers × first 10 service orders)</p>' +
          '<div class="fm-chart-body"></div>' +
        '</div>' +
        matchTableHTML +
        '<div class="fm-btn-row">' +
          '<button class="btn btn-primary fm-btn-sm" id="fm-geocode" type="button">' +
            '<i class="fas fa-location-dot"></i><span class="btn-text">Geocode matches</span>' +
          '</button>' +
          '<div class="fm-spacer"></div>' +
          '<span style="color:var(--text-soft);font-size:0.78rem;">~' + Math.ceil(s.totalCustomers * 1.1) + 's via Nominatim (1.1s/address rate limit)</span>' +
        '</div>' +
      '</div>';
    // Render the heatmap into the chart body.
    renderHeatmap(slot);
  }
  function statTile(value, label, cls) {
    return '<div class="fm-stat">' +
      '<div class="fm-stat-value ' + cls + '">' + fmtNumber(value) + '</div>' +
      '<div class="fm-stat-label">' + esc(label) + '</div>' +
    '</div>';
  }

  function renderGeocodingCard() {
    var slot = $('fm-geocode-slot');
    if (!slot) return;
    if (!state.matches) { slot.innerHTML = ''; return; }
    var g = state.geocoding;
    var geoErr = g.error
      ? '<div class="fm-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(g.error) + '</div>'
      : '';
    var bodyHTML;
    if (g.active) {
      // Live progress bar while geocoding.
      var pct = g.total > 0 ? Math.round((g.current / g.total) * 100) : 0;
      bodyHTML =
        '<div class="fm-progress">' +
          '<div class="fm-progress-head">' +
            '<div class="fm-progress-title">Geocoding via Nominatim (OpenStreetMap)</div>' +
            '<div class="fm-progress-pct">' + pct + '%</div>' +
          '</div>' +
          '<div class="fm-progress-bar"><div class="fm-progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="fm-progress-sub">Address ' + g.current + ' of ' + g.total + ': ' + esc(g.address || '') + '</div>' +
        '</div>' +
        '<div class="fm-btn-row">' +
          '<button class="btn btn-ghost fm-btn-sm" id="fm-geocode-cancel" type="button">' +
            '<i class="fas fa-stop"></i><span class="btn-text">Cancel</span>' +
          '</button>' +
        '</div>';
    } else if (state.geocodes) {
      // Results table.
      var geoRows = state.geocodes.map(function (gc, idx) {
        var a = gc.address || {};
        var latlon = gc.ok ? esc(gc.lat) + ', ' + esc(gc.lon) : '—';
        var statusPill = gc.ok
          ? '<span class="fm-status-pill matched">OK</span>'
          : '<span class="fm-status-pill unmatched">Failed</span>';
        var mapIcon = gc.ok
          ? ' <button class="fm-map-btn" data-fm-map="' + idx + '" type="button" title="View on map" aria-label="View on map"><i class="fas fa-map-pin"></i></button>'
          : '';
        return '<tr>' +
          '<td style="max-width:200px;white-space:normal;">' + esc(gc.originalAddress) + '</td>' +
          '<td style="max-width:280px;white-space:normal;">' + (gc.ok ? esc(gc.matchedAddress) + mapIcon : '<span style="color:var(--text-soft);font-style:italic;">' + esc(gc.error || '') + '</span>') + '</td>' +
          '<td class="fm-coords">' + latlon + '</td>' +
          '<td class="num">' + (gc.ok ? fmtNumber(gc.importance) : '—') + '</td>' +
          '<td>' + statusPill + '</td>' +
        '</tr>';
      }).join('');
      bodyHTML =
        '<div class="fm-table-wrap" style="max-height:440px;"><table class="fm-table"><thead><tr>' +
          '<th>Original address</th><th>Matched address (Nominatim)</th><th>Lat / Lon</th><th class="num">Importance</th><th>Status</th>' +
        '</tr></thead><tbody>' + geoRows + '</tbody></table></div>';
      var geoOk = state.geocodes.filter(function (x) { return x.ok; }).length;
      var geoFail = state.geocodes.length - geoOk;
      var nextNote = '';
      if (!state.aiBrief && !state.aiBriefLoading) {
        nextNote = '<div style="color:var(--text-soft);font-size:0.82rem;margin-top:8px;">' +
          geoOk + ' of ' + state.geocodes.length + ' addresses geocoded successfully. ' +
          (geoFail ? geoFail + ' failed — likely data entry errors.' : 'All addresses validated.') +
          '</div>';
      }
      bodyHTML += nextNote +
        '<div class="fm-btn-row">' +
          '<button class="btn btn-primary fm-btn-sm" id="fm-generate-brief" type="button"' +
            (state.aiBriefLoading || !canCallGroq() ? ' disabled' : '') + '>' +
            '<i class="fas fa-wand-magic-sparkles"></i><span class="btn-text">' + (state.aiBriefLoading ? 'Briefing…' : 'Generate AI brief') + '</span>' +
          '</button>' +
          (state.aiBriefLoading ? '<div class="fm-loading"><div class="fm-spinner"></div>Asking Groq to narrate the results…</div>' : '') +
          '<div class="fm-spacer"></div>' +
          '<button class="btn btn-ghost fm-btn-sm" id="fm-re-geocode" type="button">' +
            '<i class="fas fa-rotate"></i><span class="btn-text">Re-run geocoding</span>' +
          '</button>' +
        '</div>';
    } else {
      // Idle — geocoding hasn't run yet. The user got here without clicking
      // "Geocode matches"; offer to start.
      bodyHTML = '<div class="fm-chart-empty">Click "Geocode matches" in Step 3 to validate the customer addresses via Nominatim.</div>';
    }
    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 4 — Validate via Geo API</div>' +
        '<h3 class="fm-card-title">Geocoding (Nominatim / OpenStreetMap)</h3>' +
        '<p class="fm-card-sub">Free, CORS-enabled, no API key. Rate-limited to 1.1s per request per Nominatim\u2019s Usage Policy. Results cached in memory so re-runs are instant.</p>' +
        geoErr +
        bodyHTML +
      '</div>';
  }

  function renderAIBriefCard() {
    var slot = $('fm-ai-slot');
    if (!slot) return;
    if (!state.aiBrief && !state.aiBriefLoading && !state.aiBriefError) { slot.innerHTML = ''; return; }
    var body;
    if (state.aiBriefLoading) {
      body = '<div class="fm-loading-block"><div class="fm-spinner"></div><div>Asking Groq to narrate the results…</div><div class="fm-loading-sub">Generating a 4-section executive brief (What happened / Why it matters / What to expect / What to do).</div></div>';
    } else if (state.aiBriefError) {
      body = '<div class="fm-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.aiBriefError) +
        ' <button class="fm-link" id="fm-retry-brief" type="button">Try again</button></div>';
    } else if (state.aiBrief) {
      var textHTML = esc(state.aiBrief).replace(/\r?\n/g, '<br>');
      body = '<div class="fm-ai-result-card"><div class="fm-ai-result-text">' + textHTML + '</div></div>';
    } else {
      body = '';
    }
    var remaining = remainingGroqCalls();
    var rateNote = '<div class="fm-rate-note">' + remaining + ' / ' + MAX_GROQ_CALLS + ' AI calls remaining this session</div>';
    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 5 — AI executive summary</div>' +
        '<h3 class="fm-card-title">AI executive brief</h3>' +
        '<p class="fm-card-sub">Generated by Groq via the Netlify proxy. The model sees the match summary stats + a sample of matched + ambiguous records + geocoding success rate.</p>' +
        body +
        rateNote +
      '</div>';
  }

  function renderExportCard() {
    var slot = $('fm-export-slot');
    if (!slot) return;
    if (!state.matches) { slot.innerHTML = ''; return; }
    slot.innerHTML =
      '<div class="fm-card">' +
        '<div class="fm-card-step">Step 6 — Export + share</div>' +
        '<h3 class="fm-card-title">Export the results</h3>' +
        '<p class="fm-card-sub">CSV / Excel contain one row per (customer × service order) pair plus the geocoding table. JSON is the full results object (matches + geocodes + AI brief).</p>' +
        '<div class="fm-download-row">' +
          '<button class="btn btn-ghost fm-btn-sm" data-fm-download="csv" type="button"><i class="fas fa-file-csv"></i> CSV</button>' +
          '<button class="btn btn-ghost fm-btn-sm" data-fm-download="excel" type="button"><i class="fas fa-file-excel"></i> Excel</button>' +
          '<button class="btn btn-ghost fm-btn-sm" data-fm-download="json" type="button"><i class="fas fa-file-code"></i> JSON</button>' +
          '<div class="fm-spacer"></div>' +
          '<button class="btn btn-primary fm-btn-sm" id="fm-email-results" type="button"><i class="fas fa-envelope"></i> Email results</button>' +
        '</div>' +
      '</div>';
  }

  // ─── Top-level render ──────────────────────────────────────────────────────
  // Rebuilds the mount's slot skeleton, then calls each sub-renderer. Slot IDs
  // are stable so event delegation (bound once on the mount) keeps working.
  function render() {
    var mount = $(MOUNT_ID);
    if (!mount) return;
    mount.innerHTML =
      '<div class="fm-app">' +
        '<div id="fm-upload-slot"></div>' +
        '<div id="fm-tables-slot"></div>' +
        '<div id="fm-config-slot"></div>' +
        '<div id="fm-results-slot"></div>' +
        '<div id="fm-geocode-slot"></div>' +
        '<div id="fm-ai-slot"></div>' +
        '<div id="fm-export-slot"></div>' +
      '</div>';
    renderUploadCard();
    renderTablesPreviewCard();
    renderMatchConfigCard();
    renderMatchResultsCard();
    renderGeocodingCard();
    renderAIBriefCard();
    renderExportCard();
  }
  // Partial re-render — only one slot. Avoids nuking the whole mount when only
  // one card changed (keeps chart instance stable, prevents scroll jumps).
  function renderSlot(name) {
    if (name === 'upload')   renderUploadCard();
    if (name === 'tables')   renderTablesPreviewCard();
    if (name === 'config')   renderMatchConfigCard();
    if (name === 'results')  renderMatchResultsCard();
    if (name === 'geocode')  renderGeocodingCard();
    if (name === 'ai')       renderAIBriefCard();
    if (name === 'export')   renderExportCard();
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  // Load one of the embedded sample datasets (synchronous ~5ms).
  function onSampleClick(kind) {
    var data = generateSampleData();
    var table, rows;
    if (kind === 'A') {
      rows = data.customers;
      table = makeTable({
        type: 'sample', name: 'customers (sample)',
        rows: rows, columns: ['customer_id','customer_name','address','city','region','customer_type']
      });
      state.tableALoading = true; state.tableAError = null;
      renderSlot('upload');
      // Defer the actual set so the spinner paints first.
      setTimeout(function () {
        state.tableA = table;
        state.customers = rows;
        state.tableALoading = false;
        // Auto-detect columns.
        state.config.aAddress = detectAddressColumn(table) || 'address';
        state.config.cityColA = detectCityColumn(table) || 'city';
        // Reset downstream state when Table A changes.
        resetDownstream('A');
        render();
      }, 50);
    } else {
      rows = data.serviceOrders;
      table = makeTable({
        type: 'sample', name: 'service_orders (sample)',
        rows: rows, columns: ['service_order_id','service_type','address','city','scheduled_date','status']
      });
      state.tableBLoading = true; state.tableBError = null;
      renderSlot('upload');
      setTimeout(function () {
        state.tableB = table;
        state.serviceOrders = rows;
        state.tableBLoading = false;
        state.config.bAddress = detectAddressColumn(table) || 'address';
        state.config.cityColB = detectCityColumn(table) || 'city';
        resetDownstream('B');
        render();
      }, 50);
    }
  }

  // File chosen for upload (Table A or B). 5MB cap; resets downstream state.
  function onFileChosen(file, kind) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      if (kind === 'A') state.tableAError = 'For demo performance, please use files under 5 MB.';
      else              state.tableBError = 'For demo performance, please use files under 5 MB.';
      renderSlot('upload');
      return;
    }
    if (kind === 'A') {
      state.tableALoading = true; state.tableAError = null;
    } else {
      state.tableBLoading = true; state.tableBError = null;
    }
    renderSlot('upload');
    parseFile(file).then(function (table) {
      if (kind === 'A') {
        state.tableA = table;
        state.customers = table.rows;
        state.tableALoading = false;
        state.config.aAddress = detectAddressColumn(table) || (table.columns[0] || 'address');
        state.config.cityColA = detectCityColumn(table) || (table.columns[1] || 'city');
      } else {
        state.tableB = table;
        state.serviceOrders = table.rows;
        state.tableBLoading = false;
        state.config.bAddress = detectAddressColumn(table) || (table.columns[0] || 'address');
        state.config.cityColB = detectCityColumn(table) || (table.columns[1] || 'city');
      }
      resetDownstream(kind);
      render();
    }).catch(function (e) {
      if (kind === 'A') {
        state.tableALoading = false;
        state.tableAError = e.message || 'Couldn\u2019t parse this file.';
      } else {
        state.tableBLoading = false;
        state.tableBError = e.message || 'Couldn\u2019t parse this file.';
      }
      renderSlot('upload');
    });
  }

  // Reset everything downstream of the table that changed (or both, since
  // matches depend on both tables). Safe to call with kind='A' or 'B'.
  function resetDownstream(kind) {
    state.matches = null;
    state.matchError = null;
    state.matchLoading = false;
    state.geocodes = null;
    state.geocoding = { active: false, current: 0, total: 0, address: '', error: null, aborted: false };
    state.aiBrief = null;
    state.aiBriefLoading = false;
    state.aiBriefError = null;
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
  }

  // Run the fuzzy match with the current config.
  function onRunMatchClick() {
    if (!state.tableA || !state.tableB) return;
    // Read the dropdowns into state.config before running.
    var aAddr = $('fm-config-a-addr');
    var bAddr = $('fm-config-b-addr');
    var aCity = $('fm-config-a-city');
    var bCity = $('fm-config-b-city');
    if (aAddr) state.config.aAddress = aAddr.value;
    if (bAddr) state.config.bAddress = bAddr.value;
    if (aCity) state.config.cityColA = aCity.value;
    if (bCity) state.config.cityColB = bCity.value;
    // Validate.
    if (!state.config.aAddress || !state.config.bAddress) {
      state.matchError = 'Please pick an address column for both tables.';
      renderSlot('config');
      return;
    }
    state.matchLoading = true;
    state.matchError = null;
    state.matches = null;
    state.geocodes = null;
    state.aiBrief = null;
    state.aiBriefLoading = false;
    state.aiBriefError = null;
    state.geocoding = { active: false, current: 0, total: 0, address: '', error: null, aborted: false };
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
    renderSlot('config');
    renderSlot('results');
    renderSlot('geocode');
    renderSlot('ai');
    renderSlot('export');
    // Defer the actual computation so the loading state paints.
    setTimeout(function () {
      try {
        var matches = runFuzzyMatch(state.customers, state.serviceOrders, state.config);
        state.matches = matches;
        state.matchLoading = false;
      } catch (e) {
        state.matchLoading = false;
        state.matchError = e.message || 'Fuzzy match failed.';
      }
      renderSlot('config');
      renderSlot('results');
      renderSlot('export');
    }, 50);
  }

  // Run Nominatim geocoding on each unique customer address.
  function onGeocodeClick() {
    if (!state.matches) return;
    // Build the list of addresses to geocode — one per customer (use the
    // original fuzzy address from Table A).
    var addresses = state.matches.rows.map(function (r) { return r.customer_address; });
    state.geocoding = {
      active: true, current: 0, total: addresses.length,
      address: addresses[0] || '', error: null, aborted: false
    };
    state.geocodes = null;
    renderSlot('geocode');
    var isAborted = function () { return state.geocoding.aborted; };
    geocodeAddresses(addresses, function (cur, total, addr) {
      state.geocoding.current = cur;
      state.geocoding.total = total;
      state.geocoding.address = addr;
      renderSlot('geocode');
    }, isAborted).then(function (results) {
      state.geocoding.active = false;
      state.geocoding.current = state.geocoding.total;
      state.geocoding.address = '';
      state.geocodes = results;
      renderSlot('geocode');
    }).catch(function (e) {
      state.geocoding.active = false;
      state.geocoding.error = e.message || 'Geocoding failed.';
      renderSlot('geocode');
    });
  }
  function onGeocodeCancel() {
    state.geocoding.aborted = true;
    state.geocoding.active = false;
    renderSlot('geocode');
  }

  // Re-run geocoding — usually instant because results are cached.
  function onReGeocodeClick() {
    state.geocodes = null;
    state.geocoding = { active: false, current: 0, total: 0, address: '', error: null, aborted: false };
    renderSlot('geocode');
    onGeocodeClick();
  }

  // Generate the AI executive brief via Groq.
  function onGenerateBriefClick() {
    if (!state.matches) return;
    if (!canCallGroq()) {
      state.aiBriefError = 'Demo rate limit reached — ' + MAX_GROQ_CALLS + ' AI calls this session. Refresh the page to try again.';
      renderSlot('ai');
      return;
    }
    state.aiBriefLoading = true;
    state.aiBriefError = null;
    state.aiBrief = null;
    renderSlot('ai');
    generateAIBrief(state.matches, state.geocodes).then(function (text) {
      state.aiBrief = text;
      state.aiBriefLoading = false;
      renderSlot('ai');
      renderSlot('export');
    }).catch(function (e) {
      state.aiBriefLoading = false;
      state.aiBriefError = e.message || 'AI brief failed.';
      renderSlot('ai');
    });
  }

  function onRetryBrief() {
    state.aiBriefError = null;
    renderSlot('ai');
    onGenerateBriefClick();
  }

  // Download buttons.
  function onDownloadClick(kind) {
    if (!state.matches) return;
    if (kind === 'json') {
      var obj = {
        generatedAt: new Date().toISOString(),
        config: state.config,
        matches: state.matches,
        geocodes: state.geocodes,
        aiBrief: state.aiBrief
      };
      downloadJSON(obj, 'fuzzy-match-results.json');
      return;
    }
    if (kind === 'csv') {
      // Combine matches + geocodes into one CSV (two sections).
      var matchRows = matchesToExportRows(state.matches);
      var matchCols = ['customer_id','customer_name','customer_address','city','service_order_id','service_type','service_address','scheduled_date','service_status','jaro_winkler','match_status'];
      var geoRows = geocodesToExportRows(state.geocodes);
      var geoCols = ['original_address','matched_address','house_number','road','city','state','postcode','country','lat','lon','place_id','importance','geocode_status'];
      // Build a single CSV with two header+section blocks separated by a blank line.
      var escCsv = function (v) {
        var s = v == null ? '' : String(v);
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      var lines = [matchCols.map(escCsv).join(',')];
      matchRows.forEach(function (r) { lines.push(matchCols.map(function (c) { return escCsv(r[c]); }).join(',')); });
      lines.push('');
      lines.push(geoCols.map(escCsv).join(','));
      geoRows.forEach(function (r) { lines.push(geoCols.map(function (c) { return escCsv(r[c]); }).join(',')); });
      downloadBlob('fuzzy-match.csv', new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      return;
    }
    if (kind === 'excel') {
      // Two sheets: Matches + Geocoding.
      var mRows = matchesToExportRows(state.matches);
      var mCols = ['customer_id','customer_name','customer_address','city','service_order_id','service_type','service_address','scheduled_date','service_status','jaro_winkler','match_status'];
      var gRows = geocodesToExportRows(state.geocodes);
      var gCols = ['original_address','matched_address','house_number','road','city','state','postcode','country','lat','lon','place_id','importance','geocode_status'];
      loadScript('xlsx').then(function () {
        var wb = XLSX.utils.book_new();
        var mData = [mCols].concat(mRows.map(function (r) { return mCols.map(function (c) { return r[c]; }); }));
        var mWs = XLSX.utils.aoa_to_sheet(mData);
        mWs['!cols'] = mCols.map(function (c) {
          var maxLen = String(c).length;
          for (var j = 0; j < Math.min(mRows.length, 200); j++) {
            var v = mRows[j][c]; var l = (v == null ? '' : String(v)).length;
            if (l > maxLen) maxLen = l;
          }
          return { wch: Math.min(40, Math.max(10, maxLen + 2)) };
        });
        XLSX.utils.book_append_sheet(wb, mWs, 'Matches');
        if (gRows.length) {
          var gData = [gCols].concat(gRows.map(function (r) { return gCols.map(function (c) { return r[c]; }); }));
          var gWs = XLSX.utils.aoa_to_sheet(gData);
          gWs['!cols'] = gCols.map(function (c) {
            var maxLen = String(c).length;
            for (var k = 0; k < Math.min(gRows.length, 200); k++) {
              var v = gRows[k][c]; var l = (v == null ? '' : String(v)).length;
              if (l > maxLen) maxLen = l;
            }
            return { wch: Math.min(40, Math.max(10, maxLen + 2)) };
          });
          XLSX.utils.book_append_sheet(wb, gWs, 'Geocoding');
        }
        var arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        downloadBlob('fuzzy-match.xlsx',
          new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      });
      return;
    }
  }

  // Email — open a preview modal with HTML + plain-text versions, then mailto:.
  function onEmailClick() {
    var subject = 'Fuzzy address matcher + geocoder — results';
    var bodyPlain = buildEmailBodyPlain();
    var bodyHTML = buildEmailBodyHTML();
    openModal('Email preview',
      '<div class="fm-analysis-section">' +
        '<p class="fm-analysis-label">Subject</p>' +
        '<div class="fm-modal-pre">' + esc(subject) + '</div>' +
      '</div>' +
      '<div class="fm-analysis-section" style="margin-top:14px;">' +
        '<p class="fm-analysis-label">Preview (rendered HTML)</p>' +
        '<div class="fm-email-html-preview">' + bodyHTML + '</div>' +
      '</div>' +
      '<div class="fm-analysis-section" style="margin-top:14px;">' +
        '<p class="fm-analysis-label" style="cursor:pointer;text-decoration:underline;" id="fm-toggle-plain">Show plain-text body (what gets sent via mailto:)</p>' +
        '<div class="fm-modal-pre" id="fm-plain-body" style="display:none;">' + esc(bodyPlain) + '</div>' +
      '</div>' +
      '<div class="fm-analysis-section" style="margin-top:14px;">' +
        '<p class="fm-analysis-label">Recipient</p>' +
        '<input class="fm-input" id="fm-email-recipient" type="email" placeholder="recipient@example.com" />' +
      '</div>',
      [
        { label: 'Download as HTML email', primary: false, action: function () {
          var fullHTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(subject) + '</title></head><body>' + bodyHTML + '</body></html>';
          var blob = new Blob([fullHTML], { type: 'text/html;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'fuzzy-match-results.html';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } },
        { label: 'Open in email client', primary: true, action: function () {
          var to = ($('fm-email-recipient') || {}).value || '';
          var url = 'mailto:' + encodeURIComponent(to).replace(/%40/, '@') +
            '?subject=' + encodeURIComponent(subject) +
            '&body=' + encodeURIComponent(bodyPlain);
          window.location.href = url;
        } }
      ]);
    // Wire the plain-text toggle.
    setTimeout(function () {
      var toggle = $('fm-toggle-plain');
      var plain = $('fm-plain-body');
      if (toggle && plain) {
        toggle.addEventListener('click', function () {
          plain.style.display = plain.style.display === 'none' ? 'block' : 'none';
        });
      }
    }, 50);
  }

  // Reset one table (replace). Keeps the other table.
  function onReplaceClick(kind) {
    if (kind === 'A') {
      state.tableA = null;
      state.customers = null;
      state.tableAError = null;
      state.config.aAddress = null;
      state.config.cityColA = null;
    } else {
      state.tableB = null;
      state.serviceOrders = null;
      state.tableBError = null;
      state.config.bAddress = null;
      state.config.cityColB = null;
    }
    resetDownstream(kind);
    render();
  }

  // ─── Event delegation (bound once on the mount) ──────────────────────────────
  function wireEvents() {
    var mount = $(MOUNT_ID);
    if (!mount) return;
    if (mount._fmWired) return;
    mount._fmWired = true;

    // Click delegation.
    mount.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      // Drop zone clicks → open file pickers.
      if (t.closest('#fm-drop-a')) { var fi = $('fm-file-a'); if (fi) fi.click(); return; }
      if (t.closest('#fm-drop-b')) { var fj = $('fm-file-b'); if (fj) fj.click(); return; }
      // Sample buttons.
      if (t.closest('#fm-sample-a')) { onSampleClick('A'); return; }
      if (t.closest('#fm-sample-b')) { onSampleClick('B'); return; }
      // Replace buttons.
      if (t.closest('#fm-replace-a')) { onReplaceClick('A'); return; }
      if (t.closest('#fm-replace-b')) { onReplaceClick('B'); return; }
      // Run / geocode / generate brief / cancel / retry / re-geocode.
      if (t.closest('#fm-run-match'))      { onRunMatchClick(); return; }
      if (t.closest('#fm-geocode'))        { onGeocodeClick(); return; }
      if (t.closest('#fm-geocode-cancel')) { onGeocodeCancel(); return; }
      if (t.closest('#fm-re-geocode'))     { onReGeocodeClick(); return; }
      if (t.closest('#fm-generate-brief')) { onGenerateBriefClick(); return; }
      // Map pin button — opens an OpenStreetMap embed in a modal
      var mapBtn = t.closest('[data-fm-map]');
      if (mapBtn) {
        var geoIdx = parseInt(mapBtn.getAttribute('data-fm-map'), 10);
        var gc = state.geocodes[geoIdx];
        if (gc && gc.ok && gc.lat && gc.lon) {
          var lat = gc.lat, lon = gc.lon;
          var delta = 0.005;
          var bbox = (parseFloat(lon) - delta) + ',' + (parseFloat(lat) - delta) + ',' + (parseFloat(lon) + delta) + ',' + (parseFloat(lat) + delta);
          var mapSrc = 'https://www.openstreetmap.org/export/embed.html?bbox=' + bbox + '&layer=mapnik&marker=' + lat + ',' + lon;
          openModal('Location: ' + (gc.matchedAddress || '').slice(0, 60) + (gc.matchedAddress.length > 60 ? '…' : ''),
            '<div style="margin-bottom:10px;color:var(--text-muted);font-size:0.88rem;line-height:1.6;">' +
              '<strong style="color:var(--text);">Real address:</strong> ' + esc(gc.matchedAddress) + '<br>' +
              '<strong style="color:var(--text);">Original:</strong> ' + esc(gc.originalAddress) + '<br>' +
              '<strong style="color:var(--text);">Coordinates:</strong> ' + esc(lat) + ', ' + esc(lon) + ' · <strong style="color:var(--text);">Importance:</strong> ' + fmtNumber(gc.importance) +
            '</div>' +
            '<iframe src="' + mapSrc + '" style="width:100%;height:400px;border:0;border-radius:10px;" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>',
            [{ label: 'Close', primary: true, action: function () { closeModal(); } }]);
        }
        return;
      }
      if (t.closest('#fm-retry-brief'))    { onRetryBrief(); return; }
      if (t.closest('#fm-email-results'))  { onEmailClick(); return; }
      // Downloads.
      var dl = t.closest('[data-fm-download]');
      if (dl) { onDownloadClick(dl.getAttribute('data-fm-download')); return; }
    });

    // File input change.
    mount.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'fm-file-a' && e.target.files && e.target.files[0]) {
        onFileChosen(e.target.files[0], 'A');
        e.target.value = '';
        return;
      }
      if (e.target && e.target.id === 'fm-file-b' && e.target.files && e.target.files[0]) {
        onFileChosen(e.target.files[0], 'B');
        e.target.value = '';
        return;
      }
      // Threshold slider change — live update of the displayed value (no
      // re-render of the whole slot, just the value label).
      if (e.target && e.target.id === 'fm-threshold') {
        state.config.threshold = parseFloat(e.target.value);
        var lab = $('fm-threshold-val');
        if (lab) lab.textContent = state.config.threshold.toFixed(2);
        return;
      }
      // Config dropdowns — read into state but don't re-render (the dropdown
      // keeps focus; state changes apply on the next "Run fuzzy match" click).
      if (e.target && e.target.id === 'fm-config-a-addr') { state.config.aAddress = e.target.value; return; }
      if (e.target && e.target.id === 'fm-config-b-addr') { state.config.bAddress = e.target.value; return; }
      if (e.target && e.target.id === 'fm-config-a-city') { state.config.cityColA = e.target.value; return; }
      if (e.target && e.target.id === 'fm-config-b-city') { state.config.cityColB = e.target.value; return; }
    });

    // Drag-and-drop on the drop zones.
    mount.addEventListener('dragover', function (e) {
      var drop = $('fm-drop-a') || $('fm-drop-b');
      if (!drop) return;
      e.preventDefault();
      var active = e.target.closest && e.target.closest('#fm-drop-a, #fm-drop-b');
      if (active) active.classList.add('fm-dragover');
    });
    mount.addEventListener('dragleave', function (e) {
      var drop = $('fm-drop-a') || $('fm-drop-b');
      if (!drop) return;
      if (e.target.classList) e.target.classList.remove('fm-dragover');
    });
    mount.addEventListener('drop', function (e) {
      e.preventDefault();
      var dropA = $('fm-drop-a'); var dropB = $('fm-drop-b');
      if (dropA) dropA.classList.remove('fm-dragover');
      if (dropB) dropB.classList.remove('fm-dragover');
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files[0]) return;
      // Figure out which side got the drop — by the drop target.
      var tgt = e.target.closest ? e.target.closest('#fm-drop-a, #fm-drop-b') : null;
      var kind = tgt && tgt.id === 'fm-drop-b' ? 'B' : 'A';
      onFileChosen(e.dataTransfer.files[0], kind);
    });

    // Keyboard accessibility on the drop zones.
    mount.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target &&
          (e.target.id === 'fm-drop-a' || e.target.id === 'fm-drop-b')) {
        e.preventDefault();
        var fi = e.target.id === 'fm-drop-a' ? $('fm-file-a') : $('fm-file-b');
        if (fi) fi.click();
      }
    });
  }

  // ─── Theme change watcher ────────────────────────────────────────────────────
  // Re-render the heatmap (only) when the site theme toggles. We don't
  // re-render the whole mount — that would lose scroll position unnecessarily.
  function watchThemeChanges() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-theme') {
          if (state.chart && state.matches) {
            var slot = $('fm-results-slot');
            if (slot) renderHeatmap(slot);
          }
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    var mount = $(MOUNT_ID);
    if (mount) {
      var obs2 = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          if (m.attributeName === 'data-fm-theme' && state.chart && state.matches) {
            var slot = $('fm-results-slot');
            if (slot) renderHeatmap(slot);
          }
        });
      });
      obs2.observe(mount, { attributes: true, attributeFilter: ['data-fm-theme'] });
    }
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────────────
  // Auto-bootstrap on DOMContentLoaded. Retries every 100ms for up to 40 tries
  // if the mount isn't in the DOM yet (covers async-rendered blog post HTML).
  function boot() {
    var mount = $(MOUNT_ID);
    if (!mount) {
      if (boot._retries < 40) { boot._retries++; setTimeout(boot, 100); }
      return;
    }
    boot._retries = 0;
    injectCSS();
    render();
    wireEvents();
    watchThemeChanges();
  }
  boot._retries = 0;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
