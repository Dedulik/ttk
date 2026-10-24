// 2D-план в SVG. Размеры подписей и линий заданы в экранных пикселях — на телефоне шрифт не раздувается.
// Жесты: один палец — сдвиг (или инструмент), два пальца — масштаб, колесо — масштаб к курсору.
import { CATS, PCATS, catColor, kindOf, mapBox, poiColor, sectorColor, shapeArea, shapeBox, shapePoints, standColor, wallSegments } from './model.js';
import { RANGES, SECTORS, ST, STANDS, ring, secMid, secPts, sp } from './stadium.js';
import { esc } from './ui.js';

const pts = (p) => p.map((q) => `${(+q[0]).toFixed(2)},${(+q[1]).toFixed(2)}`).join(' ');

export class Plan2D {
  constructor(svg, handlers = {}) {
    this.svg = svg; this.h = handlers; this.map = null;
    this.view = { x: 0, y: 0, w: 800, h: 530 };
    this.opts = { admin: false, sel: null, route: null, showPanos: false, underlay: null, underlayOpacity: 0.3, grid: false, overlay: '', filter: null };
    this.pointers = new Map(); this.gesture = null; this.stadCache = { key: null };
    this.bindGestures();
    new ResizeObserver(() => this.render()).observe(svg);
  }
  setMap(map) { this.map = map; this.stadCache.key = null; this.render(); }
  set(o) { Object.assign(this.opts, o); this.render(); }
  get px() { return this.view.w / Math.max(1, this.svg.clientWidth); }
  toWorld(cx, cy) { const p = this.svg.createSVGPoint(); p.x = cx; p.y = cy; return p.matrixTransform(this.svg.getScreenCTM().inverse()); }

  /** Показать прямоугольник целиком, сохранив пропорции экрана. */
  fitBox(x, y, w, h) {
    const r = this.svg.getBoundingClientRect(), ar = r.width / Math.max(1, r.height) || 1;
    this.focus(x + w / 2, y + h / 2, Math.max(w, h * ar) * 1.15);
  }
  focus(cx, cy, w) { const r = this.svg.getBoundingClientRect(), ar = r.width / Math.max(1, r.height) || 1, h = w / ar; this.view = { x: cx - w / 2, y: cy - h / 2, w, h }; this.render(); }
  fitAll() { if (!this.map) return; const b = mapBox(this.map); this.fitBox(b.x, b.y, b.w, b.h); }
  zoomAt(p, f) {
    const v = this.view, nw = Math.max(12, Math.min(2600, v.w * f)), r = nw / v.w;
    v.x = p.x - (p.x - v.x) * r; v.y = p.y - (p.y - v.y) * r; v.w = nw; v.h *= r; this.render();
  }

