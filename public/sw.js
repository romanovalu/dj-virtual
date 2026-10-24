// Service worker: guarda la app para que abra sin internet (tu música siempre se lee de tu PC).
// - Páginas: primero la red (para tomar actualizaciones) y, sin conexión, la copia guardada.
// - assets/ (con hash en el nombre, no cambian): primero la copia guardada.
// - Otros archivos propios: copia guardada y actualización en segundo plano.
// YouTube y cualquier otro dominio no pasan por acá.
const CACHE = 'djv-v1';
const CORE = ['./', './index.html', './midi-monitor.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function put(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const c = await caches.open(CACHE);
    await c.put(req, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => put(req, res))
        .catch(async () => (await caches.match(req, { ignoreSearch: true })) || (await caches.match('./index.html'))),
    );
    return;
  }
  if (url.pathname.includes('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => put(req, res))));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => put(req, res))
        .catch(() => hit);
      return hit || net;
    }),
  );
});
