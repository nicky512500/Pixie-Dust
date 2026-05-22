// Service worker for offline use on the cruise ship (no wifi).
// Strategy: explicit user-triggered pre-cache + cache-first runtime.

const CACHE = 'pixie-dust-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './rooms.json',
  './logo.png',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  // Take over without waiting for tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Clean up old caches if version bumped.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Cache-first: serve from cache when present, otherwise hit network.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      const res = await fetch(e.request);
      // Opportunistically cache successful same-origin responses.
      if (res.ok && new URL(e.request.url).origin === self.location.origin) {
        const cache = await caches.open(CACHE);
        cache.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      // Offline & not cached — let the browser show its offline page.
      throw err;
    }
  })());
});

// Page sends "cache-all" to force-download every asset for offline use.
self.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'cache-all') return;
  const cache = await caches.open(CACHE);
  let done = 0;
  for (const url of ASSETS) {
    try {
      // Bypass HTTP cache to make sure we have the freshest version.
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, res.clone());
    } catch (err) {
      e.source.postMessage({ type: 'cache-error', url, message: String(err) });
      return;
    }
    done += 1;
    e.source.postMessage({ type: 'cache-progress', done, total: ASSETS.length });
  }
  e.source.postMessage({ type: 'cache-done', total: ASSETS.length });
});
