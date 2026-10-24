// Личная ссылка администратора (index.html?by=<автор>), если у него несколько опубликованных объектов: выбор карты.
import { esc, fmtDate, icon } from '../core/ui.js';

export function authorPage(root, owner, venues) {
  document.title = `Карты · ${owner.name}`;
  root.innerHTML = `
  <div class="author">
    <header><span class="avatar lg">${esc(owner.name.trim()[0] || '?')}</span><div><h1>${esc(owner.name)}</h1><p>${venues.length ? 'Выберите карту' : 'Опубликованных карт пока нет'}</p></div></header>
    <div class="author-list">${venues.map((v) => `
      <a class="author-card" href="?by=${encodeURIComponent(owner.handle)}&object=${encodeURIComponent(v.slug)}">
        <span class="obj-ic">${esc(v.name.trim()[0] || '?')}</span>
        <span class="t"><b>${esc(v.name)}</b><span>${esc(v.description || 'Карта объекта')} · обновлена ${fmtDate(v.published_at)}</span></span>${icon('chevron', 'chev')}
      </a>`).join('')}</div>
  </div>`;
}
