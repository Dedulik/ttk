// Пешеходная навигация по плану: сетка проходимости и поиск пути A*.
// Стены зданий и помещений непроходимы, дверные проёмы — проходимы (они уже вырезаны в wallSegments).
// На карте со стадионом непроходима чаша: к секторам ведут точки обзора на галерее.
// У каждого этажа своя сетка; между этажами путь идёт через лестницы (лестница этажа ведёт на этаж выше).
import { floorOf, floorsSorted, mapBox, wallSegments } from './model.js';
import { inBowl } from './stadium.js';

const cache = new WeakMap();

/** Сетка проходимости этажа. Пересчитывается, только если карта изменилась. */
function gridOf(map, floor) {
  const key = JSON.stringify([map.shapes, map.walls, map.doors, map.floors, !!map.stadium]);
  const all = cache.get(map) || {};
  if (all.key !== key) { for (const k of Object.keys(all)) delete all[k]; all.key = key; cache.set(map, all); }
  if (all[floor]) return all[floor];
  const b = mapBox(map), pad = 12;
  const x0 = b.x - pad, y0 = b.y - pad, W = b.w + 2 * pad, H = b.h + 2 * pad;
  const cell = Math.min(2.5, Math.max(0.4, Math.max(W, H) / 320));
  const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell), block = new Uint8Array(nx * ny);
  const at = (x, y) => [Math.floor((x - x0) / cell), Math.floor((y - y0) / cell)];
  for (const s of wallSegments(map, floor)) {
    // полоса вдоль стены без «шапок» на концах: иначе дверной проём (это разрыв между отрезками) зарастает
    const r = s.t / 2 + cell * 0.6, [ax, ay] = s.a, [bx, by] = s.b, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, L = Math.sqrt(L2);
    const pad = (cell * 0.5) / L;   // чуть заходим за концы, чтобы углы комнат оставались замкнутыми
    const [i0, j0] = at(Math.min(ax, bx) - r, Math.min(ay, by) - r), [i1, j1] = at(Math.max(ax, bx) + r, Math.max(ay, by) + r);
    for (let j = Math.max(0, j0); j <= Math.min(ny - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) {
      const px = x0 + (i + 0.5) * cell, py = y0 + (j + 0.5) * cell, t = ((px - ax) * dx + (py - ay) * dy) / L2;
      if (t < -pad || t > 1 + pad) continue;
      const tc = Math.max(0, Math.min(1, t));
      if (Math.hypot(px - ax - tc * dx, py - ay - tc * dy) < r) block[j * nx + i] = 1;
    }
  }
  const ground = floorsSorted(map)[0].id;
  if (map.stadium && floor === ground) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (inBowl(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell, 70)) block[j * nx + i] = 1;
  return (all[floor] = { x0, y0, cell, nx, ny, block });
}

/** Ближайшая проходимая клетка (если точка внутри стены или замкнутого помещения без дверей). */
function nearestFree(g, i, j) {
  const { nx, ny, block } = g;
  i = Math.max(0, Math.min(nx - 1, i)); j = Math.max(0, Math.min(ny - 1, j));
  if (!block[j * nx + i]) return [i, j];
  for (let r = 1; r < Math.max(nx, ny); r++) {
    let best = null, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny || block[b * nx + a]) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = [a, b]; }
    }
    if (best) return best;
  }
  return null;
}

/** Видна ли клетка b из клетки a по прямой, не задевая стен (в том числе «наискосок» между двумя клетками стены). */
function clear(g, a, b) {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4) || 1, at = (i, j) => g.block[j * g.nx + i];
  let pi = a[0], pj = a[1];
  for (let k = 1; k <= n; k++) {
    const i = Math.round(a[0] + ((b[0] - a[0]) * k) / n), j = Math.round(a[1] + ((b[1] - a[1]) * k) / n);
    if (at(i, j) || (i !== pi && j !== pj && (at(i, pj) || at(pi, j)))) return false;
    pi = i; pj = j;
  }
  return true;
}

/**
 * Пешеходный путь от a до b (у точек есть floor): массив [x, y, z] или null, если дойти нельзя.
 * На другой этаж — через ближайшую лестницу каждого пролёта.
 */
