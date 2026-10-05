/*
 * Insight Analytics — Service Worker
 * Strategy:
 *  - Precache app shell (HTML, CSS, JS, fonts, icons, manifest)
 *  - For same-origin requests: stale-while-revalidate (instant load + background update)
 *  - For cross-origin (CDN fonts, iframe): network-first, fall back to nothing (no caching)
 *  - On new deploy: new SW takes over via skipWaiting + clients.claim
 *  - Pull-to-refresh on the page calls window.location.reload(); the SW will fetch fresh
 *    assets in the background and update the cache for next time.
 */

const VERSION = 'v4.27.0-20261005-ai-brief-exec-style';
const STATIC_CACHE = `ia-static-${VERSION}`;
const RUNTIME_CACHE = `ia-runtime-${VERSION}`;

// App shell — the bare-minimum assets to render the page offline.
// Query strings match the cache-busting ?v=… strings in index.html so the
// SW precaches the same URLs the page actually requests.
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css?v=4.27.0',
  './js/app.js?v=4.27.0',
  './js/hero-animation.js?v=4.27.0',
  './js/pull-to-refresh.js?v=4.27.0',
  './js/assistant.js?v=4.27.0',
  './js/blog-markets-dashboard.js?v=4.27.0',
  './data/groq-config.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon.ico'
];

// Max items in runtime cache (for images fetched later).
const RUNTIME_MAX = 30;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()) // Activate new SW immediately
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim()) // Take control of open tabs immediately
  );
});

// Trim runtime cache to RUNTIME_MAX entries (LRU-ish, FIFO by insert order)
function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then((cache) => {
    cache.keys().then((keys) => {
      if (keys.length <= maxItems) return;
      cache.delete(keys[0]).then(() => trimCache(cacheName, maxItems));
    });
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests (e.g., CDN fonts, iframe dashboard) — let browser handle
  // them via its own HTTP cache. We don't want to cache third-party content.
  if (url.origin !== self.location.origin) return;

  // Skip non-http(s) schemes (chrome-extension://, data:, blob:)
  if (!url.protocol.startsWith('http')) return;

  // CRITICAL: Skip /dashboards-preview/ entirely — let all requests (HTML, CSS,
  // JS, JSON data) go straight to the network with zero SW interception.
  // The marketing SW's stale-while-revalidate strategy was causing the iframe
  // (which loads many resources in parallel — ECharts from CDN, multiple local
  // CSS/JS files, JSON data) to stall on iOS Safari + PWA. By letting these
  // requests bypass the SW entirely, the iframe behaves like a normal same-origin
  // resource load and renders reliably on every browser.
  if (url.pathname.indexOf('/dashboards-preview/') === 0) return;

  // CRITICAL: Skip /blog/ entirely too — the blog dashboard (markets dashboard)
  // updates frequently (new futures, heatmap fixes, live data changes). The SW's
  // stale-while-revalidate strategy was serving old cached JS in PWA standalone
  // mode, so users couldn't see the latest changes even after a deploy. By
  // bypassing the SW for blog assets, the browser always fetches from network.
  if (url.pathname.indexOf('/blog/') === 0) return;

  // Same for blog asset requests (JS, CSS, data) that might be resolved
  // without the /blog/ prefix (e.g. /js/blog-markets-dashboard.js).
  if (url.pathname.indexOf('/js/blog-') === 0) return;
  if (url.pathname.indexOf('/data/historical/') === 0) return;

  // Same for the dashboard data files (in case the dashboard's relative path
  // resolves outside /dashboards-preview/, e.g. legacy paths).
  if (url.pathname.indexOf('/data/executive/') === 0) return;

  // For the navigation request (the HTML page itself), network-first so users
  // always get the latest deployed content on a hard refresh / pull-to-refresh.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone + cache the fresh HTML for offline use
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // For same-origin static assets: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          // Only cache valid same-origin responses
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => {
            cache.put(request, copy);
            trimCache(RUNTIME_CACHE, RUNTIME_MAX);
          });
          return response;
        })
        .catch(() => cached); // Network failed, fall back to cached
      return cached || fetchPromise;
    })
  );
});

// Listen for messages from the page (e.g., "skipWaiting" after manual update check)
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
