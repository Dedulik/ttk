// Точка входа карты для посетителей: выбираем сервер или демо-режим и открываем объект.
//   index.html                  — Манеж ДГТУ (главный объект)
//   index.html?object=<адрес>   — любой опубликованный объект
//   index.html?by=<автор>       — личная ссылка администратора: его объекты
// Админ-панель — отдельная страница admin.html (старые ссылки #/admin ведут туда же).
import { ServerDown, createApi, showServerDown, urlSlug } from './core/api.js';
import { applySavedTheme } from './core/ui.js';

applySavedTheme();   // светлая или тёмная — как выбрал посетитель в прошлый раз

if (location.hash.startsWith('#/admin')) location.replace('admin.html');
let root = document.getElementById('app');
let api;
try { api = (await createApi()).use(urlSlug()); }
catch (e) { if (e instanceof ServerDown) showServerDown(root); throw e; }
const by = new URLSearchParams(location.search).get('by');

async function mount() {
  window.__ac?.abort(); window.__ac = new AbortController();   // снимаем обработчики прошлого экрана
  try {
    if (by && !new URLSearchParams(location.search).has('object')) {
      const { owner, venues } = await api.venuesBy(by);
      // один объект — сразу карта, несколько — выбор
      if (venues.length !== 1) { const { authorPage } = await import('./visitor/author.js'); authorPage(root, owner, venues); root.classList.remove('boot'); return; }
      api.use(venues[0].slug);
    }
    const { mountVisitor } = await import('./visitor/visitor.js');
    await mountVisitor(root, api);
    root.classList.remove('boot');
  } catch (e) {
    console.error(e);
    root.className = 'fatal';
    root.innerHTML = `<p>Не удалось открыть карту: ${String(e.message || e).replace(/</g, '&lt;')}</p><a class="btn" href="index.html">Обновить</a> <a class="txt-btn" href="admin.html">Админ-панель</a>`;
  }
}

// В обычном сайте смена экрана перезагружает страницу (чисто освобождает WebGL),
// во встроенном демо — перерисовывает приложение на месте.
window.__remount = () => {
  if (!window.__FORCE_DEMO__) return location.reload();
  const fresh = root.cloneNode(false); fresh.className = 'boot'; root.replaceWith(fresh); root = fresh; mount();
};
window.addEventListener('hashchange', () => window.__remount());
mount();

// PWA: карту можно установить на телефон, открытые ранее карты работают без сети.
// Сервис-воркер кэширует только публичное (код, опубликованные карты, фото) — данные входа и админки никогда.
if ('serviceWorker' in navigator && !window.__FORCE_DEMO__ && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* без офлайн-режима карта тоже работает */ });
}
window.addEventListener('offline', () => import('./core/ui.js').then(({ toast }) => toast('Нет сети — показываю сохранённую версию карты', 4000)));
