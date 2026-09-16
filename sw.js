/* Cache the app shell so the converter opens instantly and works offline. */
const CACHE = 'currency-exchange-v1';
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

  // Rate APIs live on other origins: always go to the network, never serve a stale rate.
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigations: network first, fall back to the cached page when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('index.html', copy));
          return response;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Everything else in the shell: cache first, refresh in the background.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