export function walkPath(map, a, b) {
  const order = floorsSorted(map), idx = (f) => Math.max(0, order.findIndex((x) => x.id === f));
  const elev = (f) => order[idx(f)].elev || 0, up = (pts, f) => pts.map(([x, y]) => [x, y, elev(f)]);
  const fa = a.floor || order[0].id, fb = b.floor || order[0].id;
  if (fa === fb) { const p = floorPath(map, fa, a, b); return p && up(p, fa); }
  const dir = idx(fb) > idx(fa) ? 1 : -1, out = [];
  let cur = a;
  for (let i = idx(fa); i !== idx(fb); i += dir) {
    const f = order[i].id, next = order[i + dir].id, lower = dir > 0 ? f : next;
    const flights = map.stairs.filter((s) => floorOf(s) === lower).map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 }));
    if (!flights.length) return null;   // нет лестницы между этажами
    const st = flights.sort((p, q) => Math.hypot(p.x - cur.x, p.y - cur.y) - Math.hypot(q.x - cur.x, q.y - cur.y))[0];
    const p = floorPath(map, f, cur, st); if (!p) return null;
    out.push(...up(p, f));
    cur = { ...st, floor: next };
  }
  const p = floorPath(map, fb, cur, b); if (!p) return null;
  return [...out, ...up(p, fb)];
}

/** Путь по сетке одного этажа: массив [x, y] или null. */
function floorPath(map, floor, a, b) {
  const g = gridOf(map, floor), { x0, y0, cell, nx, ny, block } = g;
  const s = nearestFree(g, Math.floor((a.x - x0) / cell), Math.floor((a.y - y0) / cell));
  const e = nearestFree(g, Math.floor((b.x - x0) / cell), Math.floor((b.y - y0) / cell));
  if (!s || !e) return null;
  const N = nx * ny, start = s[1] * nx + s[0], goal = e[1] * nx + e[0];
  const gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const h = (k) => { const dx = Math.abs((k % nx) - e[0]), dy = Math.abs(((k / nx) | 0) - e[1]); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
  const heap = [[h(start), start]]; gs[start] = 0;
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= it[0]) break; heap[i] = heap[p]; i = p; } heap[i] = it; };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= last[0]) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return top; };
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (heap.length) {
    const [, k] = pop();
    if (done[k]) continue;
    if (k === goal) break;
    done[k] = 1;
    const i = k % nx, j = (k / nx) | 0;
    for (const [di, dj, c] of steps) {
      const a2 = i + di, b2 = j + dj; if (a2 < 0 || b2 < 0 || a2 >= nx || b2 >= ny) continue;
      const n = b2 * nx + a2; if (block[n] || done[n]) continue;
      if (di && dj && (block[j * nx + a2] || block[b2 * nx + i])) continue;   // не срезаем углы стен
      const ng = gs[k] + c; if (ng < gs[n]) { gs[n] = ng; from[n] = k; push([ng + h(n), n]); }
    }
  }
  // до цели не дойти (замкнутое помещение без дверей) — ведём к ближайшему достижимому месту
  let end = goal, reached = gs[goal] !== Infinity;
  if (!reached) { let bd = Infinity; for (let k = 0; k < N; k++) if (gs[k] !== Infinity && h(k) < bd) { bd = h(k); end = k; } if (bd === Infinity) return null; }
  const cells = [];
  for (let k = end; k !== -1; k = from[k]) cells.unshift([k % nx, (k / nx) | 0]);
  // спрямляем: от каждой точки идём к самой дальней видимой
  const out = [cells[0]];
  for (let i = 0; i < cells.length - 1;) { let j = cells.length - 1; while (j > i + 1 && !clear(g, cells[i], cells[j])) j--; out.push(cells[j]); i = j; }
  const pts = out.map(([i, j]) => [x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell]);
  // концы — в саму точку, только если до неё видно по прямой; если она в стене, путь заканчивается у стены
  const cellOf = (p) => [Math.max(0, Math.min(nx - 1, Math.floor((p.x - x0) / cell))), Math.max(0, Math.min(ny - 1, Math.floor((p.y - y0) / cell)))];
  const ca = cellOf(a), cb = cellOf(b);
  if (!block[ca[1] * nx + ca[0]] && clear(g, ca, s)) pts[0] = [a.x, a.y];
  if (reached && !block[cb[1] * nx + cb[0]] && clear(g, e, cb)) pts[pts.length - 1] = [b.x, b.y];
  return pts;
}
