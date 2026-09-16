/* Cache the app shell so the converter opens instantly and works offline. */
const CACHE = 'currency-exchange-v4';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'currencies.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Rate APIs live on other origins: always go to the network, never serve a stale rate.
  if (url.origin !== self.location.origin) return;

  // Network first for the whole shell, cache only as the offline fallback.
  // Cache-first served yesterday's script after a deploy, so a fix could take
  // two reloads to arrive; the cache is for being offline, not for being quick.
  const fallbackKey = request.mode === 'navigate' ? 'index.html' : request;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(fallbackKey, copy));
        }
        return response;
      })
      .catch(() => caches.match(fallbackKey).then(cached => cached || caches.match('index.html')))
  );
});
