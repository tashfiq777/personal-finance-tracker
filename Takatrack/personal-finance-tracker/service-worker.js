/* ==========================================================================
   service-worker.js — App Shell Caching & Offline Resilience
   ========================================================================== */

const CACHE_NAME = 'takatrack-shell-v1';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './pages/activity.html',
  './pages/people.html',
  './pages/person-details.html',
  './pages/reports.html',
  './pages/settings.html',
  './css/style.css',
  './css/components.css',
  './css/dashboard.css',
  './css/responsive.css',
  './js/boot-guard.js',
  './js/app.js',
  './js/accounting.js',
  './js/auth.js',
  './js/config.js',
  './js/dashboard.js',
  './js/database.js',
  './js/loans.js',
  './js/people.js',
  './js/reports.js',
  './js/settings.js',
  './js/sync.js',
  './js/transactions.js',
  './js/utils.js',
  './manifest.json',
  './assets/icons/favicon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache Supabase API or /api/config responses — always network-only
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('supabase.co')) {
    return;
  }

  // Navigation requests: network-first with cached shell fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Static app shell assets: stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((res) => {
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
