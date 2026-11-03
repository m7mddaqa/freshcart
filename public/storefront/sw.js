// Service worker — makes the storefront installable (PWA) and work offline, without ever
// serving stale UI. Strategy by request type:
//   • app shell (html/js/css) → NETWORK-FIRST, so code changes show up immediately
//   • images                  → CACHE-FIRST, since they're large and never change
//   • /api/* data             → NETWORK-FIRST, falling back to the last cached response offline
// Bump CACHE whenever we want old caches wiped on the next activate.
const CACHE = 'freshcart-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/logo.svg'];

// On install: pre-cache the shell, then take over right away (skipWaiting) instead of
// waiting for all old tabs to close.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
// On activate: delete any caches from older versions, then claim open pages.
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // only ever cache GETs
  const u = new URL(e.request.url);

  // data: network-first, cached response as offline fallback
  if (u.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // images: cache-first
  if (u.pathname.startsWith('/images/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return resp;
    })));
    return;
  }
  // app shell + everything else: NETWORK-FIRST (always latest), cache only when offline
  e.respondWith(fetch(e.request).then(resp => {
    const path = u.pathname === '' ? '/' : u.pathname;
    if (resp.ok && SHELL.includes(path)) {
      const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return resp;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/'))));
});
