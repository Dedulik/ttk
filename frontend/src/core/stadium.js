// Геометрия чаши «Ростов Арены»: поле 105×68, четыре трибуны, два яруса.
// Чаша описана суперэллипсом вокруг поля, сектора нарезаны по схеме: нумерация идёт по кругу
// A101→A113 → D114→D121 → C122→C131 → B132→B138 (нижний ярус) и так же 401–442 (верхний).

export const ST = { cx: 333.5, cy: 248.5, fa: 34, fb: 52.5, n: 4 };

export function setStadiumCenter(map) {
  if (map?.stadium) { ST.cx = map.stadium.cx; ST.cy = map.stadium.cy; }
}

/** Точка на контуре чаши: угол t, отступ off метров от кромки поля. */
export function sp(t, off) {
  const c = Math.cos(t), s = Math.sin(t), e = 2 / ST.n;
  return [ST.cx + (ST.fa + off) * Math.sign(c) * Math.abs(c) ** e, ST.cy + (ST.fb + off) * Math.sign(s) * Math.abs(s) ** e];
}

export const ring = (off, n = 160) => Array.from({ length: n }, (_, i) => sp((2 * Math.PI * i) / n, off));

const PI = Math.PI;
export const STANDS = {
  A: { n: 'Западная трибуна', short: 'Западная', c: '#2c5cc5' },
  B: { n: 'Северная трибуна', short: 'Северная', c: '#2f9e44' },
  C: { n: 'Восточная трибуна', short: 'Восточная', c: '#d0343c' },
  D: { n: 'Южная трибуна', short: 'Южная', c: '#e39a12' },
};
export const RANGES = { A: [5 * PI / 4, 3 * PI / 4], D: [3 * PI / 4, PI / 4], C: [PI / 4, -PI / 4], B: [-PI / 4, -3 * PI / 4] };
export const NUMS = {
  lower: { A: [101, 113], D: [114, 121], C: [122, 131], B: [132, 138] },
  upper: { A: [401, 411], D: [412, 421], C: [422, 432], B: [433, 442] },
};
export const TIERS = {
  lower: { n: 'Нижний ярус', o0: 7, o1: 33, z0: 0.8, dz: 1.1, rows: 10 },
  upper: { n: 'Верхний ярус', o0: 40, o1: 68, z0: 15, dz: 1.5, rows: 10 },
};

export const SECTORS = [];
for (const tier of ['lower', 'upper']) {
  for (const k of ['A', 'D', 'C', 'B']) {
    const [a, b] = RANGES[k], [n0, n1] = NUMS[tier][k], cnt = n1 - n0 + 1, gap = 0.007 * Math.sign(b - a);
    for (let i = 0; i < cnt; i++) {
      SECTORS.push({ id: k + (n0 + i), stand: k, tier, index: SECTORS.length, t0: a + ((b - a) * i) / cnt + gap, t1: a + ((b - a) * (i + 1)) / cnt - gap });
    }
  }
}

export const sector = (id) => SECTORS.find((s) => s.id === id);

export function secMid(s) {
  const T = TIERS[s.tier];
  return { xy: sp((s.t0 + s.t1) / 2, (T.o0 + T.o1) / 2), z: T.z0 + (T.dz * T.rows) / 2 };
}

export function secPts(s, m = 8) {
  const T = TIERS[s.tier], p = [];
  for (let i = 0; i <= m; i++) p.push(sp(s.t0 + ((s.t1 - s.t0) * i) / m, T.o0));
  for (let i = m; i >= 0; i--) p.push(sp(s.t0 + ((s.t1 - s.t0) * i) / m, T.o1));
  return p;
}

export function neighbours(s) {
  const list = SECTORS.filter((x) => x.tier === s.tier), i = list.indexOf(s);
  return { prev: list.at(i - 1), next: list[(i + 1) % list.length] };
}

export function otherTier(s) {
  const mid = (s.t0 + s.t1) / 2;
  return SECTORS.filter((x) => x.tier !== s.tier && x.stand === s.stand).sort((p, q) => Math.abs((p.t0 + p.t1) / 2 - mid) - Math.abs((q.t0 + q.t1) / 2 - mid))[0];
}

/** Попадает ли точка плана в чашу стадиона (для подсказок и запрета построек). */
export function inBowl(x, y, off = 72) {
  const dx = (x - ST.cx) / (ST.fa + off), dy = (y - ST.cy) / (ST.fb + off);
  return Math.abs(dx) ** ST.n + Math.abs(dy) ** ST.n <= 1;
}
