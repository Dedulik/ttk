// Точка входа: выбираем сервер или демо-режим и открываем нужный экран.
//   #/        — карта для посетителей (без входа)
//   #/admin   — панель для сотрудников (вход по почте и паролю, права по ролям)
import { createApi } from './core/api.js';

let root = document.getElementById('app');
const api = await createApi();

async function mount() {
  window.__ac?.abort(); window.__ac = new AbortController();   // снимаем обработчики прошлого экрана
  try {
    if (location.hash.startsWith('#/admin')) {
      const { mountAdmin } = await import('./admin/admin.js');
      await mountAdmin(root, api);
    } else {
      const { mountVisitor } = await import('./visitor/visitor.js');
      await mountVisitor(root, api);
    }
    root.classList.remove('boot');
  } catch (e) {
    console.error(e);
    root.className = 'fatal';
    root.innerHTML = `<p>Не удалось открыть карту: ${String(e.message || e).replace(/</g, '&lt;')}</p><button onclick="location.reload()">Обновить</button>`;
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
