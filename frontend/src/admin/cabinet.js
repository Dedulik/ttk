// Админ-панель: вход, объекты (конструктор с нуля), личный кабинет, команда и администраторы, безопасность.
import { ROLE_NAMES, authorLink, can, objectLink } from '../core/api.js';
import { $, esc, fmtDate, icon, photo, toast } from '../core/ui.js';

const ACTIONS = {
  login: 'Вход', login_failed: 'Неверный пароль', account_locked: 'Учётная запись заблокирована', password_change: 'Смена пароля',
  logout_all: 'Выход на всех устройствах', publish: 'Публикация карты', restore: 'Откат версии', user_create: 'Новый сотрудник',
  user_update: 'Изменение сотрудника', user_delete: 'Удаление сотрудника', venue_create: 'Новый объект', venue_update: 'Изменение объекта',
  venue_delete: 'Удаление объекта', backup_download: 'Скачана резервная копия', handle_change: 'Новый адрес личной ссылки',
};
const SECTIONS = {
  objects: { n: 'Объекты', ic: 'map', sub: 'Карты площадок: создайте новую с чистого листа или продолжите работу над существующей' },
  account: { n: 'Личный кабинет', ic: 'user', sub: 'Профиль, пароль и ваши последние действия' },
  team: { n: 'Команда', ic: 'people', sub: 'Все администраторы и сотрудники: роли, доступ, блокировки', admin: true },
  security: { n: 'Безопасность', ic: 'check', sub: 'Защита базы данных, резервные копии и журнал действий', admin: true },
};
const initial = (u) => esc((u.name || u.email || '?').trim()[0].toUpperCase());
const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ');
const field = (label, inner, cls = '') => `<label class="field ${cls}"><span class="lbl">${label}</span>${inner}</label>`;

