// Service worker: keeps the app itself available offline and serves saved covers.
// It never touches audio requests — those go straight to the network or to stored copies.
const VERSION = 'hark-shell-v5';
const IMG_CACHE = 'hark-img-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/boot.js', 'js/app.js', 'js/ui.js', 'js/util.js', 'js/store.js',
  'js/sources.js', 'js/player.js', 'js/downloads.js', 'js/theme.js', 'js/kit.js', 'js/books.js', 'js/reader.js', 'js/own.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hark-shell-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const rq = e.request;
  if (rq.method !== 'GET') return;
  const url = new URL(rq.url);

  if (url.origin === self.location.origin) {
    // App files: answer from the cache at once, refresh the copy in the background.
    // (On a development machine the network is asked first so edits show immediately.)
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(rq, { ignoreSearch: true });
      const fresh = fetch(rq).then(r => { if (r.ok) cache.put(rq, r.clone()); return r; }).catch(() => null);
      if (self.location.hostname === 'localhost') return (await fresh) || hit || new Response('Offline', { status: 503 });
      if (hit) { e.waitUntil(fresh); return hit; }
      return (await fresh) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })());
    return;
  }

  if (rq.destination === 'image') {
    // Covers of saved and downloaded books were stored by the app; everything else uses the network.
    e.respondWith(caches.open(IMG_CACHE).then(c => c.match(rq.url)).then(hit => hit || fetch(rq)));
  }
});
