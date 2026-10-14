// Offline cache for the app shell.
// Strategy: network first, cache as fallback. Updates therefore show up on the next load
// when online, and the app still works offline. Bump VERSION to clear old caches.
const VERSION = 'v12';
const CACHE = `model-index-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'i18n/nl.json',
  'i18n/en.json',
  'js/app.js',
  'js/db.js',
  'js/import.js',
  'js/loaders.js',
  'js/thumbs.js',
  'js/viewer.js',
  'js/backup.js',
  'js/dupes.js',
  'js/disk.js',
  'js/i18n.js',
  'vendor/three/three.module.js',
  'vendor/three/three.core.js',
  'vendor/three/addons/loaders/STLLoader.js',
  'vendor/three/addons/loaders/OBJLoader.js',
  'vendor/three/addons/loaders/MTLLoader.js',
  'vendor/three/addons/loaders/3MFLoader.js',
  'vendor/three/addons/controls/OrbitControls.js',
  'vendor/three/addons/utils/BufferGeometryUtils.js',
  'vendor/three/addons/libs/fflate.module.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so we never store stale copies
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
