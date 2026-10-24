// Инструменты редактора на 2D-плане.
//   Построение: выбор, прямоугольник, многоугольник, эллипс, стена, дверь, лестница, ластик.
//   Точки:      выбор, метка, панорама, связь, ластик.
// Каждый инструмент получает касания от Plan2D (down/move/up/tap/hover) и рисует свой слой поверх плана.
import { KINDS, clone, floorById, floorOf, floorStep, floorsSorted, kindOf, moveShape, shapeBox, shapePoints, slugify, uid, uniqueSlug } from '../core/model.js';
import { confirmBox, esc } from '../core/ui.js';

export const TOOLS = {
  build: [
    { id: 'select', n: 'Выбор', ic: 'select', key: 'v' },
    { id: 'rect', n: 'Прямоуг.', ic: 'rect', key: 'r' },
    { id: 'poly', n: 'Контур', ic: 'poly', key: 'g' },
    { id: 'ellipse', n: 'Овал', ic: 'ellipse', key: 'o' },
    { id: 'wall', n: 'Стена', ic: 'wall', key: 'w' },
    { id: 'door', n: 'Дверь', ic: 'door', key: 'd' },
    { id: 'stairs', n: 'Лестница', ic: 'stairs', key: 's' },
    { id: 'erase', n: 'Ластик', ic: 'erase', key: 'e' },
  ],
  points: [
    { id: 'select', n: 'Выбор', ic: 'select', key: 'v' },
    { id: 'poi', n: 'Метка', ic: 'pin', img: 'marker', key: 'm' },
    { id: 'pano', n: 'Панорама', ic: 'pano', img: 'pano', key: 'p', pano: true },
    { id: 'link', n: 'Связь', ic: 'link', key: 'l', pano: true },
    { id: 'erase', n: 'Ластик', ic: 'erase', key: 'e' },
  ],
  stadium: [{ id: 'select', n: 'Выбор', ic: 'select', key: 'v' }],
};

export const HINTS = {
  select: 'Нажмите на объект, чтобы изменить его. Тяните — переместить, белые квадраты — размер и вершины.',
  rect: 'Проведите по плану, чтобы нарисовать прямоугольник. Нажатие на пустое место — фигура 8 × 6 м, на фигуру — выбрать её.',
  poly: 'Ставьте вершины нажатиями. Нажмите на первую точку или «Готово», чтобы замкнуть контур.',
  ellipse: 'Проведите по плану — получится овал или круг.',
  wall: 'Ставьте точки стены нажатиями. «Готово» — закончить стену.',
  door: 'Нажмите на стену — в ней появится проём. Ширину выберите сверху.',
  stairs: 'Проведите по плану — нарисуется лестница. Направление подъёма выберите сверху.',
  erase: 'Нажмите на объект, чтобы удалить его. Отменить — кнопкой ↶.',
  poi: 'Нажмите на карту, чтобы поставить метку: вход, кафе, туалет, медпункт…',
  pano: 'Нажмите, чтобы поставить точку обзора 360°. Она сама свяжется с выбранной или ближайшей.',
  link: 'Нажмите на две точки панорам — между ними появится или исчезнет переход.',
};

const DEF_CAT = { building: 'building', room: 'hall', zone: 'leisure' };

