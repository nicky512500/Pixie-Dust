// Service worker for offline use on the cruise ship (no wifi).
// Strategy: explicit user-triggered pre-cache + cache-first runtime.

const CACHE = 'pixie-dust-v19';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './firebase-config.js',
  './ships.json',
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

// Serve from cache if explicitly pre-cached; otherwise straight to
// network with NO opportunistic caching. The user opts in to offline
// only by pressing the download button (which sends "cache-all" below).
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    return fetch(e.request);
  })());
});

// Page sends "cache-all" to force-download the shell + any extra URLs
// (typically the currently mounted ship's rooms/<ship>.json).
self.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'cache-all') return;
  const extras = Array.isArray(e.data.extraUrls) ? e.data.extraUrls : [];
  const urls = ASSETS.concat(extras);
  const cache = await caches.open(CACHE);
  let done = 0;
  for (const url of urls) {
    try {
      // Bypass HTTP cache to make sure we have the freshest version.
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, res.clone());
    } catch (err) {
      e.source.postMessage({ type: 'cache-error', url, message: String(err) });
      return;
    }
    done += 1;
    e.source.postMessage({ type: 'cache-progress', done, total: urls.length });
  }
  e.source.postMessage({ type: 'cache-done', total: urls.length });
});
