/* Offline support: precache the app shell, then serve from cache and
   refresh the cache in the background. Only same-origin GET requests are
   handled; the app never makes any other network calls. */
'use strict';

const CACHE = 'budget-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(isPage ? './index.html' : req, { ignoreSearch: true });

    const refresh = fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          cache.put(isPage ? './index.html' : req, res.clone());
        }
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(refresh);
      return cached;
    }
    const fresh = await refresh;
    return fresh || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});
