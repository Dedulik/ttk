// Модель карты: справочники, геометрия фигур, стены с дверными проёмами, маршруты и поиск.
import { SECTORS, STANDS, secMid } from './stadium.js';

export const KINDS = {
  building: { n: 'Здание', hint: 'стены, крыша', walls: true, roof: true, height: 8 },
  room: { n: 'Помещение', hint: 'стены без крыши', walls: true, roof: false, height: 3.2 },
  zone: { n: 'Зона', hint: 'разметка на земле', walls: false, roof: false, height: 0 },
};

export const CATS = {
  building: { n: 'Здание', c: '#8d939a' },
  hall: { n: 'Зал', c: '#6f8fc9' },
  expo: { n: 'Выставка', c: '#6f8fc9' },
  parking: { n: 'Парковка', c: '#d9534f' },
  events: { n: 'Мероприятия', c: '#ef8a3c' },
  stage: { n: 'Сцена', c: '#c8323a' },
  sport: { n: 'Спортплощадка', c: '#2e9e4f' },
  leisure: { n: 'Отдых и развлечения', c: '#77b96f' },
  ice: { n: 'Каток', c: '#3d7be0' },
  entrance: { n: 'Вход / КПП', c: '#cf2f63' },
  service: { n: 'Кассы и сервис', c: '#8a5bd1' },
  food: { n: 'Питание', c: '#d9a400' },
  wc: { n: 'Туалеты', c: '#7d6bb8' },
  office: { n: 'Служебное', c: '#7a8088' },
  plaza: { n: 'Территория', c: '#b9b2a6' },
};

export const PCATS = {
  info: { n: 'Информация', g: 'i', c: '#2f6fe0' },
  food: { n: 'Еда и напитки', g: 'Е', c: '#c99700' },
  wc: { n: 'Туалет', g: 'WC', c: '#7d6bb8' },
  med: { n: 'Медпункт', g: '+', c: '#d6336c' },
  shop: { n: 'Магазин', g: 'М', c: '#ef8a3c' },
  gate: { n: 'Вход', g: '→', c: '#c8323a' },
  ticket: { n: 'Кассы', g: '₽', c: '#8a5bd1' },
  transport: { n: 'Транспорт', g: 'Т', c: '#2e9e4f' },
  meet: { n: 'Место встречи', g: '★', c: '#3b3f46' },
};

export const PALETTE = ['#e3242b', '#c8323a', '#cf2f63', '#b937b9', '#8a5bd1', '#2c5cc5', '#2f6fe0', '#3d7be0', '#4fb8dc', '#2e9e4f', '#77b96f', '#d9a400', '#ef8a3c', '#8d939a', '#3b3f46'];

export const uid = (p) => p + Math.random().toString(36).slice(2, 8);
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const round = (v, step = 0.5) => Math.round(v / step) * step;

export function normalize(m) {
  const map = clone(m || {});
  for (const k of ['shapes', 'walls', 'doors', 'stairs', 'pois', 'panos', 'links']) if (!Array.isArray(map[k])) map[k] = [];
  map.sectors = map.sectors || {};
  map.style = Object.assign({ cats: {}, stands: {}, poi: {}, realSeats: true }, map.style || {});
  map.stadium = map.stadium || { cx: 333.5, cy: 248.5 };
  map.version = 2;
  return map;
}

// ---------- фигуры ----------
export function shapePoints(s, seg = 48) {
  if (s.type === 'rect') return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
  if (s.type === 'ellipse') return Array.from({ length: seg }, (_, i) => { const t = (2 * Math.PI * i) / seg; return [s.cx + s.rx * Math.cos(t), s.cy + s.ry * Math.sin(t)]; });
  return s.pts;
}
export function shapeBox(s) {
  if (s.type === 'rect') return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.type === 'ellipse') return { x: s.cx - s.rx, y: s.cy - s.ry, w: 2 * s.rx, h: 2 * s.ry };
  const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]), x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
export const shapeCenter = (s) => { const b = shapeBox(s); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
export function shapeArea(s) {
  if (s.type === 'ellipse') return Math.PI * s.rx * s.ry;
  const p = shapePoints(s);
  let a = 0;
  p.forEach((q, i) => { const r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; });
  return Math.abs(a / 2);
}
export function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function moveShape(s, dx, dy) {
  if (s.type === 'rect') { s.x += dx; s.y += dy; }
  else if (s.type === 'ellipse') { s.cx += dx; s.cy += dy; }
  else s.pts = s.pts.map(([x, y]) => [x + dx, y + dy]);
}
export const kindOf = (s) => KINDS[s.kind] || KINDS.zone;

// ---------- цвета ----------
export const catColor = (map, k) => map.style.cats[k] || (CATS[k] || CATS.building).c;
export const shapeColor = (map, s) => s.color || catColor(map, s.cat);
export const poiColor = (map, p) => p.color || map.style.poi[p.cat] || (PCATS[p.cat] || PCATS.info).c;
export const standColor = (map, k) => map.style.stands[k] || STANDS[k].c;
export const sectorColor = (map, s) => map.sectors[s.id]?.color || standColor(map, s.stand);

// ---------- стены и проёмы ----------
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}
function cutSegment(a, b, doors) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const cuts = [];
  for (const d of doors) {
    const r = distToSeg(d.x, d.y, a[0], a[1], b[0], b[1]);
    if (r.d < 0.9 && L > 0) cuts.push([r.t * L - d.w / 2, r.t * L + d.w / 2]);
  }
  cuts.sort((p, q) => p[0] - q[0]);
  const out = [];
  let s = 0;
  for (const [c0, c1] of cuts) { if (c0 > s + 0.05) out.push([s, Math.min(c0, L)]); s = Math.max(s, c1); }
  if (L > s + 0.05) out.push([s, L]);
  const lerp = (u) => [a[0] + ((b[0] - a[0]) * u) / L, a[1] + ((b[1] - a[1]) * u) / L];
  return out.map(([u0, u1]) => [lerp(u0), lerp(u1)]);
}
/** Все отрезки стен карты (контуры зданий/помещений и свободные стены) с вырезанными дверями. */
export function wallSegments(map) {
  const segs = [];
  for (const s of map.shapes) {
    const k = kindOf(s);
    if (!k.walls) continue;
    const pts = shapePoints(s, 40), h = s.height || k.height, t = s.kind === 'building' ? 0.4 : 0.2;
    pts.forEach((p, i) => { for (const [a, b] of cutSegment(p, pts[(i + 1) % pts.length], map.doors)) segs.push({ a, b, h, t, owner: s.id, color: s.color }); });
  }
  for (const w of map.walls) {
    for (let i = 0; i < w.pts.length - 1; i++) for (const [a, b] of cutSegment(w.pts[i], w.pts[i + 1], map.doors)) segs.push({ a, b, h: w.height || 3, t: w.thick || 0.2, owner: w.id, color: w.color });
  }
  return segs;
}

