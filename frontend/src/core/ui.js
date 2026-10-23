// Мелкие помощники интерфейса: экранирование, иконки, тосты, нижняя шторка, фото.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const P = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  layers: '<path d="M12 4l9 5-9 5-9-5 9-5z"/><path d="M3 14l9 5 9-5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.2 5-4.8 2 2.2-5z"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h6a3 3 0 000-6h-4a3 3 0 010-6h6"/>',
  pano: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  select: '<path d="M6 3l12 8-5.5 1.6L10 18z"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  poly: '<path d="M5 8l6-4 8 4-2 10H7z"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6"/>',
  wall: '<path d="M4 18V8l8-3 8 3"/><path d="M4 18h3M17 8v10"/>',
  door: '<path d="M5 20V4h9v16"/><path d="M14 20h5M11 12h.01"/>',
  stairs: '<path d="M4 20h4v-4h4v-4h4V8h4"/>',
  erase: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  link: '<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M8 15l8-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 16v4h14v-4"/>',
  people: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3.5 19c.9-3 3-4.5 5.5-4.5s4.6 1.5 5.5 4.5M15 15c2.3 0 4 1.2 5 3.5"/>',
  history: '<path d="M4 12a8 8 0 102.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4l3 2"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1.3 0 1.8-1 1.3-2-.6-1.2.2-2.5 1.6-2.5H17a4 4 0 004-4c0-5-4-9.5-9-9.5z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="14.5" cy="7" r="1.2"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20 16l-5-5-8 8"/>',
  logout: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
  grid: '<path d="M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  publish: '<path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M4 14v6h16v-6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;

export function toast(text, ms = 2600) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text; el.hidden = false; el.classList.remove('out');
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.classList.add('out'); setTimeout(() => (el.hidden = true), 200); }, ms);
}

/** Фото из assets/photos. В сборке-демо они подставляются из window.__PHOTOS__. */
export function photo(name) {
  return window.__PHOTOS__?.[name] || new URL(`../../assets/photos/${name}.jpg`, import.meta.url).href;
}

/**
 * Нижняя шторка как в картографических приложениях: тянется пальцем, три положения.
 * На широком экране превращается в боковую панель (CSS), перетаскивание выключается.
 */
export class Sheet {
  constructor(el, { onSnap } = {}) {
    this.el = el; this.body = el.querySelector('.sheet-body'); this.onSnap = onSnap; this.state = 'half';
    const grip = el.querySelector('.sheet-grip');
    let y0 = 0, h0 = 0, dragging = false, moved = 0;
    const desktop = () => matchMedia('(min-width: 900px)').matches;
    const start = (e) => {
      if (desktop()) return;
      dragging = true; moved = 0; y0 = e.clientY; h0 = el.getBoundingClientRect().height;
      el.style.transition = 'none'; grip.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      moved = Math.abs(e.clientY - y0);
      el.style.height = Math.max(96, Math.min(this.max(), h0 - (e.clientY - y0))) + 'px';
    };
    const end = () => {
      if (!dragging) return;
      dragging = false; el.style.transition = '';
      if (moved < 6) { this.snap(this.state === 'peek' ? 'half' : this.state === 'half' ? 'full' : 'peek'); return; }
      const h = el.getBoundingClientRect().height, opts = { peek: this.peekH(), half: this.halfH(), full: this.max() };
      this.snap(Object.entries(opts).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0]);
    };
    grip.addEventListener('pointerdown', start);
    const opt = { signal: window.__ac?.signal };
    window.addEventListener('pointermove', move, opt);
    window.addEventListener('pointerup', end, opt);
    window.addEventListener('pointercancel', end, opt);
    window.addEventListener('resize', () => this.snap(this.state), opt);
  }
  avail() { return this.el.parentElement.getBoundingClientRect().height - (parseFloat(getComputedStyle(this.el).bottom) || 0); }
  max() { return this.avail() - 8; }
  peekH() { return this.peek ?? 112; }
  halfH() { return Math.round(this.avail() * 0.46); }
  snap(state) {
    this.state = state;
    if (matchMedia('(min-width: 900px)').matches) { this.el.style.height = ''; return; }
    const h = state === 'peek' ? this.peekH() : state === 'half' ? this.halfH() : this.max();
    this.el.style.height = h + 'px'; this.el.dataset.state = state; this.onSnap?.(state);
  }
  set(html, state) { this.body.innerHTML = html; this.body.scrollTop = 0; if (state) this.snap(state); }
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
