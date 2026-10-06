/* ════════════════════════════════════════════════════════════════════════════
   blog-pipeline-builder.js — AI-assisted pipeline constructor (marketing demo)

   Mounts INTO <div id="pipeline-builder-mount"></div> when the DOM is ready.
   Pure vanilla JS, no framework. Everything wrapped in an IIFE — no globals
   leaked to window.

   Flow
   ----
     1. User uploads .xlsx / .xls / .docx / .pdf / .csv — OR picks one of 3
        embedded sample templates (no upload required).
     2. The document is parsed client-side into a unified doc object
        { type, rows, columns, rawText, ... }.
     3. A sample is sent to Groq (via the Netlify proxy — never direct) for
        auto-analysis: document type, summary, key columns, suggested NL
        actions, data-quality notes. Suggested actions render as clickable
        chips that prefill the instruction textarea.
     4. User types a natural-language instruction (or clicks a chip) and hits
        "Generate pipeline". Groq returns a JSON pipeline spec.
     5. The spec renders as a human-readable card (ordered steps, output
        format) with a collapsible raw-JSON view.
     6. User clicks "Run pipeline". The spec executes client-side — filter,
        summarize, sort, limit, select, transform steps. No server round-trip.
     7. Results render as a paginated HTML table + an auto-picked ECharts
        chart (bar / line / grouped bar). Download buttons (CSV / Excel / PDF /
        JSON). Email composer opens a mailto: link (direct-send is a disabled
        "coming soon" toggle).
     8. Pipelines persist in localStorage — save / load / delete / import /
        export-as-JSON.

   Anti-footguns
   -------------
     • Files > 5 MB rejected with a friendly message.
     • Groq calls rate-limited client-side to MAX_GROQ_CALLS (10) per browser
       session (session-tracked via sessionStorage so it resets on tab close).
     • The "transform" step's expression evaluator is a hand-written
       recursive-descent parser — NEVER eval() or Function().
     • No alert/confirm/prompt — modals / inline inputs only.
     • All user-provided + AI-provided text is HTML-escaped before insertion.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  var MOUNT_ID         = 'pipeline-builder-mount';
  var GROQ_PROXY       = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
  var GROQ_MODEL       = 'qwen/qwen3.8-27b';
  var STORAGE_KEY      = 'pipelineBuilder.saved';
  var RATE_KEY         = 'pipelineBuilder.rate';
  var SESSION_KEY      = 'pipelineBuilder.sessionId';
  var MAX_GROQ_CALLS   = 10;
  var MAX_FILE_SIZE    = 5 * 1024 * 1024;   // 5 MB demo cap
  var GROQ_TIMEOUT_MS  = 25000;             // Groq can be slow on cold starts

  // CDN libraries — loaded lazily and cached in libCache so each loads at most
  // once per page lifetime. Loading is triggered only when the user actually
  // needs them (first file upload / first download).
  var LIB_URLS = {
    xlsx:        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    mammoth:     'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    pdfjs:       'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfjsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    echarts:     'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
    jspdf:       'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'
  };

  // Promise cache for each library. Once a lib loads, subsequent loadScript
  // calls for the same lib return the cached promise (no second <script> tag).
  var libCache = {};

  // ─── Module-scope state ────────────────────────────────────────────────────
  // Single source of truth. render() re-paints the whole mount from this; each
  // sub-renderer no-ops when its slice of state is absent.
  var state = {
    document:         null,   // unified doc object after parse
    analysis:         null,   // Groq auto-analysis result
    analysisLoading:  false,
    analysisError:    null,
    instruction:      '',     // textarea value (kept out of re-render flow so typing doesn't lose focus)
    pipeline:         null,   // generated spec
    pipelineLoading: false,
    pipelineError:    null,
    showSpecJson:     false,  // collapsible raw-JSON view toggle
    result:           null,   // { rows, columns } after execution
    resultError:      null,
    savedPipelines:   [],     // array of { id, name, spec, docSummary, savedAt }
    chart:            null,   // ECharts instance
    visibleRows:      25      // pagination cursor in the results table
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
    // Right-aligned table cells. Integers get thousands separators; floats
    // get 2 decimals + thousands separators. Non-numbers pass through.
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

  // ─── Lazy CDN script loader ────────────────────────────────────────────────
  // Injects a <script src> tag and resolves when it loads. Caches by lib key
  // so a second request returns the same promise (no duplicate tags). Errors
  // reject so callers can show a friendly "library failed to load" message.
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
      // pdf.js worker is configured separately after the lib loads (see parsePDF).
      document.head.appendChild(s);
    });
    libCache[libKey] = p;
    return p;
  }

  // Convenience: load multiple libs in parallel.
  function loadScripts(libKeys) {
    return Promise.all(libKeys.map(function (k) { return loadScript(k); }));
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
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      max_tokens: opts.max_tokens != null ? opts.max_tokens : 800,
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
          throw new Error('AI returned an unexpected response. Try rephrasing your instruction.');
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
        // Network / DNS / CORS error. Browsers report CORS failures as
        // generic TypeError("Failed to fetch") — the only signal we get.
        // Surface a hint that's actionable: this is most likely a stale
        // deployed Netlify edge function whose CORS list doesn't include
        // the current origin, not a network outage or a rate limit.
        if (e.name === 'TypeError' || (e.message && e.message.indexOf('Failed to fetch') >= 0)) {
          throw new Error('Couldn\u2019t reach the AI service (CORS or network error). ' +
            'The Groq proxy may be cold-starting — please try again in a few seconds. ' +
            'If the problem persists, please let us know via the Contact form.');
        }
        // Other unexpected errors
        throw new Error('Couldn\u2019t reach the AI service. Please try again — if the problem persists, the demo may be rate-limited.');
      });
  }

  // ─── JSON extraction from Groq output ──────────────────────────────────────
  // Groq often wraps JSON in ```json ... ``` fences despite the prompt asking
  // for raw JSON. Strip fences + any leading/trailing prose, then JSON.parse.
  function extractJson(content) {
    if (!content) throw new Error('AI returned an empty response. Try rephrasing your instruction.');
    var s = String(content).trim();
    // Strip markdown code fences if present.
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    // If there's still prose before/after the JSON object, try to isolate the
    // first { ... } block.
    if (s.charAt(0) !== '{' && s.charAt(0) !== '[') {
      var start = s.indexOf('{');
      if (start < 0) start = s.indexOf('[');
      if (start >= 0) s = s.slice(start);
    }
    var endBrace = s.lastIndexOf('}');
    var endBracket = s.lastIndexOf(']');
    var end = Math.max(endBrace, endBracket);
    if (end > 0 && end < s.length - 1) s = s.slice(0, end + 1);
    try {
      return JSON.parse(s);
    } catch (e) {
      throw new Error('The AI returned an unexpected response. Try rephrasing your instruction.');
    }
  }

  // ─── Sample template generators ────────────────────────────────────────────
  // Three embedded sample datasets — generated at runtime so we don't hand-write
  // 50-60 rows of fixture data. Each returns an array of plain row objects.

  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  var FIRST_NAMES = ['Aisha','Marcus','Priya','Ethan','Sofia','Liam','Mei','Noah','Zara','Owen',
    'Fatima','Caleb','Ingrid','Yusuf','Hana','Diego','Anya','Tomas','Lena','Ravi',
    'Greta','Sami','Nia','Bjorn','Vera','Arjun','Lucia','Khalid','Mira','Jonas'];
  var LAST_NAMES  = ['Patel','Chen','Williams','Müller','Okafor','Garcia','Singh','Nguyen','Schmidt','Rossi',
    'Kim','Andersen','Khan','Dubois','Silva','Hassan','Novak','Costa','Reyes','Ito',
    'Larsen','Mehta','Sato','Petrov','Mansour','Olsen','Ferreira','Tan','Yamamoto','Bauer'];
  function synthName() { return pick(FIRST_NAMES) + ' ' + pick(LAST_NAMES); }
  function synthCompany() {
    var p1 = ['Blue','Summit','Apex','Vertex','North','Pioneer','Cobalt','Meridian','Quill','Iron','Stellar','Granite'];
    var p2 = ['Logistics','Systems','Capital','Materials','Dynamics','Foods','Health','Energy','Robotics','Media','Furniture','Chemicals'];
    return pick(p1) + ' ' + pick(p2) + ' ' + pick(['Inc.','Ltd.','Co.','LLC','Corp.']);
  }

  // Template 1 — Regional Sales Q3 2026 (50 rows).
  // Realistic-ish: Ontario & Quebec overperform; Widget D & E spike in late summer.
  function genRegionalSales() {
    var rows = [];
    var regions = ['Ontario','Quebec','BC','Alberta','Nova Scotia'];
    var products = [
      { name: 'Widget A', price: 25 },
      { name: 'Widget B', price: 45 },
      { name: 'Widget C', price: 12 },
      { name: 'Widget D', price: 85 },
      { name: 'Widget E', price: 120 }
    ];
    var channels = ['Online','Retail','Partner'];
    for (var i = 0; i < 50; i++) {
      var dt = new Date(2026, 6 + randInt(0, 2), randInt(1, 28));   // Jul-Sep 2026
      var region = pick(regions);
      var prod = pick(products);
      // Ontario & Quebec skew higher qty; Widget D & E spike in Aug/Sep.
      var qty = randInt(10, 200);
      if (region === 'Ontario' || region === 'Quebec') qty = Math.round(qty * 1.35);
      if ((prod.name === 'Widget D' || prod.name === 'Widget E') && (dt.getMonth() >= 7)) {
        qty = Math.round(qty * 1.4);
      }
      rows.push({
        date: dt.toISOString().slice(0, 10),
        region: region,
        product: prod.name,
        qty: qty,
        revenue: qty * prod.price,
        channel: pick(channels)
      });
    }
    return rows;
  }

  // Template 2 — HR Headcount Snapshot (30 rows). 80% Active.
  function genHRHeadcount() {
    var rows = [];
    var depts = ['Engineering','Sales','Operations','Finance','HR'];
    var rolesByDept = {
      Engineering: ['Software Engineer','DevOps Engineer','QA Engineer','Engineering Manager'],
      Sales:        ['Account Executive','SDR','Sales Manager','Customer Success'],
      Operations:   ['Operations Analyst','Logistics Coordinator','Ops Manager'],
      Finance:      ['Financial Analyst','Accountant','Controller'],
      HR:           ['HR Generalist','Recruiter','HR Manager']
    };
    for (var i = 0; i < 30; i++) {
      var dept = pick(depts);
      var level = pick(['Junior','Mid','Senior']);
      var role = pick(rolesByDept[dept]);
      // Salary weighted by level.
      var base = level === 'Junior' ? randInt(55000, 72000)
               : level === 'Mid'    ? randInt(75000, 98000)
               :                      randInt(105000, 145000);
      var hireYear = randInt(2018, 2026);
      var hireDate = new Date(hireYear, randInt(0, 11), randInt(1, 28));
      var r = Math.random();
      var status = r < 0.8 ? 'Active' : (r < 0.92 ? 'On-Leave' : 'Terminated');
      rows.push({
        employee_id: 'EMP-' + String(i + 1).padStart(3, '0'),
        name: synthName(),
        department: dept,
        title: level + ' ' + role,
        hire_date: hireDate.toISOString().slice(0, 10),
        salary: base,
        status: status
      });
    }
    return rows;
  }

  // Template 3 — Invoice Aging (40 rows). days_outstanding computed from today.
  function genInvoiceAging() {
    var rows = [];
    var today = new Date();
    for (var i = 0; i < 40; i++) {
      // Issue date within the last 120 days.
      var issue = new Date(today.getTime() - randInt(1, 120) * 86400000);
      var due = new Date(issue.getTime() + 30 * 86400000);
      var days = Math.floor((today.getTime() - issue.getTime()) / 86400000);
      var bucket;
      if (days < 30) bucket = 'Current';
      else if (days < 60) bucket = '30-60';
      else if (days < 90) bucket = '60-90';
      else bucket = '90+';
      rows.push({
        invoice_id: 'INV-' + (1001 + i),
        customer: synthCompany(),
        issue_date: issue.toISOString().slice(0, 10),
        due_date: due.toISOString().slice(0, 10),
        amount: randInt(1000, 25000),
        days_outstanding: days,
        status: bucket
      });
    }
    return rows;
  }

  // Sample-button registry — name, icon, row count, generator (or async loader
  // for PDF samples that need fetch + pdf.js parse), columns.
  var SAMPLE_TEMPLATES = [
    {
      key: 'sales', name: 'Regional Sales Q3', icon: 'fa-chart-line',
      rowCount: 50, columns: ['date','region','product','qty','revenue','channel'],
      generate: genRegionalSales
    },
    {
      key: 'hr', name: 'HR Headcount Snapshot', icon: 'fa-users',
      rowCount: 30, columns: ['employee_id','name','department','title','hire_date','salary','status'],
      generate: genHRHeadcount
    },
    {
      key: 'invoices', name: 'Invoice Aging', icon: 'fa-file-invoice-dollar',
      rowCount: 40, columns: ['invoice_id','customer','issue_date','due_date','amount','days_outstanding','status'],
      generate: genInvoiceAging
    },
    {
      // PDF sample — fetched + parsed by pdf.js at click time (no inline data).
      // The PDF lives at /data/sample-sales-report.pdf (committed to the repo)
      // and contains a 30-row Q3 2026 regional sales report laid out as a real
      // table widget so pdf.js's text extraction + the demo's detectPDFTable()
      // heuristic produce clean rows. Lets users try the full NL → pipeline →
      // execute → email flow on a PDF (not just Excel).
      key: 'pdf', name: 'Sales Report (PDF)', icon: 'fa-file-pdf',
      rowCount: 30, columns: ['Date','Region','Product','Qty','Revenue','Channel'],
      isPDF: true,
      url: '/data/sample-sales-report.pdf'
    }
  ];

  // ─── Unified document object factory ────────────────────────────────────────
  function makeDoc(opts) {
    var columns = opts.columns || (opts.rows && opts.rows.length ? Object.keys(opts.rows[0]) : []);
    return {
      type:       opts.type,
      name:       opts.name || 'untitled',
      fileSize:   opts.fileSize || 0,
      rows:       opts.rows || [],
      columns:    columns,
      rawText:    opts.rawText || '',
      rowCount:   (opts.rows || []).length,
      columnCount: columns.length,
      warnings:   opts.warnings || []
    };
  }

  // ─── File parsers ───────────────────────────────────────────────────────────
  // Each returns a unified doc object. All async, all try/catch — failures throw
  // a friendly error that the caller surfaces as an inline error card.

  // CSV — native parse, no library. Handles quoted fields with embedded commas,
  // newlines, and doubled-quote escapes (RFC 4180).
  function parseCSV(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Couldn\u2019t read this file.')); };
      reader.onload = function () {
        try {
          var text = reader.result;
          var rows = csvToRows(text);
          if (!rows.length) {
            reject(new Error('Couldn\u2019t parse this CSV — the file appears to be empty.'));
            return;
          }
          resolve(makeDoc({
            type: 'csv', name: file.name, fileSize: file.size,
            rows: rows.rows, columns: rows.columns, rawText: ''
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
    var headers = records[0].map(function (h, idx) { return h || ('col_' + (idx + 1)); });
    var objRows = records.slice(1).filter(function (r) {
      return r.some(function (v) { return v !== '' && v != null; });
    }).map(function (r) {
      var o = {};
      headers.forEach(function (h, idx) {
        var v = r[idx];
        // Auto-coerce numeric strings — keeps summarize/sort working.
        if (v != null && v !== '' && !isNaN(v) && /^-?\d+(\.\d+)?$/.test(v.trim())) o[h] = Number(v);
        else o[h] = v != null ? v : '';
      });
      return o;
    });
    return { rows: objRows, columns: headers };
  }

  // Excel (.xlsx/.xls) via SheetJS. Loaded lazily on first parse.
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
            if (!aoa.length) {
              reject(new Error('This Excel file has no rows in its first sheet.'));
              return;
            }
            var headers = aoa[0].map(function (h, idx) { return h != null && h !== '' ? String(h) : 'col_' + (idx + 1); });
            var rows = aoa.slice(1).filter(function (r) {
              return r.some(function (v) { return v !== '' && v != null; });
            }).map(function (r) {
              var o = {};
              headers.forEach(function (h, idx) { o[h] = r[idx] != null ? r[idx] : ''; });
              return o;
            });
            resolve(makeDoc({
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

  // Word (.docx) via mammoth. Extract raw text + try to parse the first HTML
  // <table> for tabular data. If no table found, treat as text-only doc.
  function parseWord(file) {
    return loadScript('mammoth').then(function () {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('Couldn\u2019t read this Word file.')); };
        reader.onload = function () {
          var ab = reader.result;
          // extractRawText + convertToHtml in parallel.
          Promise.all([
            mammoth.extractRawText({ arrayBuffer: ab }).promise ||
              mammoth.extractRawText({ arrayBuffer: ab }),
            mammoth.convertToHtml({ arrayBuffer: ab }).promise ||
              mammoth.convertToHtml({ arrayBuffer: ab })
          ]).then(function (results) {
            var rawText = (results[0] && results[0].value) || '';
            var html    = (results[1] && results[1].value) || '';
            var warnings = [];
            var parsed = parseFirstHtmlTable(html);
            if (parsed.rows.length) {
              if (rawText) warnings.push('Document contains a table — using its rows as the dataset. Other text ignored for pipeline operations.');
              resolve(makeDoc({
                type: 'word', name: file.name, fileSize: file.size,
                rows: parsed.rows, columns: parsed.columns, rawText: rawText, warnings: warnings
              }));
            } else {
              warnings.push('No tables detected — this document is text-only. Pipeline steps that need rows (filter/summarize/sort) will return empty results, but the AI can still analyze the text.');
              resolve(makeDoc({
                type: 'word', name: file.name, fileSize: file.size,
                rows: [], columns: [], rawText: rawText, warnings: warnings
              }));
            }
          }).catch(function () {
            reject(new Error('Couldn\u2019t parse this Word file. Make sure it\u2019s a valid .docx (legacy .doc is not supported) and try again.'));
          });
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }
  // Parse the first <table> in an HTML string into { rows, columns }.
  function parseFirstHtmlTable(html) {
    if (!html) return { rows: [], columns: [] };
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var table = tmp.querySelector('table');
    if (!table) return { rows: [], columns: [] };
    var trs = table.querySelectorAll('tr');
    if (!trs.length) return { rows: [], columns: [] };
    var headers = [];
    var firstCells = trs[0].querySelectorAll('th,td');
    firstCells.forEach(function (c, idx) { headers.push((c.textContent || '').trim() || 'col_' + (idx + 1)); });
    // If first row has <th>, treat it as header; otherwise the first row is data.
    var startIdx = trs[0].querySelector('th') ? 1 : 0;
    var rows = [];
    for (var i = startIdx; i < trs.length; i++) {
      var cells = trs[i].querySelectorAll('td,th');
      if (!cells.length) continue;
      var o = {};
      headers.forEach(function (h, idx) {
        var v = (cells[idx] ? cells[idx].textContent : '').trim();
        if (v !== '' && !isNaN(v) && /^-?\d+(\.\d+)?$/.test(v)) o[h] = Number(v);
        else o[h] = v;
      });
      rows.push(o);
    }
    return { rows: rows, columns: headers };
  }

  // PDF (.pdf) via pdf.js. Extracts text per page. Attempts a simple table
  // detection: if multiple text items share the same Y coordinate across pages,
  // group them into rows. If detection fails, fall back to text-only.
  function parsePDF(file) {
    return loadScript('pdfjs').then(function () {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('Couldn\u2019t read this PDF.')); };
        reader.onload = function () {
          try {
            // Configure the worker — pdf.js won't run without it.
            if (window.pdfjsLib) {
              pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_URLS.pdfjsWorker;
            }
            var loadingTask = pdfjsLib.getDocument({ data: reader.result });
            loadingTask.promise.then(function (pdf) {
              var numPages = pdf.numPages;
              var allItems = [];   // { page, str, x, y, w }
              var rawText  = [];
              // Sequentially fetch each page's text content. We do this serially
              // (rather than Promise.all) because pdf.js's getTextContent can
              // interfere with concurrent page operations on some builds, and
              // serial is plenty fast for the demo's <5MB PDFs.
              function readPagesSequentially(pageNum) {
                if (pageNum > numPages) return Promise.resolve();
                return pdf.getPage(pageNum).then(function (page) {
                  return page.getTextContent().then(function (tc) {
                    (tc.items || []).forEach(function (it) {
                      allItems.push({
                        page: pageNum,
                        str: it.str,
                        x: it.transform ? it.transform[4] : 0,
                        y: it.transform ? it.transform[5] : 0,
                        w: it.width || 0
                      });
                      if (it.str) rawText.push(it.str);
                    });
                    return readPagesSequentially(pageNum + 1);
                  });
                });
              }
              return readPagesSequentially(1).then(function () {
                var text = rawText.join(' ').replace(/\s+/g, ' ').trim();
                var parsed = detectPDFTable(allItems);
                var warnings = [];
                if (parsed.rows.length) {
                  warnings.push('Detected a tabular layout from text positioning — rows may be imperfect. Verify against the source PDF.');
                } else if (text) {
                  warnings.push('No clear table layout detected — treating as a text document. Pipeline steps that need rows will return empty results, but the AI can still analyze the text.');
                }
                resolve(makeDoc({
                  type: 'pdf', name: file.name, fileSize: file.size,
                  rows: parsed.rows, columns: parsed.columns,
                  rawText: text || '(no extractable text)', warnings: warnings
                }));
              });
            }).catch(function () {
              reject(new Error('Couldn\u2019t open this PDF. The file may be corrupted, password-protected, or a scanned image (text-extractable PDFs only).'));
            });
          } catch (e) {
            reject(new Error('Couldn\u2019t parse this PDF. Make sure it\u2019s a valid .pdf and try again.'));
          }
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }

  // Heuristic PDF table detector: group items by Y coordinate (rounded to
  // nearest 2px to absorb sub-pixel jitter), sort each row's items by X, and
  // join into cells. If at least 3 rows × 2 cols, treat as a table.
  function detectPDFTable(items) {
    if (!items || items.length < 6) return { rows: [], columns: [] };
    // Group by rounded Y.
    var byY = {};
    items.forEach(function (it) {
      if (!it.str) return;
      var y = Math.round(it.y / 2) * 2;
      if (!byY[y]) byY[y] = [];
      byY[y].push(it);
    });
    var yKeys = Object.keys(byY).map(Number).sort(function (a, b) { return b - a; }); // top of page = larger Y
    if (yKeys.length < 3) return { rows: [], columns: [] };
    // Build row arrays (items sorted by X within each row).
    var rowArrays = yKeys.map(function (y) {
      return byY[y].sort(function (a, b) { return a.x - b.x; })
        .map(function (it) { return it.str; })
        .join(' ').trim();
    }).filter(function (s) { return s.length; });
    if (rowArrays.length < 3) return { rows: [], columns: [] };
    // Split each row on 2+ space gaps into columns. If the first row splits into
    // ≥2 columns, use that count as the column count.
    var splitRows = rowArrays.map(function (r) {
      return r.split(/\s{2,}/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    });
    var colCount = splitRows[0].length;
    if (colCount < 2) return { rows: [], columns: [] };
    // Require that most rows have ≥2 columns; otherwise it's just paragraph text.
    var multiColRows = splitRows.filter(function (r) { return r.length >= 2; }).length;
    if (multiColRows < splitRows.length * 0.6) return { rows: [], columns: [] };
    var headers = splitRows[0].map(function (h, idx) { return h || 'col_' + (idx + 1); });
    var rows = splitRows.slice(1).filter(function (r) { return r.length; }).map(function (r) {
      var o = {};
      headers.forEach(function (h, idx) {
        var v = r[idx] != null ? r[idx] : '';
        if (v !== '' && !isNaN(v) && /^-?\d+(\.\d+)?$/.test(v.replace(/[,$]/g, ''))) {
          o[h] = Number(v.replace(/[,$]/g, ''));
        } else {
          o[h] = v;
        }
      });
      return o;
    });
    return { rows: rows, columns: headers };
  }

  // Dispatcher: route a File to the right parser by extension + MIME.
  function parseFile(file) {
    var name = (file.name || '').toLowerCase();
    if (file.size > MAX_FILE_SIZE) {
      return Promise.reject(new Error('For demo performance, please use files under 5 MB.'));
    }
    if (/\.csv$/.test(name) || file.type === 'text/csv') return parseCSV(file);
    if (/\.xlsx$|\.xls$|\.xlsm$/.test(name))           return parseExcel(file);
    if (/\.docx$/.test(name))                           return parseWord(file);
    if (/\.pdf$/.test(name) || file.type === 'application/pdf') return parsePDF(file);
    return Promise.reject(new Error('Unsupported file type. Accepted: .xlsx, .xls, .docx, .pdf, .csv'));
  }

  // Load a sample template. For Excel-style samples this is synchronous
  // (returns a doc object directly). For PDF samples it's async — fetches
  // the PDF file and parses it via pdf.js (which is loaded lazily on first
  // use). Returns a Promise<doc> in either case for unified handling.
  function loadSample(tpl) {
    if (tpl.isPDF) {
      // Async path: fetch the PDF, wrap it as a File, hand off to parsePDF.
      // Same parser path as a user-uploaded PDF, so detectPDFTable() runs
      // against the real text positioning extracted by pdf.js.
      return fetch(tpl.url, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('Couldn\u2019t load the sample PDF (' + r.status + '). The file may not be deployed yet.');
        return r.arrayBuffer();
      }).then(function (buf) {
        // Wrap as a File so parsePDF's FileReader.readAsArrayBuffer works.
        var filename = tpl.url.split('/').pop();
        var file = new File([buf], filename, { type: 'application/pdf' });
        return parsePDF(file);
      }).then(function (doc) {
        // Tag the doc as a sample so the UI can show "sample dataset" hint
        // and so the analysis step knows it's a synthetic demo PDF.
        doc.name = tpl.name + ' (sample)';
        if (!doc.warnings) doc.warnings = [];
        doc.warnings.unshift('This is a committed sample PDF — no file was uploaded.');
        return doc;
      });
    }
    // Sync path: existing Excel-style generator
    var rows = tpl.generate();
    return Promise.resolve(makeDoc({
      type: 'excel', name: tpl.name + ' (sample)', fileSize: 0,
      rows: rows, columns: tpl.columns.slice(),
      warnings: ['This is a generated sample dataset — no file was uploaded.']
    }));
  }

  // ─── Groq auto-analysis ────────────────────────────────────────────────────
  // Sends a sample of the document to Groq and parses the JSON analysis. Result
  // shape: { documentType, summary, keyColumns, suggestedActions, detectedFormulas, dataQualityNotes }
  function analyzeDocument(doc) {
    var sample = doc.rows && doc.rows.length
      ? JSON.stringify(doc.rows.slice(0, 5), null, 2)
      : JSON.stringify((doc.rawText || '').slice(0, 800));
    var prompt =
      'You are analyzing a ' + doc.type + ' document titled "' + doc.name + '" with ' +
      doc.rowCount + ' rows \u00d7 ' + doc.columnCount + ' columns.\n' +
      'Column headers: ' + (doc.columns.join(', ') || '(none — text document)') + '\n' +
      'First 5 rows (sample):\n' + sample + '\n\n' +
      'Analyze this document and respond with a JSON object ONLY (no markdown, no explanation):\n' +
      '{\n' +
      '  "documentType": "what kind of data this is (e.g. \'regional sales\', \'invoice aging\', \'HR roster\')",\n' +
      '  "summary": "one-sentence description of what\'s in the data",\n' +
      '  "keyColumns": ["which columns look most important for analysis"],\n' +
      '  "suggestedActions": [\n' +
      '    "3-5 natural-language suggested actions, each a one-sentence instruction like \'Summarize total revenue by region\'",\n' +
      '    "Make them specific to this data, not generic",\n' +
      '    "Vary the difficulty — easy (sort), medium (summarize), advanced (filter+summarize)"\n' +
      '  ],\n' +
      '  "detectedFormulas": ["any formulas or derived columns you notice (e.g. \'revenue = qty \u00d7 price\')"],\n' +
      '  "dataQualityNotes": ["any issues — missing values, outliers, etc."]\n' +
      '}';
    return callGroq(
      [{ role: 'system', content: 'You are a data analyst that outputs only raw JSON.' },
       { role: 'user', content: prompt }],
      { temperature: 0.3, max_tokens: 800 }
    ).then(function (content) { return extractJson(content); });
  }

  // ─── Groq pipeline-spec generator (NL → JSON) ──────────────────────────────
  function generatePipelineSpec(doc, instruction) {
    var sampleRow = doc.rows && doc.rows.length ? JSON.stringify(doc.rows[0]) : '(no rows)';
    var prompt =
      'You are an AI pipeline constructor. Convert the user\'s natural language instruction into a JSON pipeline spec.\n\n' +
      'User\'s instruction: "' + instruction + '"\n\n' +
      'Document context:\n' +
      '- Type: ' + doc.type + '\n' +
      '- Name: ' + doc.name + '\n' +
      '- Columns: ' + (doc.columns.join(', ') || '(none)') + '\n' +
      '- Sample row: ' + sampleRow + '\n' +
      '- Row count: ' + doc.rowCount + '\n\n' +
      'Respond with a JSON object ONLY (no markdown, no explanation):\n' +
      '{\n' +
      '  "name": "short pipeline name",\n' +
      '  "description": "one-sentence description of what the pipeline does",\n' +
      '  "steps": [\n' +
      '    { "type": "filter"|"summarize"|"sort"|"limit"|"select"|"transform", "description": "what this step does",\n' +
      '      // filter:    { "column": "...", "operator": "=="|"!="|">"|"<"|">="|"<="|"contains", "value": ... }\n' +
      '      // summarize: { "groupBy": ["col1", ...], "aggregation": "sum"|"count"|"avg"|"min"|"max", "valueColumn": "..." }\n' +
      '      // sort:      { "column": "...", "order": "asc"|"desc" }\n' +
      '      // limit:     { "count": 5 }\n' +
      '      // select:    { "columns": ["col1", "col2"] }\n' +
      '      // transform: { "newColumn": "...", "expression": "qty * price" } }\n' +
      '    }\n' +
      '  ],\n' +
      '  "output": { "format": "html_table"|"csv"|"excel"|"pdf", "emailSubject": "subject line", "emailBodyIntro": "one-sentence intro" }\n' +
      '}';
    return callGroq(
      [{ role: 'system', content: 'You are a pipeline spec generator that outputs only raw JSON.' },
       { role: 'user', content: prompt }],
      { temperature: 0.2, max_tokens: 1000 }
    ).then(function (content) {
      var spec = extractJson(content);
      if (!spec.steps || !Array.isArray(spec.steps) || !spec.steps.length) {
        throw new Error('The AI didn\u2019t produce any pipeline steps. Try rephrasing your instruction.');
      }
      // Light validation — strip obviously bad step types so the executor doesn't choke.
      spec.steps = spec.steps.filter(function (s) { return s && typeof s.type === 'string'; });
      if (!spec.steps.length) {
        throw new Error('The AI returned an unexpected response. Try rephrasing your instruction.');
      }
      if (!spec.output || typeof spec.output !== 'object') spec.output = { format: 'html_table' };
      return spec;
    });
  }

  // ─── Safe expression evaluator (recursive descent) ─────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────
  // Used by the "transform" step to evaluate expressions like "qty * price" or
  // "first_name + ' ' + last_name" WITHOUT eval() or new Function() — those are
  // XSS vectors and CSP-violators. This parser supports:
  //   • numeric literals (12, 3.14)
  //   • single-quoted string literals ('hello')
  //   • column identifiers (qty, price, first_name)
  //   • operators: + - * / %  (binary, left-associative; + on a string operand
  //     coerces both sides to string and concatenates)
  //   • parentheses for grouping
  // Anything else throws — fail closed.
  //
  // Grammar (EBNF):
  //   expression := term { ('+' | '-') term }
  //   term       := factor { ('*' | '/' | '%') factor }
  //   factor     := number | string | identifier | '(' expression ')'
  // ─────────────────────────────────────────────────────────────────────────────

  function tokenizeExpr(expr) {
    var tokens = [];
    var i = 0, len = expr.length;
    while (i < len) {
      var c = expr[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      // Number literal — digits and at most one decimal point.
      if ((c >= '0' && c <= '9') || c === '.') {
        var num = '';
        var dotSeen = false;
        while (i < len && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
          if (expr[i] === '.') {
            if (dotSeen) break;
            dotSeen = true;
          }
          num += expr[i]; i++;
        }
        var n = parseFloat(num);
        if (isNaN(n)) throw new Error('Invalid number in expression: ' + num);
        tokens.push({ type: 'num', value: n });
        continue;
      }
      // Single-quoted string literal — doubled '' inside means an escaped quote.
      if (c === "'") {
        var str = '';
        i++; // skip opening quote
        while (i < len && expr[i] !== "'") { str += expr[i]; i++; }
        if (i >= len) throw new Error('Unterminated string literal in expression');
        i++; // skip closing quote
        tokens.push({ type: 'str', value: str });
        continue;
      }
      // Identifier — letters, digits, underscore (must start with letter/underscore).
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
        var id = '';
        while (i < len && ((expr[i] >= 'a' && expr[i] <= 'z') ||
                           (expr[i] >= 'A' && expr[i] <= 'Z') ||
                           (expr[i] >= '0' && expr[i] <= '9') || expr[i] === '_')) {
          id += expr[i]; i++;
        }
        tokens.push({ type: 'id', value: id });
        continue;
      }
      // Operators + parens.
      if ('+-*/%()'.indexOf(c) >= 0) { tokens.push({ type: 'op', value: c }); i++; continue; }
      throw new Error('Invalid character in expression: ' + c);
    }
    return tokens;
  }

  // Recursive-descent parser → AST nodes:
  //   { type: 'literal', value: <number|string> }
  //   { type: 'column',  name: <string> }
  //   { type: 'binop',   op: '+'|'-'|'*'|'/'|'%', left: <node>, right: <node> }
  function parseExpr(tokens) {
    var pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function parseExpression() {
      var node = parseTerm();
      while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
        var op = next().value;
        var right = parseTerm();
        node = { type: 'binop', op: op, left: node, right: right };
      }
      return node;
    }
    function parseTerm() {
      var node = parseFactor();
      while (peek() && peek().type === 'op' &&
             (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
        var op = next().value;
        var right = parseFactor();
        node = { type: 'binop', op: op, left: node, right: right };
      }
      return node;
    }
    function parseFactor() {
      var t = peek();
      if (!t) throw new Error('Unexpected end of expression');
      if (t.type === 'num' || t.type === 'str') { next(); return { type: 'literal', value: t.value }; }
      if (t.type === 'id') { next(); return { type: 'column', name: t.value }; }
      if (t.type === 'op' && t.value === '(') {
        next();
        var node = parseExpression();
        if (!peek() || peek().value !== ')') throw new Error('Missing closing parenthesis');
        next(); // consume ')'
        return node;
      }
      throw new Error('Unexpected token in expression: ' + t.value);
    }
    var ast = parseExpression();
    if (pos < tokens.length) throw new Error('Unexpected trailing tokens in expression');
    return ast;
  }

  // Evaluate an AST node against a row object. The '+' operator is polymorphic:
  // if either operand is a string, both sides stringify and concatenate; else
  // numeric addition. All other operators are numeric only.
  function evalAst(node, row) {
    if (node.type === 'literal') return node.value;
    if (node.type === 'column') {
      if (!(node.name in row)) throw new Error('Unknown column in expression: ' + node.name);
      return row[node.name];
    }
    if (node.type === 'binop') {
      var l = evalAst(node.left, row);
      var r = evalAst(node.right, row);
      if (node.op === '+' && (typeof l === 'string' || typeof r === 'string')) {
        return String(l) + String(r);
      }
      var ln = Number(l), rn = Number(r);
      if (isNaN(ln) || isNaN(rn)) throw new Error('Non-numeric operand in arithmetic expression');
      switch (node.op) {
        case '+': return ln + rn;
        case '-': return ln - rn;
        case '*': return ln * rn;
        case '/': return rn === 0 ? 0 : ln / rn;
        case '%': return rn === 0 ? 0 : ln % rn;
      }
      throw new Error('Unknown operator: ' + node.op);
    }
    throw new Error('Cannot evaluate AST node: ' + node.type);
  }

  // Public façade — tokenize + parse + evaluate. AST is cached per expression
  // (via the closure on the parsed result) so per-row evaluation skips parsing.
  function makeExprEvaluator(expression) {
    var tokens = tokenizeExpr(expression);
    var ast = parseExpr(tokens);
    return function (row) { return evalAst(ast, row); };
  }

  // ─── Case-insensitive column resolver ──────────────────────────────────────
  // Groq frequently returns column names in a DIFFERENT CASE than the actual
  // data — e.g. valueColumn: "QTY" when the data has lowercase "qty", or
  // "Revenue" when the data has "revenue". Without a resolver, r["QTY"]
  // returns undefined → Number(undefined) is NaN → NaN propagates through
  // sum/avg/min/max → the entire result column shows as NaN.
  //
  // The resolver: exact match first, case-insensitive match second, falls
  // back to the original name (so undefined values surface the bug visibly
  // in the result — better than silently failing).
  var _colLookupCache = {};
  function resolveColumn(name, docColumns) {
    if (!name) return name;
    if (docColumns.indexOf(name) >= 0) return name;
    var cacheKey = name.toLowerCase() + '\u0001' + docColumns.join('\u0001');
    if (_colLookupCache[cacheKey]) return _colLookupCache[cacheKey];
    var lower = name.toLowerCase();
    for (var i = 0; i < docColumns.length; i++) {
      if (docColumns[i].toLowerCase() === lower) {
        _colLookupCache[cacheKey] = docColumns[i];
        return docColumns[i];
      }
    }
    _colLookupCache[cacheKey] = name;
    return name;
  }

  // ─── Pipeline executor ─────────────────────────────────────────────────────
  // Runs each step in order over a shallow-cloned row array. Each step mutates
  // the array (filter shortens, summarize reshapes, sort reorders, etc.). The
  // final shape is returned to the renderer.
  function executePipeline(doc, spec) {
    var rows = (doc.rows || []).slice();
    var docCols = doc.columns || (rows.length ? Object.keys(rows[0]) : []);
    _colLookupCache = {};  // reset per-execution
    (spec.steps || []).forEach(function (step) {
      if (step.type === 'filter') {
        var fCol = resolveColumn(step.column, docCols);
        rows = rows.filter(function (r) {
          var v = r[fCol];
          switch (step.operator) {
            case '==':  return String(v) == String(step.value);
            case '!=':  return String(v) != String(step.value);
            case '>':   return Number(v) >  Number(step.value);
            case '<':   return Number(v) <  Number(step.value);
            case '>=':  return Number(v) >= Number(step.value);
            case '<=':  return Number(v) <= Number(step.value);
            case 'contains':
              return String(v).toLowerCase().indexOf(String(step.value).toLowerCase()) >= 0;
            default: return true;
          }
        });
      } else if (step.type === 'summarize') {
        var groupByRaw = step.groupBy && step.groupBy.length ? step.groupBy : [];
        var groupBy = groupByRaw.map(function (c) { return resolveColumn(c, docCols); });
        var valCol = step.valueColumn ? resolveColumn(step.valueColumn, docCols) : null;
        var groups = {};
        var order = [];
        rows.forEach(function (r) {
          var key = groupBy.map(function (c) { return r[c]; }).join(' | ');
          if (!groups[key]) { groups[key] = { count: 0, sum: 0, min: Infinity, max: -Infinity }; order.push(key); }
          var g = groups[key];
          var val = valCol ? Number(r[valCol]) : 0;
          if (isNaN(val)) val = 0;  // guard against NaN propagation
          g.count++;
          if (valCol) {
            g.sum += val;
            g.min = Math.min(g.min, val);
            g.max = Math.max(g.max, val);
          }
        });
        rows = order.map(function (key) {
          var g = groups[key];
          var parts = key.split(' | ');
          var row = {};
          groupBy.forEach(function (c, i) { row[c] = parts[i]; });
          if (valCol) {
            var agg = step.aggregation || 'sum';
            row[agg + '_of_' + valCol] =
              agg === 'sum'   ? g.sum :
              agg === 'count' ? g.count :
              agg === 'avg'   ? (g.count ? g.sum / g.count : 0) :
              agg === 'min'   ? (g.min === Infinity ? 0 : g.min) :
              agg === 'max'   ? (g.max === -Infinity ? 0 : g.max) : null;
          } else {
            row.count = g.count;
          }
          return row;
        });
      } else if (step.type === 'sort') {
        var sCol = resolveColumn(step.column, docCols);
        var order2 = step.order === 'desc' ? -1 : 1;
        rows.sort(function (a, b) {
          var av = a[sCol], bv = b[sCol];
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * order2;
          return order2 * String(av).localeCompare(String(bv));
        });
      } else if (step.type === 'limit') {
        rows = rows.slice(0, Math.max(0, step.count | 0));
      } else if (step.type === 'select') {
        var selColsRaw = step.columns || [];
        var selCols = selColsRaw.map(function (c) { return resolveColumn(c, docCols); });
        rows = rows.map(function (r) {
          var o = {};
          selCols.forEach(function (c) { o[c] = r[c]; });
          return o;
        });
      } else if (step.type === 'transform') {
        // Build the evaluator ONCE, then map — parsing per row would be wasteful.
        var evalFn;
        try { evalFn = makeExprEvaluator(step.expression); }
        catch (e) { throw new Error('Transform step has an invalid expression: ' + e.message); }
        var newCol = step.newColumn || 'computed';
        rows = rows.map(function (r) {
          var o = Object.assign({}, r);
          try { o[newCol] = evalFn(r); } catch (e) { o[newCol] = ''; }
          return o;
        });
      }
      // Unknown step types are silently skipped — the spec validator already
      // filtered out garbage, so this is a defensive no-op.
    });
    return { rows: rows, columns: rows.length ? Object.keys(rows[0]) : [] };
  }

  // ─── Theme helpers (mirror blog-markets-dashboard pattern) ──────────────────
  // Reads <html data-theme> dynamically and falls back to 'dark'. The mount
  // may override via data-pb-theme (escape hatch for blog posts that want a
  // fixed demo theme independent of the site toggle).
  function getTheme() {
    var mount = $(MOUNT_ID);
    if (mount) {
      var t = mount.getAttribute('data-pb-theme');
      if (t === 'light' || t === 'dark') return t;
    }
    var html = document.documentElement.getAttribute('data-theme');
    return html === 'light' ? 'light' : 'dark';
  }
  function axisLabelColor() { return getTheme() === 'dark' ? '#a8b3c7' : '#475569'; }
  function tooltipBgColor() { return getTheme() === 'dark' ? 'rgba(15,23,42,.95)' : 'rgba(255,255,255,.97)'; }
  function tooltipTextColor() { return getTheme() === 'dark' ? '#e6edf7' : '#0f172a'; }
  function chartGridColor() { return getTheme() === 'dark' ? 'rgba(255,255,255,.07)' : 'rgba(15,23,42,.07)'; }

  // ─── CSS injection ──────────────────────────────────────────────────────────
  // All pipeline-builder-specific CSS lives in a single injected <style> block,
  // scoped with the .pb- prefix so it can't clash with the site stylesheet.
  // Reuses the site's design tokens (--bg, --surface, --border, --text, etc.)
  // and the site's .btn / .btn-primary / .btn-ghost classes (defined globally).
  function injectCSS() {
    if ($('pb-style')) return;
    var css = '\
.pb-app { font-family: var(--font-body); color: var(--text); max-width: 980px; margin: 0 auto; padding: 0; }\
.pb-app * { box-sizing: border-box; }\
.pb-card {\
  background: var(--surface);\
  border: 1px solid var(--border);\
  border-radius: var(--radius);\
  padding: 24px;\
  margin-bottom: 20px;\
  box-shadow: var(--shadow-sm);\
}\
.pb-card-title {\
  font-family: var(--font-head);\
  font-size: 1.15rem;\
  font-weight: 700;\
  margin: 0 0 4px;\
  letter-spacing: -0.01em;\
  color: var(--text);\
}\
.pb-card-sub { color: var(--text-soft); font-size: 0.88rem; margin: 0 0 18px; }\
.pb-card-step {\
  display: inline-block;\
  font-family: var(--font-head);\
  font-size: 0.7rem;\
  font-weight: 600;\
  letter-spacing: 0.08em;\
  text-transform: uppercase;\
  color: var(--indigo);\
  margin-bottom: 6px;\
}\
.pb-drop {\
  border: 2px dashed var(--border-strong);\
  border-radius: var(--radius);\
  padding: 36px 24px;\
  text-align: center;\
  cursor: pointer;\
  transition: border-color 0.2s var(--ease), background 0.2s var(--ease);\
  background: var(--bg-alt);\
}\
.pb-drop:hover, .pb-drop.pb-dragover {\
  border-color: var(--indigo);\
  background: linear-gradient(135deg, rgba(99,102,241,0.06), rgba(6,182,212,0.06));\
}\
.pb-drop-icon { font-size: 2rem; color: var(--indigo); margin-bottom: 8px; }\
.pb-drop-text { color: var(--text); font-weight: 600; margin-bottom: 4px; }\
.pb-drop-hint { color: var(--text-soft); font-size: 0.82rem; }\
.pb-divider {\
  display: flex; align-items: center; gap: 12px;\
  color: var(--text-soft); font-size: 0.82rem; margin: 22px 0 14px;\
}\
.pb-divider::before, .pb-divider::after {\
  content: ""; flex: 1; height: 1px; background: var(--border);\
}\
.pb-sample-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }\
.pb-sample {\
  background: var(--bg-alt);\
  border: 1px solid var(--border);\
  border-radius: var(--radius-sm);\
  padding: 14px;\
  cursor: pointer;\
  text-align: left;\
  transition: transform 0.2s var(--ease), border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);\
  font-family: inherit; color: var(--text); width: 100%;\
}\
.pb-sample:hover { transform: translateY(-2px); border-color: var(--indigo); box-shadow: 0 12px 26px -14px rgba(99,102,241,0.5); }\
.pb-sample-icon { color: var(--indigo); font-size: 1.1rem; margin-bottom: 6px; }\
.pb-sample-name { font-weight: 600; font-size: 0.92rem; }\
.pb-sample-meta { color: var(--text-soft); font-size: 0.78rem; margin-top: 2px; }\
@media (max-width: 720px) { .pb-sample-grid { grid-template-columns: 1fr; } }\
\
.pb-doc-head { display: flex; align-items: center; gap: 14px; }\
.pb-doc-icon {\
  width: 44px; height: 44px; border-radius: var(--radius-sm);\
  background: linear-gradient(135deg, rgba(99,102,241,0.16), rgba(6,182,212,0.16));\
  display: flex; align-items: center; justify-content: center;\
  color: var(--indigo); font-size: 1.2rem; flex-shrink: 0;\
}\
.pb-doc-name { font-weight: 600; color: var(--text); }\
.pb-doc-meta { color: var(--text-soft); font-size: 0.82rem; }\
.pb-link { background: none; border: none; color: var(--indigo); cursor: pointer; font-size: 0.85rem; padding: 0; text-decoration: underline; font-family: inherit; }\
.pb-link:hover { color: var(--cyan); }\
\
.pb-textarea {\
  width: 100%; min-height: 96px; resize: vertical;\
  background: var(--bg-alt); border: 1px solid var(--border-strong);\
  border-radius: var(--radius-sm); padding: 12px 14px;\
  color: var(--text); font-family: var(--font-body); font-size: 0.95rem; line-height: 1.5;\
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);\
}\
.pb-textarea:focus { outline: none; border-color: var(--indigo); box-shadow: var(--ring); }\
\
.pb-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 16px; }\
.pb-chip {\
  background: var(--bg-alt); border: 1px solid var(--border);\
  border-radius: 999px; padding: 7px 14px; cursor: pointer;\
  font-size: 0.82rem; color: var(--text-muted); font-family: inherit;\
  transition: border-color 0.2s var(--ease), color 0.2s var(--ease), background 0.2s var(--ease);\
}\
.pb-chip:hover { border-color: var(--indigo); color: var(--indigo); background: rgba(99,102,241,0.06); }\
\
.pb-btn-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; }\
.pb-btn-sm { min-height: 38px; padding: 8px 16px; font-size: 0.85rem; border-radius: 999px; }\
.pb-btn-row .pb-spacer { flex: 1; }\
\
.pb-step-list { list-style: none; padding: 0; margin: 12px 0 0; }\
.pb-step-item { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); }\
.pb-step-item:first-child { border-top: none; padding-top: 4px; }\
.pb-step-num {\
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;\
  background: var(--gradient); color: #fff; font-size: 0.78rem; font-weight: 700;\
  display: flex; align-items: center; justify-content: center; font-family: var(--font-head);\
}\
.pb-step-body { flex: 1; min-width: 0; }\
.pb-step-type {\
  display: inline-block; font-family: var(--font-head); font-size: 0.68rem; font-weight: 600;\
  text-transform: uppercase; letter-spacing: 0.06em;\
  background: rgba(99,102,241,0.12); color: var(--indigo);\
  padding: 2px 8px; border-radius: 6px; margin-bottom: 4px;\
}\
.pb-step-desc { color: var(--text); font-size: 0.92rem; margin: 0 0 4px; }\
.pb-step-params { color: var(--text-soft); font-size: 0.78rem; font-family: var(--font-body); word-break: break-word; }\
\
.pb-collapsible-toggle {\
  background: none; border: 1px solid var(--border); color: var(--text-muted);\
  padding: 6px 12px; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.8rem;\
  font-family: inherit; display: inline-flex; align-items: center; gap: 6px;\
}\
.pb-collapsible-toggle:hover { border-color: var(--indigo); color: var(--indigo); }\
.pb-pre {\
  background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm);\
  padding: 14px; overflow: auto; margin: 12px 0 0; font-size: 0.78rem; line-height: 1.5;\
  color: var(--text-muted); max-height: 320px; white-space: pre; font-family: "SFMono-Regular", Consolas, monospace;\
}\
\
.pb-result-summary { color: var(--text-soft); font-size: 0.85rem; margin: 0 0 14px; }\
.pb-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 520px; }\
.pb-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }\
.pb-table th, .pb-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }\
.pb-table th {\
  background: var(--bg-alt); color: var(--text-muted); font-family: var(--font-head);\
  font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;\
  position: sticky; top: 0; z-index: 1;\
}\
.pb-table td.num { text-align: right; font-variant-numeric: tabular-nums; }\
.pb-table tbody tr:hover { background: rgba(99,102,241,0.04); }\
.pb-table-empty { padding: 36px; text-align: center; color: var(--text-soft); }\
.pb-load-more {\
  display: block; margin: 14px auto 0; background: var(--bg-alt); border: 1px solid var(--border);\
  color: var(--text-muted); padding: 8px 18px; border-radius: 999px; cursor: pointer; font-family: inherit; font-size: 0.82rem;\
}\
.pb-load-more:hover { border-color: var(--indigo); color: var(--indigo); }\
\
.pb-chart-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; margin-top: 18px; }\
.pb-chart-title { font-family: var(--font-head); font-size: 0.82rem; font-weight: 600; color: var(--text-muted); margin: 0 0 6px; }\
.pb-chart-body { width: 100%; height: 360px; }\
.pb-chart-empty { padding: 36px; text-align: center; color: var(--text-soft); font-size: 0.85rem; }\
\
.pb-download-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }\
\
.pb-analysis-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; margin-top: 16px; }\
.pb-analysis-title { font-family: var(--font-head); font-size: 0.92rem; font-weight: 600; margin: 0 0 4px; }\
.pb-analysis-summary { color: var(--text-muted); font-size: 0.88rem; margin: 0 0 12px; }\
.pb-analysis-section { margin-top: 10px; }\
.pb-analysis-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-soft); margin: 0 0 4px; font-family: var(--font-head); }\
.pb-analysis-list { margin: 0; padding-left: 18px; color: var(--text-muted); font-size: 0.84rem; }\
.pb-analysis-list li { margin-bottom: 3px; }\
.pb-pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }\
.pb-pill { background: rgba(6,182,212,0.1); color: var(--cyan); border: 1px solid rgba(6,182,212,0.25); border-radius: 6px; padding: 3px 8px; font-size: 0.74rem; font-family: var(--font-head); font-weight: 600; }\
\
.pb-error {\
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3);\
  border-radius: var(--radius-sm); padding: 12px 16px; color: #b91c1c; margin-top: 12px; font-size: 0.88rem;\
}\
[data-theme="dark"] .pb-error { color: #fca5a5; }\
.pb-warn {\
  background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.28);\
  border-radius: var(--radius-sm); padding: 10px 14px; color: #b45309; margin-top: 12px; font-size: 0.82rem;\
}\
[data-theme="dark"] .pb-warn { color: #fcd34d; }\
\
.pb-loading { display: flex; align-items: center; gap: 10px; color: var(--text-soft); font-size: 0.88rem; padding: 14px 0; }\
.pb-loading-block { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 16px; text-align: center; color: var(--text-soft); font-size: 0.95rem; }\
.pb-loading-sub { font-size: 0.78rem; color: var(--text-soft); opacity: 0.7; }\
.pb-spinner {\
  width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--indigo);\
  border-radius: 50%; animation: pb-spin 0.8s linear infinite; flex-shrink: 0;\
}\
@keyframes pb-spin { to { transform: rotate(360deg); } }\
\
.pb-saved-list { list-style: none; padding: 0; margin: 0; }\
.pb-saved-item {\
  display: flex; align-items: center; gap: 12px; padding: 12px 0;\
  border-top: 1px solid var(--border); flex-wrap: wrap;\
}\
.pb-saved-item:first-child { border-top: none; }\
.pb-saved-info { flex: 1; min-width: 180px; }\
.pb-saved-name { font-weight: 600; color: var(--text); font-size: 0.9rem; }\
.pb-saved-meta { color: var(--text-soft); font-size: 0.78rem; }\
.pb-saved-actions { display: flex; gap: 6px; }\
\
.pb-empty { color: var(--text-soft); font-size: 0.88rem; padding: 18px 0; text-align: center; }\
\
.pb-modal-backdrop {\
  position: fixed; inset: 0; background: rgba(15,23,42,0.55); backdrop-filter: blur(4px);\
  display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px;\
}\
.pb-modal {\
  background: var(--bg-elevated, var(--surface)); border: 1px solid var(--border-strong);\
  border-radius: var(--radius); padding: 24px; max-width: 640px; width: 100%; max-height: 80vh; overflow: auto;\
  box-shadow: var(--shadow-lg);\
}\
.pb-modal-title { font-family: var(--font-head); font-size: 1.1rem; font-weight: 700; margin: 0 0 14px; }\
.pb-modal-body { color: var(--text); font-size: 0.9rem; }\
.pb-modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }\
.pb-modal-pre {\
  background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm);\
  padding: 12px; white-space: pre-wrap; word-break: break-word; font-size: 0.78rem;\
  color: var(--text-muted); max-height: 320px; overflow: auto; font-family: "SFMono-Regular", Consolas, monospace;\
}\
.pb-input {\
  width: 100%; background: var(--bg-alt); border: 1px solid var(--border-strong);\
  border-radius: var(--radius-sm); padding: 10px 12px; color: var(--text); font-family: inherit; font-size: 0.92rem;\
}\
.pb-input:focus { outline: none; border-color: var(--indigo); box-shadow: var(--ring); }\
.pb-toggle-row { display: flex; gap: 18px; align-items: center; margin: 10px 0 14px; font-size: 0.85rem; color: var(--text-muted); }\
.pb-toggle-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }\
.pb-toggle-row input[type="radio"] { cursor: pointer; }\
.pb-toggle-disabled { opacity: 0.45; cursor: not-allowed; }\
.pb-toggle-disabled label, .pb-toggle-disabled input { cursor: not-allowed; }\
.pb-toggle-tip { font-size: 0.74rem; color: var(--text-soft); margin-left: 4px; }\
.pb-rate-note { color: var(--text-soft); font-size: 0.74rem; margin-top: 10px; text-align: right; }\
';
    var style = document.createElement('style');
    style.id = 'pb-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── HTML table renderer ────────────────────────────────────────────────────
  // Returns an HTML string. Numeric columns detected by scanning the first
  // non-empty cell of each column — right-aligned + number-formatted.
  function detectNumericColumns(rows, columns) {
    var isNum = {};
    columns.forEach(function (c) {
      var found = false;
      for (var i = 0; i < rows.length && i < 20; i++) {
        var v = rows[i][c];
        if (v !== '' && v != null) {
          isNum[c] = typeof v === 'number' || (!isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(String(v).replace(/[,$]/g, '')));
          found = true;
          break;
        }
      }
      if (!found) isNum[c] = false;
    });
    return isNum;
  }

  function renderTableHTML(rows, columns, visibleRows) {
    if (!rows.length) {
      return '<div class="pb-table-empty">No rows match this pipeline.</div>';
    }
    var isNum = detectNumericColumns(rows, columns);
    var shown = rows.slice(0, visibleRows);
    var html = '<div class="pb-table-wrap"><table class="pb-table"><thead><tr>';
    columns.forEach(function (c) { html += '<th class="' + (isNum[c] ? 'num' : '') + '">' + esc(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    shown.forEach(function (r) {
      html += '<tr>';
      columns.forEach(function (c) {
        var v = r[c];
        var cell;
        if (isNum[c]) cell = fmtNumber(v);
        else cell = esc(v);
        html += '<td class="' + (isNum[c] ? 'num' : '') + '">' + cell + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    if (rows.length > visibleRows) {
      html += '<button class="pb-load-more" id="pb-load-more">Load more (' + (rows.length - visibleRows) + ' remaining)</button>';
    }
    return html;
  }

  // ─── ECharts chart renderer ──────────────────────────────────────────────────
  // Auto-picks chart type from data shape:
  //   • 1 row → no chart
  //   • 2 cols, col1 categorical + col2 numeric → bar
  //   • 2 cols, col1 looks like a date → line (sorted by date)
  //   • 3+ cols, col1 categorical + rest numeric → grouped bar
  //   • otherwise → "chart not available" message
  function looksLikeDateColumn(rows, col) {
    if (!rows.length) return false;
    var parsed = 0, total = 0;
    for (var i = 0; i < Math.min(rows.length, 12); i++) {
      var v = rows[i][col];
      if (v == null || v === '') continue;
      total++;
      var d = new Date(v);
      if (!isNaN(d.getTime()) && d.getFullYear() > 1990) parsed++;
    }
    return total >= 3 && parsed / total >= 0.7;
  }
  function isNumericVal(v) {
    if (typeof v === 'number') return true;
    return v != null && v !== '' && !isNaN(Number(String(v).replace(/[,$]/g, ''))) && /^-?\d+(\.\d+)?$/.test(String(v).replace(/[,$]/g, ''));
  }

  function renderChart(mount) {
    var body = mount.querySelector('.pb-chart-body');
    if (!body) return;
    var res = state.result;
    if (!res || !res.rows || res.rows.length <= 1 || !res.columns.length) {
      body.innerHTML = '<div class="pb-chart-empty">Chart not available for this data shape.</div>';
      return;
    }
    var cols = res.columns;
    var rows = res.rows;
    var picked = pickChartConfig(rows, cols);
    if (!picked) {
      body.innerHTML = '<div class="pb-chart-empty">Chart not available for this data shape.</div>';
      return;
    }
    loadScript('echarts').then(function () {
      try {
        if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
        var inst = echarts.init(body, null, { renderer: 'canvas' });
        inst.setOption(picked);
        state.chart = inst;
        // Resize handler — only bound once.
        if (!renderChart._resizeBound) {
          window.addEventListener('resize', function () {
            if (state.chart) try { state.chart.resize(); } catch (e) {}
          });
          renderChart._resizeBound = true;
        }
      } catch (e) {
        body.innerHTML = '<div class="pb-chart-empty">Chart rendering failed.</div>';
      }
    }).catch(function () {
      body.innerHTML = '<div class="pb-chart-empty">Couldn\u2019t load the chart library.</div>';
    });
  }

  function pickChartConfig(rows, cols) {
    var theme = getTheme();
    var baseTooltip = {
      trigger: 'axis',
      backgroundColor: tooltipBgColor(),
      textStyle: { color: tooltipTextColor() },
      borderColor: 'rgba(99,102,241,0.2)'
    };
    var axisLabel = { color: axisLabelColor(), fontSize: 11 };
    var splitLine = { lineStyle: { color: chartGridColor() } };
    var axisLine  = { lineStyle: { color: chartGridColor() } };
    var gradient = ['#6366f1', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6'];

    // 2-column cases.
    if (cols.length === 2) {
      var c1 = cols[0], c2 = cols[1];
      // Categorical + numeric → bar.
      if (!looksLikeDateColumn(rows, c1) && rows.every(function (r) { return isNumericVal(r[c2]); })) {
        return {
          tooltip: baseTooltip,
          grid: { left: 50, right: 24, top: 24, bottom: 60, containLabel: true },
          xAxis: { type: 'category', data: rows.map(function (r) { return String(r[c1]); }), axisLabel: Object.assign({}, axisLabel, { rotate: rows.length > 6 ? 35 : 0 }), axisLine: axisLine, axisTick: { lineStyle: { color: chartGridColor() } } },
          yAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: axisLine },
          series: [{ type: 'bar', data: rows.map(function (r) { return Number(r[c2]); }), itemStyle: { color: gradient[0], borderRadius: [4, 4, 0, 0] } }]
        };
      }
      // Date + numeric → line.
      if (looksLikeDateColumn(rows, c1) && rows.every(function (r) { return isNumericVal(r[c2]); })) {
        var sorted = rows.slice().sort(function (a, b) { return new Date(a[c1]) - new Date(b[c1]); });
        return {
          tooltip: baseTooltip,
          grid: { left: 50, right: 24, top: 24, bottom: 60, containLabel: true },
          xAxis: { type: 'category', data: sorted.map(function (r) { return String(r[c1]); }), axisLabel: Object.assign({}, axisLabel, { rotate: 35 }), axisLine: axisLine, axisTick: { lineStyle: { color: chartGridColor() } } },
          yAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: axisLine },
          series: [{ type: 'line', data: sorted.map(function (r) { return Number(r[c2]); }), smooth: true, symbol: 'circle', symbolSize: 6, lineStyle: { color: gradient[0], width: 2 }, itemStyle: { color: gradient[0] }, areaStyle: { color: 'rgba(99,102,241,0.12)' } }]
        };
      }
      return null;
    }
    // 3+ column cases: categorical col1 + remaining numeric → grouped bar.
    if (cols.length >= 3) {
      var c1g = cols[0];
      var numericCols = cols.slice(1).filter(function (c) {
        return rows.every(function (r) { return isNumericVal(r[c]); });
      });
      if (numericCols.length >= 1) {
        var cats = rows.map(function (r) { return String(r[c1g]); });
        var series = numericCols.map(function (c, idx) {
          return {
            name: c, type: 'bar',
            data: rows.map(function (r) { return Number(r[c]); }),
            itemStyle: { color: gradient[idx % gradient.length], borderRadius: [4, 4, 0, 0] }
          };
        });
        return {
          tooltip: baseTooltip,
          legend: { data: numericCols, textStyle: { color: axisLabelColor() }, top: 0 },
          grid: { left: 50, right: 24, top: 40, bottom: 60, containLabel: true },
          xAxis: { type: 'category', data: cats, axisLabel: Object.assign({}, axisLabel, { rotate: cats.length > 6 ? 35 : 0 }), axisLine: axisLine, axisTick: { lineStyle: { color: chartGridColor() } } },
          yAxis: { type: 'value', axisLabel: axisLabel, splitLine: splitLine, axisLine: axisLine },
          series: series
        };
      }
    }
    return null;
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
    if (!rows.length) { rows = [{}]; }
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
    var csv = lines.join('\r\n');
    downloadBlob(filename || 'pipeline-result.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  }

  function downloadExcel(rows, columns, filename) {
    return loadScript('xlsx').then(function () {
      var cols = columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
      var data = [cols];
      rows.forEach(function (r) { data.push(cols.map(function (c) { return r[c]; })); });
      var ws = XLSX.utils.aoa_to_sheet(data);
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Results');
      var arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      downloadBlob(filename || 'pipeline-result.xlsx', new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
  }

  function downloadPDF(rows, columns, filename, title) {
    return loadScript('jspdf').then(function () {
      var jsPDF = window.jspdf ? window.jspdf.jsPDF : window.jsPDF;
      if (!jsPDF) throw new Error('jsPDF failed to load');
      var doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      var cols = columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = doc.internal.pageSize.getHeight();
      var margin = 36;
      // Title
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(title || 'Pipeline Result', margin, margin);
      doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(120);
      doc.text(rows.length + ' rows \u00d7 ' + cols.length + ' columns', margin, margin + 14);
      doc.setTextColor(0);
      // Compute column widths proportional to max content length, capped.
      var maxLens = cols.map(function (c) { return String(c).length; });
      rows.slice(0, 200).forEach(function (r) {
        cols.forEach(function (c, i) {
          var l = String(r[c] == null ? '' : r[c]).length;
          if (l > maxLens[i]) maxLens[i] = l;
        });
      });
      var totalLen = maxLens.reduce(function (a, b) { return a + b; }, 0) || 1;
      var colWidths = maxLens.map(function (l) { return Math.max(40, (l / totalLen) * (pageW - 2 * margin)); });
      // Normalize to fit.
      var totalW = colWidths.reduce(function (a, b) { return a + b; }, 0);
      var scale = (pageW - 2 * margin) / totalW;
      colWidths = colWidths.map(function (w) { return w * scale; });
      var y = margin + 30;
      var rowH = 16;
      var headerH = 18;
      // Header row
      doc.setFillColor(99, 102, 241); doc.setFillColor(67, 56, 202);
      doc.rect(margin, y - headerH + 4, pageW - 2 * margin, headerH, 'F');
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      var x = margin;
      cols.forEach(function (c, i) {
        doc.text(String(c).slice(0, Math.floor(colWidths[i] / 4)), x + 4, y - 4);
        x += colWidths[i];
      });
      y += 4;
      doc.setTextColor(30); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      rows.slice(0, 500).forEach(function (r, ridx) {
        if (y > pageH - margin) { doc.addPage(); y = margin + 4; }
        if (ridx % 2 === 1) { doc.setFillColor(245, 246, 248); doc.rect(margin, y - headerH + 8, pageW - 2 * margin, rowH, 'F'); }
        x = margin;
        cols.forEach(function (c, i) {
          var val = r[c] == null ? '' : String(r[c]);
          var maxChars = Math.floor(colWidths[i] / 4);
          if (val.length > maxChars) val = val.slice(0, maxChars - 1) + '\u2026';
          doc.text(val, x + 4, y);
          x += colWidths[i];
        });
        y += rowH;
      });
      doc.save(filename || 'pipeline-result.pdf');
    });
  }

  function downloadJSON(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    downloadBlob(filename || 'pipeline-spec.json', blob);
  }

  // ─── Email composer ─────────────────────────────────────────────────────────
  // Builds a plain-text ASCII table from the result rows, prepends the spec's
  // emailBodyIntro, and opens a mailto: link. Direct-send is a disabled toggle
  // ("coming soon"). Preview modal shows subject + body before opening mailto:.
  function buildEmailBody(spec, rows, columns) {
    var intro = (spec && spec.output && spec.output.emailBodyIntro) ||
      'Here is the result of the pipeline: ' + (spec ? spec.name : '');
    if (!rows.length) return intro + '\n\n(No rows in the result.)';
    var cols = columns.length ? columns : Object.keys(rows[0] || {});
    // Compute column widths (cap at 30 chars per cell to keep it readable).
    var widths = cols.map(function (c) { return Math.max(3, String(c).length); });
    var shown = rows.slice(0, 50);
    shown.forEach(function (r) {
      cols.forEach(function (c, i) {
        var l = String(r[c] == null ? '' : r[c]).length;
        if (l > widths[i]) widths[i] = Math.min(30, l);
      });
    });
    var pad = function (s, w) { s = String(s == null ? '' : s); return s.length > w ? s.slice(0, w - 1) + '\u2026' : s + ' '.repeat(w - s.length); };
    var header = cols.map(function (c, i) { return pad(c, widths[i]); }).join(' | ');
    var sep    = cols.map(function (_, i) { return '-'.repeat(widths[i]); }).join('-+-');
    var lines = [intro, '', header, sep];
    shown.forEach(function (r) {
      lines.push(cols.map(function (c, i) { return pad(r[c], widths[i]); }).join(' | '));
    });
    if (rows.length > shown.length) lines.push('... (' + (rows.length - shown.length) + ' more rows not shown)');
    return lines.join('\n');
  }

  function openEmailPreview(spec, rows, columns) {
    var subject = (spec && spec.output && spec.output.emailSubject) || ('Pipeline result: ' + (spec ? spec.name : 'untitled'));
    var body = buildEmailBody(spec, rows, columns);
    openModal('Email preview', '\
      <div class="pb-analysis-section">\
        <p class="pb-analysis-label">Subject</p>\
        <div class="pb-modal-pre">' + esc(subject) + '</div>\
      </div>\
      <div class="pb-analysis-section" style="margin-top:14px;">\
        <p class="pb-analysis-label">Body</p>\
        <div class="pb-modal-pre">' + esc(body) + '</div>\
      </div>\
      <div class="pb-analysis-section" style="margin-top:14px;">\
        <p class="pb-analysis-label">Recipient</p>\
        <input class="pb-input" id="pb-email-recipient" type="email" placeholder="recipient@example.com" />\
      </div>',
      [
        { label: 'Open in email client', primary: true, action: function () {
          var to = ($('pb-email-recipient') || {}).value || '';
          var url = 'mailto:' + encodeURIComponent(to).replace(/%40/, '@') +
            '?subject=' + encodeURIComponent(subject) +
            '&body=' + encodeURIComponent(body);
          window.location.href = url;
        } }
      ]);
  }

  // ─── Reusable modal ─────────────────────────────────────────────────────────
  function openModal(title, bodyHTML, buttons) {
    closeModal(); // only one at a time
    var back = document.createElement('div');
    back.className = 'pb-modal-backdrop';
    back.id = 'pb-modal';
    var actionsHTML = '';
    (buttons || []).forEach(function (b, idx) {
      actionsHTML += '<button class="btn ' + (b.primary ? 'btn-primary' : 'btn-ghost') +
        ' pb-btn-sm" data-pb-modal-action="' + idx + '">' + esc(b.label) + '</button>';
    });
    back.innerHTML = '\
      <div class="pb-modal" role="dialog" aria-modal="true">\
        <h3 class="pb-modal-title">' + esc(title) + '</h3>\
        <div class="pb-modal-body">' + bodyHTML + '</div>\
        <div class="pb-modal-actions">' + actionsHTML + '</div>\
      </div>';
    document.body.appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back) { closeModal(); return; }
      var btn = e.target.closest('[data-pb-modal-action]');
      if (btn) {
        var idx = parseInt(btn.getAttribute('data-pb-modal-action'), 10);
        var handler = (buttons || [])[idx];
        if (handler && handler.action) handler.action();
        // Don't auto-close — caller's action may want to keep modal open (e.g. mailto).
        // Most actions call closeModal themselves if appropriate.
      }
    });
    document.addEventListener('keydown', modalEscHandler);
  }
  function modalEscHandler(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    var m = $('pb-modal');
    if (m) m.remove();
    document.removeEventListener('keydown', modalEscHandler);
  }

  // ─── Persistence ────────────────────────────────────────────────────────────
  function loadSavedPipelines() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      state.savedPipelines = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.savedPipelines)) state.savedPipelines = [];
    } catch (e) { state.savedPipelines = []; }
  }
  function persistSavedPipelines() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedPipelines)); } catch (e) {}
  }
  function savePipeline(name) {
    if (!state.pipeline) return;
    var docSummary = state.document
      ? (state.document.name + ' (' + state.document.rowCount + ' rows)')
      : 'No document';
    var entry = {
      id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: name || state.pipeline.name || 'Untitled pipeline',
      spec: state.pipeline,
      docSummary: docSummary,
      savedAt: Date.now()
    };
    state.savedPipelines.unshift(entry);
    persistSavedPipelines();
    return entry;
  }
  function deletePipeline(id) {
    state.savedPipelines = state.savedPipelines.filter(function (p) { return p.id !== id; });
    persistSavedPipelines();
  }
  function importPipelineSpec(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Couldn\u2019t read that file.')); };
      reader.onload = function () {
        try {
          var spec = JSON.parse(reader.result);
          if (!spec.steps || !Array.isArray(spec.steps)) throw new Error('Not a pipeline spec');
          resolve(spec);
        } catch (e) { reject(new Error('That file isn\u2019t a valid pipeline spec JSON.')); }
      };
      reader.readAsText(file);
    });
  }

  // ─── Sub-renderers ──────────────────────────────────────────────────────────
  // Each writes into a fixed-id slot inside the mount. render() calls them in
  // order; each no-ops its slot when its slice of state is absent.

  function renderUploadCard() {
    var slot = $('pb-upload-slot');
    if (!slot) return;
    // Loading state — sample is being fetched + parsed (especially the PDF
    // sample which needs pdf.js). Show a spinner instead of the buttons so
    // the user knows something is happening.
    if (state.sampleLoading) {
      slot.innerHTML = '\
        <div class="pb-card">\
          <div class="pb-loading-block">\
            <div class="pb-spinner"></div>\
            <div>Loading sample\u2026</div>\
            <div class="pb-loading-sub">Fetching and parsing the sample document.</div>\
          </div>\
        </div>';
      return;
    }
    // Error loading the sample
    if (state.sampleLoadingError) {
      slot.innerHTML = '\
        <div class="pb-card">\
          <div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.sampleLoadingError) + '</div>\
          <button class="pb-link" id="pb-retry-sample" type="button">Back to samples</button>\
        </div>';
      return;
    }
    if (state.document) { slot.innerHTML = ''; return; }
    var samples = SAMPLE_TEMPLATES.map(function (t) {
      // PDF samples show a PDF icon + "PDF · 30 rows" instead of "generated"
      var meta = t.isPDF ? (t.rowCount + ' rows \u00b7 PDF') : (t.rowCount + ' rows \u00b7 generated');
      return '<button class="pb-sample" data-pb-sample="' + t.key + '" type="button">' +
        '<div class="pb-sample-icon"><i class="fas ' + t.icon + '"></i></div>' +
        '<div class="pb-sample-name">' + esc(t.name) + '</div>' +
        '<div class="pb-sample-meta">' + meta + '</div>' +
      '</button>';
    }).join('');
    slot.innerHTML = '\
      <div class="pb-card">\
        <div class="pb-card-step">Step 1</div>\
        <h3 class="pb-card-title">Upload your document</h3>\
        <p class="pb-card-sub">Drop a file below or pick a generated sample. Accepted: .xlsx, .xls, .docx, .pdf, .csv.</p>\
        <div class="pb-drop" id="pb-drop" tabindex="0" role="button" aria-label="Upload a file">\
          <div class="pb-drop-icon"><i class="fas fa-cloud-arrow-up"></i></div>\
          <div class="pb-drop-text">Drop a file here, or click to browse</div>\
          <div class="pb-drop-hint">Max 5 MB for the demo</div>\
        </div>\
        <input type="file" id="pb-file-input" accept=".xlsx,.xls,.docx,.pdf,.csv" hidden />\
        <div class="pb-divider">or pick a sample</div>\
        <div class="pb-sample-grid">' + samples + '</div>\
      </div>';
  }

  function renderDocumentCard() {
    var slot = $('pb-doc-slot');
    if (!slot) return;
    if (!state.document) { slot.innerHTML = ''; return; }
    var d = state.document;
    var icon = d.type === 'excel' ? 'fa-file-excel' :
              d.type === 'word'  ? 'fa-file-word' :
              d.type === 'pdf'    ? 'fa-file-pdf' :
              d.type === 'csv'    ? 'fa-file-csv' : 'fa-file';
    var warns = (d.warnings || []).map(function (w) { return '<div class="pb-warn"><i class="fas fa-circle-exclamation"></i> ' + esc(w) + '</div>'; }).join('');
    var analysisHTML = '';
    if (state.analysisLoading) {
      analysisHTML = '<div class="pb-analysis-card"><div class="pb-loading"><div class="pb-spinner"></div>AI is analyzing your document\u2026</div></div>';
    } else if (state.analysisError) {
      analysisHTML = '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.analysisError) +
        ' <button class="pb-link" id="pb-retry-analysis" type="button">Try again</button></div>';
    } else if (state.analysis) {
      var a = state.analysis;
      var chips = (a.suggestedActions || []).map(function (s, i) {
        return '<button class="pb-chip" data-pb-suggest="' + i + '" type="button">' + esc(s) + '</button>';
      }).join('');
      var keyPills = (a.keyColumns || []).map(function (c) { return '<span class="pb-pill">' + esc(c) + '</span>'; }).join('');
      var formulas = (a.detectedFormulas && a.detectedFormulas.length)
        ? '<ul class="pb-analysis-list">' + a.detectedFormulas.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>'
        : '<div style="color:var(--text-soft);font-size:0.82rem;">None detected.</div>';
      var notes = (a.dataQualityNotes && a.dataQualityNotes.length)
        ? '<ul class="pb-analysis-list">' + a.dataQualityNotes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>'
        : '<div style="color:var(--text-soft);font-size:0.82rem;">No issues detected.</div>';
      analysisHTML = '<div class="pb-analysis-card">\
        <div class="pb-analysis-title"><i class="fas fa-wand-magic-sparkles" style="color:var(--indigo);"></i> We analyzed your ' + esc(d.type) + '</div>\
        <p class="pb-analysis-summary">' + esc(a.documentType ? (a.documentType + ' \u2014 ' + a.summary) : a.summary) + '</p>\
        ' + (keyPills ? '<div class="pb-analysis-section"><p class="pb-analysis-label">Key columns</p><div class="pb-pill-row">' + keyPills + '</div></div>' : '') + '\
        ' + (chips ? '<div class="pb-analysis-section"><p class="pb-analysis-label">Suggested actions \u2014 click to prefill</p><div class="pb-chips">' + chips + '</div></div>' : '') + '\
        <div class="pb-analysis-section"><p class="pb-analysis-label">Detected formulas</p>' + formulas + '</div>\
        <div class="pb-analysis-section"><p class="pb-analysis-label">Data quality notes</p>' + notes + '</div>\
      </div>';
    }
    slot.innerHTML = '\
      <div class="pb-card">\
        <div class="pb-card-step">Document loaded</div>\
        <div class="pb-doc-head">\
          <div class="pb-doc-icon"><i class="fas ' + icon + '"></i></div>\
          <div style="flex:1;min-width:0;">\
            <div class="pb-doc-name">' + esc(d.name) + '</div>\
            <div class="pb-doc-meta">' + esc(d.type.toUpperCase()) + (d.fileSize ? ' \u00b7 ' + fmtBytes(d.fileSize) : '') + ' \u00b7 ' + d.rowCount + ' rows \u00d7 ' + d.columnCount + ' cols</div>\
          </div>\
          <button class="pb-link" id="pb-replace-doc" type="button">Replace document</button>\
        </div>\
        ' + warns + '\
        ' + analysisHTML + '\
      </div>';
  }

  function renderInstructionCard() {
    var slot = $('pb-instruction-slot');
    if (!slot) return;
    if (!state.document) { slot.innerHTML = ''; return; }
    var err = state.pipelineError
      ? '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.pipelineError) + '</div>'
      : '';
    var remaining = remainingGroqCalls();
    var rateNote = '<div class="pb-rate-note">' + remaining + ' / ' + MAX_GROQ_CALLS + ' AI calls remaining this session</div>';
    slot.innerHTML = '\
      <div class="pb-card">\
        <div class="pb-card-step">Step 2</div>\
        <h3 class="pb-card-title">Describe what you want to do</h3>\
        <p class="pb-card-sub">Plain English \u2014 the AI turns it into an executable pipeline.</p>\
        <textarea class="pb-textarea" id="pb-instruction" placeholder="e.g. Summarize total revenue by region and sort high to low"></textarea>\
        ' + err + '\
        <div class="pb-btn-row">\
          <button class="btn btn-primary pb-btn-sm" id="pb-generate" type="button"' + (state.pipelineLoading ? ' disabled' : '') + '>\
            <i class="fas fa-wand-magic-sparkles"></i><span class="btn-text">Generate pipeline</span>\
          </button>\
          ' + (state.pipelineLoading ? '<div class="pb-loading"><div class="pb-spinner"></div>AI is constructing your pipeline\u2026</div>' : '') + '\
        </div>\
        ' + rateNote + '\
      </div>';
    // Restore textarea value (typing doesn't trigger re-render, but generate does).
    var ta = $('pb-instruction');
    if (ta) {
      ta.value = state.instruction;
      ta.addEventListener('input', function () { state.instruction = ta.value; });
      // Ctrl/Cmd+Enter to generate.
      ta.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onGenerateClick(); }
      });
    }
  }

  function renderPipelineCard() {
    var slot = $('pb-pipeline-slot');
    if (!slot) return;
    if (!state.pipeline) { slot.innerHTML = ''; return; }
    var p = state.pipeline;
    var stepHTML = (p.steps || []).map(function (s, i) {
      var params = '';
      if (s.type === 'filter')     params = 'where ' + esc(s.column) + ' ' + esc(s.operator) + ' ' + esc(JSON.stringify(s.value));
      else if (s.type === 'summarize') params = 'group by [' + esc((s.groupBy || []).join(', ')) + '], ' + esc(s.aggregation) + '(' + esc(s.valueColumn || '') + ')';
      else if (s.type === 'sort')  params = 'by ' + esc(s.column) + ' ' + esc(s.order || 'asc');
      else if (s.type === 'limit')  params = 'first ' + esc(s.count) + ' rows';
      else if (s.type === 'select') params = 'columns [' + esc((s.columns || []).join(', ')) + ']';
      else if (s.type === 'transform') params = 'new column ' + esc(s.newColumn) + ' = ' + esc(s.expression);
      return '<li class="pb-step-item">\
        <div class="pb-step-num">' + (i + 1) + '</div>\
        <div class="pb-step-body">\
          <div class="pb-step-type">' + esc(s.type) + '</div>\
          <p class="pb-step-desc">' + esc(s.description || '') + '</p>\
          <div class="pb-step-params">' + params + '</div>\
        </div>\
      </li>';
    }).join('');
    var jsonHTML = state.showSpecJson
      ? '<pre class="pb-pre">' + esc(JSON.stringify(p, null, 2)) + '</pre>'
      : '';
    var outFmt = p.output && p.output.format ? p.output.format : 'html_table';
    slot.innerHTML = '\
      <div class="pb-card">\
        <div class="pb-card-step">Step 3</div>\
        <h3 class="pb-card-title">Review the pipeline</h3>\
        <p class="pb-card-sub">' + esc(p.description || p.name || '') + ' \u2014 output: <code>' + esc(outFmt) + '</code></p>\
        <ol class="pb-step-list">' + stepHTML + '</ol>\
        <div class="pb-btn-row">\
          <button class="btn btn-primary pb-btn-sm" id="pb-run" type="button">\
            <i class="fas fa-play"></i><span class="btn-text">Run pipeline</span>\
          </button>\
          <button class="pb-link" id="pb-edit-instruction" type="button">Edit instruction</button>\
          <div class="pb-spacer"></div>\
          <button class="pb-collapsible-toggle" id="pb-toggle-json" type="button">\
            <i class="fas ' + (state.showSpecJson ? 'fa-chevron-up' : 'fa-chevron-down') + '"></i>\
            ' + (state.showSpecJson ? 'Hide JSON' : 'Show JSON') + '\
          </button>\
        </div>\
        ' + jsonHTML + '\
      </div>';
  }

  function renderResultsCard() {
    var slot = $('pb-results-slot');
    if (!slot) return;
    if (!state.result && !state.resultError) { slot.innerHTML = ''; return; }
    var err = state.resultError
      ? '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.resultError) + '</div>'
      : '';
    var body = '';
    if (state.result) {
      var r = state.result;
      body = '\
        <p class="pb-result-summary">' + r.rows.length + ' rows \u00d7 ' + r.columns.length + ' columns</p>\
        ' + renderTableHTML(r.rows, r.columns, state.visibleRows) + '\
        <div class="pb-chart-card">\
          <p class="pb-chart-title"><i class="fas fa-chart-bar"></i> Auto-chart</p>\
          <div class="pb-chart-body"></div>\
        </div>\
        <div class="pb-download-row">\
          <button class="btn btn-ghost pb-btn-sm" data-pb-download="csv" type="button"><i class="fas fa-file-csv"></i> CSV</button>\
          <button class="btn btn-ghost pb-btn-sm" data-pb-download="excel" type="button"><i class="fas fa-file-excel"></i> Excel</button>\
          <button class="btn btn-ghost pb-btn-sm" data-pb-download="pdf" type="button"><i class="fas fa-file-pdf"></i> PDF</button>\
          <button class="btn btn-ghost pb-btn-sm" data-pb-download="json" type="button"><i class="fas fa-file-code"></i> JSON</button>\
          <div class="pb-spacer"></div>\
          <button class="btn btn-ghost pb-btn-sm" id="pb-save-pipeline" type="button"><i class="fas fa-bookmark"></i> Save pipeline</button>\
          <button class="btn btn-primary pb-btn-sm" id="pb-email-results" type="button"><i class="fas fa-envelope"></i> Email results</button>\
        </div>';
    }
    slot.innerHTML = '\
      <div class="pb-card">\
        <div class="pb-card-step">Step 4</div>\
        <h3 class="pb-card-title">Results</h3>\
        ' + err + '\
        ' + body + '\
      </div>';
    if (state.result) renderChart(slot);
  }

  function renderSavedPipelinesCard() {
    var slot = $('pb-saved-slot');
    if (!slot) return;
    var items = state.savedPipelines.length
      ? state.savedPipelines.map(function (p) {
          return '<li class="pb-saved-item">\
            <div class="pb-saved-info">\
              <div class="pb-saved-name">' + esc(p.name) + '</div>\
              <div class="pb-saved-meta">From: ' + esc(p.docSummary) + ' \u00b7 saved ' + esc(fmtDate(p.savedAt)) + '</div>\
            </div>\
            <div class="pb-saved-actions">\
              <button class="btn btn-ghost pb-btn-sm" data-pb-load="' + p.id + '" type="button">Load</button>\
              <button class="pb-collapsible-toggle" data-pb-export="' + p.id + '" type="button" title="Download spec JSON"><i class="fas fa-download"></i></button>\
              <button class="pb-collapsible-toggle" data-pb-delete="' + p.id + '" type="button" title="Delete"><i class="fas fa-trash"></i></button>\
            </div>\
          </li>';
        }).join('')
      : '<div class="pb-empty">No saved pipelines yet \u2014 generate one above and click <strong>Save pipeline</strong>.</div>';
    slot.innerHTML = '\
      <div class="pb-card">\
        <h3 class="pb-card-title">Your saved pipelines</h3>\
        <ul class="pb-saved-list">' + items + '</ul>\
        <div class="pb-btn-row" style="margin-top:14px;">\
          <button class="btn btn-ghost pb-btn-sm" id="pb-import-pipeline" type="button"><i class="fas fa-file-import"></i> Import pipeline</button>\
          <input type="file" id="pb-import-input" accept=".json" hidden />\
        </div>\
      </div>';
  }

  // ─── Top-level render ──────────────────────────────────────────────────────
  // Rebuilds the mount's slot skeleton, then calls each sub-renderer. Slot IDs
  // are stable so event delegation (bound once on the mount) keeps working.
  function render() {
    var mount = $(MOUNT_ID);
    if (!mount) return;
    mount.innerHTML = '\
      <div class="pb-app">\
        <div id="pb-upload-slot"></div>\
        <div id="pb-doc-slot"></div>\
        <div id="pb-instruction-slot"></div>\
        <div id="pb-pipeline-slot"></div>\
        <div id="pb-results-slot"></div>\
        <div id="pb-saved-slot"></div>\
      </div>';
    renderUploadCard();
    renderDocumentCard();
    renderInstructionCard();
    renderPipelineCard();
    renderResultsCard();
    renderSavedPipelinesCard();
  }

  // Partial re-render — only one slot. Avoids nuking the whole mount when only
  // one card changed (keeps textarea focus + chart instance stable).
  function renderSlot(name) {
    if (name === 'upload')    renderUploadCard();
    if (name === 'document')  renderDocumentCard();
    if (name === 'instruction') renderInstructionCard();
    if (name === 'pipeline')  renderPipelineCard();
    if (name === 'results')   renderResultsCard();
    if (name === 'saved')     renderSavedPipelinesCard();
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  function onFileChosen(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      state.analysisError = null;
      // Show error inline in the upload slot.
      var slot = $('pb-upload-slot');
      if (slot) {
        renderUploadCard();
        var card = slot.querySelector('.pb-card');
        if (card) card.insertAdjacentHTML('beforeend',
          '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> For demo performance, please use files under 5 MB.</div>');
      }
      return;
    }
    // Reset downstream state when a new document is loaded.
    state.document = null;
    state.analysis = null; state.analysisLoading = false; state.analysisError = null;
    state.pipeline = null; state.pipelineError = null; state.pipelineLoading = false;
    state.result = null; state.resultError = null;
    state.visibleRows = 25;
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
    render();
    // Show a "parsing..." placeholder in the document slot.
    var slot = $('pb-doc-slot');
    if (slot) slot.innerHTML = '<div class="pb-card"><div class="pb-loading"><div class="pb-spinner"></div>Parsing your file\u2026</div></div>';
    parseFile(file).then(function (doc) {
      state.document = doc;
      renderSlot('upload');    // clears upload slot
      renderSlot('document');  // shows doc card
      renderSlot('instruction'); // shows instruction card
      // Kick off auto-analysis.
      state.analysisLoading = true;
      renderSlot('document');
      if (doc.rows.length || doc.rawText) {
        analyzeDocument(doc).then(function (analysis) {
          state.analysis = analysis;
          state.analysisLoading = false;
          renderSlot('document');
        }).catch(function (e) {
          state.analysisLoading = false;
          state.analysisError = e.message || 'Analysis failed.';
          renderSlot('document');
        });
      } else {
        state.analysisLoading = false;
        state.analysisError = 'Nothing to analyze — the document has no rows and no extractable text.';
        renderSlot('document');
      }
    }).catch(function (e) {
      // Parse failed — restore upload card with the error inline.
      state.document = null;
      renderSlot('upload');
      renderSlot('document');
      renderSlot('instruction');
      var us = $('pb-upload-slot');
      if (us) {
        var c = us.querySelector('.pb-card');
        if (c) c.insertAdjacentHTML('beforeend',
          '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(e.message || 'Couldn\u2019t parse this file.') + '</div>');
      }
    });
  }

  function onSampleClick(key) {
    var tpl = SAMPLE_TEMPLATES.filter(function (t) { return t.key === key; })[0];
    if (!tpl) return;
    // Show loading state immediately (especially for the PDF sample which
    // needs fetch + pdf.js parse — takes ~500ms on first load).
    state.document = null;
    state.analysis = null; state.analysisLoading = false; state.analysisError = null;
    state.pipeline = null; state.pipelineError = null; state.pipelineLoading = false;
    state.result = null; state.resultError = null;
    state.visibleRows = 25;
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
    state.sampleLoading = true;
    state.sampleLoadingError = null;
    render();
    loadSample(tpl).then(function (doc) {
      state.sampleLoading = false;
      state.document = doc;
      render();
      // Auto-analyze the document (same as onFileUploaded).
      state.analysisLoading = true;
      renderSlot('document');
      return analyzeDocument(doc);
    }).then(function (analysis) {
      state.analysis = analysis; state.analysisLoading = false;
      renderSlot('document');
    }).catch(function (e) {
      state.sampleLoading = false;
      state.analysisLoading = false;
      state.sampleLoadingError = e.message || 'Couldn\u2019t load the sample.';
      render();
    });
  }

  function onGenerateClick() {
    if (!state.document) return;
    var instruction = (state.instruction || '').trim();
    if (!instruction) return;
    if (!canCallGroq()) {
      state.pipelineError = 'Demo rate limit reached — ' + MAX_GROQ_CALLS + ' AI calls this session. Refresh the page to try again.';
      renderSlot('instruction');
      return;
    }
    state.pipelineLoading = true; state.pipelineError = null; state.pipeline = null;
    state.result = null; state.resultError = null;
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
    renderSlot('instruction'); renderSlot('pipeline'); renderSlot('results');
    generatePipelineSpec(state.document, instruction).then(function (spec) {
      state.pipeline = spec; state.pipelineLoading = false;
      renderSlot('instruction'); renderSlot('pipeline');
    }).catch(function (e) {
      state.pipelineLoading = false;
      state.pipelineError = e.message || 'Failed to generate the pipeline.';
      renderSlot('instruction');
    });
  }

  function onRunClick() {
    if (!state.document || !state.pipeline) return;
    try {
      var res = executePipeline(state.document, state.pipeline);
      state.result = res; state.resultError = null;
      state.visibleRows = 25;
      renderSlot('results');
    } catch (e) {
      state.result = null; state.resultError = e.message || 'Pipeline execution failed.';
      renderSlot('results');
    }
  }

  function onDownloadClick(kind) {
    if (!state.result) return;
    var rows = state.result.rows, cols = state.result.columns;
    if (kind === 'csv')   downloadCSV(rows, cols);
    else if (kind === 'excel') downloadExcel(rows, cols).catch(function () { alertSafe('Excel export failed — the library may not have loaded.'); });
    else if (kind === 'pdf')   downloadPDF(rows, cols, 'pipeline-result.pdf', state.pipeline ? state.pipeline.name : 'Pipeline Result').catch(function () { alertSafe('PDF export failed — the library may not have loaded.'); });
    else if (kind === 'json') downloadJSON(state.pipeline, 'pipeline-spec.json');
  }

  function alertSafe(msg) {
    // Inline notice — no alert(). Reuses the saved-pipelines card as a fallback surface.
    var slot = $('pb-results-slot');
    if (slot) {
      var card = slot.querySelector('.pb-card');
      if (card) card.insertAdjacentHTML('beforeend', '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(msg) + '</div>');
    }
  }

  function onSaveClick() {
    if (!state.pipeline) return;
    openModal('Save pipeline', '\
      <label class="pb-analysis-label" for="pb-save-name">Pipeline name</label>\
      <input class="pb-input" id="pb-save-name" type="text" value="' + esc(state.pipeline.name || '') + '" placeholder="e.g. Q3 revenue by region" />',
      [
        { label: 'Cancel' , action: function () { closeModal(); } },
        { label: 'Save'   , primary: true, action: function () {
          var name = ($('pb-save-name') || {}).value || state.pipeline.name || 'Untitled pipeline';
          savePipeline(name);
          closeModal();
          renderSlot('saved');
          // Flash a confirmation.
          var slot = $('pb-results-slot');
          if (slot) {
            var card = slot.querySelector('.pb-card');
            if (card) card.insertAdjacentHTML('beforeend',
              '<div class="pb-warn"><i class="fas fa-check"></i> Pipeline saved to your browser storage.</div>');
          }
        } }
      ]);
    setTimeout(function () { var i = $('pb-save-name'); if (i) { i.focus(); i.select(); } }, 50);
  }

  function onEmailClick() {
    if (!state.result || !state.pipeline) return;
    openEmailPreview(state.pipeline, state.result.rows, state.result.columns);
  }

  function onLoadSaved(id) {
    var p = state.savedPipelines.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    state.pipeline = p.spec;
    state.showSpecJson = false;
    state.result = null; state.resultError = null;
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
    state.instruction = p.spec.description || p.spec.name || '';
    renderSlot('instruction'); renderSlot('pipeline'); renderSlot('results');
    // Scroll the pipeline card into view.
    var slot = $('pb-pipeline-slot');
    if (slot && slot.scrollIntoView) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onDeleteSaved(id) {
    deletePipeline(id);
    renderSlot('saved');
  }

  function onExportSaved(id) {
    var p = state.savedPipelines.filter(function (x) { return x.id === id; })[0];
    if (p) downloadJSON(p.spec, p.name.replace(/[^a-z0-9-_]+/gi, '_') + '.json');
  }

  function onImportClick() {
    var input = $('pb-import-input');
    if (input) input.click();
  }

  function onImportFile(file) {
    importPipelineSpec(file).then(function (spec) {
      // Add as a saved pipeline (name from spec).
      var entry = {
        id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        name: spec.name || 'Imported pipeline',
        spec: spec,
        docSummary: '(imported \u2014 no document)',
        savedAt: Date.now()
      };
      state.savedPipelines.unshift(entry);
      persistSavedPipelines();
      renderSlot('saved');
    }).catch(function (e) {
      var slot = $('pb-saved-slot');
      if (slot) {
        var card = slot.querySelector('.pb-card');
        if (card) card.insertAdjacentHTML('beforeend', '<div class="pb-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(e.message) + '</div>');
      }
    });
  }

  // ─── Event delegation (bound once on the mount) ──────────────────────────────
  function wireEvents() {
    var mount = $(MOUNT_ID);
    if (!mount) return;
    if (mount._pbWired) return;
    mount._pbWired = true;

    // Click delegation for everything inside the mount.
    mount.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      // Drop zone click → open file picker.
      if (t.closest('#pb-drop')) { var fi = $('pb-file-input'); if (fi) fi.click(); return; }
      // Sample button.
      var sample = t.closest('[data-pb-sample]');
      if (sample) { onSampleClick(sample.getAttribute('data-pb-sample')); return; }
      // Suggested action chip.
      var chip = t.closest('[data-pb-suggest]');
      if (chip && state.analysis) {
        var idx = parseInt(chip.getAttribute('data-pb-suggest'), 10);
        state.instruction = state.analysis.suggestedActions[idx] || '';
        var ta = $('pb-instruction'); if (ta) { ta.value = state.instruction; ta.focus(); }
        return;
      }
      // Generate / run / edit / replace / retry.
      if (t.closest('#pb-generate'))      { onGenerateClick(); return; }
      if (t.closest('#pb-run'))           { onRunClick(); return; }
      if (t.closest('#pb-edit-instruction')) { var ta = $('pb-instruction'); if (ta) { ta.focus(); } var is = $('pb-instruction-slot'); if (is && is.scrollIntoView) is.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (t.closest('#pb-replace-doc'))  { resetDocument(); return; }
      if (t.closest('#pb-retry-analysis')) { retryAnalysis(); return; }
      if (t.closest('#pb-retry-sample'))  { state.sampleLoadingError = null; renderSlot('upload'); return; }
      if (t.closest('#pb-toggle-json'))   { state.showSpecJson = !state.showSpecJson; renderSlot('pipeline'); return; }
      // Load more rows in the results table.
      if (t.closest('#pb-load-more'))    { state.visibleRows += 25; renderSlot('results'); return; }
      // Downloads.
      var dl = t.closest('[data-pb-download]');
      if (dl) { onDownloadClick(dl.getAttribute('data-pb-download')); return; }
      // Save / email.
      if (t.closest('#pb-save-pipeline')) { onSaveClick(); return; }
      if (t.closest('#pb-email-results')) { onEmailClick(); return; }
      // Saved pipeline actions.
      var load = t.closest('[data-pb-load]');
      if (load) { onLoadSaved(load.getAttribute('data-pb-load')); return; }
      var del = t.closest('[data-pb-delete]');
      if (del)  { onDeleteSaved(del.getAttribute('data-pb-delete')); return; }
      var exp = t.closest('[data-pb-export]');
      if (exp) { onExportSaved(exp.getAttribute('data-pb-export')); return; }
      if (t.closest('#pb-import-pipeline')) { onImportClick(); return; }
    });

    // File input change.
    mount.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'pb-file-input' && e.target.files && e.target.files[0]) {
        onFileChosen(e.target.files[0]);
        e.target.value = ''; // allow re-uploading the same file
        return;
      }
      if (e.target && e.target.id === 'pb-import-input' && e.target.files && e.target.files[0]) {
        onImportFile(e.target.files[0]);
        e.target.value = '';
        return;
      }
    });

    // Drag-and-drop on the drop zone.
    mount.addEventListener('dragover', function (e) {
      var drop = $('pb-drop'); if (!drop) return;
      e.preventDefault(); drop.classList.add('pb-dragover');
    });
    mount.addEventListener('dragleave', function (e) {
      var drop = $('pb-drop'); if (!drop) return;
      if (e.target === drop || !drop.contains(e.relatedTarget)) drop.classList.remove('pb-dragover');
    });
    mount.addEventListener('drop', function (e) {
      var drop = $('pb-drop'); if (!drop) return;
      e.preventDefault(); drop.classList.remove('pb-dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        onFileChosen(e.dataTransfer.files[0]);
      }
    });

    // Keyboard accessibility on the drop zone.
    mount.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.id === 'pb-drop') {
        e.preventDefault(); var fi = $('pb-file-input'); if (fi) fi.click();
      }
    });
  }

  function resetDocument() {
    state.document = null;
    state.analysis = null; state.analysisLoading = false; state.analysisError = null;
    state.pipeline = null; state.pipelineError = null; state.pipelineLoading = false;
    state.result = null; state.resultError = null;
    state.instruction = '';
    state.visibleRows = 25;
    if (state.chart) { try { state.chart.dispose(); } catch (e) {} state.chart = null; }
    render();
  }

  function retryAnalysis() {
    if (!state.document) return;
    state.analysisLoading = true; state.analysisError = null;
    renderSlot('document');
    analyzeDocument(state.document).then(function (a) {
      state.analysis = a; state.analysisLoading = false;
      renderSlot('document');
    }).catch(function (e) {
      state.analysisLoading = false; state.analysisError = e.message || 'Analysis failed.';
      renderSlot('document');
    });
  }

  // ─── Theme change watcher ────────────────────────────────────────────────────
  // Mirror the markets-dashboard pattern: re-render the chart (only) when the
  // site theme toggles. We don't re-render the whole mount — that would lose
  // scroll position + textarea focus unnecessarily.
  function watchThemeChanges() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-theme') {
          if (state.chart && state.result) renderChart($(MOUNT_ID) || document);
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // Also watch the mount's own data-pb-theme override.
    var mount = $(MOUNT_ID);
    if (mount) {
      var obs2 = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          if (m.attributeName === 'data-pb-theme' && state.chart && state.result) {
            renderChart(mount);
          }
        });
      });
      obs2.observe(mount, { attributes: true, attributeFilter: ['data-pb-theme'] });
    }
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────────────
  function boot() {
    var mount = $(MOUNT_ID);
    if (!mount) {
      // Mount not in the DOM yet — retry shortly.
      if (boot._retries < 40) { boot._retries++; setTimeout(boot, 100); }
      return;
    }
    boot._retries = 0;
    injectCSS();
    loadSavedPipelines();
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
