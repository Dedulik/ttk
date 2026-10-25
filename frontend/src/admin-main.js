// Точка входа админ-панели (admin.html):
//   #/            — объекты: список и создание нового с пустого плана
//   #/account     — личный кабинет
//   #/team        — команда и администраторы (только администратор)
//   #/security    — защита базы, резервные копии, журнал (только администратор)
//   #/edit/<slug> — конструктор карты объекта
//   #/register    — регистрация посетителя
//   #/invite/<токен> — принятие приглашения в команду
import { ServerDown, can, createApi, isStaff, showServerDown } from './core/api.js';
import { applySavedTheme } from './core/ui.js';

applySavedTheme();

let root = document.getElementById('app');
let api;
try { api = await createApi(); }
catch (e) { if (e instanceof ServerDown) showServerDown(root); throw e; }
const editing = () => /^#\/edit\//.test(location.hash);

async function mount() {
  window.__ac?.abort(); window.__ac = new AbortController();   // снимаем обработчики прошлого экрана
  const fresh = root.cloneNode(false); fresh.className = 'boot'; root.replaceWith(fresh); root = fresh;
  try {
    const user = await api.me().catch(() => null);
    const { loginScreen, inviteScreen, cabinet } = await import('./admin/cabinet.js');
    const invite = location.hash.match(/^#\/invite\/([\w-]{20,})/);
    if (invite) await inviteScreen(root, api, invite[1]);
    else if (!user) loginScreen(root, api, location.hash === '#/register' ? 'register' : 'login');
    else if (editing() && !isStaff(user)) { history.replaceState(null, '', '#/account'); return mount(); }
    else if (editing()) {
      const { editor } = await import('./admin/admin.js');
      api.use(decodeURIComponent(location.hash.slice(7).split(/[?#/]/)[0]));
      // один редактор за раз: если объект занят, конструктор откроется только для просмотра
      const lock = can(user, 'editor') ? await api.lock().catch(() => ({ mine: true })) : { mine: false };
      editor(root, api, user, await api.draft(), lock);
    } else await cabinet(root, api, user, location.hash.replace(/^#\/?/, '') || 'objects');
    root.classList.remove('boot');
  } catch (e) {
    console.error(e);
    root.className = 'fatal';
    root.innerHTML = `<p>Не удалось открыть админ-панель: ${String(e.message || e).replace(/</g, '&lt;')}</p><a class="btn" href="#/">К объектам</a>`;
  }
}

// Разделы кабинета перерисовываются на месте; вход и выход из конструктора перезагружают страницу — так чисто освобождается WebGL.
window.__remount = mount;
let wasEditing = editing();
window.addEventListener('hashchange', () => { if (wasEditing || editing()) location.reload(); else mount(); wasEditing = editing(); });
mount();
