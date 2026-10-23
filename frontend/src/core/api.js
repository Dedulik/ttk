// Клиент API. Если бэкенд недоступен (GitHub Pages, просмотр без сервера), включается демо-режим:
// те же методы и роли, но данные живут в localStorage этого браузера.
import { clone, normalize } from './model.js';

const SLUG = 'rostov-arena';
const TOKEN_KEY = 'arena.token';

export class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

export async function loadTemplate() {
  if (window.__TEMPLATE__) return clone(window.__TEMPLATE__);
  const r = await fetch(new URL('../../data/template_map.json', import.meta.url));
  return r.json();
}

// ---------------- настоящий сервер ----------------
class ServerApi {
  constructor(base) { this.base = base; this.demo = false; this.token = localStorage.getItem(TOKEN_KEY); }
  async req(method, path, body, isForm) {
    const headers = {};
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (body && !isForm) headers['Content-Type'] = 'application/json';
    const r = await fetch(this.base + path, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && this.token) this.logout();
      throw new ApiError(r.status, data.detail || 'Ошибка сервера');
    }
    return data;
  }
  async login(email, password) { const r = await this.req('POST', '/api/auth/login', { email, password }); this.token = r.token; localStorage.setItem(TOKEN_KEY, r.token); return r.user; }
  logout() { this.token = null; localStorage.removeItem(TOKEN_KEY); }
  me() { return this.token ? this.req('GET', '/api/auth/me') : Promise.resolve(null); }
  async published() { const r = await this.req('GET', `/api/venues/${SLUG}/map`); return { ...r, data: normalize(r.data) }; }
  async draft() { const r = await this.req('GET', `/api/venues/${SLUG}/draft`); return { ...r, data: normalize(r.data) }; }
  saveDraft(data, base_revision) { return this.req('PUT', `/api/venues/${SLUG}/draft`, { data, base_revision }); }
  publish(comment) { return this.req('POST', `/api/venues/${SLUG}/publish`, { comment }); }
  versions() { return this.req('GET', `/api/venues/${SLUG}/versions`); }
  restore(id) { return this.req('POST', `/api/venues/${SLUG}/versions/${id}/restore`); }
  users() { return this.req('GET', '/api/users'); }
  createUser(u) { return this.req('POST', '/api/users', u); }
  updateUser(id, u) { return this.req('PATCH', `/api/users/${id}`, u); }
  deleteUser(id) { return this.req('DELETE', `/api/users/${id}`); }
  upload(file) { const f = new FormData(); f.append('file', file); return this.req('POST', '/api/uploads', f, true); }
}

// ---------------- демо без сервера ----------------
const LEVEL = { viewer: 0, editor: 1, admin: 2 };
const mem = {};
const store = {
  get(k, d) { try { const v = localStorage.getItem('arena.demo.' + k); return v ? JSON.parse(v) : (mem[k] ?? d); } catch { return mem[k] ?? d; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem('arena.demo.' + k, JSON.stringify(v)); } catch { /* хранилище недоступно — держим в памяти */ } return true; },
};
const DEMO_USERS = [
  { id: 1, email: 'admin@arena.local', name: 'Администратор', role: 'admin', password: 'admin12345' },
  { id: 2, email: 'editor@arena.local', name: 'Редактор', role: 'editor', password: 'editor12345' },
  { id: 3, email: 'viewer@arena.local', name: 'Наблюдатель', role: 'viewer', password: 'viewer12345' },
];
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at || '2026-10-23T00:00:00Z' });
const now = () => new Date().toISOString();

const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return ss.mem[k] ?? null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { ss.mem[k] = v; } },
  del(k) { try { sessionStorage.removeItem(k); } catch { delete ss.mem[k]; } },
  mem: {},
};