export function createTools(ed) {
  const T = { draft: null, drag: null, poly: null, wall: null, hover: null, linkFrom: null };
  const st = () => ed.state;
  const sn = (v) => { const s = st().snap; return s ? Math.round(v / s) * s : Math.round(v * 10) / 10; };
  const P = (w) => [sn(w.x), sn(w.y)];
  const map = () => ed.map;
  const same = (a, b) => a && b && a.type === b.type && a.id === b.id;
  // всё новое рисуется на текущем этаже; на первом этаже поле floor не пишем — так карта совместима со старыми
  const fl = () => (st().floor && st().floor !== floorsSorted(map())[0].id ? { floor: st().floor } : {});
  const here = (o) => floorOf(o) === (st().floor || floorsSorted(map())[0].id);

  function selOf(hit) {
    if (!hit) return null;
    const m = map();
    if (hit.kind === 'wall') return m.shapes.some((s) => s.id === hit.id) ? { type: 'shape', id: hit.id } : { type: 'wall', id: hit.id };
    if (hit.kind === 'sector') return { type: 'sector', id: hit.id };
    if (['shape', 'door', 'stairs', 'poi', 'pano', 'stadium'].includes(hit.kind)) return { type: hit.kind, id: hit.id || 'stadium' };
    return null;
  }
  // граница участка: объекты не выходят за неё (у стадиона границы нет — там ограничений нет)
  function area() { const p = map().shapes.find((s) => s.cat === 'plaza'); return p ? shapeBox(p) : null; }
  const inArea = (x, y) => { const a = area(); return !a || (x >= a.x - 0.01 && y >= a.y - 0.01 && x <= a.x + a.w + 0.01 && y <= a.y + a.h + 0.01); };
  /** Сдвиг (dx, dy), урезанный так, чтобы рамка объекта осталась внутри участка. */
  function clampShift(box, dx, dy) {
    const a = area(); if (!a) return [dx, dy];
    const fit = (d, lo, size, alo, asize) => (size > asize ? alo - lo : Math.min(Math.max(d, alo - lo), alo + asize - (lo + size)));
    return [fit(dx, box.x, box.w, a.x, a.w), fit(dy, box.y, box.h, a.y, a.h)];
  }
  function boxOf(type, o) {
    if (type === 'shape') return shapeBox(o);
    if (type === 'wall') { const xs = o.pts.map((p) => p[0]), ys = o.pts.map((p) => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
    if (type === 'stairs') return { x: o.x, y: o.y, w: o.w, h: o.h };
    return { x: o.x, y: o.y, w: 0, h: 0 };
  }
  /** Рамка (x, y, w, h), подрезанная по участку. */
  function clipBox(x, y, w, h) {
    const a = area(); if (!a) return { x, y, w, h };
    const x0 = Math.max(x, a.x), y0 = Math.max(y, a.y), x1 = Math.min(x + w, a.x + a.w), y1 = Math.min(y + h, a.y + a.h);
    return { x: x0, y: y0, w: Math.max(0.5, x1 - x0), h: Math.max(0.5, y1 - y0) };
  }
  const outside = () => ed.toast('Здесь граница участка — ставьте объекты внутри неё');
  // выбор уже существующего объекта под курсором — вместо создания поверх него нового
  const pickable = (sel) => sel && !['sector', 'stadium'].includes(sel.type) && !(sel.type === 'shape' && ed.find(sel)?.cat === 'plaza');

  function nextName(base, list) { let n = list.length + 1; while (list.some((x) => x.name === `${base} ${n}`)) n++; return `${base} ${n}`; }

  function createShape(type, geom) {
    const kind = st().newKind, m = map();
    const s = { id: uid('s'), type, kind, cat: DEF_CAT[kind], name: nextName(KINDS[kind].n, m.shapes.filter((x) => x.kind === kind)), desc: '', ...geom, ...fl() };
    if (KINDS[kind].walls) s.height = KINDS[kind].height;
    ed.change(() => m.shapes.push(s), 'Фигура добавлена');
    ed.select({ type: 'shape', id: s.id });
  }
  function finishPoly() {
    if (T.poly && T.poly.length >= 3) createShape('poly', { pts: T.poly });
    else if (T.poly) ed.toast('В контуре нужно хотя бы 3 точки');
    T.poly = null; ed.redraw(); ed.refreshOpt();
  }
  function finishWall() {
    if (T.wall && T.wall.length >= 2) {
      const w = { id: uid('w'), pts: T.wall, thick: st().wallThick, height: 3, ...fl() };
      ed.change(() => map().walls.push(w), 'Стена добавлена'); ed.select({ type: 'wall', id: w.id });
    }
    T.wall = null; ed.redraw(); ed.refreshOpt();
  }
  function placeDoor(w) {
    let best = null;
    const test = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / L2));
      const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(w.x - x, w.y - y);
      if (!best || d < best.d) best = { d, x, y };
    };
    for (const s of map().shapes) if (kindOf(s).walls && here(s)) { const p = shapePoints(s, 40); p.forEach((q, i) => test(q, p[(i + 1) % p.length])); }
    for (const wl of map().walls) if (here(wl)) for (let i = 0; i < wl.pts.length - 1; i++) test(wl.pts[i], wl.pts[i + 1]);
    if (!best || best.d > Math.max(3, 24 * ed.plan.px)) return ed.toast('Нажмите ближе к стене здания, помещения или к отдельной стене этого этажа');
    const d = { id: uid('d'), x: Math.round(best.x * 10) / 10, y: Math.round(best.y * 10) / 10, w: st().doorWidth, ...fl() };
    ed.change(() => map().doors.push(d), 'Проём добавлен'); ed.select({ type: 'door', id: d.id });
  }
  function addPano(w) {
    const m = map(), name = nextName('Точка', m.panos), id = uid('p'), p = { id, name, slug: uniqueSlug(m, slugify(name), id), x: sn(w.x), y: sn(w.y), created: Date.now(), ...fl() };
    const cur = st().sel?.type === 'pano' ? m.panos.find((x) => x.id === st().sel.id) : null;
    const base = cur || [...m.panos.filter(here)].sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    ed.change(() => { m.panos.push(p); if (base && Math.hypot(base.x - p.x, base.y - p.y) < 150) m.links.push([base.id, p.id]); });
    ed.toast(base && Math.hypot(base.x - p.x, base.y - p.y) < 150 ? `Связана с «${base.name}»` : 'Точка обзора добавлена');
    ed.select({ type: 'pano', id: p.id });
  }
  async function erase(sel) {
    if (!sel) return;
    const m = map(), list = { shape: 'shapes', wall: 'walls', door: 'doors', stairs: 'stairs', poi: 'pois', pano: 'panos' }[sel.type];
    if (!list) return ed.toast('Стадион — часть шаблона: сектора можно перекрасить и подписать, но не удалить');
    const obj = m[list].find((x) => x.id === sel.id);
    if (obj?.cat === 'plaza') return ed.toast('Границу участка можно только редактировать');
    if (!(await ed.confirmDelete(sel, obj))) return;
    ed.change(() => { m[list] = m[list].filter((x) => x.id !== sel.id); if (sel.type === 'pano') m.links = m.links.filter((l) => !l.includes(sel.id)); }, `«${obj?.name || 'Объект'}» удалён`);
    if (same(sel, st().sel)) ed.select(null);
  }

  return {
    get linkFrom() { return T.linkFrom; },
    busy: () => !!(T.poly || T.wall),
    finish() { if (T.poly) finishPoly(); if (T.wall) finishWall(); },
    undoPoint() { const a = T.poly || T.wall; if (a) { a.pop(); if (!a.length) { T.poly = T.wall = null; ed.refreshOpt(); } ed.redraw(); } },
    escape() { T.poly = T.wall = T.draft = T.drag = null; T.linkFrom = null; ed.redraw(); ed.refreshOpt(); },
    reset() { this.escape(); },

    down(w, hit) {
      if (st().readonly) return false;
      const tool = st().tool;
      if (tool === 'select') {
        if (hit && (hit.kind === 'vtx' || hit.kind === 'rs')) { T.drag = { type: hit.kind, i: hit.i, sel: st().sel, orig: clone(ed.find(st().sel)), started: false }; return true; }
        const sel = selOf(hit);
        if (!sel || sel.type === 'sector' || sel.type === 'stadium') return false;
        const obj = ed.find(sel);
        if (sel.type === 'shape' && obj.cat === 'plaza' && !same(sel, st().sel)) return false;
        if (!same(sel, st().sel)) ed.select(sel);
        T.drag = { type: 'move', sel, start: w, orig: clone(obj), started: false };
        return true;
      }
      if (tool === 'rect' || tool === 'ellipse' || tool === 'stairs') { const [x, y] = P(w); T.draft = { tool, x0: x, y0: y, x1: x, y1: y, moved: false, hit: selOf(hit) }; return true; }
      return false;
    },
    move(w) {
      if (T.draft) { [T.draft.x1, T.draft.y1] = P(w); T.draft.moved = true; ed.redraw(); return; }
      const d = T.drag; if (!d) return;
      if (!d.started) { ed.snapshot(); d.started = true; }
      const obj = ed.find(d.sel); if (!obj) return;
      if (d.type === 'move') {
        const [dx, dy] = clampShift(boxOf(d.sel.type, d.orig), sn(w.x - d.start.x), sn(w.y - d.start.y));
        Object.assign(obj, clone(d.orig));
        if (d.sel.type === 'shape') moveShape(obj, dx, dy);
        else if (d.sel.type === 'wall') obj.pts = obj.pts.map(([x, y]) => [x + dx, y + dy]);
        else { obj.x += dx; obj.y += dy; }
      } else if (d.type === 'vtx') { const p = P(w); if (inArea(p[0], p[1]) || ed.find(d.sel)?.cat === 'plaza') obj.pts[d.i] = p; }
      else if (d.type === 'rs') {
        if (obj.type === 'ellipse') {
          const a = area();
          obj.rx = Math.max(0.5, Math.abs(sn(w.x) - obj.cx)); obj.ry = Math.max(0.5, Math.abs(sn(w.y) - obj.cy));
          if (a) { obj.rx = Math.min(obj.rx, obj.cx - a.x, a.x + a.w - obj.cx); obj.ry = Math.min(obj.ry, obj.cy - a.y, a.y + a.h - obj.cy); obj.rx = Math.max(0.5, obj.rx); obj.ry = Math.max(0.5, obj.ry); }
        }
        else {
          const o = d.orig, corners = [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]], fixed = corners[(d.i + 2) % 4];
          let [x, y] = P(w);
          const a = obj.cat === 'plaza' ? null : area();
          if (a) { x = Math.min(Math.max(x, a.x), a.x + a.w); y = Math.min(Math.max(y, a.y), a.y + a.h); }
          obj.x = Math.min(fixed[0], x); obj.y = Math.min(fixed[1], y); obj.w = Math.max(0.5, Math.abs(x - fixed[0])); obj.h = Math.max(0.5, Math.abs(y - fixed[1]));
        }
      }
      ed.changedLive();
    },
    up() {
      if (T.draft) {
        const d = T.draft; T.draft = null;
        let x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        const tiny = w < 1 || h < 1;
        // нажатие по уже существующему объекту (фигура, лестница, точка…) выделяет его, а не создаёт поверх новый
        if (tiny && pickable(d.hit)) { ed.select(d.hit); ed.redraw(); return; }
        if (!inArea(d.x0, d.y0)) { outside(); ed.redraw(); return; }
        if (tiny) {
          const nw = d.tool === 'stairs' ? (st().stairDir === 'x' ? 6 : 3) : st().newW, nh = d.tool === 'stairs' ? (st().stairDir === 'x' ? 3 : 6) : st().newH;
          w = nw; h = nh; x = d.x0 - w / 2; y = d.y0 - h / 2;
          const [sx, sy] = clampShift({ x, y, w, h }, 0, 0); x += sx; y += sy;
        } else ({ x, y, w, h } = clipBox(x, y, w, h));
        if (d.tool === 'rect') createShape('rect', { x, y, w, h });
        if (d.tool === 'ellipse') createShape('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 });
        if (d.tool === 'stairs') {
          // лестница поднимается ровно на следующий этаж, если он есть
          const cf = st().floor || floorsSorted(map())[0].id, next = floorStep(map(), cf, 1);
          const s = { id: uid('st'), x, y, w, h, dir: st().stairDir, rise: next ? +(next.elev - floorById(map(), cf).elev).toFixed(2) : 3, ...fl() };
          ed.change(() => map().stairs.push(s), 'Лестница добавлена'); ed.select({ type: 'stairs', id: s.id });
        }
        ed.redraw(); return;
      }
      if (T.drag) { const started = T.drag.started; T.drag = null; if (started) ed.changed(); }
    },
    tap(w, hit) {
      const tool = st().tool, sel = selOf(hit);
      if (tool === 'select' || st().readonly) return ed.select(sel);
      // контур и стена начинаются с пустого места; нажатие по точке, лестнице или проёму выбирает их
      if ((tool === 'poly' || tool === 'wall') && !T.poly && !T.wall && sel && ['poi', 'pano', 'stairs', 'door'].includes(sel.type)) return ed.select(sel);
      if (['poly', 'wall', 'poi', 'pano'].includes(tool) && !inArea(w.x, w.y) && !(sel && pickable(sel))) return outside();
      if (tool === 'poly') {
        const p = P(w);
        if (!T.poly) { T.poly = [p]; ed.refreshOpt(); }
        else if (T.poly.length >= 3 && Math.hypot(p[0] - T.poly[0][0], p[1] - T.poly[0][1]) < 14 * ed.plan.px) return finishPoly();
        else T.poly.push(p);
        return ed.redraw();
      }
      if (tool === 'wall') {
        const p = P(w), last = T.wall?.at(-1);
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 10 * ed.plan.px) return finishWall();
        if (!T.wall) { T.wall = [p]; ed.refreshOpt(); } else T.wall.push(p);
        return ed.redraw();
      }
      if (tool === 'door') { if (sel?.type === 'door') return ed.select(sel); return placeDoor(w); }
      if (tool === 'erase') return erase(sel);
      if (tool === 'poi') {
        if (sel?.type === 'poi' || sel?.type === 'pano') return ed.select(sel);
        const m = { id: uid('m'), name: 'Новая метка', cat: st().poiCat, x: sn(w.x), y: sn(w.y), text: '', ...fl() };
        ed.change(() => map().pois.push(m), 'Метка поставлена — впишите название и текст');
        return ed.select({ type: 'poi', id: m.id });
      }
      if (tool === 'pano') { if (sel?.type === 'pano' || sel?.type === 'poi') return ed.select(sel); return addPano(w); }
      if (tool === 'link') {
        if (sel?.type !== 'pano') return ed.toast('Нажмите на синюю точку панорамы');
        if (!T.linkFrom) { T.linkFrom = sel.id; ed.redraw(); return ed.toast('Теперь нажмите на вторую точку'); }
        if (T.linkFrom === sel.id) { T.linkFrom = null; return ed.redraw(); }
        const a = T.linkFrom, b = sel.id, m = map(), exists = m.links.some((l) => l.includes(a) && l.includes(b));
        ed.change(() => { m.links = exists ? m.links.filter((l) => !(l.includes(a) && l.includes(b))) : [...m.links, [a, b]]; }, exists ? 'Переход убран' : 'Переход добавлен');
        T.linkFrom = null; return ed.redraw();
      }
    },
    hover(w) { T.hover = w; if (T.poly || T.wall) ed.redraw(); },
    cancel() { T.draft = null; if (T.drag?.started) { Object.assign(ed.find(T.drag.sel), T.drag.orig); ed.changedLive(); } T.drag = null; },

    /** Слой поверх плана: черновики фигур, выделение и ручки. */
    overlay(px) {
      const f = (n) => (n * px).toFixed(3), m = map(), sel = st().sel;
      let h = '';
      const handle = (x, y, kind, i) => `<rect data-kind="${kind}" data-i="${i}" x="${x - 7 * px}" y="${y - 7 * px}" width="${14 * px}" height="${14 * px}" rx="${3 * px}" fill="#fff" stroke="var(--pano)" stroke-width="${f(2)}" style="cursor:move"/>`;
      if (sel) {
        const o = ed.find(sel);
        if (o && sel.type === 'shape') {
          const b = shapeBox(o), pts = shapePoints(o).map((p) => p.join(',')).join(' ');
          h += `<polygon points="${pts}" fill="none" stroke="var(--pano)" stroke-width="${f(2)}" stroke-dasharray="${f(6)} ${f(4)}" style="pointer-events:none"/>`;
          if (!st().readonly) {
            if (o.type === 'poly') o.pts.forEach(([x, y], i) => (h += handle(x, y, 'vtx', i)));
            else if (o.type === 'rect') [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]].forEach(([x, y], i) => (h += handle(x, y, 'rs', i)));
            else h += handle(o.cx + o.rx, o.cy + o.ry, 'rs', 2);
          }
          h += `<text x="${b.x + b.w / 2}" y="${b.y - 9 * px}" font-size="${f(11)}" class="t-pano" style="fill:var(--pano)">${o.type === 'rect' ? `${+o.w.toFixed(1)} × ${+o.h.toFixed(1)} м` : o.type === 'ellipse' ? `${+(o.rx * 2).toFixed(1)} × ${+(o.ry * 2).toFixed(1)} м` : `${o.pts.length} вершин`}</text>`;
        }
        if (o && sel.type === 'wall') { h += `<polyline points="${o.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--pano)" stroke-width="${f(3)}" stroke-opacity=".5"/>`; if (!st().readonly) o.pts.forEach(([x, y], i) => (h += handle(x, y, 'vtx', i))); }
        if (o && sel.type === 'stairs') { h += `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="none" stroke="var(--pano)" stroke-width="${f(2)}" stroke-dasharray="${f(6)} ${f(4)}"/>`; if (!st().readonly) [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]].forEach(([x, y], i) => (h += handle(x, y, 'rs', i))); }
        if (o && sel.type === 'door') h += `<circle cx="${o.x}" cy="${o.y}" r="${Math.max(o.w / 2, 9 * px)}" fill="none" stroke="var(--pano)" stroke-width="${f(2.5)}"/>`;
      }
      const d = T.draft;
      if (d) {
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
        const shape = d.tool === 'ellipse' ? `<ellipse cx="${x + w / 2}" cy="${y + hh / 2}" rx="${w / 2}" ry="${hh / 2}"` : `<rect x="${x}" y="${y}" width="${w}" height="${hh}"`;
        h += `${shape} fill="var(--pano)" fill-opacity=".14" stroke="var(--pano)" stroke-width="${f(2)}"/><text x="${x + w / 2}" y="${y + hh / 2}" font-size="${f(12)}" class="t-pano" dominant-baseline="central" style="fill:var(--pano)">${+w.toFixed(1)} × ${+hh.toFixed(1)} м</text>`;
      }
      const chain = T.poly || T.wall;
      if (chain) {
        const pts = [...chain, ...(T.hover ? [[sn(T.hover.x), sn(T.hover.y)]] : [])];
        h += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="${T.poly ? 'var(--pano)' : 'none'}" fill-opacity=".1" stroke="var(--pano)" stroke-width="${T.wall ? Math.max(st().wallThick, 3 * px) : 2 * px}" stroke-linejoin="round"/>`;
        chain.forEach(([x, y], i) => (h += `<circle cx="${x}" cy="${y}" r="${f(i === 0 && T.poly ? 8 : 5)}" fill="${i === 0 && T.poly ? '#fff' : 'var(--pano)'}" stroke="var(--pano)" stroke-width="${f(2)}" style="pointer-events:none"/>`));
        if (T.hover && chain.length) { const l = chain.at(-1), len = Math.hypot(sn(T.hover.x) - l[0], sn(T.hover.y) - l[1]); h += `<text x="${sn(T.hover.x) + 10 * px}" y="${sn(T.hover.y) - 10 * px}" font-size="${f(11)}" class="t-pano" style="fill:var(--pano)">${len.toFixed(1)} м</text>`; }
      }
      if (T.linkFrom) { const p = m.panos.find((x) => x.id === T.linkFrom); if (p) h += `<circle cx="${p.x}" cy="${p.y}" r="${f(16)}" fill="none" stroke="var(--pano)" stroke-width="${f(3)}"/>`; }
      return h;
    },
    chainLength: () => (T.poly || T.wall)?.length || 0,
    esc,
  };
}
