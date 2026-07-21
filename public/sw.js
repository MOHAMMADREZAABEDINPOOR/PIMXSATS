/* PIMXSATS service worker.
 *
 * Goal: once the site has been opened, everything needed to run it lives in
 * the browser's Cache Storage on that device — the app shell, the bundled
 * satellite catalog, and all textures. Repeat visits start instantly and work
 * even with a weak or absent connection. Nothing is re-downloaded across
 * sessions unless it actually changed.
 *
 * Bump CACHE_VERSION whenever the precached asset list changes so old caches
 * are cleaned up on activate.
 */
const CACHE_VERSION = 'pimxsats-v1';
const CORE_CACHE = `${CACHE_VERSION}-core`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Large, stable assets fetched eagerly on install so the very first repeat
// visit is fully warm. The catalog snapshot is the important one.
const PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/tle-snapshot.txt',
  '/textures/earth_day.jpg',
  '/textures/earth_night.jpg',
  '/textures/earth_specular.jpg',
  '/textures/earth_clouds.png',
  '/textures/earth_water.png',
  '/textures/planets/mercury.jpg',
  '/textures/planets/venus.jpg',
  '/textures/planets/mars.jpg',
  '/textures/planets/jupiter.jpg',
  '/textures/planets/saturn.jpg',
  '/textures/planets/uranus.jpg',
  '/textures/planets/neptune.jpg',
  '/textures/planets/sun.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CORE_CACHE);
      // Best-effort per-asset: one 404 or slow asset must not abort install.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok) await cache.put(url, res.clone());
          } catch { /* will be cached on first runtime hit instead */ }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CORE_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Let the page trigger an immediate activation after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/textures/') ||
    url.pathname === '/tle-snapshot.txt' ||
    /\.(?:js|css|woff2?|png|jpg|jpeg|webp|svg|ico)$/.test(url.pathname) ||
    url.pathname.startsWith('/_next/static/')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through

  // Navigations: network-first, fall back to cached shell, then offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(request);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put('/', net.clone()).catch(() => {});
          return net;
        } catch {
          return (
            (await caches.match('/')) ||
            (await caches.match('/offline.html')) ||
            new Response('Offline', { status: 503, statusText: 'Offline' })
          );
        }
      })()
    );
    return;
  }

  // Live cloud map: stale-while-revalidate — instant from cache, refreshed
  // in the background when the network allows.
  if (url.pathname === '/api/clouds') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || new Response('', { status: 504 });
      })()
    );
    return;
  }

  // Static assets (textures, catalog, JS/CSS): cache-first, populate on miss.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          if (res.ok) {
            const cache = await caches.open(
              url.pathname === '/tle-snapshot.txt' || url.pathname.startsWith('/textures/')
                ? CORE_CACHE
                : RUNTIME_CACHE
            );
            cache.put(request, res.clone());
          }
          return res;
        } catch {
          return cached || new Response('', { status: 504 });
        }
      })()
    );
  }
});
