// Модель карты: справочники, геометрия фигур, стены с дверными проёмами, маршруты и поиск.
import { walkPath } from './nav.js';
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
  info: { n: 'Информация', g: 'i', c: '#e30613' },
  food: { n: 'Еда и напитки', g: 'Е', c: '#c99700' },
  wc: { n: 'Туалет', g: 'WC', c: '#7d6bb8' },
  med: { n: 'Медпункт', g: '+', c: '#d6336c' },
  shop: { n: 'Магазин', g: 'М', c: '#ef8a3c' },
  gate: { n: 'Вход', g: '→', c: '#c8323a' },
  ticket: { n: 'Кассы', g: '₽', c: '#8a5bd1' },
  transport: { n: 'Транспорт', g: 'Т', c: '#2e9e4f' },
  meet: { n: 'Место встречи', g: '★', c: '#3b3f46' },
  // типы под значки ТТК
  hall: { n: 'Вход в зал', g: '→', c: '#e30613' },
  registration: { n: 'Регистрация', g: 'Р', c: '#e30613' },
  wardrobe: { n: 'Гардероб', g: 'Г', c: '#e30613' },
  coffee: { n: 'Кофе', g: 'К', c: '#e30613' },
  stage: { n: 'Сцена', g: '★', c: '#e30613' },
  partners: { n: 'Зона партнёров', g: 'П', c: '#e30613' },
  participants: { n: 'Зона участников', g: 'У', c: '#e30613' },
  // своя точка: админ прикрепляет к ней длинное фото-панораму, посетитель смотрит её изнутри цилиндра
  custom: { n: 'Своя точка', g: '◎', c: '#0e9f8e' },
  // «Пиксельная охота»: пиксель ТТК виден посетителям только в панорамах рядом с ним
  quest: { n: 'Пиксель (охота)', g: '■', c: '#e30613' },
};

/** Слои карты, которые можно скрывать — в конструкторе любого объекта и у посетителя. */
export const LAYERS = [
  { k: 'underlay', n: 'Подложка', admin: true },
  { k: 'grid', n: 'Сетка', admin: true },
  { k: 'rooms', n: 'Здания и помещения' },
  { k: 'zones', n: 'Зоны и площадки' },
  { k: 'walls', n: 'Отдельные стены' },
  { k: 'doors', n: 'Двери и проёмы', admin: true },
  { k: 'stairs', n: 'Лестницы' },
  { k: 'stadium', n: 'Чаша стадиона', stadium: true },
  { k: 'roof', n: 'Крыша стадиона', stadium: true },
  { k: 'pois', n: 'Метки' },
  { k: 'panos', n: 'Точки панорам' },
  { k: 'labels', n: 'Подписи' },
];
/** Какие слои показать в панели для этой карты. */
export const layersFor = (map, admin) => LAYERS.filter((l) => (!l.admin || admin) && (!l.stadium || map.stadium));
/** Чей это слой: фигура со стенами — «здания», без — «зоны», граница участка — всегда видна. */
export const shapeLayer = (s) => (s.cat === 'plaza' ? null : kindOf(s).walls ? 'rooms' : 'zones');

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
  // stadium: null — объект без чаши стадиона (собран в конструкторе с пустого плана)
  if (map.stadium !== null) map.stadium = map.stadium || { cx: 333.5, cy: 248.5 };
  map.floors = Array.isArray(map.floors) && map.floors.length ? map.floors : [{ id: 'f0', name: 'Первый этаж', elev: 0 }];
  map.visitorLayers = map.visitorLayers || {};
  map.version = 2;
  return map;
}

