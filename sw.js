CACHE_NAME = 'mc-stocks-v1'
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/montecarlo.js',
  '/js/charts.js',
  '/js/sentiment.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS.filter(a => !a.startsWith('http'))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Datele financiare si stirile => network first, fallback cache
  if (e.request.url.includes('finance.yahoo') ||
      e.request.url.includes('corsproxy') ||
      e.request.url.includes('rss2json')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  // Restul => cache first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
