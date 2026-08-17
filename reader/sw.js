/* Service worker: full up-front precache.
 *
 * The reader is meant to work with no connection once installed, so activation
 * pulls every chapter file listed in assets.json (~10 MB across 247 requests)
 * rather than caching lazily. Requests are batched so a phone doesn't open 247
 * sockets at once, and progress is posted back to the page.
 */

const VERSION = 'bom-v1';
const CACHE = `${VERSION}`;
const BATCH = 12;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
      await precacheAll();
    })()
  );
});

async function post(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function precacheAll() {
  const cache = await caches.open(CACHE);

  let manifest;
  try {
    manifest = await (await fetch(new URL('assets.json', self.registration.scope))).json();
  } catch {
    return;
  }

  const urls = [...manifest.shell, ...manifest.data].map(
    (path) => new URL(path, self.registration.scope).href
  );

  let done = 0;
  for (let i = 0; i < urls.length; i += BATCH) {
    const slice = urls.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (url) => {
        try {
          // cache.add would refetch assets already stored from a prior visit.
          if (!(await cache.match(url))) await cache.add(url);
        } catch {
          /* A single missing asset shouldn't abort the whole precache. */
        }
      })
    );
    done += slice.length;
    await post({ type: 'precache-progress', done, total: urls.length });
  }
  await post({ type: 'precache-done', total: urls.length });
}

/* Cache-first: the corpus is immutable between deploys, and offline reading is
   the point. A new VERSION on deploy drops the old cache wholesale. */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== location.origin) return;

  event.respondWith(
    (async () => {
      const hit = await caches.match(request, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, res.clone());
        }
        return res;
      } catch {
        // Navigations fall back to the shell so deep links work offline.
        if (request.mode === 'navigate') {
          const shell = await caches.match(new URL('index.html', self.registration.scope).href);
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })()
  );
});