// ---------- этажи ----------
// У каждого объекта карты есть поле floor (id этажа, по умолчанию 'f0'). Этаж — { id, name, elev }:
// elev — высота пола над землёй, м. Объекты разных этажей не мешают друг другу: в 2D виден текущий этаж,
// в 3D этажи стоят друг над другом. Лестница на этаже ведёт на следующий этаж вверх.
export const floorOf = (o) => o?.floor || 'f0';
export const floorsSorted = (map) => [...map.floors].sort((a, b) => a.elev - b.elev);
export const floorById = (map, id) => map.floors.find((f) => f.id === id) || floorsSorted(map)[0];
export const elevOf = (map, o) => floorById(map, floorOf(o)).elev || 0;
/** Этаж непосредственно выше / ниже (или null). */
export function floorStep(map, id, dir) {
  const fs = floorsSorted(map), i = fs.findIndex((f) => f.id === id);
  return fs[i + dir] || null;
}
/** Режим слоя для посетителей, который выбрал админ: 'on' — показан, 'off' — скрыт, но можно включить, 'none' — недоступен. */
export const visitorLayerMode = (map, k) => map.visitorLayers?.[k] || 'on';

/** Рамка всего, что есть на карте: для «показать всё» в 2D и центра 3D-сцены. */
export function mapBox(map) {
  if (map.stadium) return { x: 20, y: 4, w: 760, h: 516 };
  const xs = [], ys = [];
  const add = (x, y) => { xs.push(x); ys.push(y); };
  for (const s of map.shapes) { const b = shapeBox(s); add(b.x, b.y); add(b.x + b.w, b.y + b.h); }
  for (const w of map.walls) for (const [x, y] of w.pts) add(x, y);
  for (const p of [...map.pois, ...map.panos, ...map.stairs, ...map.doors]) add(p.x, p.y);
  if (!xs.length) { const b = map.bounds || { w: 200, h: 150 }; return { x: 0, y: 0, w: b.w, h: b.h }; }
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(20, Math.max(...xs) - x), h: Math.max(20, Math.max(...ys) - y) };
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
/** Все отрезки стен карты (контуры зданий/помещений и свободные стены) с вырезанными дверями.
 *  floor — только этого этажа; двери режут только стены своего этажа. */
export function wallSegments(map, floor) {
  const segs = [], doorsOf = {};
  const doors = (f) => (doorsOf[f] ||= map.doors.filter((d) => floorOf(d) === f));
  for (const s of map.shapes) {
    const k = kindOf(s), f = floorOf(s);
    if (!k.walls || (floor && f !== floor)) continue;
    const pts = shapePoints(s, 40), h = s.height || k.height, t = s.kind === 'building' ? 0.4 : 0.2;
    pts.forEach((p, i) => { for (const [a, b] of cutSegment(p, pts[(i + 1) % pts.length], doors(f))) segs.push({ a, b, h, t, owner: s.id, color: s.color, floor: f }); });
  }
  for (const w of map.walls) {
    const f = floorOf(w);
    if (floor && f !== floor) continue;
    for (let i = 0; i < w.pts.length - 1; i++) for (const [a, b] of cutSegment(w.pts[i], w.pts[i + 1], doors(f))) segs.push({ a, b, h: w.height || 3, t: w.thick || 0.2, owner: w.id, color: w.color, floor: f });
  }
  return segs;
}

// ---------- маршруты по графу панорам ----------
export function nearestPano(map, pt, filter = () => true) {
  let best = null, bd = Infinity;
  for (const p of map.panos) { const d = dist(p, pt); if (d < bd && filter(p)) { bd = d; best = p; } }
  return best;
}
// Фото 360° и стрелки. Угол «по фото» u = yaw + φ (φ — поворот фото photoRot): он не меняется, когда фото
// поворачивают, поэтому вручную поставленные стрелки и начальный вид остаются на своих местах на фото.
const RAD = Math.PI / 180;
/** Стрелки переходов точки обзора: направление по плану или — если админ поставил стрелку по фото — по фото. */
export function arrowItems(p, nb) {
  return nb.map((q) => (p.img && Number.isFinite(p.arrows?.[q.id]) ? { ...q, yaw: (p.arrows[q.id] - (p.photoRot || 0)) * RAD } : q));
}
/** Начальный взгляд точки обзора, если админ его запомнил: { yaw, pitch, fov } в координатах сцены. */
export function startView(p) {
  const v = p?.view;
  return v && Number.isFinite(v.u) ? { yaw: (v.u - (p.photoRot || 0)) * RAD, pitch: (Number.isFinite(v.pitch) ? v.pitch : 0) * RAD, fov: Number.isFinite(v.fov) ? v.fov : undefined } : null;
}