  bindGestures() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      svg.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        if (this.gesture?.tool) this.h.cancel?.();
        const [a, b] = [...this.pointers.values()];
        this.gesture = { pinch: true, d0: Math.hypot(a.x - b.x, a.y - b.y), v0: { ...this.view }, c0: this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
        return;
      }
      const w = this.toWorld(e.clientX, e.clientY), hit = hitOf(e.target);
      const tool = this.h.down?.(w, hit, e) === true;
      this.gesture = { tool, x0: e.clientX, y0: e.clientY, v0: { ...this.view }, s: this.px, moved: false, hit, t0: performance.now() };
    });
    svg.addEventListener('pointermove', (e) => {
      const w = this.toWorld(e.clientX, e.clientY);
      this.h.hover?.(w);
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this.gesture; if (!g) return;
      if (g.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), f = g.d0 / Math.max(1, d);
        const nw = Math.max(12, Math.min(2600, g.v0.w * f)), r = nw / g.v0.w;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rect = svg.getBoundingClientRect();
        const s = nw / rect.width;
        this.view = { x: g.c0.x - (mid.x - rect.left) * s, y: g.c0.y - (mid.y - rect.top) * s, w: nw, h: g.v0.h * r };
        this.render(); return;
      }
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 5) g.moved = true;
      if (g.tool) { this.h.move?.(w, e); return; }
      if (g.moved) { this.view.x = g.v0.x - (e.clientX - g.x0) * g.s; this.view.y = g.v0.y - (e.clientY - g.y0) * g.s; this.render(); }
    });
    const up = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const g = this.gesture; if (!g) return;
      if (g.pinch) { if (this.pointers.size === 0) this.gesture = null; return; }
      const w = this.toWorld(e.clientX, e.clientY);
      if (g.tool) this.h.up?.(w, e);
      else if (!g.moved) this.h.tap?.(w, g.hit, e);
      this.gesture = null;
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(this.toWorld(e.clientX, e.clientY), e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  }

  stadiumSvg() {
    const m = this.map, key = JSON.stringify(m.style.stands) + JSON.stringify(m.sectors) + ST.cx + ST.cy;
    if (this.stadCache.key === key) return this.stadCache;
    const fx = ST.cx - 34, fy = ST.cy - 52.5, L = (d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width=".35"/>`;
    let s = `<g data-kind="stadium"><polygon points="${pts(ring(86))}" fill="var(--podium)"/><polygon points="${pts(ring(74))}" fill="var(--bowl)" stroke="var(--line-strong)" stroke-width=".6"/>
      <polygon points="${pts(ring(36.5))}" fill="none" stroke="var(--line-strong)" stroke-width=".4" stroke-dasharray="2 1.5"/><polygon points="${pts(ring(6.5))}" fill="#3e8a47"/>
      <rect x="${fx}" y="${fy}" width="68" height="105" fill="#45a152"/>${L(`M${fx} ${fy}h68v105h-68z`)}${L(`M${fx} ${ST.cy}h68`)}
      <circle cx="${ST.cx}" cy="${ST.cy}" r="9.15" fill="none" stroke="#fff" stroke-width=".35"/>${L(`M${ST.cx - 20.15} ${fy}v16.5h40.3v-16.5`)}${L(`M${ST.cx - 20.15} ${fy + 105}v-16.5h40.3v16.5`)}</g>`;
    for (const sec of SECTORS) s += `<polygon data-kind="sector" data-id="${sec.id}" points="${pts(secPts(sec))}" fill="${sectorColor(m, sec)}" fill-opacity="${sec.tier === 'lower' ? 0.62 : 0.9}" stroke="var(--surface)" stroke-width=".35"/>`;
    this.stadCache = { key, shapes: s };
    return this.stadCache;
  }

  render() {
    const m = this.map, svg = this.svg; if (!m || !svg.clientWidth) return;
    const v = this.view, px = this.px, o = this.opts, admin = o.admin;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const fs = (n) => (n * px).toFixed(3);
    let h = '';
    if (o.grid) {
      const step = [1, 2, 5, 10, 20, 50].find((st) => st / px >= 14) || 100;
      h += `<defs><pattern id="g1" width="${step}" height="${step}" patternUnits="userSpaceOnUse"><path d="M${step} 0H0V${step}" fill="none" stroke="var(--grid)" stroke-width="${fs(1)}"/></pattern></defs><rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" fill="url(#g1)"/>`;
    }
    // крупные фигуры снизу, вложенные сверху: зону внутри здания видно и можно выбрать отдельно
    const shapes = [...m.shapes].sort((a, b) => (a.cat === 'plaza' ? -1 : 0) - (b.cat === 'plaza' ? -1 : 0) || shapeArea(b) - shapeArea(a));
    const geom = (s, attrs) => s.type === 'rect' ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${attrs}/>` : s.type === 'ellipse' ? `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${attrs}/>` : `<polygon points="${pts(s.pts)}" ${attrs}/>`;
    for (const s of shapes.filter((x) => x.cat === 'plaza')) h += geom(s, `data-kind="shape" data-id="${s.id}" fill="var(--plaza)" stroke="var(--line-strong)" stroke-width="${fs(1)}"`);
    if (admin && o.underlay && o.underlayOpacity > 0) h += `<image href="${o.underlay.src}" x="${o.underlay.x}" y="${o.underlay.y}" width="${o.underlay.w}" height="${o.underlay.h}" opacity="${o.underlayOpacity}" preserveAspectRatio="none" style="pointer-events:none"/>`;
    for (const s of shapes) {
      if (s.cat === 'plaza') continue;
      const k = kindOf(s), col = s.color || catColor(m, s.cat), soft = s.cat === 'leisure' || s.cat === 'expo';
      const fill = k.walls ? (s.color ? col : 'var(--room)') : col, op = k.walls ? (s.color ? 0.28 : 0.95) : soft ? 0.18 : 0.3;
      const dash = s.cat === 'parking' ? `stroke-dasharray="${fs(6)} ${fs(4)}"` : '';
      h += geom(s, `data-kind="shape" data-id="${s.id}" fill="${fill}" fill-opacity="${op}" stroke="${k.walls ? 'none' : col}" stroke-width="${fs(1.4)}" ${dash}`);
    }
    for (const st of m.stairs) {
      const n = Math.max(3, Math.round((st.dir === 'x' ? st.w : st.h) / 0.6));
      let lines = '';
      for (let i = 1; i < n; i++) lines += st.dir === 'x' ? `M${st.x + (st.w * i) / n} ${st.y}v${st.h}` : `M${st.x} ${st.y + (st.h * i) / n}h${st.w}`;
      h += `<g data-kind="stairs" data-id="${st.id}"><rect x="${st.x}" y="${st.y}" width="${st.w}" height="${st.h}" fill="var(--room)" stroke="var(--line-strong)" stroke-width="${fs(1)}"/><path d="${lines}" stroke="var(--line-strong)" stroke-width="${fs(0.8)}"/></g>`;
    }
    for (const seg of wallSegments(m)) h += `<line data-kind="wall" data-id="${seg.owner}" x1="${seg.a[0]}" y1="${seg.a[1]}" x2="${seg.b[0]}" y2="${seg.b[1]}" stroke="${seg.color || 'var(--wall-line)'}" stroke-width="${Math.max(seg.t, 2.2 * px)}" stroke-linecap="square"/>`;
    for (const d of m.doors) h += `<g data-kind="door" data-id="${d.id}"><circle cx="${d.x}" cy="${d.y}" r="${Math.max(d.w / 2, 5 * px)}" fill="var(--accent)" fill-opacity=".14"/><circle cx="${d.x}" cy="${d.y}" r="${fs(3)}" fill="var(--accent)"/></g>`;
    if (m.stadium) {
      h += this.stadiumSvg().shapes;
      if (px < 0.4) for (const sec of SECTORS) { const [x, y] = secMid(sec).xy; h += `<text x="${x}" y="${y}" font-size="${Math.min(2.6, 10 * px)}" class="t-sec">${sec.id}</text>`; }
      for (const k of ['A', 'B', 'C', 'D']) { const [a, b] = RANGES[k], [x, y] = sp((a + b) / 2, 92); h += `<text x="${x}" y="${y}" font-size="${fs(11)}" class="t-stand" fill="${standColor(m, k)}">${STANDS[k].short} · ${k}</text>`; }
    }
    // подписи объектов — только если помещаются
    for (const s of shapes) {
      if (s.cat === 'plaza' || !s.name) continue;
      const b = shapeBox(s), size = 11, wpx = b.w / px, need = s.name.length * size * 0.56;
      if (wpx < need + 6 || b.h / px < size + 4) continue;
      h += `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" font-size="${fs(size)}" class="t-shape${kindOf(s).walls ? ' b' : ''}">${esc(s.name)}</text>`;
    }
    if (o.route) h += `<polyline points="${pts(o.route.pts)}" fill="none" stroke="#fff" stroke-width="${fs(8)}" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${pts(o.route.pts)}" fill="none" stroke="var(--accent)" stroke-width="${fs(4.5)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (o.showPanos) {
      for (const [i, j] of m.links) { const a = m.panos.find((p) => p.id === i), b = m.panos.find((p) => p.id === j); if (a && b) h += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--pano)" stroke-width="${fs(2.5)}" stroke-dasharray="${fs(6)} ${fs(5)}" opacity=".85" style="pointer-events:none"/>`; }
      for (const p of m.panos) {
        const on = o.sel === p.id || o.linkFrom?.() === p.id;
        h += `<g data-kind="pano" data-id="${p.id}"><circle cx="${p.x}" cy="${p.y}" r="${fs(16)}" fill="transparent"/>${on ? `<circle cx="${p.x}" cy="${p.y}" r="${fs(13)}" fill="var(--pano)" fill-opacity=".22"/>` : ''}<circle cx="${p.x}" cy="${p.y}" r="${fs(6.5)}" fill="var(--pano)" stroke="#fff" stroke-width="${fs(2)}"/>${p.img ? `<circle cx="${p.x}" cy="${p.y}" r="${fs(2.2)}" fill="#fff"/>` : ''}</g>`;
        if (on || px < 0.35) h += `<text x="${p.x}" y="${p.y - 14 * px}" font-size="${fs(11)}" class="t-pano">${esc(p.name)}</text>`;
      }
    }
    for (const p of m.pois) {
      if (o.filter && p.cat !== o.filter) continue;
      const on = o.sel === p.id, c = poiColor(m, p), g = (PCATS[p.cat] || PCATS.info).g, r = (on ? 13 : 11) * px;
      h += `<g data-kind="poi" data-id="${p.id}" class="pin"><circle cx="${p.x}" cy="${p.y}" r="${r * 1.5}" fill="transparent"/><circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${c}" stroke="#fff" stroke-width="${fs(2)}"/>
        <text x="${p.x}" y="${p.y}" font-size="${fs(g.length > 1 ? 8 : 11)}" class="t-glyph">${esc(g)}</text></g>`;
      if (on || px < 0.3) h += `<text x="${p.x + r + 4 * px}" y="${p.y}" font-size="${fs(12)}" class="t-poi">${esc(p.name)}</text>`;
    }
    if (o.sel?.startsWith('sec:')) { const sec = SECTORS.find((x) => x.id === o.sel.slice(4)); if (sec) h += `<polygon points="${pts(secPts(sec))}" fill="none" stroke="var(--ink)" stroke-width="${fs(2.5)}" style="pointer-events:none"/>`; }
    h += typeof o.overlay === 'function' ? o.overlay(px) : o.overlay || '';
    svg.innerHTML = h;
  }
}

function hitOf(target) {
  const el = target.closest?.('[data-kind]');
  return el ? { kind: el.dataset.kind, id: el.dataset.id, i: el.dataset.i !== undefined ? +el.dataset.i : undefined } : null;
}

export { CATS };
