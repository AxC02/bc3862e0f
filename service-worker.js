/* Offline support. Network first so every update shows up right away;
   the saved copy is only used when the phone is offline. Only same-origin
   GET requests are handled; the app never makes any other network calls. */
'use strict';

const CACHE = 'budget-v5';
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
      // cache:'reload' skips the browser's HTTP cache (GitHub Pages sends max-age=600).
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
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
  const key = isPage ? './index.html' : req;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(key, { ignoreSearch: true });
      return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
