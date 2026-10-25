// Сервис-воркер карты (PWA): карта открывается без сети с последними загруженными данными.
// Кэшируем только то, что и так публично: код и картинки сайта, опубликованные карты, фото панорам.
// Никогда не кэшируем: вход, профиль, черновики, команду, журнал, приглашения — всё под /api/, кроме
// опубликованной карты и /api/health; страницу и код админ-панели — тоже нет.
const VERSION = 'arena-v4';
const STATIC = `${VERSION}-static`, DATA = `${VERSION}-data`, MEDIA = `${VERSION}-media`;
const SHELL = ['./', './index.html', './src/styles.css', './src/main.js', './manifest.webmanifest', './assets/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const PUBLIC_API = [/^\/api\/health$/, /^\/api\/venues\/[\w-]+\/map$/, /^\/api\/venues\/by\/[\w-]+$/, /^\/api\/quest\/[\w-]+\/leaders$/];
const PRIVATE = [/^\/admin\.html/, /^\/src\/admin/, /^\/src\/admin-main\.js/];

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname;
  if (PRIVATE.some((r) => r.test(path))) return;
  if (path.startsWith('/api/')) {
    if (PUBLIC_API.some((r) => r.test(path))) e.respondWith(networkFirst(req, DATA));
    return;
  }
  // видео (и любые запросы «частями» — Range) идут мимо кэша: частичный ответ 206 в кэш не кладётся
  if (req.headers.has('range') || /\.(mp4|webm)$/i.test(path)) return;
  if (path.startsWith('/uploads/')) { e.respondWith(cacheFirst(req, MEDIA, 80)); return; }
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, STATIC).catch(() => offlinePage())); return; }
  // код сайта — сначала из сети (после обновления сразу новая версия, без смеси старых и новых модулей),
  // картинки, шрифты и three.js — из кэша с фоновым обновлением
  if (path.startsWith('/src/') || path.endsWith('.webmanifest')) { e.respondWith(networkFirst(req, STATIC)); return; }
  e.respondWith(staleWhileRevalidate(req, STATIC));
});

async function networkFirst(req, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    throw err;
  }
}
async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name), hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || new Response('', { status: 504 });
}
async function cacheFirst(req, name, limit) {
  const cache = await caches.open(name), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.status === 200) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(k);
  }
  return res;
}
function offlinePage() {
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет связи</title>
    <body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fff;color:#17181a;text-align:center;padding:16px">
    <div><h1 style="font-size:20px">Нет подключения к интернету</h1><p>Эту страницу ещё не открывали на этом устройстве, поэтому её нет в памяти. Подключитесь к сети и обновите страницу.</p></div></body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