// ---------- маршруты по графу панорам ----------
export function nearestPano(map, pt, filter = () => true) {
  let best = null, bd = Infinity;
  for (const p of map.panos) { const d = dist(p, pt); if (d < bd && filter(p)) { bd = d; best = p; } }
  return best;
}
export function neighbors(map, id) {
  return map.links.filter((l) => l.includes(id)).map((l) => map.panos.find((p) => p.id === (l[0] === id ? l[1] : l[0]))).filter(Boolean);
}
export function route(map, from, to) {
  const a = nearestPano(map, from), b = nearestPano(map, to);
  if (!a || !b) return null;
  const D = new Map(map.panos.map((p) => [p.id, Infinity])), prev = new Map(), left = new Set(map.panos.map((p) => p.id));
  D.set(a.id, 0);
  while (left.size) {
    let u = null;
    for (const id of left) if (u === null || D.get(id) < D.get(u)) u = id;
    if (D.get(u) === Infinity) break;
    left.delete(u);
    if (u === b.id) break;
    const pu = map.panos.find((p) => p.id === u);
    for (const q of neighbors(map, u)) { const nd = D.get(u) + dist(pu, q); if (nd < D.get(q.id)) { D.set(q.id, nd); prev.set(q.id, u); } }
  }
  if (D.get(b.id) === Infinity) return null;
  const chain = [b.id];
  while (chain[0] !== a.id) chain.unshift(prev.get(chain[0]));
  const nodes = chain.map((id) => map.panos.find((p) => p.id === id));
  const pts = [[from.x, from.y, from.z || 0], ...nodes.map((p) => [p.x, p.y, p.z || 0]), [to.x, to.y, to.z || 0]];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { pts, len, nodes, minutes: Math.max(1, Math.round(len / 1.2 / 60)) };
}

// ---------- места ----------
/** Единый список того, что можно найти и выбрать: сектора, метки, объекты. */
export function placeOf(map, ref) {
  if (!ref) return null;
  if (ref.startsWith('sec:')) {
    const s = SECTORS.find((x) => x.id === ref.slice(4));
    if (!s) return null;
    const m = secMid(s);
    return { ref, type: 'sector', id: s.id, name: `Сектор ${s.id}`, sub: `${STANDS[s.stand].n} · ${s.tier === 'lower' ? 'нижний' : 'верхний'} ярус`, x: m.xy[0], y: m.xy[1], obj: s, color: sectorColor(map, s), text: map.sectors[s.id]?.text || '' };
  }
  const p = map.pois.find((x) => x.id === ref);
  if (p) return { ref, type: 'poi', id: p.id, name: p.name, sub: (PCATS[p.cat] || PCATS.info).n, x: p.x, y: p.y, z: p.z || 0, obj: p, color: poiColor(map, p), text: p.text, photo: p.photo };
  const s = map.shapes.find((x) => x.id === ref);
  if (s) { const c = shapeCenter(s); return { ref, type: 'shape', id: s.id, name: s.name, sub: (CATS[s.cat] || CATS.building).n, x: c.x, y: c.y, obj: s, color: shapeColor(map, s), text: s.desc, photo: s.photo }; }
  const pn = map.panos.find((x) => x.id === ref);
  if (pn) return { ref, type: 'pano', id: pn.id, name: pn.name, sub: 'Точка обзора 360°', x: pn.x, y: pn.y, z: pn.z || 0, obj: pn, color: '#2f6fe0', text: '' };
  if (ref === 'stadium') return { ref, type: 'stadium', id: 'stadium', name: 'Стадион «Ростов Арена»', sub: 'Поле 105 × 68 м · 4 трибуны · 2 яруса', x: map.stadium.cx, y: map.stadium.cy };
  return null;
}

export function search(map, q, limit = 12) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const secQ = q.replace(/^сектор\s*/, '').toUpperCase();
  for (const s of SECTORS) if (s.id.startsWith(secQ) || s.id.replace(/^./, (c) => ({ A: 'А', B: 'В', C: 'С', D: 'Д' })[c] || c).startsWith(secQ)) out.push('sec:' + s.id);
  for (const p of map.pois) if ((p.name + ' ' + (PCATS[p.cat]?.n || '')).toLowerCase().includes(q)) out.push(p.id);
  for (const s of map.shapes) if (s.cat !== 'plaza' && (s.name + ' ' + (CATS[s.cat]?.n || '')).toLowerCase().includes(q)) out.push(s.id);
  return out.slice(0, limit).map((r) => placeOf(map, r));
}