export function neighbors(map, id) {
  return map.links.filter((l) => l.includes(id)).map((l) => map.panos.find((p) => p.id === (l[0] === id ? l[1] : l[0]))).filter(Boolean);
}
/**
 * Встраиваемый вид для точки обзора: панорама Google Maps или видео YouTube (обычное или 360°).
 * Принимает код <iframe> или ссылку; возвращает адрес для iframe или null.
 */
export function mapsEmbed(text) {
  const s = String(text || '');
  const maps = s.match(/https:\/\/www\.google\.[a-z.]+\/maps\/embed\?[^"'\s<>]+/)?.[0];
  if (maps) return maps.replace(/&amp;/g, '&');
  const yt = s.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s<>]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/)?.[1];
  return yt ? `https://www.youtube-nocookie.com/embed/${yt}?rel=0&playsinline=1` : null;
}
export const embedKind = (text) => (/youtube/.test(mapsEmbed(text) || '') ? 'Видео YouTube' : 'Панорама Google Maps');
/**
 * Маршрут от места до места. Если есть граф точек обзора — идём по нему (его можно пройти в панорамах),
 * а подходы к первой и от последней точки строим в обход стен. Нет графа — пешеходный путь по сетке.
 */
export function route(map, from, to) {
  const r = panoRoute(map, from, to);
  if (r) return r;
  const pts = walkPath(map, from, to);
  return pts ? finish(pts, []) : null;
}
function finish(pts, nodes) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { pts, len, nodes, minutes: Math.max(1, Math.round(len / 1.2 / 60)) };
}
const panoZ = (map, p) => elevOf(map, p) + (p.z || 0);
function leg(map, a, b) {
  const p = walkPath(map, a, b) || [[a.x, a.y, a.z || 0], [b.x, b.y, b.z || 0]];
  return p.map(([x, y, z], i) => [x, y, i === p.length - 1 ? b.z ?? z : i === 0 ? a.z ?? z : z]);
}
function panoRoute(map, from, to) {
  // точки без переходов (например, отдельная панорама на поле) в маршрут не попадают; сначала ищем на своём этаже
  const linked = (p) => map.links.some((l) => l.includes(p.id));
  const near = (pt) => nearestPano(map, pt, (p) => linked(p) && floorOf(p) === (pt.floor || 'f0')) || nearestPano(map, pt, linked);
  const a = near(from), b = near(to);
  if (!a || !b) return null;
  // если цель ближе, чем точки обзора, панорамы не нужны
  if (a.id === b.id && dist(from, to) < dist(from, a) + dist(a, to) * 0.5) return null;
  const D = new Map(map.panos.map((p) => [p.id, Infinity])), prev = new Map(), left = new Set(map.panos.map((p) => p.id));
  D.set(a.id, 0);
  while (left.size) {
    let u = null;
    for (const id of left) if (u === null || D.get(id) < D.get(u)) u = id;
    if (D.get(u) === Infinity) break;
    left.delete(u);
    if (u === b.id) break;
    const pu = map.panos.find((p) => p.id === u);
    // подъём на другой уровень (галерея, лестница) «стоит» 6 м пути за метр высоты — по земле удобнее
    for (const q of neighbors(map, u)) { const nd = D.get(u) + dist(pu, q) + 6 * Math.abs(panoZ(map, q) - panoZ(map, pu)); if (nd < D.get(q.id)) { D.set(q.id, nd); prev.set(q.id, u); } }
  }
  if (D.get(b.id) === Infinity) return null;
  const chain = [b.id];
  while (chain[0] !== a.id) chain.unshift(prev.get(chain[0]));
  const nodes = chain.map((id) => map.panos.find((p) => p.id === id));
  // переход между точками обзора админ мог провести через стену — идём по нему пешком, в обход стен и через проёмы
  const at = (p) => ({ x: p.x, y: p.y, z: panoZ(map, p), floor: floorOf(p) }), stops = [from, ...nodes.map(at), to];
  const pts = leg(map, stops[0], stops[1]);
  for (let i = 2; i < stops.length; i++) pts.push(...leg(map, stops[i - 1], stops[i]).slice(1));
  return finish(pts, nodes);
}

