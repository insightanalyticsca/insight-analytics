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

const VERSION = 'v1.3.0-20260930-iframe-revert';
const STATIC_CACHE = `ia-static-${VERSION}`;
const RUNTIME_CACHE = `ia-runtime-${VERSION}`;

// App shell — the bare-minimum assets to render the page offline.
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/hero-animation.js',
  './js/pull-to-refresh.js',
  './js/assistant.js',
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
