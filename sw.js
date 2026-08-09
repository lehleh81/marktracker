const CACHE = 'mark-tracker-v2';
const ASSETS = ['./', './index.html', './manifest.json', './app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for the CDN scripts (OCR/xlsx libs), cache-first for local shell.
  // Exact origin comparison (not a substring check) so a cross-origin URL that
  // merely *contains* this origin's string somewhere (e.g. in a query param)
  // can't be mis-routed into the local cache-first path.
  let isLocal = false;
  try {
    isLocal = new URL(e.request.url).origin === self.location.origin;
  } catch (err) {
    isLocal = false;
  }
  if (!isLocal) return; // let CDN requests pass through normally

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