class DemoApi {
  constructor() { this.demo = true; this.token = ss.get(TOKEN_KEY); }
  async init() {
    if (!store.get('draft')) {
      const t = await loadTemplate();
      store.set('draft', { data: t, revision: 1, updated_at: now(), updated_by: null });
      store.set('versions', [{ id: 1, number: 1, comment: 'Шаблон по генплану', published_at: now(), published_by: null, data: t }]);
    }
    if (!store.get('users')) store.set('users', DEMO_USERS);
  }
  user() { return store.get('users', []).find((u) => 'demo:' + u.id === this.token) || null; }
  need(role) {
    const u = this.user();
    if (!u) throw new ApiError(401, 'Нужно войти');
    if (LEVEL[u.role] < LEVEL[role]) throw new ApiError(403, 'Недостаточно прав');
    return u;
  }
  async login(email, password) {
    const u = store.get('users', []).find((x) => x.email === email.trim().toLowerCase() && x.password === password);
    if (!u) throw new ApiError(401, 'Неверная почта или пароль');
    this.token = 'demo:' + u.id; ss.set(TOKEN_KEY, this.token);
    return pub(u);
  }
  logout() { this.token = null; ss.del(TOKEN_KEY); }
  async me() { const u = this.user(); return u ? pub(u) : null; }
  async published() { const v = store.get('versions', [])[0]; return { data: normalize(v.data), number: v.number, published_at: v.published_at }; }
  async draft() { this.need('viewer'); const d = store.get('draft'); return { ...d, data: normalize(d.data) }; }
  async saveDraft(data, base) {
    const u = this.need('editor'), d = store.get('draft');
    if (base !== d.revision) throw new ApiError(409, 'Черновик изменили в другой вкладке. Обновите карту.');
    const next = { data, revision: d.revision + 1, updated_at: now(), updated_by: u.name };
    if (!store.set('draft', next)) throw new ApiError(413, 'Не хватает места в браузере — уберите тяжёлые фото');
    return next;
  }
  async publish(comment) {
    const u = this.need('admin'), vs = store.get('versions', []);
    const v = { id: (vs[0]?.id || 0) + 1, number: (vs[0]?.number || 0) + 1, comment, published_at: now(), published_by: u.name, data: store.get('draft').data };
    store.set('versions', [v, ...vs].slice(0, 15));
    const { data, ...meta } = v; return meta;
  }
  async versions() { this.need('viewer'); return store.get('versions', []).map(({ data, ...m }) => m); }
  async restore(id) {
    const u = this.need('admin'), v = store.get('versions', []).find((x) => x.id === id), d = store.get('draft');
    const next = { data: v.data, revision: d.revision + 1, updated_at: now(), updated_by: u.name };
    store.set('draft', next); return { ...next, data: normalize(next.data) };
  }
  async users() { this.need('admin'); return store.get('users', []).map(pub); }
  async createUser(b) {
    this.need('admin'); const us = store.get('users', []);
    if (us.some((u) => u.email === b.email.toLowerCase())) throw new ApiError(409, 'Пользователь с такой почтой уже есть');
    if ((b.password || '').length < 6) throw new ApiError(422, 'Пароль — минимум 6 символов');
    const u = { ...b, email: b.email.toLowerCase(), id: Math.max(...us.map((x) => x.id)) + 1, created_at: now() };
    store.set('users', [...us, u]); return pub(u);
  }
  async updateUser(id, b) {
    this.need('admin'); const us = store.get('users', []), u = us.find((x) => x.id === id);
    if (b.role && u.role === 'admin' && b.role !== 'admin' && us.filter((x) => x.role === 'admin').length < 2) throw new ApiError(400, 'Нельзя снять права с последнего администратора');
    Object.assign(u, Object.fromEntries(Object.entries(b).filter(([, v]) => v))); store.set('users', us); return pub(u);
  }
  async deleteUser(id) {
    const me = this.need('admin');
    if (me.id === id) throw new ApiError(400, 'Нельзя удалить самого себя');
    store.set('users', store.get('users', []).filter((u) => u.id !== id)); return null;
  }
  async upload(file) {
    this.need('editor');
    if (file.size > 2.5 * 1024 * 1024) throw new ApiError(413, 'В демо-режиме — фото до 2,5 МБ. На сервере — до 15 МБ.');
    const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
    return { id: Date.now(), url, filename: file.name, size: file.size };
  }
}

/** Выбирает сервер или демо. Адрес сервера можно задать в window.API_BASE (по умолчанию — тот же сайт). */
export async function createApi() {
  const base = window.API_BASE ?? '';
  if (!window.__FORCE_DEMO__) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(base + '/api/health', { signal: ctl.signal }); clearTimeout(t);
      if (r.ok && (await r.json()).ok) return new ServerApi(base);
    } catch { /* сервера нет — демо */ }
  }
  const d = new DemoApi(); await d.init(); return d;
}

export const ROLE_NAMES = { viewer: 'Наблюдатель', editor: 'Редактор', admin: 'Администратор' };
export const can = (user, role) => !!user && LEVEL[user.role] >= LEVEL[role];