// ---------- места ----------
/** Единый список того, что можно найти и выбрать: сектора, метки, объекты. */
export function placeOf(map, ref) {
  if (!ref) return null;
  if (ref.startsWith('sec:') && map.stadium) {
    const s = SECTORS.find((x) => x.id === ref.slice(4));
    if (!s) return null;
    const m = secMid(s);
    return { ref, type: 'sector', id: s.id, name: `Сектор ${s.id}`, sub: `${STANDS[s.stand].n} · ${s.tier === 'lower' ? 'нижний' : 'верхний'} ярус`, x: m.xy[0], y: m.xy[1], obj: s, color: sectorColor(map, s), text: map.sectors[s.id]?.text || '' };
  }
  // у мест на этажах: floor — этаж, z — высота над землёй; в подписи — название этажа, если их несколько
  const fl = (o) => ({ floor: floorOf(o), z: elevOf(map, o) + (o.z || 0) });
  const fsub = (o, s) => (map.floors.length > 1 ? `${s} · ${floorById(map, floorOf(o)).name}` : s);
  const p = map.pois.find((x) => x.id === ref);
  if (p) return { ref, type: 'poi', id: p.id, name: p.name, sub: fsub(p, (PCATS[p.cat] || PCATS.info).n), x: p.x, y: p.y, ...fl(p), obj: p, color: poiColor(map, p), text: p.text, photo: p.photo };
  const s = map.shapes.find((x) => x.id === ref);
  if (s) { const c = shapeCenter(s); return { ref, type: 'shape', id: s.id, name: s.name, sub: fsub(s, (CATS[s.cat] || CATS.building).n), x: c.x, y: c.y, ...fl(s), obj: s, color: shapeColor(map, s), text: s.desc, photo: s.photo }; }
  const pn = map.panos.find((x) => x.id === ref);
  if (pn) return { ref, type: 'pano', id: pn.id, name: pn.name, sub: fsub(pn, 'Точка обзора 360°'), x: pn.x, y: pn.y, ...fl(pn), obj: pn, color: '#c4121c', text: '' };
  if (ref === 'stadium' && map.stadium) return { ref, type: 'stadium', id: 'stadium', name: 'Стадион «Ростов Арена»', sub: 'Поле 105 × 68 м · 4 трибуны · 2 яруса', x: map.stadium.cx, y: map.stadium.cy };
  return null;
}

// адреса панорам в ссылках — только латиница, цифры и дефис (кириллица в адресе ломается при пересылке)
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** «Вход № 3 (Север)» → «vhod-3-sever». */
export function slugify(s) {
  return [...String(s || '').toLowerCase()].map((c) => TR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tochka';
}
/** Свободный адрес панорамы: при совпадении добавляет -2, -3… */
export function uniqueSlug(map, base, selfId) {
  let s = base, n = 2;
  while (map.panos.some((p) => p.id !== selfId && p.slug === s)) s = `${base.slice(0, 56)}-${n++}`;
  return s;
}

export function search(map, q, limit = 12) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const secQ = q.replace(/^сектор\s*/, '').toUpperCase();
  if (map.stadium) for (const s of SECTORS) if (s.id.startsWith(secQ) || s.id.replace(/^./, (c) => ({ A: 'А', B: 'В', C: 'С', D: 'Д' })[c] || c).startsWith(secQ)) out.push('sec:' + s.id);
  for (const p of map.pois) if (p.cat !== 'quest' && (p.name + ' ' + (PCATS[p.cat]?.n || '')).toLowerCase().includes(q)) out.push(p.id);
  for (const p of map.panos) if (p.name.toLowerCase().includes(q)) out.push(p.id);
  for (const s of map.shapes) if (s.cat !== 'plaza' && (s.name + ' ' + (CATS[s.cat]?.n || '')).toLowerCase().includes(q)) out.push(s.id);
  return out.slice(0, limit).map((r) => placeOf(map, r));
}