// ---------------- вход ----------------
export function loginScreen(root, api) {
  root.innerHTML = `
  <div class="login"><form id="lf" novalidate>
    <img class="hero" src="${photo('facade')}" alt="">
    <div><h1>Админ-панель</h1><p class="cap">Вход для администраторов и сотрудников</p></div>
    <label class="field"><span class="lbl">Почта</span><input class="inp" id="le" type="email" autocomplete="username" required></label>
    <label class="field"><span class="lbl">Пароль</span><input class="inp" id="lp" type="password" autocomplete="current-password" required></label>
    <p class="err" id="lerr" hidden></p>
    <button class="btn primary full" type="submit">Войти</button>
    ${api.demo ? `<div class="demo-note"><b>Демо без сервера.</b> Данные хранятся только в этом браузере.<br>
      <b>admin@arena.local</b> / admin12345 — администратор<br><b>editor@arena.local</b> / editor12345 — редактор<br><b>viewer@arena.local</b> / viewer12345 — наблюдатель</div>`
      : '<p class="cap" style="margin:0">Учётные записи выдаёт администратор. После 5 неверных паролей вход блокируется на 15 минут.</p>'}
    <a class="txt-btn" href="index.html" style="text-align:center">← Карта для посетителей</a>
  </form></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#lerr'), btn = e.target.querySelector('[type=submit]'); err.hidden = true; btn.disabled = true;
    try { await api.login($('#le').value, $('#lp').value); window.__remount(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
  root.addEventListener('click', (e) => { const b = e.target.closest('.demo-note b'); if (b && b.textContent.includes('@')) { $('#le').value = b.textContent; $('#lp').value = b.nextSibling.textContent.split('—')[0].replace('/', '').trim(); } });
}

// ---------------- кабинет ----------------
export async function cabinet(root, api, user, section) {
  const isAdmin = can(user, 'admin');
  if (!SECTIONS[section] || (SECTIONS[section].admin && !isAdmin)) section = 'objects';
  const S = SECTIONS[section];
  root.innerHTML = `
  <div class="cab">
    <aside class="cab-side">
      <a class="cab-brand" href="#/"><span class="mark">РА</span><span><b>Админ-панель</b><span>Карта пространства</span></span></a>
      <nav class="cab-nav">${Object.entries(SECTIONS).filter(([, v]) => !v.admin || isAdmin).map(([k, v]) => `<a href="#/${k === 'objects' ? '' : k}" aria-current="${k === section ? 'page' : 'false'}">${icon(v.ic)}<span>${v.n}</span></a>`).join('')}</nav>
      <div class="cab-me">
        <span class="avatar">${initial(user)}</span><span class="t"><b>${esc(user.name || user.email)}</b><span>${ROLE_NAMES[user.role]}${api.demo ? ' · демо' : ''}</span></span>
        <button class="iconbtn flat" data-act="logout" aria-label="Выйти" title="Выйти">${icon('logout')}</button>
      </div>
    </aside>
    <main class="cab-main">
      <header class="cab-head"><div><h1>${S.n}</h1><p>${S.sub}</p></div><div class="row" id="headActs"></div></header>
      <div id="body" class="cab-body"><p class="cap">Загружаю…</p></div>
    </main>
  </div>`;
  const body = $('#body', root);
  const fail = (e) => { body.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; };

  root.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Ссылка скопирована — отправьте её посетителям'); } catch { toast(c.dataset.copy, 8000); } return; }
    const t = e.target.closest('[data-act]'); if (!t) return;
    if (t.dataset.act === 'logout') { api.logout(); location.hash = '#/'; window.__remount(); }
  });

  try {
    if (section === 'objects') await objects();
    if (section === 'account') await account();
    if (section === 'team') await team();
    if (section === 'security') await security();
  } catch (e) { fail(e); }

  // ---------- объекты ----------
  async function objects() {
    const all = await api.venues(), mine = all.filter((v) => v.owner?.handle === user.handle);
    let showAll = !isAdmin || !mine.length;
    if (isAdmin) $('#headActs').innerHTML = `<button class="btn primary" data-act="newObj">${icon('rect')}Новый объект</button>`;
    const myLink = user.handle ? authorLink(user.handle) : null;
    const linkCard = isAdmin && myLink ? `<section class="card my-link">
      <div><h2 style="font-size:16px">Ваша ссылка для посетителей</h2><p class="cap" style="margin:2px 0 0">По ней откроются только ваши опубликованные объекты: один — сразу карта, несколько — список. Сейчас опубликовано: ${mine.filter((v) => v.published).length}.</p></div>
      <div class="row nowrap"><input class="inp mono" readonly value="${esc(myLink)}" aria-label="Ваша ссылка"><button class="btn sm dark" data-copy="${esc(myLink)}">${icon('copy')}Копировать</button><a class="btn sm" href="${esc(myLink)}" target="_blank" rel="noopener">${icon('eye')}Открыть</a></div>
      <a class="txt-btn" href="#/account" style="align-self:flex-start">Изменить адрес ссылки</a></section>` : '';
    const list = all;
    const card = (v) => `<article class="obj">
      <div class="obj-top"><span class="obj-ic">${esc(v.name.trim()[0] || '?')}</span><div class="t"><h2>${esc(v.name)}</h2><span class="mono">${esc(v.slug)}</span></div>
        <span class="status-pill ${v.published ? 'ok' : 'warn'}">${v.published ? 'Опубликован · v' + v.published : 'Не опубликован'}</span></div>
      ${v.description ? `<p class="obj-desc">${esc(v.description)}</p>` : ''}
      <p class="cap" style="margin:0">${v.owner ? `Автор: ${esc(v.owner.name)}${v.owner.handle === user.handle ? ' (вы)' : ''} · ` : ''}${v.updated_at ? `черновик изменён ${fmtDate(v.updated_at)}${v.updated_by ? ' · ' + esc(v.updated_by) : ''}` : ''}</p>
      <div class="row">
        <a class="btn dark sm" href="#/edit/${encodeURIComponent(v.slug)}">${icon('cube')}Конструктор</a>
        ${v.published ? `<a class="btn sm" href="index.html?object=${encodeURIComponent(v.slug)}" target="_blank" rel="noopener">${icon('eye')}Карта</a><button class="btn sm ghost" data-copy="${esc(objectLink(v.slug))}" title="Скопировать ссылку на эту карту">${icon('link')}Ссылка</button>` : ''}
        ${isAdmin && !api.demo ? `<button class="btn sm ghost" data-act="renameObj" data-slug="${esc(v.slug)}">Изменить</button><button class="btn sm ghost" data-act="delObj" data-slug="${esc(v.slug)}" ${list.length < 2 ? 'disabled title="Единственный объект нельзя удалить"' : ''}>${icon('erase')}</button>` : ''}
      </div>
      <div class="obj-extra" hidden></div>
    </article>`;
    const grid = () => { const vs = showAll ? all : mine; $('#grid').innerHTML = vs.map(card).join('') || '<p class="cap">Пока нет ни одного объекта.</p>'; };
    body.innerHTML = `${linkCard}${isAdmin ? newForm(list) : ''}
      ${isAdmin && mine.length ? `<div class="seg" id="own"><button data-own="mine" aria-pressed="${!showAll}">Мои · ${mine.length}</button><button data-own="all" aria-pressed="${showAll}">Все · ${all.length}</button></div>` : ''}
      <div class="obj-grid" id="grid"></div>`;
    grid();

    body.addEventListener('click', async (e) => {
      const own = e.target.closest('[data-own]');
      if (own) { showAll = own.dataset.own === 'all'; $('#own').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === own)); return grid(); }
      const t = e.target.closest('[data-act]'); if (!t) return;
      const a = t.dataset.act, slug = t.dataset.slug, extra = t.closest('.obj')?.querySelector('.obj-extra');
      if (a === 'renameObj') {
        const v = list.find((x) => x.slug === slug);
        extra.hidden = !extra.hidden;
        extra.innerHTML = `<form class="stack" data-form="rename" data-slug="${esc(slug)}">${field('Название', `<input class="inp" name="name" value="${esc(v.name)}" required>`)}${field('Описание для посетителей', `<textarea class="inp" name="description">${esc(v.description || '')}</textarea>`)}<button class="btn sm dark">Сохранить</button></form>`;
      }
      if (a === 'delObj') {
        extra.hidden = !extra.hidden;
        extra.innerHTML = `<form class="stack danger" data-form="delete" data-slug="${esc(slug)}"><p class="cap" style="margin:0">Удалятся черновик и все опубликованные версии. Это нельзя отменить. Введите адрес объекта <b class="mono">${esc(slug)}</b>, чтобы подтвердить.</p><input class="inp mono" name="confirm" autocomplete="off" required><button class="btn sm primary">Удалить навсегда</button></form>`;
      }
    });
    root.addEventListener('click', (e) => { if (e.target.closest('[data-act="newObj"]')) { const f = $('#newObj'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); } });
    body.addEventListener('change', (e) => { if (e.target.name === 'start') syncStart(); });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, d = Object.fromEntries(new FormData(f)), btn = f.querySelector('button:not([type=button])'); btn.disabled = true;
      try {
        if (f.id === 'newObj') { const v = await api.createVenue(d); toast('Объект создан — рисуйте план'); location.hash = '#/edit/' + encodeURIComponent(v.slug); return; }
        if (f.dataset.form === 'rename') { await api.updateVenue(f.dataset.slug, d); toast('Сохранено'); return window.__remount(); }
        if (f.dataset.form === 'delete') { await api.deleteVenue(f.dataset.slug, d.confirm.trim()); toast('Объект удалён'); return window.__remount(); }
      } catch (ex) { toast(ex.message, 4000); btn.disabled = false; }
    });
    syncStart();
  }
  function newForm(list) {
    const opt = (v, title, sub, on) => `<label class="pick"><input type="radio" name="start" value="${v}" ${on ? 'checked' : ''}><span><b>${title}</b><span>${sub}</span></span></label>`;
    return `<form class="card new-obj" id="newObj" hidden>
      <div><h2 style="font-size:17px">Новый объект</h2><p class="cap" style="margin:2px 0 0">Здание, торговый центр, кампус, парк — любой объект. После создания откроется конструктор.</p></div>
      ${api.demo ? '<p class="demo-note"><b>Нужен сервер.</b> В демо без сервера можно работать только с одним объектом.</p>' : ''}
      <div class="grid2">${field('Название', '<input class="inp" name="name" required maxlength="120" placeholder="Например: ТЦ «Горизонт»">')}${field('Адрес в ссылке (необязательно)', '<input class="inp mono" name="slug" pattern="[a-z0-9][a-z0-9-]{1,47}" placeholder="создастся из названия">')}</div>
      ${field('Описание для посетителей', '<input class="inp" name="description" maxlength="500" placeholder="Что это за место">')}
      <div class="field"><span class="lbl">С чего начать</span><div class="picks">
        ${opt('blank', 'Пустой план', 'Чистый участок с сеткой: рисуете всё с нуля', true)}
        ${opt('copy', 'Копия объекта', 'Повторить карту, которая уже есть', false)}
        ${opt('template', 'Шаблон «Ростов Арена»', 'Стадион и территория по генплану', false)}</div></div>
      <div class="grid2" data-for="blank">${field('Ширина участка, м', '<input class="inp mono" name="width" type="number" min="20" max="5000" value="200">')}${field('Глубина участка, м', '<input class="inp mono" name="height" type="number" min="20" max="5000" value="150">')}</div>
      <div data-for="copy" hidden>${field('Какой объект скопировать', `<select class="inp" name="source">${list.map((v) => `<option value="${esc(v.slug)}">${esc(v.name)}</option>`).join('')}</select>`)}</div>
      <div class="row"><button class="btn primary" ${api.demo ? 'disabled' : ''}>${icon('check')}Создать и открыть конструктор</button><button type="button" class="btn ghost" data-act="newObj">Отмена</button></div>
    </form>`;
  }
  function syncStart() {
    const f = $('#newObj'); if (!f) return;
    const v = f.querySelector('[name=start]:checked').value;
    f.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== v; el.querySelectorAll('input,select').forEach((i) => (i.disabled = el.hidden)); });
  }

  // ---------- личный кабинет ----------
  async function account() {
    const me = await api.me(), acts = await api.myActivity().catch(() => []);
    body.innerHTML = `<div class="cab-cols">
      <section class="card">
        <div class="row nowrap"><span class="avatar lg">${initial(me)}</span><div><h2 style="font-size:18px">${esc(me.name || me.email)}</h2><p class="cap" style="margin:2px 0 0">${esc(me.email)}</p></div></div>
        <dl class="kv"><dt>Роль</dt><dd>${ROLE_NAMES[me.role]}</dd><dt>В команде с</dt><dd>${fmtDate(me.created_at) || '—'}</dd>
          <dt>Последний вход</dt><dd>${fmtDate(me.last_login_at) || '—'}</dd><dt>Пароль менялся</dt><dd>${fmtDate(me.password_changed_at) || 'ещё ни разу'}</dd></dl>
        <form class="stack" id="pf">${field('Имя — его увидят посетители на странице ваших карт', `<input class="inp" name="name" value="${esc(me.name || '')}" maxlength="120">`)}
          ${me.handle ? field('Адрес личной ссылки', `<div class="row nowrap"><span class="cap mono nowrap">?by=</span><input class="inp mono" name="handle" value="${esc(me.handle)}" pattern="[a-z0-9][a-z0-9\\-]{2,29}" required></div>`) + `<p class="cap mono" style="margin:0">${esc(authorLink(me.handle))}</p>` : ''}
          <button class="btn sm dark">Сохранить</button></form>
      </section>
      <section class="card">
        <h2 style="font-size:16px">Сменить пароль</h2>
        <form class="stack" id="pwf">
          ${field('Текущий пароль', '<input class="inp" name="password" type="password" autocomplete="current-password" required>')}
          ${field('Новый пароль', '<input class="inp" name="new_password" type="password" autocomplete="new-password" minlength="8" required>')}
          ${field('Повторите новый', '<input class="inp" name="repeat" type="password" autocomplete="new-password" required>')}
          <p class="cap" style="margin:0">От 8 символов, буквы и цифры. После смены пароля остальные устройства выйдут из системы.</p>
          <button class="btn sm primary">Сменить пароль</button>
        </form>
        <div class="sep"></div>
        <h2 style="font-size:16px">Сеансы</h2>
        <p class="cap" style="margin:0">Потеряли телефон или входили с чужого компьютера — завершите все сеансы.</p>
        <div class="row"><button class="btn sm" data-act="logoutAll" ${api.demo ? 'disabled' : ''}>Выйти на всех устройствах</button><button class="btn sm ghost" data-act="logout">${icon('logout')}Выйти здесь</button></div>
      </section>
      <section class="card wide"><h2 style="font-size:16px">Мои последние действия</h2>${activity(acts, false)}</section>
    </div>`;
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      try {
        if (e.target.id === 'pf') { await api.updateMe({ name: d.name, handle: d.handle?.trim().toLowerCase() }); toast('Сохранено'); return window.__remount(); }
        if (d.new_password !== d.repeat) throw new Error('Новые пароли не совпадают');
        await api.updateMe({ password: d.password, new_password: d.new_password }); toast('Пароль изменён, другие устройства вышли из системы', 4000); window.__remount();
      } catch (ex) { toast(ex.message, 4000); }
    });
    body.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-act="logoutAll"]')) return;
      try { await api.logoutAll(); api.logout(); toast('Все сеансы завершены'); window.__remount(); } catch (ex) { toast(ex.message, 4000); }
    });
  }

  function activity(rows, withUser) {
    if (!rows.length) return '<p class="cap">Записей пока нет.</p>';
    return `<div class="table-wrap"><table class="tbl"><thead><tr><th>Когда</th>${withUser ? '<th>Кто</th>' : ''}<th>Действие</th><th>Подробности</th><th>IP</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${/failed|locked/.test(r.action) ? 'bad' : ''}"><td class="nowrap">${fmtDate(r.created_at)}</td>${withUser ? `<td>${esc(r.name || r.email || '—')}</td>` : ''}<td>${esc(ACTIONS[r.action] || r.action)}</td><td class="muted">${esc(r.details)}</td><td class="mono muted">${esc(r.ip || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  // ---------- команда и администраторы ----------
  async function team() {
    let filter = 'all', q = '';
    $('#headActs').innerHTML = `<button class="btn primary" data-act="newUser">${icon('people')}Добавить</button>`;
    body.innerHTML = `
      <form class="card" id="uf" hidden><h2 style="font-size:16px">Новый сотрудник</h2>
        <div class="grid2">${field('Почта', '<input class="inp" name="email" type="email" required>')}${field('Имя', '<input class="inp" name="name">')}</div>
        <div class="grid2">${field('Пароль', `<div class="row nowrap"><input class="inp mono" name="password" type="text" minlength="8" required autocomplete="off"><button type="button" class="btn sm" data-act="gen">Сгенерировать</button></div>`)}
          ${field('Роль', `<select class="inp" name="role">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${k === 'editor' ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
        <p class="cap" style="margin:0">Передайте пароль человеку лично — после входа он сменит его в личном кабинете.</p>
        <div class="row"><button class="btn dark">Добавить</button><button type="button" class="btn ghost" data-act="newUser">Отмена</button></div></form>
      <div class="card">
        <div class="row" style="justify-content:space-between"><div class="seg" id="seg">${[['all', 'Все'], ['admin', 'Администраторы'], ['editor', 'Редакторы'], ['viewer', 'Наблюдатели']].map(([k, n]) => `<button data-f="${k}" aria-pressed="${k === filter}">${n}</button>`).join('')}</div>
          <input class="inp" id="uq" placeholder="Поиск по имени или почте" style="max-width:260px"></div>
        <div id="users"><p class="cap">Загружаю…</p></div>
      </div>
      <div class="card"><b>Что может каждая роль</b><dl class="kv"><dt>Наблюдатель</dt><dd>смотрит черновики и историю версий</dd><dt>Редактор</dt><dd>рисует в конструкторе, ставит точки, загружает фото</dd><dt>Администратор</dt><dd>всё выше + публикует, создаёт и удаляет объекты, управляет командой, видит журнал и резервные копии</dd></dl></div>`;
    let users = [];
    const load = async () => { users = await api.users(); render(); };
    const render = () => {
      const rows = users.filter((u) => (filter === 'all' || u.role === filter) && (u.name + ' ' + u.email).toLowerCase().includes(q));
      const admins = users.filter((u) => u.role === 'admin').length;
      $('#users').innerHTML = `<p class="cap">Всего ${users.length} · администраторов ${admins}</p><div class="table-wrap"><table class="tbl"><thead><tr><th>Сотрудник</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th></th></tr></thead><tbody>
        ${rows.map((u) => `<tr data-id="${u.id}"><td><div class="row nowrap"><span class="avatar">${initial(u)}</span><span class="t2"><b>${esc(u.name || '—')}${u.id === user.id ? ' <span class="role-tag">это вы</span>' : ''}</b><span>${esc(u.email)}</span>${u.role === 'admin' && u.handle ? `<button class="txt-btn mono" data-copy="${esc(authorLink(u.handle))}" title="Скопировать личную ссылку" style="font-size:12px;text-align:left">?by=${esc(u.handle)}</button>` : ''}</span></div></td>
          <td><select class="inp sm" data-role="${u.id}" ${u.id === user.id ? 'disabled' : ''} aria-label="Роль">${Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td>${u.is_active === false ? '<span class="status-pill bad">Отключён</span>' : u.locked ? '<span class="status-pill warn">Заблокирован</span>' : '<span class="status-pill ok">Активен</span>'}</td>
          <td class="nowrap muted">${fmtDate(u.last_login_at) || '—'}</td>
          <td><div class="row nowrap" style="justify-content:flex-end">
            ${u.locked ? `<button class="btn sm" data-u="unlock">Разблокировать</button>` : ''}
            ${u.id !== user.id && !api.demo ? `<button class="btn sm ghost" data-u="pw" title="Задать новый пароль">Пароль</button><button class="btn sm ghost" data-u="active">${u.is_active === false ? 'Включить' : 'Отключить'}</button>` : ''}
            ${u.id !== user.id ? `<button class="iconbtn flat" data-u="del" aria-label="Удалить">${icon('erase')}</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Никого не нашлось</td></tr>'}
      </tbody></table></div>`;
    };
    await load();
    body.addEventListener('input', (e) => { if (e.target.id === 'uq') { q = e.target.value.trim().toLowerCase(); render(); } });
    root.addEventListener('click', (e) => { if (e.target.closest('[data-act="newUser"]')) { const f = $('#uf'); f.hidden = !f.hidden; } });
    body.addEventListener('click', async (e) => {
      const fb = e.target.closest('[data-f]');
      if (fb) { filter = fb.dataset.f; $('#seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === fb)); return render(); }
      if (e.target.closest('[data-act="gen"]')) { $('#uf [name=password]').value = genPassword(); return; }
      const b = e.target.closest('[data-u]'); if (!b) return;
      const id = +b.closest('tr').dataset.id, u = users.find((x) => x.id === id);
      try {
        if (b.dataset.u === 'unlock') { await api.updateUser(id, { unlock: true }); toast('Разблокирован'); }
        if (b.dataset.u === 'active') { await api.updateUser(id, { is_active: u.is_active === false }); toast(u.is_active === false ? 'Доступ возвращён' : 'Доступ отключён, сеансы завершены'); }
        if (b.dataset.u === 'pw') {
          const pw = genPassword();
          if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Сбросить?'; b.classList.add('primary'); return; }
          await api.updateUser(id, { password: pw }); toast(`Новый пароль для ${u.email}: ${pw} — передайте лично`, 12000);
        }
        if (b.dataset.u === 'del') {
          if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.style.color = 'var(--accent)'; toast('Нажмите ещё раз, чтобы удалить ' + u.email); return; }
          await api.deleteUser(id); toast('Удалён');
        }
        await load();
      } catch (ex) { toast(ex.message, 4000); }
    });
    body.addEventListener('change', async (e) => {
      const id = e.target.dataset.role; if (!id) return;
      try { await api.updateUser(+id, { role: e.target.value }); toast('Роль изменена'); } catch (ex) { toast(ex.message, 4000); }
      await load();
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.createUser(Object.fromEntries(new FormData(e.target))); toast('Сотрудник добавлен'); e.target.reset(); e.target.hidden = true; await load(); }
      catch (ex) { toast(ex.message, 4000); }
    });
  }

  // ---------- безопасность ----------
  async function security() {
    const [rep, log] = await Promise.all([api.security(), api.audit()]);
    const check = (ok, title, text) => `<li class="${ok ? 'ok' : 'warn'}"><span class="ck">${ok ? icon('check') : '!'}</span><div><b>${title}</b><span>${text}</span></div></li>`;
    $('#headActs').innerHTML = `<button class="btn dark" data-act="backup">${icon('save')}Скачать резервную копию</button>`;
    body.innerHTML = `<div class="cab-cols">
      <section class="card"><h2 style="font-size:16px">Проверка</h2><ul class="checks">
        ${check(rep.secret_source !== 'default', 'Ключ подписи сессий', rep.secret_source === 'env' ? 'Задан в переменной окружения SECRET_KEY' : 'Случайный, создан сервером и хранится в data/secret.key')}
        ${check(!rep.default_passwords.length, 'Стандартные пароли', rep.default_passwords.length ? `Смените пароли учебных записей: ${rep.default_passwords.map(esc).join(', ')}` : 'Учебные пароли нигде не используются')}
        ${check(rep.admins >= 2, 'Администраторов: ' + rep.admins, rep.admins >= 2 ? 'Доступ не потеряется, если один уйдёт в отпуск' : 'Добавьте второго администратора на случай потери пароля')}
        ${check(!rep.locked.length, 'Заблокированные записи', rep.locked.length ? rep.locked.map(esc).join(', ') + ' — разблокировать можно в разделе «Команда»' : 'Нет')}
        ${check(rep.failed_today < 10, 'Неудачных входов сегодня: ' + rep.failed_today, rep.failed_today < 10 ? 'Похоже на обычные опечатки' : 'Много — возможно, кто-то подбирает пароль')}
      </ul></section>
      <section class="card"><h2 style="font-size:16px">Как защищена база</h2><ul class="bullets">
        <li>Пароли хранятся только как хэш PBKDF2-SHA256 (200 000 итераций, своя соль) — даже из копии базы их не прочитать.</li>
        <li>5 неверных паролей подряд — запись блокируется на 15 минут; с одного IP — не больше 20 ошибок за 10 минут.</li>
        <li>Смена пароля, отключение сотрудника или «выйти везде» сразу отзывают все его сеансы. Сеанс живёт ${Math.round(rep.token_ttl_min / 60)} ч.</li>
        <li>Права проверяет сервер при каждом запросе; запросы к базе параметризованы — SQL-инъекции не пройдут.</li>
        <li>Заголовки CSP, nosniff и запрет встраивания страниц на чужих сайтах; ответы API не кэшируются.</li>
        <li>Удалённые записи затираются на диске (secure_delete). Файл базы — ${size(rep.db_size)}, доступен только владельцу.</li>
      </ul></section>
      <section class="card"><h2 style="font-size:16px">Резервные копии</h2>
        <p class="cap" style="margin:0">Сервер сохраняет копию базы при каждом запуске (последние 10 — в папке backend/data/backups). Скачайте копию перед крупными изменениями и храните её отдельно: в ней хэши паролей.</p>
        <div class="list">${rep.backups.map((b) => `<div class="item"><span class="t"><b class="mono">${esc(b.name)}</b><span>${size(b.size)}</span></span></div>`).join('') || '<p class="cap">Автоматических копий ещё нет — появятся при следующем запуске сервера.</p>'}</div>
      </section>
      <section class="card wide"><div class="row" style="justify-content:space-between"><h2 style="font-size:16px">Журнал действий</h2><input class="inp" id="lq" placeholder="Фильтр: имя, действие, IP" style="max-width:260px"></div><div id="log">${activity(log, true)}</div></section>
    </div>`;
    body.addEventListener('input', (e) => {
      if (e.target.id !== 'lq') return;
      const q = e.target.value.trim().toLowerCase();
      $('#log').innerHTML = activity(log.filter((r) => [r.name, r.email, ACTIONS[r.action] || r.action, r.details, r.ip].join(' ').toLowerCase().includes(q)), true);
    });
    root.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-act="backup"]')) return;
      try {
        const { blob, name } = await api.backup(), url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: name }).click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('Копия базы скачана — храните её в надёжном месте');
      } catch (ex) { toast(ex.message, 4000); }
    });
  }
}

/** Случайный пароль из 12 символов без похожих букв (l, I, O, 0): всегда есть буквы и цифры. */
function genPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', dig = '23456789';
  return [...crypto.getRandomValues(new Uint32Array(12))].map((n, i) => { const set = i === 0 ? abc : i % 4 === 3 ? dig : abc + dig; return set[n % set.length]; }).join('');
}
