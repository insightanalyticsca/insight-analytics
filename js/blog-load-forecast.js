/* ════════════════════════════════════════════════════════════════════════════
   blog-load-forecast.js — Weather-Driven Electricity Load Forecasting & Operational Planning
   (marketing demo, embedded in a blog post for Insight Analytics)

   Mounts INTO <div id="load-forecast-mount"></div> when the DOM is ready.
   Pure vanilla JS, no framework. Everything wrapped in an IIFE — no globals
   leaked to window.

   Flow
   ----
     1. Detect the user's REAL location via navigator.geolocation (fallback to
        Toronto if denied or timed out). Reverse-geocode via Open-Meteo's
        geocoding API to show "Toronto, ON".
     2. Fetch 365 days of REAL historical hourly weather from Open-Meteo's
        Archive API + 14 days of REAL hourly forecast from Open-Meteo's
        Forecast API. No API key required; CORS-enabled; generous limits.
     3. Generate REALISTIC synthetic electricity load (MW) FROM the real
        weather + timestamps using utility-grade load patterns (diurnal,
        weekend reduction, heating/cooling degree change-point at 18°C,
        humidity, wind, solar, precipitation, seasonal baseline, Gaussian
        noise σ=0.3 GW). Realistic Ontario-like coefficients: 13 GW trough,
        19 GW peak. The synthetic load is the "ground truth" — the model
        DISCOVERS the coefficients from data, not from assumptions.
     4. Engineer 20 features (calendar cyclicals, weather vars, heating /
        cooling degrees, lag_1h, lag_24h) and train an OLS regression model
        with change-point detection (sweep 10°C → 25°C in 0.5°C steps, pick
        the breakpoint that minimizes RMSE). All matrix ops from scratch —
        no math library.
     5. Display model accuracy (R², adj R², RMSE, MAE, MAPE), coefficient
        table with std errors + t-stats + p-values + standardized betas,
        variable importance bar chart, temperature response curve (V-shape
        with detected change-point + heating/cooling slopes), actual-vs-
        predicted time series with 80% + 95% prediction interval bands,
        residual histogram.
     6. Apply the trained model to the 14-day forecast → recursive predicted
        hourly load + prediction intervals → daily peak / avg → operational
        recommendations (Normal / Elevated / High / Critical) using
        configurable P90 / P95 / P99 thresholds derived from historical
        daily peaks.
     7. AI layer (Groq via Netlify proxy): answer free-text questions like
        "Why is load expected to increase on Thursday?" using the model's
        LEARNED coefficients (not assumptions), and generate daily operational
        briefings (Expected Load → Main Drivers → Risk Level →
        Recommended Action).
     8. Export card: CSV (historical actual vs predicted + 14-day forecast),
        Excel (multi-sheet via SheetJS), JSON (full results), email (mailto:
        with HTML preview modal).

   Anti-footguns
   -------------
     • Geolocation timeout: 10 seconds, fallback to Toronto.
     • Open-Meteo fetch timeout: 15 seconds; failure surfaces a clear retry.
     • Groq rate limit: 10 calls per session (localStorage + sessionStorage).
     • No eval() / new Function() — every numeric expression is hand-coded.
     • No alert/confirm/prompt — modals only.
     • All user + AI text HTML-escaped before insertion.
     • Matrix inverse: Gaussian elimination with partial pivoting; throws a
       friendly "singular matrix" error if the determinant is near zero
       (collinear features) — the demo recommends dropping features.
     • Charts: dispose + re-init on theme toggle. ResizeObserver on the
       mount + IntersectionObserver for lazy chart init when cards scroll
       into view.
   ════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  var MOUNT_ID           = 'load-forecast-mount';
  var GROQ_PROXY         = 'https://startling-belekoy-b0ec70.netlify.app/groq-proxy';
  var GROQ_MODEL         = 'qwen/qwen3.8-27b';
  var RATE_KEY           = 'loadForecast.rate';
  var SESSION_KEY        = 'loadForecast.sessionId';
  var MAX_GROQ_CALLS     = 10;
  var GEO_TIMEOUT_MS     = 10000;
  var WEATHER_TIMEOUT_MS = 15000;
  var GROQ_TIMEOUT_MS   = 30000;
  var FALLBACK_LOCATION  = { lat: 43.6532, lon: -79.3832, label: 'Toronto, ON' };
  var BALANCE_POINT_INIT = 18.0;          // starting guess for change-point sweep

  // Open-Meteo endpoints (free, no API key, CORS-enabled, generous non-commercial limits).
  var OPEN_METEO_ARCHIVE  = 'https://archive-api.open-meteo.com/v1/archive';
  var OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var OPEN_METEO_GEOCODE  = 'https://geocoding-api.open-meteo.com/v1/search';

  // Hourly variables requested from both APIs.
  var HOURLY_VARS = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,shortwave_radiation,surface_pressure,weather_code';

  // CDN libraries — loaded lazily and cached in libCache so each loads at
  // most once per page lifetime. Loading is triggered only when the user
  // actually needs them (first chart render / first Excel export).
  var LIB_URLS = {
    echarts: 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
    xlsx:    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
  };
  var libCache = {};

  // ─── Module-scope state ────────────────────────────────────────────────────
  // Single source of truth. render() re-paints the whole mount from this;
  // each sub-renderer no-ops when its slice of state is absent.
  var state = {
    // Step 1 — location + weather
    location:           null,   // { lat, lon, label, source: 'geolocation'|'fallback' }
    locationLoading:    false,
    locationError:      null,
    manualLat:          '',
    manualLon:          '',

    weatherHistory:     null,   // Open-Meteo archive hourly payload (object with time[] + variable[] arrays)
    weatherForecast:    null,   // Open-Meteo forecast hourly payload
    weatherLoading:     false,
    weatherError:       null,

    loadData:           null,   // { timestamps:[Date], load:[MW], weather:{} }

    // Step 2 — model
    model:              null,   // see trainModel() for shape
    modelLoading:       false,
    modelError:          null,
    avpWindow:           30,    // days shown in actual-vs-predicted chart (7 | 30 | 365)

    // Step 3 — forecast + recommendations
    forecast:            null,  // { hourly:{...}, daily:[...] }
    thresholds:          { p90: null, p95: null, p99: null, custom: { p90: null, p95: null, p99: null } },

    // Step 4 — AI Q&A
    aiQuestion:         '',
    aiResult:           null,
    aiLoading:           false,
    aiError:             null,

    // Step 5 — daily briefings
    briefings:          null,   // array of { day, expectedLoad, mainDrivers, riskLevel, recommendation, aiNarration }
    briefingsLoading:    false,
    briefingsError:      null,

    // Chart instances keyed by element id (for dispose + re-init)
    charts:             {},
    resizeObserver:      null
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
  function fmtNum(n, dp) {
    if (n === null || n === undefined || n === '') return '';
    var x = Number(n);
    if (isNaN(x)) return String(n);
    return x.toLocaleString('en-US', {
      minimumFractionDigits: dp == null ? 2 : dp,
      maximumFractionDigits: dp == null ? 2 : dp
    });
  }
  function fmtMW(n) {
    // Megawatts with thousand separators + 0 decimals + ' MW' suffix.
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-US') + ' MW';
  }
  function fmtMW1(n) { return (n == null || isNaN(n)) ? '—' : n.toFixed(1) + ' GW'; }
  function fmtPct(n, dp) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toFixed(dp == null ? 1 : dp) + '%';
  }
  function fmtDate(d) {
    try { return new Date(d).toLocaleDateString('en-CA'); } catch (e) { return ''; }
  }
  function fmtDateShort(d) {
    try {
      var dt = new Date(d);
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }
  function fmtTime(d) {
    try {
      return new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) { return ''; }
  }
  function isoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  // ─── Lazy CDN script loader ────────────────────────────────────────────────
  // Injects a <script src> tag and resolves when it loads. Caches by lib key
  // so a second request returns the same promise (no duplicate tags).
  function loadScript(libKey) {
    if (libCache[libKey]) return libCache[libKey];
    var url = LIB_URLS[libKey];
    if (!url) return Promise.reject(new Error('Unknown library: ' + libKey));
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + libKey + ' from ' + url)); };
      document.head.appendChild(s);
    });
    libCache[libKey] = p;
    return p;
  }

  // ─── Groq rate limiter ──────────────────────────────────────────────────────
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

  // ─── Groq API helper ────────────────────────────────────────────────────────
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
        if (!r.ok) throw new Error('AI service returned ' + r.status + '. Please try again.');
        return r.json();
      })
      .then(function (data) {
        bumpGroqCount();
        if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error('AI returned an unexpected response. Try rephrasing your question.');
        }
        return data.choices[0].message.content || '';
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          throw new Error('The AI service took too long to respond. Please try again.');
        }
        if (e.message && (e.message.indexOf('AI service') === 0 || e.message.indexOf('Demo rate limit') === 0)) throw e;
        if (e.name === 'TypeError' || (e.message && e.message.indexOf('Failed to fetch') >= 0)) {
          throw new Error('Couldn\u2019t reach the AI service (CORS or network error). ' +
            'The Groq proxy may be cold-starting — please try again in a few seconds.');
        }
        throw new Error('Couldn\u2019t reach the AI service. Please try again.');
      });
  }

  // ─── Geolocation ────────────────────────────────────────────────────────────
  // Promise-based wrapper around navigator.geolocation.getCurrentPosition.
  // Always resolves (never rejects) — falls back to Toronto on any error,
  // timeout, or unsupported browser.
  function detectLocation() {
    if (!navigator || !navigator.geolocation) {
      return Promise.resolve(fallbackLocation('Geolocation not supported by this browser.'));
    }
    return new Promise(function (resolve) {
      var resolved = false;
      function finish(loc) { if (!resolved) { resolved = true; resolve(loc); } }
      // Hard timeout fallback — the spec API can hang silently in some browsers.
      var timer = setTimeout(function () {
        finish(fallbackLocation('Location request timed out — using Toronto as default.'));
      }, GEO_TIMEOUT_MS);
      try {
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            clearTimeout(timer);
            var lat = pos.coords && pos.coords.latitude != null ? pos.coords.latitude : FALLBACK_LOCATION.lat;
            var lon = pos.coords && pos.coords.longitude != null ? pos.coords.longitude : FALLBACK_LOCATION.lon;
            reverseGeocode(lat, lon).then(function (label) {
              finish({
                lat: lat, lon: lon,
                label: label || (lat.toFixed(4) + '\u00b0, ' + lon.toFixed(4) + '\u00b0'),
                source: 'geolocation'
              });
            }).catch(function () {
              finish({ lat: lat, lon: lon, label: lat.toFixed(4) + '\u00b0, ' + lon.toFixed(4) + '\u00b0', source: 'geolocation' });
            });
          },
          function () {
            clearTimeout(timer);
            finish(fallbackLocation('Location permission denied — using Toronto as default.'));
          },
          { timeout: GEO_TIMEOUT_MS, maximumAge: 600000, enableHighAccuracy: false }
        );
      } catch (e) {
        clearTimeout(timer);
        finish(fallbackLocation('Location detection failed — using Toronto as default.'));
      }
    });
  }
  function fallbackLocation(reason) {
    return {
      lat: FALLBACK_LOCATION.lat, lon: FALLBACK_LOCATION.lon,
      label: FALLBACK_LOCATION.label, source: 'fallback', reason: reason
    };
  }
  function reverseGeocode(lat, lon) {
    // Open-Meteo geocoding API — returns nearest city name. If it fails, the
    // caller shows lat/long instead. The reverse-geocode endpoint isn't
    // officially documented but works in practice and is rate-limit-tolerant.
    var url = OPEN_METEO_GEOCODE + '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&count=1&language=en&format=json';
    return fetchWithTimeout(url, 8000)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.results && data.results.length) {
          var r = data.results[0];
          var parts = [];
          if (r.name) parts.push(r.name);
          if (r.admin1 && r.admin1 !== r.name) parts.push(r.admin1);
          return parts.join(', ');
        }
        return null;
      })
      .catch(function () { return null; });
  }

  // ─── Fetch with timeout helper ──────────────────────────────────────────────
  function fetchWithTimeout(url, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || WEATHER_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal, cache: 'no-cache' })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' from Open-Meteo');
        return r;
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error('Request timed out after ' + ((timeoutMs || WEATHER_TIMEOUT_MS) / 1000) + 's. Please retry.');
        throw e;
      });
  }

  // ─── Open-Meteo fetch helpers ──────────────────────────────────────────────
  function fetchHistoricalWeather(lat, lon) {
    var end = new Date();
    end.setDate(end.getDate() - 1); // yesterday (Open-Meteo archive is ~1 day delayed)
    var start = new Date(end.getTime() - 364 * 86400000); // 365 days inclusive
    var url = OPEN_METEO_ARCHIVE +
      '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&start_date=' + isoDate(start) + '&end_date=' + isoDate(end) +
      '&hourly=' + HOURLY_VARS + '&timezone=auto';
    return fetchWithTimeout(url, WEATHER_TIMEOUT_MS)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.hourly || !data.hourly.time || !data.hourly.time.length) {
          throw new Error('Open-Meteo Archive returned no hourly data for this location.');
        }
        return data.hourly;
      });
  }
  function fetchForecastWeather(lat, lon) {
    var url = OPEN_METEO_FORECAST +
      '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&hourly=' + HOURLY_VARS + '&forecast_days=14&timezone=auto';
    return fetchWithTimeout(url, WEATHER_TIMEOUT_MS)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.hourly || !data.hourly.time || !data.hourly.time.length) {
          throw new Error('Open-Meteo Forecast returned no hourly data for this location.');
        }
        return data.hourly;
      });
  }

  // ─── Synthetic load generator ────────────────────────────────────────────────
  // Builds hourly load (MW) FROM the real weather + timestamps using realistic
  // utility coefficients for a mid-size grid (Ontario-like, 13 GW trough /
  // 19 GW peak). The "ground truth" coefficients below are intentionally
  // realistic so the model can DISCOVER them from data — they are NOT used
  // by the regression (which is the whole point of the demo).
  //
  // The generator is deterministic given (location, weather) — the seed
  // derives from lat/lon so re-renders reproduce the same noise pattern.
  // This means the demo is reproducible: a user who reloads the page sees
  // the same synthetic load for the same location, so the "discovered"
  // coefficients are stable across reloads.
  //
  // Ground-truth coefficients (for reference only — NOT shown to the user):
  //   heating_slope    = 0.5 GW per °C below 18°C balance point
  //   cooling_slope    = 0.8 GW per °C above 18°C balance point
  //   humidity_effect  = 0.05 GW per % above 60% RH (AC works harder in humid heat)
  //   wind_effect      = -0.02 GW per m/s (slight cooling reduces heating load)
  //   solar_effect     = -0.01 GW per W/m² (PV self-generation reduces net load)
  //   precip_effect    = +0.01 GW per mm (minimal direct, mostly indirect via solar)
  //   weekend_mult     = 0.85 (less industrial/commercial demand)
  //   seasonal_ampl    = 2.0 GW (winter base higher than shoulder seasons)
  //   noise_sigma      = 0.3 GW (~1.5-2% of typical load — Gaussian)
  //
  // The model will discover close approximations to these from data:
  //   - The change-point sweep should land near 18°C.
  //   - The cooling slope should be ~0.8 GW/°C (above the balance point).
  //   - The heating slope should be ~0.5 GW/°C (below the balance point).
  //   - Humidity_excess coefficient should be ~0.05 GW per % above 60%.
  //   - The weekend indicator coefficient should be ~-2 GW (15% of ~14 GW base).
  //   - Hour-of-day cyclicals should capture the diurnal shape.
  //   - Lag_24h should have a strong positive coefficient (~0.4-0.6) because
  //     load is highly autocorrelated.
  //   - R² should be ~0.90-0.95 because the synthetic data has structured
  //     noise (σ=0.3 GW) on top of strong deterministic drivers.
  function generateLoad(weather, timestamps, seedSalt) {
    var n = timestamps.length;
    var load = new Array(n);
    // Seedable RNG (mulberry32) — keeps the synthetic load reproducible per
    // location so re-renders don't reshuffle the noise pattern.
    var seed = (0x12345 + (seedSalt | 0)) | 0;
    var rng = mulberry32(seed);
    for (var i = 0; i < n; i++) {
      var dt = new Date(timestamps[i]);
      var hour = dt.getHours();
      var dow = dt.getDay();
      var month = dt.getMonth() + 1;
      var temp = num(weather.temperature_2m, i);
      var humid = num(weather.relative_humidity_2m, i);
      var wind = num(weather.wind_speed_10m, i);
      var solar = num(weather.shortwave_radiation, i);
      var precip = num(weather.precipitation, i);

      // 1. Smooth diurnal base — sinusoidal. Peak at hour=18 (~19 GW),
      //    trough at hour=6 (~13 GW), centered on mean 16 GW, amplitude 3.
      var base = 16.0 + 3.0 * Math.cos(2 * Math.PI * (hour - 18) / 24);

      // 2. Weekend reduction (Saturday=6, Sunday=0) — ~15% lower (less
      //    industrial/commercial demand).
      if (dow === 0 || dow === 6) base *= 0.85;

      // 3. Seasonal baseline — winter base ~2 GW higher than summer base.
      //    month=1 (Jan): cos(0) = 1 → +2.0
      //    month=7 (Jul): cos(PI) = -1 → -2.0
      base += 2.0 * Math.cos(2 * Math.PI * (month - 1) / 12);

      // 4. Temperature response (heating + cooling degrees at 18°C balance).
      //    This is THE KEY DRIVER — the model will discover both slopes.
      var BP = 18.0;
      var heatingDeg = Math.max(0, BP - temp);
      var coolingDeg = Math.max(0, temp - BP);
      var tempLoad = 0.5 * heatingDeg + 0.8 * coolingDeg;

      // 5. Humidity — AC works harder in humid heat above 60% RH.
      var humidExcess = Math.max(0, humid - 60);
      var humidLoad = 0.05 * humidExcess;

      // 6. Wind — slight cooling reduces heating load in winter.
      var windLoad = -0.02 * wind;

      // 7. Solar — PV self-generation reduces net load during daytime.
      var solarLoad = -0.01 * solar;

      // 8. Precipitation — minimal direct effect (mostly indirect via solar).
      var precipLoad = 0.01 * precip;

      // 9. Noise — Gaussian via Box-Muller, σ = 0.3 GW. This is the
      //    "unexplained" variance the model won't capture (industrial
      //    process fluctuations, demand-response events, data noise, etc.).
      var noise = gaussian(rng) * 0.3;

      var total = base + tempLoad + humidLoad + windLoad + solarLoad + precipLoad + noise;
      if (total < 8) total = 8 + Math.abs(noise); // sanity floor

      load[i] = total;
    }
    return load;
  }
  // Safe indexed lookup on a possibly-sparse weather array.
  function num(arr, i) {
    var v = arr && arr[i];
    return typeof v === 'number' ? v : 0;
  }
  // Seedable PRNG (mulberry32) — small, fast, sufficient for demo noise.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Standard-normal sample via Box-Muller transform.
  function gaussian(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // ─── Feature engineering ────────────────────────────────────────────────────
  // Builds the design matrix X (n × p) from real weather + timestamps + lag
  // features. Each row corresponds to one hour. Columns:
  //   0  intercept (constant 1)
  //   1  hour_sin, hour_cos             — cyclical hour-of-day
  //   3  dow_sin, dow_cos               — cyclical day-of-week
  //   5  month_sin, month_cos           — cyclical month
  //   7  is_weekend                     — binary (Sat or Sun)
  //   8  temperature                     — °C
  //   9  temperature_sq                  — for nonlinearity
  //  10  heating_degree                  — max(0, BP - temp)
  //  11  cooling_degree                  — max(0, temp - BP)
  //  12  humidity                        — %
  //  13  humidity_excess                 — max(0, humidity - 60)
  //  14  wind_speed                      — m/s
  //  15  solar_radiation                 — W/m²
  //  16  precipitation                   — mm
  //  17  pressure                        — hPa
  //  18  lag_1h                          — load from 1 hour ago
  //  19  lag_24h                         — load from 24 hours ago
  //
  // The change-point BP is a parameter (detected by detectChangePoint) so the
  // feature builder can be re-invoked at each candidate BP during the sweep.
  function FEATURE_NAMES() {
    return [
      'intercept', 'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos', 'month_sin', 'month_cos',
      'is_weekend', 'temperature', 'temperature_sq', 'heating_degree', 'cooling_degree',
      'humidity', 'humidity_excess', 'wind_speed', 'solar_radiation', 'precipitation', 'pressure',
      'lag_1h', 'lag_24h'
    ];
  }
  function buildDesignMatrix(weather, timestamps, load, balancePoint) {
    var n = timestamps.length;
    var X = new Array(n);
    for (var i = 0; i < n; i++) {
      var dt = new Date(timestamps[i]);
      var hour = dt.getHours();
      var dow = dt.getDay();
      var month = dt.getMonth() + 1;
      var temp = num(weather.temperature_2m, i);
      var humid = num(weather.relative_humidity_2m, i);
      var wind = num(weather.wind_speed_10m, i);
      var solar = num(weather.shortwave_radiation, i);
      var precip = num(weather.precipitation, i);
      var pressure = num(weather.surface_pressure, i);
      var heatingDeg = Math.max(0, balancePoint - temp);
      var coolingDeg = Math.max(0, temp - balancePoint);
      // Lag features — for the first hour, fall back to the current load so
      // the matrix doesn't have NaNs. The intercept absorbs the offset.
      var lag1h  = i >= 1  ? load[i - 1]  : load[i];
      var lag24h = i >= 24 ? load[i - 24] : (i > 0 ? load[i - 1] : load[i]);
      X[i] = [
        1.0,
        Math.sin(2 * Math.PI * hour / 24),
        Math.cos(2 * Math.PI * hour / 24),
        Math.sin(2 * Math.PI * dow / 7),
        Math.cos(2 * Math.PI * dow / 7),
        Math.sin(2 * Math.PI * (month - 1) / 12),
        Math.cos(2 * Math.PI * (month - 1) / 12),
        (dow === 0 || dow === 6) ? 1 : 0,
        temp,
        temp * temp,
        heatingDeg,
        coolingDeg,
        humid,
        Math.max(0, humid - 60),
        wind,
        solar,
        precip,
        pressure,
        lag1h,
        lag24h
      ];
    }
    return X;
  }
  // Forecast features are the same except lag_1h / lag_24h use the PREDICTED
  // load (recursive forecast) — we don't have actual future load. The caller
  // must provide the rolling predicted-load buffer.
  function buildForecastDesignMatrix(weather, timestamps, predictedLoad, balancePoint) {
    var n = timestamps.length;
    var X = new Array(n);
    for (var i = 0; i < n; i++) {
      X[i] = buildForecastRow(weather, timestamps, i, predictedLoad, balancePoint);
    }
    return X;
  }
  // Build a single feature row for a forecast hour. lagBuffer is the rolling
  // array of most-recent load values (oldest first, length ≤ 24).
  function buildForecastRow(w, ts, i, lagBuffer, balancePoint) {
    var dt = new Date(ts[i]);
    var hour = dt.getHours();
    var dow = dt.getDay();
    var month = dt.getMonth() + 1;
    var temp = num(w.temperature_2m, i);
    var humid = num(w.relative_humidity_2m, i);
    var wind = num(w.wind_speed_10m, i);
    var solar = num(w.shortwave_radiation, i);
    var precip = num(w.precipitation, i);
    var pressure = num(w.surface_pressure, i);
    var heatingDeg = Math.max(0, balancePoint - temp);
    var coolingDeg = Math.max(0, temp - balancePoint);
    var lag1h  = lagBuffer.length > 0  ? lagBuffer[lagBuffer.length - 1] : 0;
    var lag24h = lagBuffer.length >= 24 ? lagBuffer[0] :
                 (lagBuffer.length > 0 ? lagBuffer[0] : 0);
    return [
      1.0,
      Math.sin(2 * Math.PI * hour / 24),
      Math.cos(2 * Math.PI * hour / 24),
      Math.sin(2 * Math.PI * dow / 7),
      Math.cos(2 * Math.PI * dow / 7),
      Math.sin(2 * Math.PI * (month - 1) / 12),
      Math.cos(2 * Math.PI * (month - 1) / 12),
      (dow === 0 || dow === 6) ? 1 : 0,
      temp,
      temp * temp,
      heatingDeg,
      coolingDeg,
      humid,
      Math.max(0, humid - 60),
      wind,
      solar,
      precip,
      pressure,
      lag1h,
      lag24h
    ];
  }

  // ─── Matrix operations (pure JS, no library) ──────────────────────────────────
  // These three primitives (transpose, multiply, inverse) are all that OLS
  // regression needs. Everything else (X'X, β = (X'X)^(-1) X'y, prediction-
  // interval quadratic forms) builds on top of them. The inverse uses
  // Gauss-Jordan elimination with partial pivoting — the same algorithm
  // numpy.linalg uses under the hood, just in pure JS.
  //
  // Performance: with n=8760 (one year of hourly data) and p=20 features,
  // X'X is 20×20, X'y is 20×1, and the inverse of a 20×20 matrix takes
  // ~8000 multiply-adds — well under 1 ms on any modern CPU. The expensive
  // step is actually computing X'X (n × p × p = 3.5M multiplies, ~30 ms).
  function matrixTranspose(M) {
    var rows = M.length, cols = M[0].length;
    var T = new Array(cols);
    for (var j = 0; j < cols; j++) {
      T[j] = new Array(rows);
      for (var i = 0; i < rows; i++) T[j][i] = M[i][j];
    }
    return T;
  }
  function matrixMultiply(A, B) {
    // C[i][j] = Σ_k A[i][k] * B[k][j]. Standard triple-loop implementation.
    // For a 20×8760 * 8760×20 multiply (X'X), this is the dominant cost.
    var m = A.length, n = B[0].length, k = B.length;
    var C = new Array(m);
    for (var i = 0; i < m; i++) {
      C[i] = new Array(n);
      for (var j = 0; j < n; j++) {
        var s = 0;
        for (var p = 0; p < k; p++) s += A[i][p] * B[p][j];
        C[i][j] = s;
      }
    }
    return C;
  }
  // Matrix inverse via Gauss-Jordan elimination with partial pivoting.
  // Algorithm:
  //   1. Augment M with the identity → [M | I] (same number of rows, 2n cols).
  //   2. For each column i:
  //      a. Find the row with the largest absolute value in column i
  //         (partial pivot — minimizes floating-point error).
  //      b. If the pivot is ~0, the matrix is singular (collinear features).
  //      c. Swap rows so the pivot row is at position i.
  //      d. For every OTHER row k (≠ i), subtract (A[k][i] / A[i][i]) × row_i
  //         from row_k so that column i has zeros everywhere except row i.
  //   3. Divide each row i by A[i][i] so the left half becomes identity.
  //   4. The right half is now M^(-1).
  //
  // Throws a friendly error on singularity (collinear features → determinant
  // ≈ 0). The caller surfaces this to the UI as "drop a feature" advice.
  function matrixInverse(M) {
    var n = M.length;
    if (n === 0) throw new Error('Cannot invert an empty matrix.');
    if (M[0].length !== n) throw new Error('Matrix must be square to invert.');
    // Step 1 — augment M with the identity matrix → [M | I].
    var A = M.map(function (row, i) {
      var r = row.slice();
      for (var j = 0; j < n; j++) r.push(i === j ? 1 : 0);
      return r;
    });
    // Forward elimination with partial pivoting.
    for (var i = 0; i < n; i++) {
      var maxRow = i;
      for (var k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
      }
      if (Math.abs(A[maxRow][i]) < 1e-12) {
        throw new Error('Singular design matrix (collinear features) — try fewer features.');
      }
      if (maxRow !== i) { var tmp = A[i]; A[i] = A[maxRow]; A[maxRow] = tmp; }
      var pivot = A[i][i];
      for (var k = 0; k < n; k++) {
        if (k === i) continue;
        var factor = A[k][i] / pivot;
        if (factor === 0) continue;
        for (var j = i; j < 2 * n; j++) A[k][j] -= factor * A[i][j];
      }
    }
    // Normalize pivots → right half becomes M^(-1).
    for (var i = 0; i < n; i++) {
      var p = A[i][i];
      for (var j = n; j < 2 * n; j++) A[i][j] /= p;
    }
    return A.map(function (row) { return row.slice(n); });
  }
  // Vector helpers.
  function vecMean(v) {
    var s = 0, n = v.length;
    for (var i = 0; i < n; i++) s += v[i];
    return s / n;
  }
  function vecStd(v) {
    var m = vecMean(v); var s = 0, n = v.length;
    for (var i = 0; i < n; i++) { var d = v[i] - m; s += d * d; }
    return Math.sqrt(s / Math.max(1, n - 1));
  }

  // ─── Statistical helpers ────────────────────────────────────────────────────
  // Standard-normal CDF (Abramowitz & Stegun 26.2.17) — max abs error 7.5e-8.
  // Sufficient for t-dist p-values when n > 30 (we have n = 8760).
  function normCDF(z) {
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    var p = 0.3275911;
    var sign = z < 0 ? -1 : 1;
    var x = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + p * x);
    var y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
  }
  // Two-tailed p-value from a t-statistic. For df > 30, t-dist ≈ normal.
  function pValueFromT(t, df) {
    return 2 * (1 - normCDF(Math.abs(t)));
  }
  // Linear-interpolated percentile of an unsorted array.
  function percentile(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var idx = (sorted.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
  }

  // ─── OLS regression ──────────────────────────────────────────────────────────
  // Closed-form ordinary least squares:
  //
  //   β = (X'X)^(-1) X'y
  //
  // where X is the n×p design matrix (rows = observations, columns = features,
  // first column = all-ones for the intercept) and y is the n×1 response.
  //
  // Once β is estimated, the model can:
  //   • predict: ŷ = Xβ
  //   • diagnose: residuals e = y - ŷ → R², RMSE, MAE, MAPE, σ
  //   • explain: SE(βᵢ) = σ × √((X'X)^(-1)ᵢᵢ), t = βᵢ/SE, p = 2(1-Φ(|t|))
  //   • forecast with uncertainty: ŷ ± z × σ × √(1 + x'(X'X)^(-1)x)
  //
  // The last formula is the prediction interval for a NEW observation (not a
  // confidence interval for the conditional mean). The "1 +" under the square
  // root accounts for the new observation's own noise. z=1.96 for 95% PI,
  // z=1.282 for 80% PI.
  //
  // Returns an object with everything the UI needs:
  //   beta, se, tStat, pValue, predictions, residuals, r2, adjR2, rmse, mae,
  //   mape, sigma, XtX_inv, featureNames, n, p
  function fitOLS(X, y, featureNames) {
    var n = X.length;
    if (n === 0) throw new Error('Cannot fit on empty data.');
    var p = X[0].length;
    if (n <= p) throw new Error('Not enough observations (' + n + ') for ' + p + ' features.');
    var Xt  = matrixTranspose(X);
    var XtX = matrixMultiply(Xt, X);
    var XtX_inv;
    try { XtX_inv = matrixInverse(XtX); }
    catch (e) { throw new Error('Regression failed: ' + e.message); }
    // Xt * y (column vector → treat as p×1 matrix).
    var yMat = y.map(function (v) { return [v]; });
    var Xty = matrixMultiply(Xt, yMat);
    var betaMat = matrixMultiply(XtX_inv, Xty);
    var beta = betaMat.map(function (row) { return row[0]; });
    // Predictions ŷ = Xβ.
    var predictions = new Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0;
      var row = X[i];
      for (var j = 0; j < p; j++) s += row[j] * beta[j];
      predictions[i] = s;
    }
    // Residuals e = y - ŷ, plus error metrics.
    var residuals = new Array(n);
    var sse = 0, maeSum = 0, mapeSum = 0, mapeCount = 0;
    for (var i = 0; i < n; i++) {
      var r = y[i] - predictions[i];
      residuals[i] = r;
      sse += r * r;
      maeSum += Math.abs(r);
      if (Math.abs(y[i]) > 1e-6) { mapeSum += Math.abs(r / y[i]); mapeCount++; }
    }
    var yMean = vecMean(y);
    var sst = 0;
    for (var i = 0; i < n; i++) { var d = y[i] - yMean; sst += d * d; }
    var r2 = sst > 0 ? 1 - sse / sst : 0;
    var adjR2 = 1 - (1 - r2) * (n - 1) / (n - p - 1);
    var rmse = Math.sqrt(sse / n);
    var mae = maeSum / n;
    var mape = mapeCount > 0 ? (mapeSum / mapeCount) * 100 : 0;
    var sigma = Math.sqrt(sse / Math.max(1, n - p));
    // Coefficient standard errors: SE(βᵢ) = σ × sqrt((X'X)^(-1)ᵢᵢ).
    var se = new Array(p);
    var tStat = new Array(p);
    var pValue = new Array(p);
    for (var i = 0; i < p; i++) {
      se[i] = sigma * Math.sqrt(Math.max(0, XtX_inv[i][i]));
      tStat[i] = se[i] > 0 ? beta[i] / se[i] : 0;
      pValue[i] = pValueFromT(tStat[i], n - p);
    }
    return {
      beta: beta, se: se, tStat: tStat, pValue: pValue,
      predictions: predictions, residuals: residuals,
      r2: r2, adjR2: adjR2, rmse: rmse, mae: mae, mape: mape, sigma: sigma,
      XtX_inv: XtX_inv, featureNames: featureNames, n: n, p: p
    };
  }

  // ─── Standardized coefficients (variable importance) ────────────────────────
  // Standardize each feature (subtract mean, divide by std), re-fit OLS, take
  // the absolute value of each resulting coefficient as variable importance.
  // The intercept stays at the response mean (constant has zero variance) —
  // we skip it from the importance ranking.
  function fitStandardized(X, y, featureNames) {
    var n = X.length, p = X[0].length;
    var means = new Array(p), stds = new Array(p);
    for (var j = 0; j < p; j++) {
      var col = new Array(n);
      for (var i = 0; i < n; i++) col[i] = X[i][j];
      means[j] = vecMean(col);
      stds[j]  = vecStd(col);
    }
    var Xstd = X.map(function (row) {
      var r = new Array(p);
      for (var j = 0; j < p; j++) {
        if (j === 0) r[j] = 1; // keep intercept as constant 1
        else r[j] = stds[j] > 0 ? (row[j] - means[j]) / stds[j] : 0;
      }
      return r;
    });
    var m = fitOLS(Xstd, y, featureNames);
    return m.beta;
  }

  // ─── Change-point detection ─────────────────────────────────────────────────
  // Sweep BP from 10°C to 25°C in 0.5°C steps. For each, rebuild the design
  // matrix with that BP (heating_degree + cooling_degree derived from it),
  // fit OLS, record RMSE. Pick the BP that minimizes RMSE. This is the key
  // differentiator from "10 MW per degree" — the model LEARNS the change-
  // point AND the slopes from data, instead of assuming a hardcoded 18°C.
  //
  // Why this matters: the change-point (or "balance point") is the outdoor
  // temperature where a building transitions from heating to cooling —
  // neither system dominates. It varies by climate, building stock, and
  // end-use mix (electric heating vs gas heating + electric AC). Hardcoding
  // 18°C is wrong for most utilities; detecting it from data is correct.
  //
  // The sweep is O(31 × OLS_fit). Each OLS fit takes ~30 ms on 8760 rows
  // with 20 features, so the full sweep is ~1 s — fast enough to run live
  // in the browser with a loading spinner.
  function detectChangePoint(weather, timestamps, load) {
    var bestBP = BALANCE_POINT_INIT;
    var bestRMSE = Infinity;
    var bestModel = null;
    var features = FEATURE_NAMES();
    for (var bp = 10.0; bp <= 25.0; bp += 0.5) {
      var X = buildDesignMatrix(weather, timestamps, load, bp);
      var m;
      try { m = fitOLS(X, load, features); }
      catch (e) { continue; }
      if (m.rmse < bestRMSE) {
        bestRMSE = m.rmse;
        bestBP = bp;
        bestModel = m;
      }
    }
    if (!bestModel) throw new Error('Change-point sweep failed — no model converged.');
    return { changePoint: bestBP, model: bestModel, rmse: bestRMSE };
  }

  // ─── Train model (top-level orchestrator) ────────────────────────────────────
  // 1. Detect the change-point by sweep.
  // 2. Build the final design matrix at the detected BP.
  // 3. Standardize features → variable importance ranking.
  // 4. Compute prediction intervals (95% + 80%) at every historical hour.
  // 5. Compute P90 / P95 / P99 thresholds from historical daily peaks.
  function trainModel() {
    var w = state.weatherHistory;
    var ts = w.time;
    var load = state.loadData.load;
    var det = detectChangePoint(w, ts, load);
    var m = det.model;
    // Standardized coefficients → variable importance.
    var Xfull = buildDesignMatrix(w, ts, load, det.changePoint);
    var stdBetas = fitStandardized(Xfull, load, FEATURE_NAMES());
    var importance = [];
    for (var j = 1; j < stdBetas.length; j++) {
      importance.push({ feature: FEATURE_NAMES()[j], importance: Math.abs(stdBetas[j]) });
    }
    importance.sort(function (a, b) { return b.importance - a.importance; });

    // Discovered heating/cooling slopes.
    var featIdx = FEATURE_NAMES();
    var heatingIdx = featIdx.indexOf('heating_degree');
    var coolingIdx = featIdx.indexOf('cooling_degree');
    var heatingSlope = m.beta[heatingIdx];
    var coolingSlope = m.beta[coolingIdx];

    // Prediction intervals at every historical point:
    //   ŷ ± z × σ × sqrt(1 + x'(X'X)^(-1)x)
    //   z_95 = 1.96, z_80 = 1.282
    var piL95 = new Array(m.n), piU95 = new Array(m.n);
    var piL80 = new Array(m.n), piU80 = new Array(m.n);
    for (var i = 0; i < m.n; i++) {
      var x = Xfull[i];
      var q = 0;
      for (var j = 0; j < m.p; j++) {
        var sj = 0;
        for (var k = 0; k < m.p; k++) sj += m.XtX_inv[j][k] * x[k];
        q += x[j] * sj;
      }
      var se = m.sigma * Math.sqrt(Math.max(0, 1 + q));
      piL95[i] = m.predictions[i] - 1.96 * se;
      piU95[i] = m.predictions[i] + 1.96 * se;
      piL80[i] = m.predictions[i] - 1.282 * se;
      piU80[i] = m.predictions[i] + 1.282 * se;
    }

    state.model = {
      beta: m.beta, se: m.se, tStat: m.tStat, pValue: m.pValue,
      predictions: m.predictions, residuals: m.residuals,
      r2: m.r2, adjR2: m.adjR2, rmse: m.rmse, mae: m.mae, mape: m.mape, sigma: m.sigma,
      XtX_inv: m.XtX_inv, featureNames: m.featureNames,
      n: m.n, p: m.p, changePoint: det.changePoint,
      heatingSlope: heatingSlope, coolingSlope: coolingSlope,
      standardizedBetas: stdBetas, variableImportance: importance,
      piL95: piL95, piU95: piU95, piL80: piL80, piU80: piU80,
      timestamps: ts, actual: load
    };

    // P90 / P95 / P99 thresholds from historical daily peak distribution.
    var dailyPeaks = computeDailyPeaks(ts, load);
    state.thresholds = {
      p90: percentile(dailyPeaks, 0.90),
      p95: percentile(dailyPeaks, 0.95),
      p99: percentile(dailyPeaks, 0.99),
      custom: {
        p90: percentile(dailyPeaks, 0.90),
        p95: percentile(dailyPeaks, 0.95),
        p99: percentile(dailyPeaks, 0.99)
      }
    };
  }
  function computeDailyPeaks(timestamps, load) {
    var byDay = {};
    for (var i = 0; i < timestamps.length; i++) {
      var d = new Date(timestamps[i]);
      var key = isoDate(d);
      if (!(key in byDay)) byDay[key] = -Infinity;
      if (load[i] > byDay[key]) byDay[key] = load[i];
    }
    return Object.keys(byDay).map(function (k) { return byDay[k]; });
  }

  // ─── Apply model to 14-day forecast (recursive) ─────────────────────────────
  // At each forecast hour, predict using weather + lag features where the
  // lags come from earlier predictions (or the last 24 actual loads for the
  // first 24 hours). Compute 80% + 95% PIs at each hour, aggregate to daily
  // peak / avg, then assign operational recommendations.
  //
  // Recursive forecasting: each hour's lag_1h and lag_24h features depend
  // on earlier predictions. We seed the lag buffer with the last 24 ACTUAL
  // loads from history, then append each new prediction as we step forward.
  // After 24 forecast hours, the buffer is fully populated with predictions.
  //
  // This is the standard approach for autoregressive + exogenous (ARX)
  // models. The prediction intervals WIDEN over the forecast horizon because
  // the lag-feature uncertainty compounds (each step's PI propagates into
  // the next step's lag features). The 1.96 × σ × sqrt(1 + x'(X'X)^(-1)x)
  // formula captures only the single-step uncertainty — for true multi-step
  // intervals you'd need to integrate over the lag-feature distribution.
  // For this demo we use the simpler single-step formula and note the
  // limitation in the UI text.
  function applyModelToForecast() {
    var m = state.model;
    var w = state.weatherForecast;
    var ts = w.time;
    var n = ts.length;
    var predicted = new Array(n);
    var piL95 = new Array(n), piU95 = new Array(n);
    var piL80 = new Array(n), piU80 = new Array(n);
    // Seed the recursive lag buffer with the last 24 actual loads from history.
    var lastHist = state.loadData.load;
    var lagBuffer = lastHist.slice(-24);
    for (var i = 0; i < n; i++) {
      var x = buildForecastRow(w, ts, i, lagBuffer, m.changePoint);
      var yhat = 0;
      for (var j = 0; j < m.p; j++) yhat += x[j] * m.beta[j];
      predicted[i] = yhat;
      // PI for a NEW observation: σ × sqrt(1 + x'(X'X)^(-1)x)
      var q = 0;
      for (var j = 0; j < m.p; j++) {
        var sj = 0;
        for (var k = 0; k < m.p; k++) sj += m.XtX_inv[j][k] * x[k];
        q += x[j] * sj;
      }
      var se = m.sigma * Math.sqrt(Math.max(0, 1 + q));
      piL95[i] = yhat - 1.96 * se;
      piU95[i] = yhat + 1.96 * se;
      piL80[i] = yhat - 1.282 * se;
      piU80[i] = yhat + 1.282 * se;
      // Update lag buffer (FIFO — keep last 24 values).
      lagBuffer.push(yhat);
      if (lagBuffer.length > 24) lagBuffer.shift();
    }
    var daily = aggregateDaily(ts, predicted, w);
    state.forecast = {
      hourly: {
        timestamps: ts, predicted: predicted,
        piL95: piL95, piU95: piU95, piL80: piL80, piU80: piU80,
        weather: w
      },
      daily: daily
    };
    assignRiskLevels();
    computeLocalBriefings();
  }
  function aggregateDaily(timestamps, predicted, weather) {
    var byDay = {};
    var order = [];
    for (var i = 0; i < timestamps.length; i++) {
      var d = new Date(timestamps[i]);
      var key = isoDate(d);
      if (!(key in byDay)) {
        byDay[key] = { date: key, loads: [], temps: [], humids: [], winds: [], precips: [], solars: [] };
        order.push(key);
      }
      var e = byDay[key];
      e.loads.push(predicted[i]);
      e.temps.push(num(weather.temperature_2m, i));
      e.humids.push(num(weather.relative_humidity_2m, i));
      e.winds.push(num(weather.wind_speed_10m, i));
      e.precips.push(num(weather.precipitation, i));
      e.solars.push(num(weather.shortwave_radiation, i));
    }
    return order.map(function (key) {
      var e = byDay[key];
      var peakLoad = Math.max.apply(null, e.loads);
      var peakIdx = e.loads.indexOf(peakLoad);
      var avgLoad = e.loads.reduce(function (a, b) { return a + b; }, 0) / e.loads.length;
      var maxTemp = Math.max.apply(null, e.temps);
      var minTemp = Math.min.apply(null, e.temps);
      var avgHumid = vecMean(e.humids);
      var totalPrecip = e.precips.reduce(function (a, b) { return a + b; }, 0);
      var maxWind = Math.max.apply(null, e.winds);
      var avgSolar = vecMean(e.solars);

      // Per-feature contributions to the peak-hour prediction.
      var m = state.model;
      var featIdx = m.featureNames;
      var heatingIdx = featIdx.indexOf('heating_degree');
      var coolingIdx = featIdx.indexOf('cooling_degree');
      var humidIdx = featIdx.indexOf('humidity_excess');
      var solarIdx = featIdx.indexOf('solar_radiation');
      var windIdx  = featIdx.indexOf('wind_speed');
      var weekendIdx = featIdx.indexOf('is_weekend');
      var dt = new Date(key + 'T00:00');
      var dow = dt.getDay();
      var isWeekend = (dow === 0 || dow === 6) ? 1 : 0;
      var heatingDeg = Math.max(0, m.changePoint - maxTemp);
      var coolingDeg = Math.max(0, maxTemp - m.changePoint);
      var humidExcess = Math.max(0, avgHumid - 60);

      var drivers = [];
      var tempContrib = m.beta[heatingIdx] * heatingDeg + m.beta[coolingIdx] * coolingDeg;
      var humidContrib = m.beta[humidIdx] * humidExcess;
      var solarContrib = m.beta[solarIdx] * avgSolar;
      var windContrib  = m.beta[windIdx]  * maxWind;
      var weekendContrib = m.beta[weekendIdx] * isWeekend;
      if (Math.abs(tempContrib) > 0.05)
        drivers.push({ name: 'Temperature ' + maxTemp.toFixed(1) + '\u00b0C', contribution: tempContrib });
      if (Math.abs(humidContrib) > 0.05)
        drivers.push({ name: 'Humidity ' + Math.round(avgHumid) + '%', contribution: humidContrib });
      if (Math.abs(solarContrib) > 0.05)
        drivers.push({ name: 'Solar ' + Math.round(avgSolar) + ' W/m\u00b2', contribution: solarContrib });
      if (Math.abs(windContrib) > 0.05)
        drivers.push({ name: 'Wind ' + maxWind.toFixed(1) + ' m/s', contribution: windContrib });
      if (Math.abs(weekendContrib) > 0.05)
        drivers.push({ name: isWeekend ? 'Weekend reduction' : 'Weekday premium', contribution: weekendContrib });
      drivers.sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });

      return {
        date: key,
        peakLoad: peakLoad, avgLoad: avgLoad,
        maxTemp: maxTemp, minTemp: minTemp,
        avgHumid: avgHumid, totalPrecip: totalPrecip, maxWind: maxWind,
        peakHourIdx: peakIdx,
        peakTime: String(Math.floor(peakIdx)).padStart(2, '0') + ':00',
        drivers: drivers,
        mainDriver: drivers[0] ? drivers[0].name : 'Baseline load',
        riskLevel: 'Normal',
        recommendation: '',
        aiNarration: null
      };
    });
  }
  function assignRiskLevels() {
    if (!state.forecast || !state.forecast.daily) return;
    var t = state.thresholds.custom || state.thresholds;
    state.forecast.daily.forEach(function (d) {
      var peak = d.peakLoad;
      if (peak >= t.p99)      { d.riskLevel = 'Critical'; d.recommendation = 'Activate contingency planning and additional resources.'; }
      else if (peak >= t.p95) { d.riskLevel = 'High';     d.recommendation = 'Increase operational crews / reserve capacity.'; }
      else if (peak >= t.p90) { d.riskLevel = 'Elevated'; d.recommendation = 'Increase readiness and monitor conditions.'; }
      else                    { d.riskLevel = 'Normal';   d.recommendation = 'Maintain nominal staffing and generation capacity.'; }
    });
  }
  // Build a structured (locally-computed) briefing per day. The optional
  // Groq pass later replaces `aiNarration` with a polished paragraph.
  function computeLocalBriefings() {
    if (!state.forecast || !state.forecast.daily) return;
    state.briefings = state.forecast.daily.map(function (d) {
      var topDrivers = d.drivers.slice(0, 2).map(function (dr) {
        return dr.name + ' (' + (dr.contribution >= 0 ? '+' : '') + fmtMW1(dr.contribution) + ')';
      }).join(', ');
      return {
        date: d.date,
        peakLoad: d.peakLoad,
        peakTime: d.peakTime,
        avgLoad: d.avgLoad,
        mainDrivers: topDrivers || 'Baseline diurnal + seasonal pattern',
        riskLevel: d.riskLevel,
        recommendation: d.recommendation,
        aiNarration: null
      };
    });
  }

  // ─── Theme helpers (mirror blog-pipeline-builder pattern) ────────────────────
  function getTheme() {
    var mount = $(MOUNT_ID);
    if (mount) {
      var t = mount.getAttribute('data-lf-theme');
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
  // All load-forecast-specific CSS lives in a single injected <style> block,
  // scoped with the .lf- prefix so it can't clash with the site stylesheet.
  // Reuses the site's design tokens (--bg, --surface, --border, --text, etc.)
  // and the site's .btn / .btn-primary / .btn-ghost classes (defined globally).
  function injectCSS() {
    if ($('lf-style')) return;
    var css = '\
.lf-app { font-family: var(--font-body); color: var(--text); max-width: 1080px; margin: 0 auto; padding: 0; }\
.lf-app * { box-sizing: border-box; }\
.lf-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 20px; box-shadow: var(--shadow-sm); }\
.lf-card-title { font-family: var(--font-head); font-size: 1.15rem; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; color: var(--text); }\
.lf-card-sub { color: var(--text-soft); font-size: 0.88rem; margin: 0 0 18px; line-height: 1.5; }\
.lf-card-step { display: inline-block; font-family: var(--font-head); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--indigo); margin-bottom: 6px; }\
.lf-btn-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; }\
.lf-btn-sm { min-height: 38px; padding: 8px 16px; font-size: 0.85rem; border-radius: 999px; }\
.lf-spacer { flex: 1; }\
.lf-input { width: 100%; background: var(--bg-alt); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 10px 12px; color: var(--text); font-family: inherit; font-size: 0.92rem; }\
.lf-input:focus { outline: none; border-color: var(--indigo); box-shadow: var(--ring); }\
.lf-textarea { width: 100%; min-height: 80px; resize: vertical; background: var(--bg-alt); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 12px 14px; color: var(--text); font-family: var(--font-body); font-size: 0.95rem; line-height: 1.5; }\
.lf-textarea:focus { outline: none; border-color: var(--indigo); box-shadow: var(--ring); }\
.lf-input-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }\
.lf-input-row > label { font-size: 0.82rem; color: var(--text-soft); min-width: 32px; }\
.lf-input-row > input { max-width: 120px; }\
.lf-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-top: 14px; }\
.lf-stat { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; }\
.lf-stat-label { font-family: var(--font-head); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-soft); margin: 0 0 4px; }\
.lf-stat-value { font-family: var(--font-head); font-size: 1.1rem; font-weight: 700; color: var(--text); }\
.lf-stat-sub { font-size: 0.74rem; color: var(--text-soft); margin-top: 2px; }\
.lf-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 440px; }\
.lf-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }\
.lf-table th, .lf-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }\
.lf-table th { background: var(--bg-alt); color: var(--text-muted); font-family: var(--font-head); font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; z-index: 1; }\
.lf-table td.num { text-align: right; font-variant-numeric: tabular-nums; }\
.lf-table tbody tr:hover { background: rgba(99,102,241,0.04); }\
.lf-coef-row-significant td { font-weight: 700; }\
.lf-chart-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; margin-top: 16px; }\
.lf-chart-title { font-family: var(--font-head); font-size: 0.82rem; font-weight: 600; color: var(--text-muted); margin: 0 0 8px; }\
.lf-chart-body { width: 100%; height: 340px; }\
.lf-chart-empty { padding: 36px; text-align: center; color: var(--text-soft); font-size: 0.85rem; }\
.lf-loading { display: flex; align-items: center; gap: 10px; color: var(--text-soft); font-size: 0.88rem; padding: 14px 0; }\
.lf-loading-block { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 16px; text-align: center; color: var(--text-soft); font-size: 0.95rem; }\
.lf-loading-sub { font-size: 0.78rem; color: var(--text-soft); opacity: 0.7; }\
.lf-spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--indigo); border-radius: 50%; animation: lf-spin 0.8s linear infinite; flex-shrink: 0; }\
@keyframes lf-spin { to { transform: rotate(360deg); } }\
.lf-error { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-sm); padding: 12px 16px; color: #b91c1c; margin-top: 12px; font-size: 0.88rem; }\
[data-theme="dark"] .lf-error { color: #fca5a5; }\
.lf-warn { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.28); border-radius: var(--radius-sm); padding: 10px 14px; color: #b45309; margin-top: 12px; font-size: 0.82rem; }\
[data-theme="dark"] .lf-warn { color: #fcd34d; }\
.lf-pill { display: inline-block; padding: 2px 8px; border-radius: 6px; font-family: var(--font-head); font-weight: 600; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; }\
.lf-pill-normal { background: rgba(16,185,129,0.12); color: #059669; border: 1px solid rgba(16,185,129,0.3); }\
.lf-pill-elevated { background: rgba(245,158,11,0.12); color: #b45309; border: 1px solid rgba(245,158,11,0.3); }\
.lf-pill-high { background: rgba(249,115,22,0.12); color: #c2410c; border: 1px solid rgba(249,115,22,0.3); }\
.lf-pill-critical { background: rgba(239,68,68,0.12); color: #b91c1c; border: 1px solid rgba(239,68,68,0.3); }\
[data-theme="dark"] .lf-pill-normal { color: #34d399; }\
[data-theme="dark"] .lf-pill-elevated { color: #fcd34d; }\
[data-theme="dark"] .lf-pill-high { color: #fb923c; }\
[data-theme="dark"] .lf-pill-critical { color: #fca5a5; }\
.lf-threshold-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-top: 1px solid var(--border); }\
.lf-threshold-row:first-child { border-top: none; }\
.lf-threshold-label { display: flex; justify-content: space-between; font-size: 0.82rem; color: var(--text-muted); }\
.lf-threshold-label span { font-family: var(--font-head); font-weight: 700; color: var(--text); }\
.lf-threshold-row input[type="range"] { width: 100%; accent-color: var(--indigo); }\
.lf-qa-input { display: flex; gap: 8px; flex-wrap: wrap; }\
.lf-qa-input > input { flex: 1; min-width: 220px; }\
.lf-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }\
.lf-chip { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; cursor: pointer; font-size: 0.78rem; color: var(--text-muted); font-family: inherit; transition: border-color 0.2s, color 0.2s; }\
.lf-chip:hover { border-color: var(--indigo); color: var(--indigo); }\
.lf-ai-result-card { padding: 18px 20px; border-radius: var(--radius); background: linear-gradient(135deg, rgba(99,102,241,0.04), rgba(6,182,212,0.03)); border: 1px solid var(--border); margin-top: 8px; }\
.lf-ai-result-text { font-size: 0.95rem; line-height: 1.7; color: var(--text); white-space: normal; }\
.lf-ai-result-text br + br { margin-top: 8px; }\
.lf-briefing { border-left: 3px solid var(--indigo); background: var(--bg-alt); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; padding: 12px 16px; margin-bottom: 12px; }\
.lf-briefing-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }\
.lf-briefing-date { font-family: var(--font-head); font-weight: 700; color: var(--text); }\
.lf-briefing-load { font-family: var(--font-head); font-size: 1.0rem; color: var(--indigo); }\
.lf-briefing-lines { margin-top: 8px; font-size: 0.85rem; line-height: 1.55; color: var(--text-muted); }\
.lf-briefing-lines div { padding: 1px 0; }\
.lf-briefing-lines strong { color: var(--text); }\
.lf-briefing-narration { margin-top: 8px; padding: 10px 12px; background: rgba(99,102,241,0.06); border-radius: 6px; font-size: 0.82rem; line-height: 1.55; color: var(--text); }\
.lf-rate-note { color: var(--text-soft); font-size: 0.74rem; margin-top: 10px; text-align: right; }\
.lf-empty { color: var(--text-soft); font-size: 0.88rem; padding: 18px 0; text-align: center; }\
.lf-location-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; }\
.lf-location-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }\
.lf-location-icon { width: 44px; height: 44px; border-radius: var(--radius-sm); background: linear-gradient(135deg, rgba(99,102,241,0.16), rgba(6,182,212,0.16)); display: flex; align-items: center; justify-content: center; color: var(--indigo); font-size: 1.2rem; flex-shrink: 0; }\
.lf-location-label { font-weight: 600; color: var(--text); }\
.lf-location-meta { color: var(--text-soft); font-size: 0.8rem; }\
.lf-features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; margin-top: 12px; }\
.lf-feature-pill { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 0.74rem; color: var(--text-muted); font-family: var(--font-head); }\
.lf-feature-pill .lf-feature-type { color: var(--text-soft); font-size: 0.68rem; margin-left: 4px; }\
.lf-modal-backdrop { position: fixed; inset: 0; background: rgba(15,23,42,0.55); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px; }\
.lf-modal { background: var(--bg-elevated, var(--surface)); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 24px; max-width: 640px; width: 100%; max-height: 80vh; overflow: auto; box-shadow: var(--shadow-lg); }\
.lf-modal-title { font-family: var(--font-head); font-size: 1.1rem; font-weight: 700; margin: 0 0 14px; }\
.lf-modal-body { color: var(--text); font-size: 0.9rem; }\
.lf-modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }\
.lf-modal-pre { background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; white-space: pre-wrap; word-break: break-word; font-size: 0.78rem; color: var(--text-muted); max-height: 320px; overflow: auto; font-family: "SFMono-Regular", Consolas, monospace; }\
.lf-email-html-preview { max-height: 480px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; padding: 0; background: #f8fafc; }\
.lf-window-toggle-row { display: flex; gap: 6px; margin: 10px 0 0; }\
.lf-window-toggle { background: var(--bg-alt); border: 1px solid var(--border); color: var(--text-muted); padding: 4px 12px; border-radius: 999px; cursor: pointer; font-size: 0.78rem; font-family: inherit; }\
.lf-window-toggle.lf-active { background: var(--gradient); color: #fff; border-color: transparent; }\
@media (max-width: 720px) { .lf-input-row > input { max-width: 100%; } .lf-chart-body { height: 260px; } }\
';
    var style = document.createElement('style');
    style.id = 'lf-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── ECharts chart factories ─────────────────────────────────────────────────
  // Each returns a ready-to-setOption config object. The renderer handles
  // loading ECharts lazily + disposing prior instances.

  function baseTooltip() {
    return {
      trigger: 'axis',
      backgroundColor: tooltipBgColor(),
      textStyle: { color: tooltipTextColor() },
      borderColor: 'rgba(99,102,241,0.2)'
    };
  }
  function baseAxisLabel() { return { color: axisLabelColor(), fontSize: 11 }; }
  function baseSplitLine() { return { lineStyle: { color: chartGridColor() } }; }
  function baseAxisLine()  { return { lineStyle: { color: chartGridColor() } }; }

  // 1. Mini temperature history + forecast (weather card)
  function chartTemperatureMini() {
    var wH = state.weatherHistory;
    var wF = state.weatherForecast;
    var nH = wH.time.length;
    var nF = wF.time.length;
    var histData = [];
    var last30Start = Math.max(0, nH - 24 * 30);
    for (var i = last30Start; i < nH; i++) {
      histData.push([wH.time[i], num(wH.temperature_2m, i)]);
    }
    var foreData = [];
    for (var i = 0; i < nF; i++) {
      foreData.push([wF.time[i], num(wF.temperature_2m, i)]);
    }
    return {
      tooltip: baseTooltip(),
      legend: { data: ['Historical (last 30d)', '14-day forecast'], textStyle: { color: axisLabelColor() }, top: 0 },
      grid: { left: 50, right: 24, top: 36, bottom: 50, containLabel: true },
      xAxis: { type: 'time', axisLabel: baseAxisLabel(), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      yAxis: { type: 'value', name: '°C', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      series: [
        { name: 'Historical (last 30d)', type: 'line', data: histData, showSymbol: false, smooth: true, lineStyle: { color: '#6366f1', width: 1.5 }, itemStyle: { color: '#6366f1' } },
        { name: '14-day forecast', type: 'line', data: foreData, showSymbol: false, smooth: true, lineStyle: { color: '#06b6d4', width: 2, type: 'dashed' }, itemStyle: { color: '#06b6d4' } }
      ]
    };
  }

  // 2. Load + temperature overlay (load card)
  function chartLoadOverlay() {
    var wH = state.weatherHistory;
    var load = state.loadData.load;
    var n = wH.time.length;
    var last30Start = Math.max(0, n - 24 * 30);
    var loadData = [];
    var tempData = [];
    for (var i = last30Start; i < n; i++) {
      loadData.push([wH.time[i], load[i]]);
      tempData.push([wH.time[i], num(wH.temperature_2m, i)]);
    }
    return {
      tooltip: baseTooltip(),
      legend: { data: ['Load (MW)', 'Temperature (°C)'], textStyle: { color: axisLabelColor() }, top: 0 },
      grid: { left: 60, right: 60, top: 36, bottom: 50, containLabel: true },
      xAxis: { type: 'time', axisLabel: baseAxisLabel(), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      yAxis: [
        { type: 'value', name: 'MW', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine(), splitNumber: 4 },
        { type: 'value', name: '°C', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: { show: false }, axisLine: baseAxisLine(), splitNumber: 4 }
      ],
      series: [
        { name: 'Load (MW)', type: 'line', data: loadData, showSymbol: false, smooth: true, yAxisIndex: 0, lineStyle: { color: '#6366f1', width: 1.5 }, itemStyle: { color: '#6366f1' }, areaStyle: { color: 'rgba(99,102,241,0.10)' } },
        { name: 'Temperature (°C)', type: 'line', data: tempData, showSymbol: false, smooth: true, yAxisIndex: 1, lineStyle: { color: '#f59e0b', width: 1, type: 'dashed' }, itemStyle: { color: '#f59e0b' } }
      ]
    };
  }

  // 3. Variable importance horizontal bar
  function chartVariableImportance() {
    var imp = state.model.variableImportance.slice(0, 12);
    var cats = imp.map(function (d) { return d.feature; });
    var vals = imp.map(function (d) { return Number(d.importance.toFixed(4)); });
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: tooltipBgColor(), textStyle: { color: tooltipTextColor() } },
      grid: { left: 100, right: 30, top: 16, bottom: 36, containLabel: false },
      xAxis: { type: 'value', axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      yAxis: { type: 'category', data: cats.reverse(), axisLabel: baseAxisLabel(), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      series: [{
        type: 'bar',
        data: vals.reverse(),
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
            colorStops: [{ offset: 0, color: '#6366f1' }, { offset: 1, color: '#06b6d4' }]
          },
          borderRadius: [0, 4, 4, 0]
        },
        label: { show: true, position: 'right', color: axisLabelColor(), fontSize: 11, formatter: function (p) { return p.value.toFixed(3); } }
      }]
    };
  }

  // 4. Temperature response curve (predicted load vs temperature, others at mean)
  function chartTemperatureResponse() {
    var m = state.model;
    var bp = m.changePoint;
    // Sweep temperature from observed min - 5 to observed max + 5.
    var temps = state.weatherHistory.temperature_2m.filter(function (v) { return typeof v === 'number'; });
    var tMin = Math.min.apply(null, temps);
    var tMax = Math.max.apply(null, temps);
    var x0 = Math.max(-15, Math.floor(tMin - 2));
    var x1 = Math.min(40, Math.ceil(tMax + 2));
    var pts = [];
    // Build a "mean row" — same features but with temperature swept.
    // Use the historical mean for non-temperature features. Lag features use
    // the mean load (a reasonable representative value).
    var w = state.weatherHistory;
    var n = w.time.length;
    var meanHumid = 0, meanWind = 0, meanSolar = 0, meanPrecip = 0, meanPressure = 0;
    for (var i = 0; i < n; i++) {
      meanHumid += num(w.relative_humidity_2m, i);
      meanWind  += num(w.wind_speed_10m, i);
      meanSolar += num(w.shortwave_radiation, i);
      meanPrecip += num(w.precipitation, i);
      meanPressure += num(w.surface_pressure, i);
    }
    meanHumid /= n; meanWind /= n; meanSolar /= n; meanPrecip /= n; meanPressure /= n;
    var meanLoad = vecMean(state.loadData.load);
    // Mean cyclicals — use hour=12 (midday), dow=3 (Wed), month=current.
    var now = new Date();
    var month = now.getMonth() + 1;
    var dow = 3; // Wednesday
    var hour = 12;
    var featIdx = m.featureNames;
    var heatingIdx = featIdx.indexOf('heating_degree');
    var coolingIdx = featIdx.indexOf('cooling_degree');
    var humidIdx = featIdx.indexOf('humidity_excess');
    for (var t = x0; t <= x1; t += 0.5) {
      var heatingDeg = Math.max(0, bp - t);
      var coolingDeg = Math.max(0, t - bp);
      var row = [
        1.0,
        Math.sin(2 * Math.PI * hour / 24),
        Math.cos(2 * Math.PI * hour / 24),
        Math.sin(2 * Math.PI * dow / 7),
        Math.cos(2 * Math.PI * dow / 7),
        Math.sin(2 * Math.PI * (month - 1) / 12),
        Math.cos(2 * Math.PI * (month - 1) / 12),
        0, // weekday (mean)
        t,
        t * t,
        heatingDeg,
        coolingDeg,
        meanHumid,
        Math.max(0, meanHumid - 60),
        meanWind,
        meanSolar,
        meanPrecip,
        meanPressure,
        meanLoad,
        meanLoad
      ];
      var yhat = 0;
      for (var j = 0; j < m.p; j++) yhat += row[j] * m.beta[j];
      pts.push([t, yhat]);
    }
    // Find the predicted load at the detected change-point (closest sampled temp).
    var closestPt = pts[0];
    for (var i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i][0] - bp) < Math.abs(closestPt[0] - bp)) closestPt = pts[i];
    }
    return {
      tooltip: baseTooltip(),
      grid: { left: 60, right: 30, top: 24, bottom: 50, containLabel: true },
      xAxis: { type: 'value', name: 'Temperature (°C)', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine(), min: x0, max: x1 },
      yAxis: { type: 'value', name: 'Predicted load (MW)', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      series: [{
        name: 'Temperature response',
        type: 'line',
        data: pts,
        showSymbol: false,
        smooth: true,
        lineStyle: { color: '#6366f1', width: 2.5 },
        itemStyle: { color: '#6366f1' },
        markLine: {
          symbol: 'none',
          label: { formatter: 'Change-point ' + bp.toFixed(1) + '°C', color: axisLabelColor(), position: 'end' },
          lineStyle: { color: '#f59e0b', type: 'dashed', width: 2 },
          data: [{ xAxis: bp }]
        },
        markPoint: {
          symbol: 'circle', symbolSize: 10,
          itemStyle: { color: '#f59e0b' },
          label: { formatter: 'Balance point', position: 'top', color: axisLabelColor(), fontSize: 10 },
          data: [{ coord: [bp, closestPt[1]] }]
        }
      }]
    };
  }

  // 5. Actual vs predicted with 80% + 95% PI bands
  function chartActualVsPredicted() {
    var m = state.model;
    var ts = m.timestamps;
    var actual = m.actual;
    var pred = m.predictions;
    var l95 = m.piL95, u95 = m.piU95, l80 = m.piL80, u80 = m.piU80;
    var n = ts.length;
    var startIdx = Math.max(0, n - state.avpWindow * 24);
    var actualData = [], predData = [], l95Data = [], u95Data = [], l80Data = [], u80Data = [];
    for (var i = startIdx; i < n; i++) {
      actualData.push([ts[i], actual[i]]);
      predData.push([ts[i], pred[i]]);
      l95Data.push([ts[i], l95[i]]);
      u95Data.push([ts[i], u95[i]]);
      l80Data.push([ts[i], l80[i]]);
      u80Data.push([ts[i], u80[i]]);
    }
    // Compute "band" arrays = upper - lower for the stacking trick.
    var band95 = u95Data.map(function (p, i) { return [p[0], p[1] - l95Data[i][1]]; });
    var band80 = u80Data.map(function (p, i) { return [p[0], p[1] - l80Data[i][1]]; });
    return {
      tooltip: baseTooltip(),
      legend: { data: ['Predicted', 'Actual', '95% PI', '80% PI'], textStyle: { color: axisLabelColor() }, top: 0, selected: { '95% PI': true, '80% PI': true } },
      grid: { left: 60, right: 30, top: 36, bottom: 50, containLabel: true },
      xAxis: { type: 'time', axisLabel: baseAxisLabel(), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      yAxis: { type: 'value', name: 'MW', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      series: [
        // 95% PI band: lower bound (invisible) + (upper - lower) stacked on top.
        { name: '_l95', type: 'line', data: l95Data, stack: 'pi95', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, silent: true, animation: false },
        { name: '95% PI', type: 'line', data: band95, stack: 'pi95', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { color: 'rgba(99,102,241,0.10)' }, silent: true, animation: false },
        // 80% PI band (separate stack so it overlays the 95% band correctly).
        { name: '_l80', type: 'line', data: l80Data, stack: 'pi80', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, silent: true, animation: false },
        { name: '80% PI', type: 'line', data: band80, stack: 'pi80', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { color: 'rgba(99,102,241,0.18)' }, silent: true, animation: false },
        // Predicted line.
        { name: 'Predicted', type: 'line', data: predData, showSymbol: false, smooth: true, lineStyle: { color: '#06b6d4', width: 1.5 }, itemStyle: { color: '#06b6d4' } },
        // Actual line — thicker, on top.
        { name: 'Actual', type: 'line', data: actualData, showSymbol: false, smooth: false, lineStyle: { color: '#0f172a', width: 1.5 }, itemStyle: { color: '#0f172a' } }
      ]
    };
  }

  // 6. Residual histogram — distribution of prediction errors (e = y - ŷ).
  //    Binned from -3σ to +3σ; a symmetric bell around 0 indicates the model
  //    is unbiased. Long tails suggest heteroscedasticity or missing features.
  function chartResidualHistogram() {
    var m = state.model;
    var residuals = m.residuals;
    var n = residuals.length;
    var sigma = m.sigma;
    var lo = -3 * sigma, hi = 3 * sigma;
    var nbins = 41;
    var step = (hi - lo) / nbins;
    var counts = new Array(nbins).fill(0);
    for (var i = 0; i < n; i++) {
      var r = residuals[i];
      var idx = Math.floor((r - lo) / step);
      if (idx < 0) idx = 0;
      if (idx >= nbins) idx = nbins - 1;
      counts[idx]++;
    }
    var data = [];
    for (var i = 0; i < nbins; i++) {
      var center = lo + (i + 0.5) * step;
      data.push([center, counts[i]]);
    }
    return {
      tooltip: baseTooltip(),
      grid: { left: 60, right: 30, top: 24, bottom: 50, containLabel: true },
      xAxis: { type: 'value', name: 'Residual (MW)', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      yAxis: { type: 'value', name: 'Count', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      series: [{
        type: 'bar',
        data: data,
        barWidth: '90%',
        itemStyle: { color: '#6366f1', borderRadius: [3, 3, 0, 0] }
      }],
      markLine: {
        symbol: 'none',
        lineStyle: { color: '#f59e0b', type: 'dashed', width: 2 },
        data: [{ xAxis: 0, label: { formatter: 'Zero', color: axisLabelColor(), position: 'end' } }]
      }
    };
  }

  // 6b. Residual autocorrelation — shows whether the model leaves residual
  //     structure on the table. Significant autocorrelation at lag-24 means
  //     the daily cycle is imperfectly captured. The 95% confidence band
  //     is ±1.96 / sqrt(n) for white noise.
  function chartResidualAutocorrelation() {
    var m = state.model;
    var residuals = m.residuals;
    var n = residuals.length;
    var maxLag = 48;
    var mean = vecMean(residuals);
    var denom = 0;
    for (var i = 0; i < n; i++) { var d = residuals[i] - mean; denom += d * d; }
    var acfData = [];
    var ci = 1.96 / Math.sqrt(n);
    for (var lag = 1; lag <= maxLag; lag++) {
      var num = 0;
      for (var i = lag; i < n; i++) {
        num += (residuals[i] - mean) * (residuals[i - lag] - mean);
      }
      var acf = denom > 0 ? num / denom : 0;
      acfData.push([lag, acf]);
    }
    return {
      tooltip: baseTooltip(),
      grid: { left: 60, right: 30, top: 24, bottom: 50, containLabel: true },
      xAxis: { type: 'value', name: 'Lag (hours)', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine(), min: 1, max: maxLag },
      yAxis: { type: 'value', name: 'ACF', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine(), min: -0.3, max: 0.6 },
      series: [{
        type: 'bar',
        data: acfData,
        barWidth: '60%',
        itemStyle: { color: '#06b6d4' }
      }],
      markLine: {
        symbol: 'none',
        lineStyle: { color: '#ef4444', type: 'dashed', width: 1.5 },
        data: [
          { yAxis: ci,  label: { formatter: '95% CI', color: axisLabelColor(), position: 'end' } },
          { yAxis: -ci, label: { formatter: '-95% CI', color: axisLabelColor(), position: 'end' } },
          { yAxis: 0,   lineStyle: { color: chartGridColor() } }
        ]
      }
    };
  }

  // 6c. Daily peaks bar chart — shows the 14 forecast days' peak loads
  //     color-coded by risk level. Helps the operator spot the worst day
  //     at a glance.
  function chartDailyPeaks() {
    var daily = state.forecast.daily;
    var cats = daily.map(function (d) { return fmtDateShort(d.date); });
    var colorByRisk = {
      Normal: '#10b981', Elevated: '#f59e0b', High: '#f97316', Critical: '#ef4444'
    };
    var data = daily.map(function (d) {
      return { value: Math.round(d.peakLoad), itemStyle: { color: colorByRisk[d.riskLevel] } };
    });
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: tooltipBgColor(), textStyle: { color: tooltipTextColor() } },
      grid: { left: 60, right: 30, top: 24, bottom: 50, containLabel: true },
      xAxis: { type: 'category', data: cats, axisLabel: Object.assign({}, baseAxisLabel(), { rotate: 30 }), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      yAxis: { type: 'value', name: 'Peak MW', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      series: [{
        type: 'bar',
        data: data,
        barWidth: '60%',
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: axisLabelColor(), fontSize: 10, formatter: function (p) { return p.value.toLocaleString('en-US'); } }
      }]
    };
  }

  // 7. 14-day forecast weather multi-line (temp, humidity, wind, precip)
  function chartForecastWeather() {
    var w = state.weatherForecast;
    var n = w.time.length;
    var tempData = [], humidData = [], windData = [], precipData = [];
    for (var i = 0; i < n; i++) {
      tempData.push([w.time[i], num(w.temperature_2m, i)]);
      humidData.push([w.time[i], num(w.relative_humidity_2m, i)]);
      windData.push([w.time[i], num(w.wind_speed_10m, i)]);
      precipData.push([w.time[i], num(w.precipitation, i)]);
    }
    return {
      tooltip: baseTooltip(),
      legend: { data: ['Temperature (°C)', 'Humidity (%)', 'Wind (m/s)', 'Precip (mm)'], textStyle: { color: axisLabelColor() }, top: 0 },
      grid: { left: 50, right: 50, top: 36, bottom: 50, containLabel: true },
      xAxis: { type: 'time', axisLabel: baseAxisLabel(), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      yAxis: [
        { type: 'value', name: '°C / %', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine(), splitNumber: 4 },
        { type: 'value', name: 'm/s / mm', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: { show: false }, axisLine: baseAxisLine(), splitNumber: 4 }
      ],
      series: [
        { name: 'Temperature (°C)', type: 'line', data: tempData, showSymbol: false, smooth: true, yAxisIndex: 0, lineStyle: { color: '#f59e0b', width: 1.5 }, itemStyle: { color: '#f59e0b' } },
        { name: 'Humidity (%)', type: 'line', data: humidData, showSymbol: false, smooth: true, yAxisIndex: 0, lineStyle: { color: '#06b6d4', width: 1.5 }, itemStyle: { color: '#06b6d4' } },
        { name: 'Wind (m/s)', type: 'line', data: windData, showSymbol: false, smooth: true, yAxisIndex: 1, lineStyle: { color: '#8b5cf6', width: 1.5 }, itemStyle: { color: '#8b5cf6' } },
        { name: 'Precip (mm)', type: 'bar', data: precipData, yAxisIndex: 1, itemStyle: { color: 'rgba(59,130,246,0.4)' } }
      ]
    };
  }

  // 8. 14-day forecast load with 80% + 95% PI bands
  function chartForecastLoad() {
    var f = state.forecast.hourly;
    var ts = f.timestamps, pred = f.predicted;
    var l95 = f.piL95, u95 = f.piU95, l80 = f.piL80, u80 = f.piU80;
    var n = ts.length;
    var predData = [], l95Data = [], u95Data = [], l80Data = [], u80Data = [];
    for (var i = 0; i < n; i++) {
      predData.push([ts[i], pred[i]]);
      l95Data.push([ts[i], l95[i]]);
      u95Data.push([ts[i], u95[i]]);
      l80Data.push([ts[i], l80[i]]);
      u80Data.push([ts[i], u80[i]]);
    }
    var band95 = u95Data.map(function (p, i) { return [p[0], p[1] - l95Data[i][1]]; });
    var band80 = u80Data.map(function (p, i) { return [p[0], p[1] - l80Data[i][1]]; });
    // Daily peak markers
    var peaks = state.forecast.daily.map(function (d) {
      var peakTs = ts[Math.min(d.peakHourIdx, n - 1)];
      return { coord: [peakTs, d.peakLoad], value: d.peakLoad };
    });
    return {
      tooltip: baseTooltip(),
      legend: { data: ['Predicted load', '95% PI', '80% PI'], textStyle: { color: axisLabelColor() }, top: 0, selected: { '95% PI': true, '80% PI': true } },
      grid: { left: 60, right: 30, top: 36, bottom: 50, containLabel: true },
      xAxis: { type: 'time', axisLabel: baseAxisLabel(), axisLine: baseAxisLine(), axisTick: { lineStyle: { color: chartGridColor() } } },
      yAxis: { type: 'value', name: 'MW', nameTextStyle: { color: axisLabelColor() }, axisLabel: baseAxisLabel(), splitLine: baseSplitLine(), axisLine: baseAxisLine() },
      series: [
        { name: '_l95f', type: 'line', data: l95Data, stack: 'fpi95', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, silent: true, animation: false },
        { name: '95% PI', type: 'line', data: band95, stack: 'fpi95', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { color: 'rgba(99,102,241,0.10)' }, silent: true, animation: false },
        { name: '_l80f', type: 'line', data: l80Data, stack: 'fpi80', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, silent: true, animation: false },
        { name: '80% PI', type: 'line', data: band80, stack: 'fpi80', showSymbol: false, lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 }, areaStyle: { color: 'rgba(99,102,241,0.18)' }, silent: true, animation: false },
        {
          name: 'Predicted load', type: 'line', data: predData, showSymbol: false, smooth: true,
          lineStyle: { color: '#06b6d4', width: 2 }, itemStyle: { color: '#06b6d4' },
          markPoint: {
            symbol: 'circle', symbolSize: 8,
            itemStyle: { color: '#ef4444' },
            label: { formatter: function (p) { return Math.round(p.value).toLocaleString('en-US'); }, color: '#ef4444', position: 'top', fontSize: 10, fontWeight: 'bold' },
            data: peaks
          }
        }
      ]
    };
  }

  // ─── Chart init / dispose / resize helpers ──────────────────────────────────
  function initChart(el, config) {
    if (!el) return null;
    if (state.charts[el.id]) {
      try { state.charts[el.id].dispose(); } catch (e) {}
    }
    try {
      var inst = echarts.init(el, null, { renderer: 'canvas' });
      inst.setOption(config);
      state.charts[el.id] = inst;
      return inst;
    } catch (e) {
      el.innerHTML = '<div class="lf-chart-empty">Chart rendering failed.</div>';
      return null;
    }
  }
  function disposeChart(id) {
    if (state.charts[id]) {
      try { state.charts[id].dispose(); } catch (e) {}
      delete state.charts[id];
    }
  }
  function disposeAllCharts() {
    Object.keys(state.charts).forEach(disposeChart);
  }
  function resizeAllCharts() {
    Object.keys(state.charts).forEach(function (id) {
      if (state.charts[id]) { try { state.charts[id].resize(); } catch (e) {} }
    });
  }
  // Lazy chart renderer — loads ECharts then initializes the chart in the
  // given element id with the given config factory. If ECharts fails to load,
  // shows a friendly "couldn't load" message in place.
  function renderChartInto(elId, configFactory) {
    var el = $(elId);
    if (!el) return;
    loadScript('echarts').then(function () {
      initChart(el, configFactory());
    }).catch(function () {
      el.innerHTML = '<div class="lf-chart-empty">Couldn\u2019t load the chart library.</div>';
    });
  }

  // ─── Sub-renderers ───────────────────────────────────────────────────────────
  // Each writes into a fixed-id slot inside the mount. render() calls them in
  // order; each no-ops its slot when its slice of state is absent.

  // 1. Location card
  function renderLocationCard() {
    var slot = $('lf-location-slot');
    if (!slot) return;
    if (state.locationLoading) {
      slot.innerHTML = '\
        <div class="lf-card">\
          <div class="lf-card-step">Step 1</div>\
          <h3 class="lf-card-title">Your location</h3>\
          <p class="lf-card-sub">We use your real coordinates to pull live weather from Open-Meteo.</p>\
          <div class="lf-loading-block">\
            <div class="lf-spinner"></div>\
            <div>Detecting your location\u2026</div>\
            <div class="lf-loading-sub">Allow location permission in your browser. Falls back to Toronto after 10s.</div>\
          </div>\
        </div>';
      return;
    }
    if (state.locationError) {
      slot.innerHTML = '\
        <div class="lf-card">\
          <div class="lf-card-step">Step 1</div>\
          <h3 class="lf-card-title">Your location</h3>\
          <div class="lf-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.locationError) + '</div>\
          <button class="btn btn-ghost lf-btn-sm" id="lf-retry-loc" type="button"><i class="fas fa-rotate-right"></i> Retry</button>\
        </div>';
      return;
    }
    if (!state.location) {
      slot.innerHTML = '\
        <div class="lf-card">\
          <div class="lf-card-step">Step 1</div>\
          <h3 class="lf-card-title">Your location</h3>\
          <p class="lf-card-sub">We use your real coordinates to pull live weather from Open-Meteo. Falls back to Toronto if denied.</p>\
          <div class="lf-btn-row">\
            <button class="btn btn-primary lf-btn-sm" id="lf-detect-loc" type="button"><i class="fas fa-location-crosshairs"></i><span class="btn-text">Detect my location</span></button>\
            <button class="btn btn-ghost lf-btn-sm" id="lf-manual-loc" type="button"><i class="fas fa-keyboard"></i> Enter manually</button>\
          </div>\
          <div id="lf-manual-loc-row" style="display:none;margin-top:14px;">\
            <div class="lf-input-row">\
              <label for="lf-lat">Lat</label>\
              <input class="lf-input" id="lf-lat" type="number" step="0.0001" placeholder="43.6532" />\
              <label for="lf-lon">Lon</label>\
              <input class="lf-input" id="lf-lon" type="number" step="0.0001" placeholder="-79.3832" />\
              <button class="btn btn-ghost lf-btn-sm" id="lf-use-manual" type="button">Use</button>\
            </div>\
          </div>\
        </div>';
      return;
    }
    var loc = state.location;
    var iconCls = loc.source === 'fallback' ? 'fa-location-dot' : 'fa-location-crosshairs';
    var sourceNote = loc.source === 'fallback'
      ? (loc.reason || 'Fell back to Toronto — using default coordinates.')
      : 'Detected via browser geolocation' + (loc.label ? ' \u00b7 reverse-geocoded via Open-Meteo' : '');
    var weatherBtn = state.weatherLoading
      ? '<div class="lf-loading"><div class="lf-spinner"></div>Fetching real historical + forecast weather\u2026</div>'
      : (state.weatherError
        ? '<div class="lf-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.weatherError) + ' <button class="btn btn-ghost lf-btn-sm" id="lf-retry-weather" type="button">Retry</button></div>'
        : (state.weatherHistory
          ? '<div class="lf-warn"><i class="fas fa-check"></i> Weather data loaded — proceed to Step 2.</div>'
          : ''));
    var fetchBtn = (!state.weatherHistory && !state.weatherLoading && !state.weatherError)
      ? '<button class="btn btn-primary lf-btn-sm" id="lf-fetch-weather" type="button"><i class="fas fa-cloud-bolt"></i><span class="btn-text">Fetch weather data</span></button>'
      : '';
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Step 1</div>\
        <h3 class="lf-card-title">Your location</h3>\
        <p class="lf-card-sub">We use your real coordinates to pull live weather from Open-Meteo.</p>\
        <div class="lf-location-card">\
          <div class="lf-location-row">\
            <div class="lf-location-icon"><i class="fas ' + iconCls + '"></i></div>\
            <div style="flex:1;min-width:0;">\
              <div class="lf-location-label">Weather data for: ' + esc(loc.label) + '</div>\
              <div class="lf-location-meta">' + loc.lat.toFixed(4) + '\u00b0N, ' + Math.abs(loc.lon).toFixed(4) + '\u00b0' + (loc.lon >= 0 ? 'E' : 'W') + ' \u00b7 ' + esc(sourceNote) + '</div>\
            </div>\
            <button class="btn btn-ghost lf-btn-sm" id="lf-redetect-loc" type="button"><i class="fas fa-rotate-right"></i> Re-detect</button>\
          </div>\
        </div>\
        <div class="lf-btn-row">' + fetchBtn + '</div>\
        ' + weatherBtn + '\
      </div>';
  }

  // 2. Weather data card (shows after fetch)
  function renderWeatherCard() {
    var slot = $('lf-weather-slot');
    if (!slot) return;
    if (!state.weatherHistory) { slot.innerHTML = ''; return; }
    var wH = state.weatherHistory;
    var wF = state.weatherForecast;
    var nH = wH.time.length;
    var nF = wF.time.length;
    var firstDate = fmtDate(wH.time[0]);
    var lastDate  = fmtDate(wH.time[nH - 1]);
    var foreFirst = fmtDate(wF.time[0]);
    var foreLast  = fmtDate(wF.time[nF - 1]);
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Weather loaded</div>\
        <h3 class="lf-card-title">Real historical + forecast weather</h3>\
        <p class="lf-card-sub">' + nH.toLocaleString() + ' hours of historical weather (' + firstDate + ' \u2192 ' + lastDate + ') + ' + nF.toLocaleString() + ' hours of forecast (' + foreFirst + ' \u2192 ' + foreLast + '). Variables: temperature, humidity, precipitation, wind speed, solar radiation, surface pressure, weather codes. Source: Open-Meteo (free, no API key, CORS-enabled).</p>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-temperature-half"></i> Temperature \u2014 last 30 days historical + 14-day forecast</p>\
          <div class="lf-chart-body" id="lf-chart-temp-mini"></div>\
        </div>\
      </div>';
    renderChartInto('lf-chart-temp-mini', chartTemperatureMini);
  }

  // 3. Load data card (synthetic load + temperature overlay)
  function renderLoadCard() {
    var slot = $('lf-load-slot');
    if (!slot) return;
    if (!state.loadData) { slot.innerHTML = ''; return; }
    var n = state.loadData.load.length;
    var meanLoad = vecMean(state.loadData.load);
    var peakLoad = Math.max.apply(null, state.loadData.load);
    var troughLoad = Math.min.apply(null, state.loadData.load);
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Synthetic load generated</div>\
        <h3 class="lf-card-title">Realistic synthetic electricity load</h3>\
        <p class="lf-card-sub">' + n.toLocaleString() + ' hourly observations generated FROM the real weather using realistic utility load patterns: 18-20 GW peak, 13 GW trough, mean ~' + fmtMW1(meanLoad) + '. Weather-driven: temperature (heating/cooling change-point), humidity, wind, solar, precipitation. Calendar: hour-of-day, day-of-week, weekend reduction. Realistic Gaussian noise (\u03c3 = 0.3 GW). The model will DISCOVER the coefficients from data.</p>\
        <div class="lf-stat-grid">\
          <div class="lf-stat"><div class="lf-stat-label">Mean load</div><div class="lf-stat-value">' + fmtMW1(meanLoad) + '</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Peak</div><div class="lf-stat-value">' + fmtMW1(peakLoad) + '</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Trough</div><div class="lf-stat-value">' + fmtMW1(troughLoad) + '</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Observations</div><div class="lf-stat-value">' + n.toLocaleString() + '</div><div class="lf-stat-sub">hourly</div></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-chart-line"></i> Hourly load + temperature \u2014 last 30 days</p>\
          <div class="lf-chart-body" id="lf-chart-load-overlay"></div>\
        </div>\
      </div>';
    renderChartInto('lf-chart-load-overlay', chartLoadOverlay);
  }

  // 4. Model training card
  function renderModelCard() {
    var slot = $('lf-model-slot');
    if (!slot) return;
    if (!state.loadData) { slot.innerHTML = ''; return; }
    // Feature list
    var features = [
      { name: 'hour_sin / hour_cos', type: 'cyclical' },
      { name: 'dow_sin / dow_cos', type: 'cyclical' },
      { name: 'month_sin / month_cos', type: 'cyclical' },
      { name: 'is_weekend', type: 'binary' },
      { name: 'temperature', type: 'continuous' },
      { name: 'temperature_sq', type: 'continuous' },
      { name: 'heating_degree', type: 'change-point' },
      { name: 'cooling_degree', type: 'change-point' },
      { name: 'humidity', type: 'continuous' },
      { name: 'humidity_excess', type: 'continuous' },
      { name: 'wind_speed', type: 'continuous' },
      { name: 'solar_radiation', type: 'continuous' },
      { name: 'precipitation', type: 'continuous' },
      { name: 'pressure', type: 'continuous' },
      { name: 'lag_1h', type: 'autoregressive' },
      { name: 'lag_24h', type: 'autoregressive' }
    ];
    var featureHTML = features.map(function (f) {
      return '<span class="lf-feature-pill">' + esc(f.name) + '<span class="lf-feature-type">' + esc(f.type) + '</span></span>';
    }).join('');
    var trainBtn = state.modelLoading
      ? '<div class="lf-loading"><div class="lf-spinner"></div>Training OLS regression + detecting change-point\u2026</div>'
      : (state.modelError
        ? '<div class="lf-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.modelError) + '</div>'
        : '');
    var fetchBtn = (!state.model && !state.modelLoading && !state.modelError)
      ? '<button class="btn btn-primary lf-btn-sm" id="lf-train-model" type="button"><i class="fas fa-brain"></i><span class="btn-text">Train model</span></button>'
      : (!state.model ? '<button class="btn btn-ghost lf-btn-sm" id="lf-train-model" type="button"><i class="fas fa-rotate-right"></i> Retry training</button>' : '');
    var modelHTML = '';
    if (state.model) {
      var m = state.model;
      var adjR2Pct = (m.adjR2 * 100).toFixed(1);
      var r2Pct = (m.r2 * 100).toFixed(1);
      // Coefficient table
      var coefRows = '';
      for (var i = 0; i < m.featureNames.length; i++) {
        var sig = m.pValue[i] < 0.001 ? '***' : (m.pValue[i] < 0.01 ? '**' : (m.pValue[i] < 0.05 ? '*' : ''));
        var significant = m.pValue[i] < 0.05 ? ' lf-coef-row-significant' : '';
        var stdBeta = m.standardizedBetas[i];
        coefRows += '<tr class="' + significant + '">'
          + '<td>' + esc(m.featureNames[i]) + (sig ? ' ' + sig : '') + '</td>'
          + '<td class="num">' + fmtNum(m.beta[i], 4) + '</td>'
          + '<td class="num">' + fmtNum(m.se[i], 4) + '</td>'
          + '<td class="num">' + fmtNum(m.tStat[i], 2) + '</td>'
          + '<td class="num">' + (m.pValue[i] < 0.0001 ? '<0.0001' : m.pValue[i].toFixed(4)) + '</td>'
          + '<td class="num">' + (i === 0 ? '\u2014' : fmtNum(Math.abs(stdBeta), 4)) + '</td>'
          + '</tr>';
      }
      // AVP window toggle
      var winBtns = [7, 30, 365].map(function (d) {
        return '<button class="lf-window-toggle ' + (state.avpWindow === d ? 'lf-active' : '') + '" data-lf-window="' + d + '" type="button">Last ' + d + 'd</button>';
      }).join('');
      modelHTML = '\
        <div class="lf-stat-grid">\
          <div class="lf-stat"><div class="lf-stat-label">R\u00b2</div><div class="lf-stat-value">' + r2Pct + '%</div><div class="lf-stat-sub">variance explained</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Adjusted R\u00b2</div><div class="lf-stat-value">' + adjR2Pct + '%</div><div class="lf-stat-sub">penalized for # features</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">RMSE</div><div class="lf-stat-value">' + fmtMW1(m.rmse) + '</div><div class="lf-stat-sub">root mean sq error</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">MAE</div><div class="lf-stat-value">' + fmtMW1(m.mae) + '</div><div class="lf-stat-sub">mean abs error</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">MAPE</div><div class="lf-stat-value">' + m.mape.toFixed(2) + '%</div><div class="lf-stat-sub">mean abs % error</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Change-point</div><div class="lf-stat-value">' + m.changePoint.toFixed(1) + '\u00b0C</div><div class="lf-stat-sub">detected from data</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Heating slope</div><div class="lf-stat-value">' + fmtMW1(m.heatingSlope) + '/\u00b0C</div><div class="lf-stat-sub">below BP</div></div>\
          <div class="lf-stat"><div class="lf-stat-label">Cooling slope</div><div class="lf-stat-value">' + fmtMW1(m.coolingSlope) + '/\u00b0C</div><div class="lf-stat-sub">above BP</div></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-ranking-star"></i> Variable importance \u2014 top 12 by |standardized coefficient|</p>\
          <div class="lf-chart-body" id="lf-chart-importance" style="height:380px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-temperature-half"></i> Temperature response curve \u2014 predicted load vs temperature (other features at mean)</p>\
          <div class="lf-chart-body" id="lf-chart-temp-response" style="height:320px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-chart-area"></i> Actual vs predicted \u2014 with 80% + 95% prediction intervals</p>\
          <div class="lf-window-toggle-row">' + winBtns + '</div>\
          <div class="lf-chart-body" id="lf-chart-avp" style="height:380px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-chart-column"></i> Residual histogram \u2014 prediction errors (\u00b13\u03c3)</p>\
          <div class="lf-chart-body" id="lf-chart-residual" style="height:280px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-wave-square"></i> Residual autocorrelation \u2014 unexplained structure (lags 1-48h)</p>\
          <div class="lf-chart-body" id="lf-chart-acf" style="height:260px;"></div>\
          <p class="lf-card-sub" style="margin-top:8px;">Significant spikes (beyond red dashed 95% CI) at lag-24 indicate residual daily-cycle structure the model has not fully captured \u2014 a known signature of utility load.</p>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-table"></i> Coefficient table \u2014 feature | \u03b2 | std error | t-stat | p-value | standardized</p>\
          <div class="lf-table-wrap">\
            <table class="lf-table">\
              <thead><tr><th>Feature</th><th class="num">Coefficient</th><th class="num">Std Error</th><th class="num">t-stat</th><th class="num">p-value</th><th class="num">|Std \u03b2|</th></tr></thead>\
              <tbody>' + coefRows + '</tbody>\
            </table>\
          </div>\
          <p class="lf-card-sub" style="margin-top:8px;">Significance: *** p&lt;0.001, ** p&lt;0.01, * p&lt;0.05. Bold rows are statistically significant. Heating/cooling slopes are discovered from data via change-point detection (10\u00b0C \u2192 25\u00b0C sweep, 0.5\u00b0C steps).</p>\
        </div>';
    }
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Step 2</div>\
        <h3 class="lf-card-title">Train the model</h3>\
        <p class="lf-card-sub">Ordinary Least Squares regression with change-point detection. All math is implemented from scratch in vanilla JS \u2014 no math library. 17 features engineered from real weather + timestamps.</p>\
        <div class="lf-features-grid">' + featureHTML + '</div>\
        <div class="lf-btn-row">' + fetchBtn + '</div>\
        ' + trainBtn + '\
        ' + modelHTML + '\
      </div>';
    if (state.model) {
      renderChartInto('lf-chart-importance', chartVariableImportance);
      renderChartInto('lf-chart-temp-response', chartTemperatureResponse);
      renderChartInto('lf-chart-avp', chartActualVsPredicted);
      renderChartInto('lf-chart-residual', chartResidualHistogram);
      renderChartInto('lf-chart-acf', chartResidualAutocorrelation);
    }
  }

  // 5. Forecast card (14-day)
  function renderForecastCard() {
    var slot = $('lf-forecast-slot');
    if (!slot) return;
    if (!state.forecast) { slot.innerHTML = ''; return; }
    var daily = state.forecast.daily;
    var t = state.thresholds;
    var peakLoads = daily.map(function (d) { return d.peakLoad; });
    var maxPeak = Math.max.apply(null, peakLoads);
    var minPeak = Math.min.apply(null, peakLoads);
    // Threshold sliders
    var sliderHTML = '\
      <div class="lf-threshold-row">\
        <div class="lf-threshold-label">P90 (Elevated threshold) <span>' + fmtMW(t.custom.p90) + '</span></div>\
        <input type="range" min="' + Math.floor(minPeak - 200) + '" max="' + Math.ceil(maxPeak + 200) + '" step="50" value="' + t.custom.p90 + '" id="lf-slider-p90" />\
      </div>\
      <div class="lf-threshold-row">\
        <div class="lf-threshold-label">P95 (High threshold) <span>' + fmtMW(t.custom.p95) + '</span></div>\
        <input type="range" min="' + Math.floor(minPeak - 200) + '" max="' + Math.ceil(maxPeak + 200) + '" step="50" value="' + t.custom.p95 + '" id="lf-slider-p95" />\
      </div>\
      <div class="lf-threshold-row">\
        <div class="lf-threshold-label">P99 (Critical threshold) <span>' + fmtMW(t.custom.p99) + '</span></div>\
        <input type="range" min="' + Math.floor(minPeak - 200) + '" max="' + Math.ceil(maxPeak + 200) + '" step="50" value="' + t.custom.p99 + '" id="lf-slider-p99" />\
      </div>\
      <div class="lf-btn-row">\
        <button class="btn btn-ghost lf-btn-sm" id="lf-reset-thresholds" type="button"><i class="fas fa-rotate-left"></i> Reset to defaults</button>\
      </div>';
    // Daily summary table
    var rowsHTML = daily.map(function (d) {
      var pillCls = 'lf-pill-' + d.riskLevel.toLowerCase();
      return '<tr>'
        + '<td>' + fmtDateShort(d.date) + '</td>'
        + '<td class="num">' + fmtMW(d.peakLoad) + '</td>'
        + '<td class="num">' + fmtMW(d.avgLoad) + '</td>'
        + '<td>' + esc(d.mainDriver) + '</td>'
        + '<td>' + d.maxTemp.toFixed(1) + '\u00b0C / ' + d.minTemp.toFixed(1) + '\u00b0C</td>'
        + '<td><span class="lf-pill ' + pillCls + '">' + esc(d.riskLevel) + '</span></td>'
        + '<td>' + esc(d.recommendation) + '</td>'
        + '</tr>';
    }).join('');
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Step 3</div>\
        <h3 class="lf-card-title">14-day load forecast</h3>\
        <p class="lf-card-sub">Trained model applied recursively to the 14-day weather forecast. Daily peak / avg aggregated from hourly predictions. Risk thresholds default to P90 / P95 / P99 of historical daily peaks \u2014 adjust below.</p>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-cloud-sun"></i> 14-day weather forecast \u2014 temperature, humidity, wind, precipitation</p>\
          <div class="lf-chart-body" id="lf-chart-forecast-weather" style="height:340px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-bolt"></i> 14-day load forecast \u2014 predicted hourly load with 80% + 95% prediction intervals. Red dots mark daily peaks.</p>\
          <div class="lf-chart-body" id="lf-chart-forecast-load" style="height:380px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-chart-column"></i> Daily peaks \u2014 color-coded by risk level (Normal/Elevated/High/Critical)</p>\
          <div class="lf-chart-body" id="lf-chart-daily-peaks" style="height:280px;"></div>\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-sliders"></i> Operational thresholds \u2014 adjust to recalibrate risk levels</p>\
          ' + sliderHTML + '\
        </div>\
        <div class="lf-chart-card">\
          <p class="lf-chart-title"><i class="fas fa-table"></i> Daily summary \u2014 date | peak | avg | main driver | temps | risk | recommendation</p>\
          <div class="lf-table-wrap">\
            <table class="lf-table">\
              <thead><tr><th>Date</th><th class="num">Peak</th><th class="num">Avg</th><th>Main driver</th><th>Hi / Lo</th><th>Risk</th><th>Recommendation</th></tr></thead>\
              <tbody>' + rowsHTML + '</tbody>\
            </table>\
          </div>\
        </div>\
      </div>';
    renderChartInto('lf-chart-forecast-weather', chartForecastWeather);
    renderChartInto('lf-chart-forecast-load', chartForecastLoad);
    renderChartInto('lf-chart-daily-peaks', chartDailyPeaks);
  }

  // 6. AI Q&A card
  function renderAQCard() {
    var slot = $('lf-ai-qa-slot');
    if (!slot) return;
    if (!state.forecast || !state.model) { slot.innerHTML = ''; return; }
    var suggestions = [
      'Why is load expected to increase on Thursday?',
      'What\u2019s the main driver of tomorrow\u2019s peak?',
      'Which days require elevated readiness?',
      'How does temperature affect the forecast?'
    ];
    var chips = suggestions.map(function (q) {
      return '<button class="lf-chip" data-lf-suggest="' + esc(q) + '" type="button">' + esc(q) + '</button>';
    }).join('');
    var loadingHTML = state.aiLoading
      ? '<div class="lf-loading"><div class="lf-spinner"></div>AI is analyzing the forecast + model coefficients\u2026</div>'
      : '';
    var errHTML = state.aiError
      ? '<div class="lf-error"><i class="fas fa-triangle-exclamation"></i> ' + esc(state.aiError) + '</div>'
      : '';
    var resultHTML = '';
    if (state.aiResult) {
      var textHTML = esc(state.aiResult).replace(/\r?\n/g, '<br>');
      resultHTML = '<div class="lf-ai-result-card"><div class="lf-ai-result-text">' + textHTML + '</div></div>';
    }
    var remaining = remainingGroqCalls();
    var rateNote = '<div class="lf-rate-note">' + remaining + ' / ' + MAX_GROQ_CALLS + ' AI calls remaining this session</div>';
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Step 4</div>\
        <h3 class="lf-card-title">Ask the AI</h3>\
        <p class="lf-card-sub">The AI uses the model\u2019s LEARNED coefficients (not assumptions) to explain forecast drivers in plain English. Powered by Groq via the Netlify proxy.</p>\
        <div class="lf-chips">' + chips + '</div>\
        <div class="lf-qa-input">\
          <input class="lf-input" id="lf-ai-question" type="text" placeholder="Ask a question about the forecast\u2026" value="' + esc(state.aiQuestion) + '" />\
          <button class="btn btn-primary lf-btn-sm" id="lf-ask-ai" type="button" ' + (state.aiLoading || !canCallGroq() ? 'disabled' : '') + '><i class="fas fa-paper-plane"></i><span class="btn-text">Ask</span></button>\
        </div>\
        ' + loadingHTML + '\
        ' + errHTML + '\
        ' + resultHTML + '\
        ' + rateNote + '\
      </div>';
    // Note: the input + keydown handlers are wired at the mount level in
    // wireEvents() — we don't attach them here because (a) renderAQCard runs
    // on every state change and re-attaching listeners leaks, and (b) we'd
    // double-fire on Enter (input-level + mount-level both catch the event
    // as it bubbles). The mount-level handler is the single source of truth.
  }

  // 7. Daily briefings card
  function renderBriefingsCard() {
    var slot = $('lf-briefings-slot');
    if (!slot) return;
    if (!state.briefings) { slot.innerHTML = ''; return; }
    var briefings = state.briefings;
    var loadingHTML = state.briefingsLoading
      ? '<div class="lf-loading"><div class="lf-spinner"></div>AI is narrating operational briefings\u2026</div>'
      : '';
    var errHTML = state.briefingsError
      ? '<div class="lf-warn"><i class="fas fa-circle-info"></i> ' + esc(state.briefingsError) + ' Showing locally-computed briefings.</div>'
      : '';
    var cardsHTML = briefings.map(function (b, idx) {
      var pillCls = 'lf-pill-' + b.riskLevel.toLowerCase();
      var narrationHTML = b.aiNarration
        ? '<div class="lf-briefing-narration">' + esc(b.aiNarration).replace(/\r?\n/g, '<br>') + '</div>'
        : '';
      return '<div class="lf-briefing">\
        <div class="lf-briefing-head">\
          <div>\
            <div class="lf-briefing-date">' + fmtDateShort(b.date) + ' \u00b7 Day ' + (idx + 1) + '</div>\
            <div class="lf-briefing-load">' + fmtMW(b.peakLoad) + ' peak @ ' + b.peakTime + '</div>\
          </div>\
          <span class="lf-pill ' + pillCls + '">' + esc(b.riskLevel) + '</span>\
        </div>\
        <div class="lf-briefing-lines">\
          <div><strong>Expected Load:</strong> ' + fmtMW(b.peakLoad) + ' (peak at ' + b.peakTime + ', avg ' + fmtMW1(b.avgLoad) + ')</div>\
          <div><strong>Main Drivers:</strong> ' + esc(b.mainDrivers) + '</div>\
          <div><strong>Risk Level:</strong> ' + esc(b.riskLevel) + '</div>\
          <div><strong>Recommended Action:</strong> ' + esc(b.recommendation) + '</div>\
        </div>\
        ' + narrationHTML + '\
      </div>';
    }).join('');
    var remaining = remainingGroqCalls();
    var rateNote = '<div class="lf-rate-note">' + remaining + ' / ' + MAX_GROQ_CALLS + ' AI calls remaining this session</div>';
    var narrateBtn = state.briefingsLoading
      ? ''
      : '<button class="btn btn-primary lf-btn-sm" id="lf-narrate-briefings" type="button" ' + (!canCallGroq() ? 'disabled' : '') + '><i class="fas fa-wand-magic-sparkles"></i><span class="btn-text">Generate AI-narrated briefings</span></button>';
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Step 5</div>\
        <h3 class="lf-card-title">Daily operational briefings</h3>\
        <p class="lf-card-sub">14 daily cards. Locally-computed structure (Expected Load / Main Drivers / Risk / Action) is always shown. The optional AI narration button calls Groq once for polished paragraph briefings using the model\u2019s learned coefficients.</p>\
        <div class="lf-btn-row">' + narrateBtn + '</div>\
        ' + loadingHTML + '\
        ' + errHTML + '\
        ' + cardsHTML + '\
        ' + rateNote + '\
      </div>';
  }

  // 8. Export card
  function renderExportCard() {
    var slot = $('lf-export-slot');
    if (!slot) return;
    if (!state.forecast || !state.model) { slot.innerHTML = ''; return; }
    slot.innerHTML = '\
      <div class="lf-card">\
        <div class="lf-card-step">Step 6</div>\
        <h3 class="lf-card-title">Export results</h3>\
        <p class="lf-card-sub">Download the full dataset (historical actual vs predicted + 14-day forecast), or share via email.</p>\
        <div class="lf-btn-row">\
          <button class="btn btn-ghost lf-btn-sm" id="lf-export-csv" type="button"><i class="fas fa-file-csv"></i> CSV (forecast + actuals)</button>\
          <button class="btn btn-ghost lf-btn-sm" id="lf-export-excel" type="button"><i class="fas fa-file-excel"></i> Excel (multi-sheet)</button>\
          <button class="btn btn-ghost lf-btn-sm" id="lf-export-json" type="button"><i class="fas fa-file-code"></i> JSON (full results)</button>\
          <div class="lf-spacer"></div>\
          <button class="btn btn-primary lf-btn-sm" id="lf-email-results" type="button"><i class="fas fa-envelope"></i> Email results</button>\
        </div>\
      </div>';
  }

  // ─── Top-level render ──────────────────────────────────────────────────────
  // Rebuilds the mount's slot skeleton, then calls each sub-renderer. Slot IDs
  // are stable so event delegation (bound once on the mount) keeps working.
  function render() {
    var mount = $(MOUNT_ID);
    if (!mount) return;
    disposeAllCharts();
    mount.innerHTML = '\
      <div class="lf-app">\
        <div id="lf-location-slot"></div>\
        <div id="lf-weather-slot"></div>\
        <div id="lf-load-slot"></div>\
        <div id="lf-model-slot"></div>\
        <div id="lf-forecast-slot"></div>\
        <div id="lf-ai-qa-slot"></div>\
        <div id="lf-briefings-slot"></div>\
        <div id="lf-export-slot"></div>\
      </div>';
    renderLocationCard();
    renderWeatherCard();
    renderLoadCard();
    renderModelCard();
    renderForecastCard();
    renderAQCard();
    renderBriefingsCard();
    renderExportCard();
  }

  // Partial re-render — only one slot. Avoids nuking the whole mount when only
  // one card changed (keeps chart instances + scroll position stable).
  function renderSlot(name) {
    if (name === 'location')   renderLocationCard();
    if (name === 'weather')    renderWeatherCard();
    if (name === 'load')       renderLoadCard();
    if (name === 'model')      renderModelCard();
    if (name === 'forecast')   renderForecastCard();
    if (name === 'qa')         renderAQCard();
    if (name === 'briefings')  renderBriefingsCard();
    if (name === 'export')     renderExportCard();
  }

  // ─── Event handlers ─────────────────────────────────────────────────────────

  function onDetectLocationClick() {
    state.locationLoading = true; state.locationError = null;
    renderSlot('location');
    detectLocation().then(function (loc) {
      state.locationLoading = false;
      state.location = loc;
      // Auto-fetch weather once location is known.
      renderSlot('location');
      onFetchWeatherClick();
    });
  }

  function onManualLocationToggle() {
    var row = $('lf-manual-loc-row');
    if (row) row.style.display = row.style.display === 'none' ? 'block' : 'none';
  }

  function onUseManualLocation() {
    var lat = parseFloat(($('lf-lat') || {}).value);
    var lon = parseFloat(($('lf-lon') || {}).value);
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      state.locationError = 'Please enter valid latitude (\u00b190) and longitude (\u00b1180).';
      renderSlot('location');
      return;
    }
    state.locationLoading = true; state.locationError = null; state.location = null;
    renderSlot('location');
    reverseGeocode(lat, lon).then(function (label) {
      state.locationLoading = false;
      state.location = {
        lat: lat, lon: lon,
        label: label || (lat.toFixed(4) + '\u00b0, ' + lon.toFixed(4) + '\u00b0'),
        source: 'manual'
      };
      renderSlot('location');
      onFetchWeatherClick();
    });
  }

  function onFetchWeatherClick() {
    if (!state.location) return;
    state.weatherLoading = true; state.weatherError = null;
    state.weatherHistory = null; state.weatherForecast = null; state.loadData = null;
    state.model = null; state.forecast = null; state.briefings = null;
    state.aiResult = null; state.aiError = null;
    disposeAllCharts();
    renderSlot('location');
    renderSlot('weather');
    renderSlot('load');
    renderSlot('model');
    renderSlot('forecast');
    renderSlot('qa');
    renderSlot('briefings');
    renderSlot('export');
    var loc = state.location;
    var tasks = [
      fetchHistoricalWeather(loc.lat, loc.lon),
      fetchForecastWeather(loc.lat, loc.lon)
    ];
    Promise.all(tasks).then(function (results) {
      state.weatherHistory = results[0];
      state.weatherForecast = results[1];
      state.weatherLoading = false;
      // Generate synthetic load from real weather — seed by lat/lon so it's
      // reproducible per location.
      var seedSalt = Math.floor(Math.abs(loc.lat * 1000) + Math.abs(loc.lon * 1000));
      var load = generateLoad(state.weatherHistory, state.weatherHistory.time, seedSalt);
      state.loadData = { timestamps: state.weatherHistory.time, load: load, weather: state.weatherHistory };
      renderSlot('location');
      renderSlot('weather');
      renderSlot('load');
    }).catch(function (e) {
      state.weatherLoading = false;
      state.weatherError = (e && e.message) || 'Failed to fetch weather from Open-Meteo.';
      renderSlot('location');
    });
  }

  function onTrainModelClick() {
    if (!state.loadData) return;
    state.modelLoading = true; state.modelError = null;
    state.model = null; state.forecast = null; state.briefings = null;
    state.aiResult = null; state.aiError = null;
    disposeAllCharts();
    renderSlot('model');
    renderSlot('forecast');
    renderSlot('qa');
    renderSlot('briefings');
    renderSlot('export');
    // Defer the heavy compute to next tick so the loading spinner paints.
    setTimeout(function () {
      try {
        trainModel();
        state.modelLoading = false;
        // Apply the trained model to the 14-day forecast.
        applyModelToForecast();
        renderSlot('model');
        renderSlot('forecast');
        renderSlot('qa');
        renderSlot('briefings');
        renderSlot('export');
      } catch (e) {
        state.modelLoading = false;
        state.modelError = (e && e.message) || 'Training failed.';
        renderSlot('model');
      }
    }, 30);
  }

  function onThresholdChange(which, value) {
    if (!state.thresholds.custom) state.thresholds.custom = { p90: null, p95: null, p99: null };
    state.thresholds.custom[which] = value;
    // Enforce ordering: p90 <= p95 <= p99
    var c = state.thresholds.custom;
    if (c.p90 > c.p95) { state.thresholds.custom.p90 = c.p95; }
    if (c.p95 > c.p99) { state.thresholds.custom.p95 = c.p99; }
    assignRiskLevels();
    computeLocalBriefings();
    // Don't re-render the chart elements — just the table + sliders.
    renderSlot('forecast');
    renderSlot('briefings');
  }

  function onResetThresholds() {
    state.thresholds.custom = {
      p90: state.thresholds.p90,
      p95: state.thresholds.p95,
      p99: state.thresholds.p99
    };
    assignRiskLevels();
    computeLocalBriefings();
    renderSlot('forecast');
    renderSlot('briefings');
  }

  function onAskAIClick() {
    if (!state.forecast || !state.model) return;
    var q = (state.aiQuestion || '').trim();
    if (!q) return;
    if (!canCallGroq()) {
      state.aiError = 'Demo rate limit reached — ' + MAX_GROQ_CALLS + ' AI calls this session. Refresh the page to try again.';
      renderSlot('qa');
      return;
    }
    state.aiLoading = true; state.aiError = null; state.aiResult = null;
    renderSlot('qa');
    callGroq(
      [{ role: 'system', content: buildQASystemPrompt() },
       { role: 'user',   content: buildQAUserPrompt(q) }],
      { temperature: 0.3, max_tokens: 700 }
    ).then(function (text) {
      state.aiLoading = false;
      state.aiResult = text;
      renderSlot('qa');
    }).catch(function (e) {
      state.aiLoading = false;
      state.aiError = (e && e.message) || 'AI request failed.';
      renderSlot('qa');
    });
  }

  function buildQASystemPrompt() {
    return 'You are an analyst explaining weather-driven electricity load forecasts. ' +
      'Use the model\u2019s ACTUAL learned coefficients (provided in the user message) — never assume generic values. ' +
      'Be specific about which weather variables drive the forecast and by how much. ' +
      'Plain text, 3-5 sentences. No markdown, no headers, no bullet points.';
  }
  function buildQAUserPrompt(question) {
    var m = state.model;
    var daily = state.forecast.daily;
    var featIdx = m.featureNames;
    var summary = daily.map(function (d, i) {
      return 'Day ' + (i + 1) + ' (' + fmtDateShort(d.date) + '): peak ' + Math.round(d.peakLoad) +
        ' MW at ' + d.peakTime + ', max temp ' + d.maxTemp.toFixed(1) + '°C, avg humidity ' + Math.round(d.avgHumid) +
        '%, wind ' + d.maxWind.toFixed(1) + ' m/s, precip ' + d.totalPrecip.toFixed(1) + 'mm, risk ' + d.riskLevel +
        '. Main driver: ' + d.mainDriver + '.';
    }).join('\n');
    return 'User question: "' + question + '"\n\n' +
      'Model context (LEARNED from data — not assumed):\n' +
      '- Detected change-point (balance temperature): ' + m.changePoint.toFixed(1) + '°C\n' +
      '- Heating slope (below BP): ' + m.heatingSlope.toFixed(3) + ' GW per °C\n' +
      '- Cooling slope (above BP): ' + m.coolingSlope.toFixed(3) + ' GW per °C\n' +
      '- Residual std dev (σ): ' + m.sigma.toFixed(3) + ' GW\n' +
      '- R²: ' + (m.r2 * 100).toFixed(1) + '%, MAPE: ' + m.mape.toFixed(2) + '%\n' +
      '- Top 5 features by |standardized coefficient|: ' +
        m.variableImportance.slice(0, 5).map(function (v) { return v.feature + ' (' + v.importance.toFixed(3) + ')'; }).join(', ') + '\n\n' +
      '14-day forecast summary:\n' + summary + '\n\n' +
      'Answer the user\u2019s question using the model\u2019s actual learned coefficients. ' +
      'Cite specific numbers (e.g., "the model learned a cooling slope of +0.8 GW per °C above 18°C"). ' +
      '3-5 sentences, plain text.';
  }

  function onNarrateBriefingsClick() {
    if (!state.briefings || !state.forecast) return;
    if (!canCallGroq()) {
      state.briefingsError = 'Demo rate limit reached — ' + MAX_GROQ_CALLS + ' AI calls this session. Refresh to try again.';
      renderSlot('briefings');
      return;
    }
    state.briefingsLoading = true; state.briefingsError = null;
    renderSlot('briefings');
    var m = state.model;
    var prompt = buildBriefingsPrompt();
    callGroq(
      [{ role: 'system', content: 'You are an operational load forecaster writing concise daily briefings. For each day, write ONE paragraph (2-3 sentences) that narrates the expected load, main drivers (using the model\u2019s learned coefficients), risk level, and recommended action. Use plain text. Format: "Day N (Mon DD): ..." with one day per line. Do not use markdown.' },
       { role: 'user', content: prompt }],
      { temperature: 0.4, max_tokens: 1500 }
    ).then(function (text) {
      state.briefingsLoading = false;
      // Parse the AI response — split by lines starting with "Day N".
      var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); });
      var parsed = {};
      lines.forEach(function (line) {
        var match = line.match(/^Day\s+(\d+)\s*[\u2014\-:]\s*(.+)$/i);
        if (match) parsed[parseInt(match[1], 10)] = match[2].trim();
      });
      // Assign narrations to briefings.
      state.briefings.forEach(function (b, idx) {
        b.aiNarration = parsed[idx + 1] || null;
      });
      // If no day-tagged lines, fall back to assigning the whole text as one block.
      if (Object.keys(parsed).length === 0 && lines.length === state.briefings.length) {
        state.briefings.forEach(function (b, idx) {
          b.aiNarration = lines[idx];
        });
      }
      renderSlot('briefings');
    }).catch(function (e) {
      state.briefingsLoading = false;
      state.briefingsError = (e && e.message) || 'AI narration failed.';
      renderSlot('briefings');
    });
  }
  function buildBriefingsPrompt() {
    var m = state.model;
    var daily = state.forecast.daily;
    var days = daily.map(function (d, i) {
      return 'Day ' + (i + 1) + ' (' + fmtDateShort(d.date) + '): peak ' + Math.round(d.peakLoad) +
        ' MW at ' + d.peakTime + ', avg ' + Math.round(d.avgLoad) + ' MW, max temp ' + d.maxTemp.toFixed(1) +
        '°C, humidity ' + Math.round(d.avgHumid) + '%, wind ' + d.maxWind.toFixed(1) +
        ' m/s, precip ' + d.totalPrecip.toFixed(1) + 'mm. Drivers: ' + d.drivers.slice(0, 3).map(function (dr) {
          return dr.name + ' (' + (dr.contribution >= 0 ? '+' : '') + dr.contribution.toFixed(2) + ' GW)';
        }).join(', ') + '. Risk: ' + d.riskLevel + '. Action: ' + d.recommendation;
    }).join('\n');
    return 'Model context (LEARNED):\n' +
      '- Change-point: ' + m.changePoint.toFixed(1) + '°C\n' +
      '- Heating slope: ' + m.heatingSlope.toFixed(3) + ' GW/°C below BP\n' +
      '- Cooling slope: ' + m.coolingSlope.toFixed(3) + ' GW/°C above BP\n' +
      '- R²: ' + (m.r2 * 100).toFixed(1) + '%, MAPE: ' + m.mape.toFixed(2) + '%\n\n' +
      'Daily forecast data:\n' + days + '\n\n' +
      'Write a 2-3 sentence paragraph per day that narrates the expected load and main drivers using the model\u2019s actual coefficients. ' +
      'Format each line as: "Day N (Mon DD): <paragraph>" — one line per day.';
  }

  // ─── Export helpers ─────────────────────────────────────────────────────────

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  function exportCSV() {
    var m = state.model;
    var f = state.forecast;
    var lines = [];
    // ── Section 1: 14-day hourly forecast ──
    lines.push('Section,Date,Hour,PredictedLoad_MW,Lower95_MW,Upper95_MW,Lower80_MW,Upper80_MW,Temperature_C,Humidity_Pct,Wind_mps,Solar_Wm2,Precip_mm');
    var w = f.hourly.weather;
    for (var i = 0; i < f.hourly.timestamps.length; i++) {
      lines.push(['forecast', f.hourly.timestamps[i], i,
        f.hourly.predicted[i].toFixed(2), f.hourly.piL95[i].toFixed(2), f.hourly.piU95[i].toFixed(2),
        f.hourly.piL80[i].toFixed(2), f.hourly.piU80[i].toFixed(2),
        num(w.temperature_2m, i), num(w.relative_humidity_2m, i), num(w.wind_speed_10m, i),
        num(w.shortwave_radiation, i), num(w.precipitation, i)
      ].join(','));
    }
    // ── Section 2: historical actual vs predicted ──
    lines.push('');
    lines.push('Section,Date,Hour,ActualLoad_MW,PredictedLoad_MW,Residual_MW,Lower95_MW,Upper95_MW');
    for (var i = 0; i < m.timestamps.length; i++) {
      lines.push(['history', m.timestamps[i], i,
        m.actual[i].toFixed(2), m.predictions[i].toFixed(2), m.residuals[i].toFixed(2),
        m.piL95[i].toFixed(2), m.piU95[i].toFixed(2)
      ].join(','));
    }
    // ── Section 3: daily summary ──
    lines.push('');
    lines.push('Section,Date,PeakLoad_MW,AvgLoad_MW,MaxTemp_C,MinTemp_C,AvgHumidity_Pct,TotalPrecip_mm,MaxWind_mps,MainDriver,RiskLevel,Recommendation');
    f.daily.forEach(function (d) {
      lines.push(['daily', d.date, d.peakLoad.toFixed(2), d.avgLoad.toFixed(2),
        d.maxTemp.toFixed(2), d.minTemp.toFixed(2), d.avgHumid.toFixed(1), d.totalPrecip.toFixed(2),
        d.maxWind.toFixed(2), '"' + d.mainDriver.replace(/"/g, '""') + '"',
        d.riskLevel, '"' + d.recommendation.replace(/"/g, '""') + '"'
      ].join(','));
    });
    // ── Section 4: coefficients ──
    lines.push('');
    lines.push('Section,Feature,Coefficient,StdError,tStat,pValue,StandardizedAbs');
    m.featureNames.forEach(function (name, i) {
      lines.push(['coef', name, m.beta[i].toFixed(6), m.se[i].toFixed(6),
        m.tStat[i].toFixed(4), m.pValue[i].toFixed(6),
        (i === 0 ? '' : Math.abs(m.standardizedBetas[i]).toFixed(6))
      ].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob('load-forecast-' + isoDate(new Date()) + '.csv', blob);
  }

  function exportExcel() {
    loadScript('xlsx').then(function () {
      var m = state.model;
      var f = state.forecast;
      // Sheet 1: Forecast (hourly)
      var forecastRows = [['Date', 'Hour', 'PredictedLoad_MW', 'Lower95_MW', 'Upper95_MW', 'Lower80_MW', 'Upper80_MW', 'Temperature_C', 'Humidity_Pct', 'Wind_mps', 'Solar_Wm2', 'Precip_mm']];
      var w = f.hourly.weather;
      for (var i = 0; i < f.hourly.timestamps.length; i++) {
        forecastRows.push([
          f.hourly.timestamps[i], i,
          f.hourly.predicted[i], f.hourly.piL95[i], f.hourly.piU95[i],
          f.hourly.piL80[i], f.hourly.piU80[i],
          num(w.temperature_2m, i), num(w.relative_humidity_2m, i), num(w.wind_speed_10m, i),
          num(w.shortwave_radiation, i), num(w.precipitation, i)
        ]);
      }
      // Sheet 2: Historical actual vs predicted
      var histRows = [['Date', 'Hour', 'ActualLoad_MW', 'PredictedLoad_MW', 'Residual_MW', 'Lower95_MW', 'Upper95_MW']];
      for (var i = 0; i < m.timestamps.length; i++) {
        histRows.push([m.timestamps[i], i, m.actual[i], m.predictions[i], m.residuals[i], m.piL95[i], m.piU95[i]]);
      }
      // Sheet 3: Daily summary
      var dailyRows = [['Date', 'PeakLoad_MW', 'AvgLoad_MW', 'MaxTemp_C', 'MinTemp_C', 'AvgHumidity_Pct', 'TotalPrecip_mm', 'MaxWind_mps', 'MainDriver', 'RiskLevel', 'Recommendation']];
      f.daily.forEach(function (d) {
        dailyRows.push([d.date, d.peakLoad, d.avgLoad, d.maxTemp, d.minTemp, d.avgHumid, d.totalPrecip, d.maxWind, d.mainDriver, d.riskLevel, d.recommendation]);
      });
      // Sheet 4: Coefficients
      var coefRows = [['Feature', 'Coefficient', 'StdError', 'tStat', 'pValue', 'StandardizedAbs']];
      m.featureNames.forEach(function (name, i) {
        coefRows.push([name, m.beta[i], m.se[i], m.tStat[i], m.pValue[i], i === 0 ? '' : Math.abs(m.standardizedBetas[i])]);
      });
      // Sheet 5: Model metrics
      var metricsRows = [
        ['Metric', 'Value'],
        ['R2', m.r2],
        ['AdjustedR2', m.adjR2],
        ['RMSE', m.rmse],
        ['MAE', m.mae],
        ['MAPE', m.mape],
        ['ResidualStdDev', m.sigma],
        ['ChangePoint_C', m.changePoint],
        ['HeatingSlope_GWperC', m.heatingSlope],
        ['CoolingSlope_GWperC', m.coolingSlope],
        ['N', m.n],
        ['P', m.p]
      ];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(forecastRows), 'Forecast');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(histRows),    'History');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dailyRows),   'Daily');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(coefRows),     'Coefficients');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metricsRows), 'Metrics');
      var arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      downloadBlob('load-forecast-' + isoDate(new Date()) + '.xlsx',
        new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    }).catch(function () {
      var slot = $('lf-export-slot');
      if (slot) {
        var card = slot.querySelector('.lf-card');
        if (card) card.insertAdjacentHTML('beforeend',
          '<div class="lf-error"><i class="fas fa-triangle-exclamation"></i> Excel export failed — the SheetJS library could not be loaded.</div>');
      }
    });
  }

  function exportJSON() {
    var out = {
      generatedAt: new Date().toISOString(),
      location: state.location,
      model: state.model ? {
        r2: state.model.r2, adjR2: state.model.adjR2, rmse: state.model.rmse, mae: state.model.mae, mape: state.model.mape,
        sigma: state.model.sigma, changePoint: state.model.changePoint,
        heatingSlope: state.model.heatingSlope, coolingSlope: state.model.coolingSlope,
        n: state.model.n, p: state.model.p,
        coefficients: state.model.featureNames.map(function (name, i) {
          return { feature: name, beta: state.model.beta[i], se: state.model.se[i], tStat: state.model.tStat[i], pValue: state.model.pValue[i],
                   standardizedAbs: i === 0 ? null : Math.abs(state.model.standardizedBetas[i]) };
        }),
        variableImportance: state.model.variableImportance
      } : null,
      thresholds: state.thresholds,
      forecast: state.forecast ? {
        hourlyCount: state.forecast.hourly.timestamps.length,
        daily: state.forecast.daily
      } : null,
      briefings: state.briefings,
      aiResult: state.aiResult
    };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    downloadBlob('load-forecast-' + isoDate(new Date()) + '.json', blob);
  }

  // ─── Email preview + modal ──────────────────────────────────────────────────

  function buildEmailBodyPlain() {
    var m = state.model, f = state.forecast, loc = state.location;
    var bar = '\u2550'.repeat(60);
    var header = bar + '\n' +
      '  INSIGHT ANALYTICS  \u00b7  LOAD FORECAST BRIEFING\n' +
      bar + '\n\n' +
      'Location:    ' + (loc ? loc.label : '\u2014') + '\n' +
      'Generated:   ' + new Date().toLocaleString('en-CA') + '\n' +
      'Model:       OLS regression + change-point detection\n' +
      'R\u00b2:          ' + (m ? (m.r2 * 100).toFixed(1) + '%' : '\u2014') + '\n' +
      'RMSE:        ' + (m ? fmtMW1(m.rmse) : '\u2014') + '\n' +
      'Change-pt:   ' + (m ? m.changePoint.toFixed(1) + '\u00b0C' : '\u2014') + '\n' +
      'Heating:     ' + (m ? m.heatingSlope.toFixed(3) + ' GW/\u00b0C below BP' : '\u2014') + '\n' +
      'Cooling:     ' + (m ? m.coolingSlope.toFixed(3) + ' GW/\u00b0C above BP' : '\u2014') + '\n\n' +
      '\u2500'.repeat(60) + '\n' +
      '  14-DAY FORECAST SUMMARY\n' +
      '\u2500'.repeat(60) + '\n';
    var lines = [header];
    f.daily.forEach(function (d, i) {
      lines.push('Day ' + (i + 1) + ' (' + fmtDateShort(d.date) + '): ' + Math.round(d.peakLoad) +
        ' MW peak @ ' + d.peakTime + ' | ' + d.maxTemp.toFixed(1) + '\u00b0C max | ' + d.riskLevel +
        ' | ' + d.recommendation);
    });
    lines.push('');
    lines.push('\u2500'.repeat(60));
    lines.push('Insight Analytics  \u00b7  Live truth on every desk.');
    lines.push('https://insight-analytics.ca');
    return lines.join('\n');
  }

  function buildEmailBodyHTML() {
    var m = state.model, f = state.forecast, loc = state.location;
    var dailyRows = f.daily.map(function (d, i) {
      var pillColor = d.riskLevel === 'Critical' ? '#dc2626' :
                      d.riskLevel === 'High' ? '#ea580c' :
                      d.riskLevel === 'Elevated' ? '#d97706' : '#16a34a';
      return '<tr>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;">Day ' + (i + 1) + '<br>' + fmtDateShort(d.date) + '</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;text-align:right;font-weight:600;">' + Math.round(d.peakLoad).toLocaleString('en-US') + ' MW</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;text-align:right;">' + d.maxTemp.toFixed(1) + '°C</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;">' + esc(d.mainDriver) + '</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#fff;font-size:11px;font-weight:700;text-align:center;background:' + pillColor + ';border-radius:4px;">' + esc(d.riskLevel.toUpperCase()) + '</td>' +
      '</tr>';
    }).join('');
    return '' +
      '<div style="font-family:Inter,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;background:#f8fafc;padding:24px;">' +
        '<div style="background:linear-gradient(135deg,#4338ca 0%,#0e7490 100%);padding:24px 28px;border-radius:12px 12px 0 0;">' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:0.16em;color:#cbd5e1;text-transform:uppercase;">INSIGHT ANALYTICS</div>' +
          '<div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px;">14-Day Load Forecast Briefing</div>' +
          '<div style="font-size:12px;color:#cbd5e1;margin-top:6px;">' + esc(loc ? loc.label : '\u2014') + ' \u00b7 generated ' + esc(new Date().toLocaleString('en-CA')) + '</div>' +
        '</div>' +
        '<div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-top:0;">' +
          '<div style="margin-bottom:20px;padding:14px 16px;background:#f1f5f9;border-radius:8px;border-left:3px solid #4338ca;">' +
            '<div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">MODEL (LEARNED FROM DATA)</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:#0f172a;">' +
              '<span>R\u00b2 <strong>' + (m.r2 * 100).toFixed(1) + '%</strong></span>' +
              '<span>RMSE <strong>' + fmtMW1(m.rmse) + '</strong></span>' +
              '<span>Change-pt <strong>' + m.changePoint.toFixed(1) + '°C</strong></span>' +
              '<span>Heating <strong>' + m.heatingSlope.toFixed(2) + ' GW/°C</strong></span>' +
              '<span>Cooling <strong>' + m.coolingSlope.toFixed(2) + ' GW/°C</strong></span>' +
            '</div>' +
          '</div>' +
          '<table style="width:100%;border-collapse:collapse;font-family:Inter,Helvetica,Arial,sans-serif;">' +
            '<thead><tr>' +
              '<th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#fff;background:#4338ca;border-bottom:2px solid #0e7490;">Day</th>' +
              '<th style="padding:10px 12px;text-align:right;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#fff;background:#4338ca;border-bottom:2px solid #0e7490;">Peak</th>' +
              '<th style="padding:10px 12px;text-align:right;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#fff;background:#4338ca;border-bottom:2px solid #0e7490;">Max Temp</th>' +
              '<th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#fff;background:#4338ca;border-bottom:2px solid #0e7490;">Main Driver</th>' +
              '<th style="padding:10px 12px;text-align:center;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#fff;background:#4338ca;border-bottom:2px solid #0e7490;">Risk</th>' +
            '</tr></thead>' +
            '<tbody>' + dailyRows + '</tbody>' +
          '</table>' +
        '</div>' +
        '<div style="background:#0b1120;padding:18px 28px;border-radius:0 0 12px 12px;text-align:center;">' +
          '<div style="font-size:13px;font-weight:600;color:#e6edf7;">Insight Analytics &middot; <em style="font-style:italic;color:#06b6d4;">Live truth on every desk.</em></div>' +
          '<div style="font-size:11px;color:#64748b;margin-top:4px;"><a href="https://insight-analytics.ca" style="color:#06b6d4;text-decoration:none;">insight-analytics.ca</a></div>' +
        '</div>' +
      '</div>';
  }

  function openEmailPreview() {
    var subject = '14-Day Load Forecast Briefing \u2014 ' + (state.location ? state.location.label : 'Location');
    var bodyPlain = buildEmailBodyPlain();
    var bodyHTML = buildEmailBodyHTML();
    openModal('Email preview', '\
      <div class="lf-card-step">Subject</div>\
      <div class="lf-modal-pre">' + esc(subject) + '</div>\
      <div class="lf-card-step" style="margin-top:14px;">Preview (rendered HTML)</div>\
      <div class="lf-email-html-preview">' + bodyHTML + '</div>\
      <div class="lf-card-step" style="margin-top:14px;cursor:pointer;text-decoration:underline;" id="lf-toggle-plain">Show plain-text body (what gets sent via mailto:)</div>\
      <div class="lf-modal-pre" id="lf-plain-body" style="display:none;">' + esc(bodyPlain) + '</div>\
      <div class="lf-card-step" style="margin-top:14px;">Recipient</div>\
      <input class="lf-input" id="lf-email-recipient" type="email" placeholder="recipient@example.com" />',
      [
        { label: 'Download as HTML email', primary: false, action: function () {
          var fullHTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(subject) + '</title></head><body>' + bodyHTML + '</body></html>';
          var blob = new Blob([fullHTML], { type: 'text/html;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'load-forecast-briefing.html';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } },
        { label: 'Open in email client', primary: true, action: function () {
          var to = ($('lf-email-recipient') || {}).value || '';
          var url = 'mailto:' + encodeURIComponent(to).replace(/%40/, '@') +
            '?subject=' + encodeURIComponent(subject) +
            '&body=' + encodeURIComponent(bodyPlain);
          window.location.href = url;
        } }
      ]);
    setTimeout(function () {
      var toggle = $('lf-toggle-plain');
      var plain = $('lf-plain-body');
      if (toggle && plain) {
        toggle.addEventListener('click', function () {
          plain.style.display = plain.style.display === 'none' ? 'block' : 'none';
        });
      }
    }, 50);
  }

  // ─── Reusable modal ─────────────────────────────────────────────────────────
  function openModal(title, bodyHTML, buttons) {
    closeModal();
    var back = document.createElement('div');
    back.className = 'lf-modal-backdrop';
    back.id = 'lf-modal';
    var actionsHTML = '';
    (buttons || []).forEach(function (b, idx) {
      actionsHTML += '<button class="btn ' + (b.primary ? 'btn-primary' : 'btn-ghost') +
        ' lf-btn-sm" data-lf-modal-action="' + idx + '">' + esc(b.label) + '</button>';
    });
    back.innerHTML = '\
      <div class="lf-modal" role="dialog" aria-modal="true">\
        <h3 class="lf-modal-title">' + esc(title) + '</h3>\
        <div class="lf-modal-body">' + bodyHTML + '</div>\
        <div class="lf-modal-actions">' + actionsHTML + '</div>\
      </div>';
    document.body.appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back) { closeModal(); return; }
      var btn = e.target.closest('[data-lf-modal-action]');
      if (btn) {
        var idx = parseInt(btn.getAttribute('data-lf-modal-action'), 10);
        var handler = (buttons || [])[idx];
        if (handler && handler.action) handler.action();
      }
    });
    document.addEventListener('keydown', modalEscHandler);
  }
  function modalEscHandler(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    var m = $('lf-modal');
    if (m) m.remove();
    document.removeEventListener('keydown', modalEscHandler);
  }

  // ─── Event delegation (bound once on the mount) ──────────────────────────────
  function wireEvents() {
    var mount = $(MOUNT_ID);
    if (!mount) return;
    if (mount._lfWired) return;
    mount._lfWired = true;

    mount.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      // Step 1 — location
      if (t.closest('#lf-detect-loc'))      { onDetectLocationClick(); return; }
      if (t.closest('#lf-manual-loc'))      { onManualLocationToggle(); return; }
      if (t.closest('#lf-use-manual'))      { onUseManualLocation(); return; }
      if (t.closest('#lf-retry-loc'))       { onDetectLocationClick(); return; }
      if (t.closest('#lf-redetect-loc'))    { onDetectLocationClick(); return; }
      if (t.closest('#lf-fetch-weather'))   { onFetchWeatherClick(); return; }
      if (t.closest('#lf-retry-weather'))   { onFetchWeatherClick(); return; }
      // Step 2 — train
      if (t.closest('#lf-train-model'))     { onTrainModelClick(); return; }
      // AVP window toggle
      var winBtn = t.closest('[data-lf-window]');
      if (winBtn) {
        state.avpWindow = parseInt(winBtn.getAttribute('data-lf-window'), 10);
        renderSlot('model');
        return;
      }
      // Step 3 — thresholds
      if (t.closest('#lf-reset-thresholds')) { onResetThresholds(); return; }
      // Step 4 — Q&A
      var suggest = t.closest('[data-lf-suggest]');
      if (suggest) {
        state.aiQuestion = suggest.getAttribute('data-lf-suggest');
        var inp = $('lf-ai-question');
        if (inp) inp.value = state.aiQuestion;
        onAskAIClick();
        return;
      }
      if (t.closest('#lf-ask-ai'))            { onAskAIClick(); return; }
      // Step 5 — briefings
      if (t.closest('#lf-narrate-briefings')) { onNarrateBriefingsClick(); return; }
      // Step 6 — exports
      if (t.closest('#lf-export-csv'))        { exportCSV(); return; }
      if (t.closest('#lf-export-excel'))      { exportExcel(); return; }
      if (t.closest('#lf-export-json'))       { exportJSON(); return; }
      if (t.closest('#lf-email-results'))     { openEmailPreview(); return; }
      // Modal action
      var modalBtn = t.closest('[data-lf-modal-action]');
      if (modalBtn) {
        // The action handler is wired directly in openModal — this branch is a
        // no-op fallback to prevent the click from bubbling further.
        return;
      }
    });

    // Range slider input events (threshold changes).
    mount.addEventListener('input', function (e) {
      if (!e.target) return;
      if (e.target.id === 'lf-slider-p90') onThresholdChange('p90', parseFloat(e.target.value));
      if (e.target.id === 'lf-slider-p95') onThresholdChange('p95', parseFloat(e.target.value));
      if (e.target.id === 'lf-slider-p99') onThresholdChange('p99', parseFloat(e.target.value));
      // Track AI question input — kept out of the re-render flow so typing
      // doesn't lose focus, but the value lives in state for the next render.
      if (e.target.id === 'lf-ai-question') state.aiQuestion = e.target.value;
    });

    // Enter on the AI question input → ask. (Single source of truth — the
    // input-level handler is NOT attached in renderAQCard to avoid double-
    // firing with this mount-level handler.)
    mount.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'lf-ai-question') {
        e.preventDefault(); onAskAIClick();
      }
    });
  }

  // ─── Theme change watcher ────────────────────────────────────────────────────
  // Re-render all visible charts when the site theme toggles. We don't re-
  // render the whole mount — that would lose scroll position. Instead, we
  // dispose all ECharts instances and let the next slot render rebuild them.
  function watchThemeChanges() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-theme') {
          // Re-render every slot that has a chart in it (cheap no-op for slots
          // without charts). The renderers will dispose + re-init the charts.
          disposeAllCharts();
          renderWeatherCard();
          renderLoadCard();
          renderModelCard();
          renderForecastCard();
        }
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    var mount = $(MOUNT_ID);
    if (mount) {
      var obs2 = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          if (m.attributeName === 'data-lf-theme') {
            disposeAllCharts();
            renderWeatherCard();
            renderLoadCard();
            renderModelCard();
            renderForecastCard();
          }
        });
      });
      obs2.observe(mount, { attributes: true, attributeFilter: ['data-lf-theme'] });
    }
  }

  // ─── Resize observer ─────────────────────────────────────────────────────────
  // Resize the charts whenever the mount changes width (responsive layout).
  function watchResize() {
    if (typeof ResizeObserver === 'undefined') return;
    var mount = $(MOUNT_ID);
    if (!mount) return;
    state.resizeObserver = new ResizeObserver(function () {
      resizeAllCharts();
    });
    state.resizeObserver.observe(mount);
    // Fallback window resize listener — older browsers + iframe resize.
    window.addEventListener('resize', resizeAllCharts);
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────────────
  // Polls for the mount element with 40-retry/100ms-poll fallback so the
  // script can be loaded in <head> before the body is parsed.
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
    watchResize();
    // Auto-detect location on first boot — this is the entry point of the
    // demo. The user can re-detect or enter manually afterwards.
    onDetectLocationClick();
  }
  boot._retries = 0;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
