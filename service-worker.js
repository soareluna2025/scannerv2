const CACHE_NAME = 'alohascan-v29'; // bump: SW network-first pt HTML/JS/CSS + rezilienta live

// External API hostnames — never intercept these
const BYPASS_HOSTS = [
  'v3.football.api-sports.io',
  'api.football-data.org',
  'api-sports.io',
  'api.anthropic.com',
  'api.telegram.org',
  'api.open-meteo.com',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html'])
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Let external API calls go through unmodified
  if (BYPASS_HOSTS.some(h => url.hostname.includes(h))) return;

  // Let internal API routes and admin go through (always need fresh data)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

  // Rețea-întâi pentru pagină + JS/CSS (ca un deploy să ajungă la primul reload, nu la al doilea);
  // cache = doar rezervă offline / rețea lentă (>4s). Restul (imagini, fonturi) rămâne cache-first.
  const isCode = request.mode === 'navigate' || request.destination === 'script' ||
                 request.destination === 'style' || /\.(?:js|css|html)$/.test(url.pathname) || url.pathname === '/';
  if (isCode) {
    event.respondWith((() => {
      const net = fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 4000));
      return Promise.race([net.catch(() => null), timeout]).then(r =>
        r || caches.match(request).then(c => c || net.catch(() => (request.mode === 'navigate' ? caches.match('/') : Response.error())))
      );
    })());
    return;
  }

  // Cache-first for everything else (static assets)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback: serve cached index for navigation
        if (request.mode === 'navigate') return caches.match('/');
      });
    })
  );
});
