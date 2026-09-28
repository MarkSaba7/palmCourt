// Palm Court Racket: the phone racket app's service worker (controller.html registers it).
// Its scope is controller.html alone, so it never sees the game (play/) or the website. It keeps the racket's shell
// (the page, its manifest and icons, and the PeerJS library) for an instant start, even on a weak signal. Everything
// live (lan.json, the relay socket, PeerJS signalling, fonts) goes straight to the network and is never cached.
// Bump VERSION with every change to controller.html or this file: the new worker installs a fresh copy of the shell,
// takes over at once and deletes the old copy. (The page is also refreshed in the background on each launch, so a
// forgotten bump only delays an update by one launch.)
const VERSION = 'palmcourt-racket-v1';
const SHELL = ['controller.html', 'racket.webmanifest', 'site/racket-icon.svg', 'site/racket-icon-192.png'];
const LIB = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';   // versioned, never changes
const PAGE = new URL('controller.html', self.location).href;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    try { const r = await fetch(LIB, { mode: 'cors' }); if (r.ok) await c.put(LIB, r); } catch (err) { /* fetched on first use instead */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('palmcourt-racket-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') { e.respondWith(page(e)); return; }
  if (req.url === LIB) { e.respondWith(cacheFirst(req, LIB)); return; }
  if (url.origin === self.location.origin && !url.search && SHELL.some((u) => url.href === new URL(u, self.location).href)) e.respondWith(cacheFirst(req, url.href));
  // anything else: the network, untouched
});

// The page: the cached copy at once (whatever ?c=CODE it was opened with), refreshed in the background for next time.
async function page(e) {
  const c = await caches.open(VERSION);
  const fresh = fetch(PAGE, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(PAGE, r.clone()); return r; });
  e.waitUntil(fresh.catch(() => null));
  const hit = await c.match(PAGE);
  if (hit) return hit;
  try { return await fresh; } catch (err) { return fetch(e.request); }
}

async function cacheFirst(req, key) {
  const c = await caches.open(VERSION), hit = await c.match(key);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) c.put(key, r.clone());
  return r;
}
