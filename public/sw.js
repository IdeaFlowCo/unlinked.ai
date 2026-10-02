/* Unlinked service worker — privacy-safe by construction.
 *
 * Unlinked is an auth-walled private product, so this worker caches ONLY the
 * fixed public shell assets listed below, all precached at install time.
 * It never writes to any cache at runtime, never touches POST or cross-origin
 * requests, and never stores a page, API response, cookie-authenticated or
 * member-specific byte. Signing out or deleting an account therefore leaves
 * nothing personal behind in any cache, and nothing can leak across users.
 *
 * Updates: bump VERSION whenever a listed asset changes; the old cache is
 * deleted on activate and /sw.js itself is served no-store, so clients pick
 * up new releases on their next load.
 */
const VERSION = 'unlinked-public-shell-v1'
const PUBLIC_SHELL = [
  '/offline.html',
  '/manifest.webmanifest',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/app-icon-maskable-512.png',
]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(PUBLIC_SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (PUBLIC_SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then(hit => hit || fetch(request)))
    return
  }
  // Navigations go to the network untouched; only a network failure shows the
  // static offline page. Nothing from the live response is ever cached.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')))
  }
  // Every other request (APIs, fonts, downloads) is left entirely to the network.
})
