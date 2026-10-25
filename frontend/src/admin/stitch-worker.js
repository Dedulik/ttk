// Склейка панорамы в отдельном потоке: 16 кадров с известной ориентацией → эквидистантная проекция 2:1.
// 1. Выравнивание по изображению. Гироскоп телефона ошибается на 1–3° (а в ручном режиме — на 5–15°), отсюда
//    двоение и «рваные» стыки. По уменьшенным кадрам подбираем для каждого кадра небольшой поворот (рысканье,
//    наклон, крен), а если угол обзора не задан вручную — и сам угол обзора, чтобы в зонах перекрытия соседние кадры
//    совпадали. Первый кадр неподвижен — он задаёт направление «вперёд».
// 2. Яркость и цвет: по тем же перекрытиям подбираем множитель каждого канала каждого кадра (автоэкспозиция и
//    баланс белого телефона меняются от кадра к кадру).
// 3. Смешивание: вес плавно убывает к краям кадра и резко растёт к центру — в стыке берётся в основном более
//    «центральный» кадр, поэтому движущиеся люди и параллакс дают меньше двоения.
// Расчёты — на плоских числовых массивах: на телефоне это в разы быстрее, чем массивы объектов.
// Сообщения: { w, h, shots: [{ data, w, h, fwd, up, right, gain, manual }], fovLong, fitFov } → { progress } … { done, data }.

const RAD = Math.PI / 180;
// ориентация кадра в массиве из 10 чисел: вперёд (0–2), вправо (3–5), вверх (6–8), фокусное расстояние (9)
const RT = 3, UP = 6, FL = 9;

self.onmessage = (e) => {
  const { w: W, h: H, shots, fovLong, fitFov } = e.data;
  const n = shots.length, px = shots.map((s) => new Uint8ClampedArray(s.data));
  const rot = shots.map(() => [0, 0, 0]), gains = new Float64Array(n * 3);
  shots.forEach((s, i) => gains.fill(s.gain || 1, i * 3, i * 3 + 3));
  let fov = fovLong;
  try { fov = align(shots, px, rot, fovLong, fitFov, (p) => self.postMessage({ progress: p * 0.35 })); }
  catch { for (const r of rot) r.fill(0); fov = fovLong; }   // выравнивание не удалось — склеиваем по датчикам, как раньше
  const fr = new Float64Array(n * 10);
  shots.forEach((s, i) => frameInto(fr, i, s, rot[i], focal(s.w, s.h, fov)));
  try { exposure(shots, px, fr, gains); } catch { /* оставляем прежнюю поправку яркости */ }

  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      // направление: восток, север, вверх (lon = 0 — направление первого кадра)
      const dx = Math.sin(lon) * cl, dy = Math.cos(lon) * cl, dz = sl;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 10, zf = dx * fr[o] + dy * fr[o + 1] + dz * fr[o + 2];
        if (zf < 0.35) continue;                                   // кадр смотрит в другую сторону
        const sw = shots[i].w, sh = shots[i].h, f = fr[o + FL];
        const u = sw / 2 + ((dx * fr[o + RT] + dy * fr[o + RT + 1] + dz * fr[o + RT + 2]) / zf) * f;
        const v = sh / 2 - ((dx * fr[o + UP] + dy * fr[o + UP + 1] + dz * fr[o + UP + 2]) / zf) * f;
        if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) continue;
        // вес: 0 на краю кадра, 1 в центре; в квадрате — стык узкий, двоения меньше
        const ex = Math.min(u, sw - 1 - u) / (sw / 2), ey = Math.min(v, sh - 1 - v) / (sh / 2);
        const fe = Math.min(1, ex * 2.2) * Math.min(1, ey * 2.2), z2 = zf * zf;
        const wt = fe * fe * z2 * z2 + 1e-6;
        // билинейная выборка
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i00 = (y0 * sw + x0) * 4, i01 = i00 + 4, i10 = i00 + sw * 4, i11 = i10 + 4, p = px[i];
        const k00 = (1 - fx) * (1 - fy), k01 = fx * (1 - fy), k10 = (1 - fx) * fy, k11 = fx * fy, gi = i * 3;
        r += wt * gains[gi] * (p[i00] * k00 + p[i01] * k01 + p[i10] * k10 + p[i11] * k11);
        g += wt * gains[gi + 1] * (p[i00 + 1] * k00 + p[i01 + 1] * k01 + p[i10 + 1] * k10 + p[i11 + 1] * k11);
        b += wt * gains[gi + 2] * (p[i00 + 2] * k00 + p[i01 + 2] * k01 + p[i10 + 2] * k10 + p[i11 + 2] * k11);
        wsum += wt;
      }
      const o = (y * W + x) * 4;
      if (wsum > 0) { out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = 255; }
      else out[o + 3] = 0;                                         // не снято — заполним ниже
    }
    if (y % 64 === 0) self.postMessage({ progress: 0.35 + 0.65 * (y / H) });
  }
  fillGaps(out, W, H);
  self.postMessage({ done: true, data: out.buffer }, [out.buffer]);
};

// фокусное расстояние в пикселях кадра: длинная сторона кадра видит fov градусов
const focal = (w, h, fov) => (Math.max(w, h) / 2) / Math.tan((fov * Math.PI) / 360);

/** Повернуть вектор v вокруг единичной оси a на угол t (формула Родрига). */
function rotAxis(v, a, t) {
  const c = Math.cos(t), s = Math.sin(t), d = (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) * (1 - c);
  return [v[0] * c + (a[1] * v[2] - a[2] * v[1]) * s + a[0] * d, v[1] * c + (a[2] * v[0] - a[0] * v[2]) * s + a[1] * d, v[2] * c + (a[0] * v[1] - a[1] * v[0]) * s + a[2] * d];
}
/** Записать в fr[i] оси кадра после поправки r = [рысканье, наклон, крен] (градусы, вокруг собственных осей кадра). */
function frameInto(fr, i, s, [yaw, pitch, roll], f) {
  let { fwd, up, right } = s;
  if (yaw) { fwd = rotAxis(fwd, up, -yaw * RAD); right = rotAxis(right, up, -yaw * RAD); }
  if (pitch) { fwd = rotAxis(fwd, right, pitch * RAD); up = rotAxis(up, right, pitch * RAD); }
  if (roll) { up = rotAxis(up, fwd, roll * RAD); right = rotAxis(right, fwd, roll * RAD); }
  const o = i * 10;
  fr[o] = fwd[0]; fr[o + 1] = fwd[1]; fr[o + 2] = fwd[2];
  fr[o + 3] = right[0]; fr[o + 4] = right[1]; fr[o + 5] = right[2];
  fr[o + 6] = up[0]; fr[o + 7] = up[1]; fr[o + 8] = up[2]; fr[o + 9] = f;
}

/** Направления по сфере с равной площадью ячеек (спираль Фибоначчи), x y z подряд. */
function sphereDirs(N) {
  const d = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    const z = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - z * z), a = i * 2.399963229728653;
    d[i * 3] = Math.cos(a) * r; d[i * 3 + 1] = Math.sin(a) * r; d[i * 3 + 2] = z;
  }
  return d;
}

/** Уменьшенная яркостная копия кадра (для выравнивания): длинная сторона ~ L пикселей, усреднение блоками. */
function lowGray(s, p, L) {
  const k = Math.max(1, Math.round(Math.max(s.w, s.h) / L)), w = Math.floor(s.w / k), h = Math.floor(s.h / k), g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) { const i = ((y * k + yy) * s.w + x * k + xx) * 4; sum += p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11; }
    g[y * w + x] = sum / (k * k);
  }
  return { g, w, h };
}

/** Значение уменьшенного кадра i в направлении (x, y, z) или -1, если направление вне кадра. */
function sampleLow(fr, i, lo, x, y, z) {
  const o = i * 10, zf = x * fr[o] + y * fr[o + 1] + z * fr[o + 2];
  if (zf < 0.4) return -1;
  const f = fr[o + FL];
  const u = lo.w / 2 + ((x * fr[o + RT] + y * fr[o + RT + 1] + z * fr[o + RT + 2]) / zf) * f;
  const v = lo.h / 2 - ((x * fr[o + UP] + y * fr[o + UP + 1] + z * fr[o + UP + 2]) / zf) * f;
  // самый край кадра (4%) не используем — там сильнее всего искажения объектива
  const mx = lo.w * 0.04, my = lo.h * 0.04;
  if (u < mx || v < my || u >= lo.w - 1 - mx || v >= lo.h - 1 - my) return -1;
  const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, j = y0 * lo.w + x0, g = lo.g;
  return (g[j] * (1 - fx) + g[j + 1] * fx) * (1 - fy) + (g[j + lo.w] * (1 - fx) + g[j + lo.w + 1] * fx) * fy;
}

/**
 * Подбор поворотов кадров (и угла обзора) по совпадению изображений в перекрытиях. Покоординатный спуск
 * с уменьшающимся шагом; ошибка — усечённый квадрат разницы яркости (люди и параллакс не тянут решение),
 * плюс штраф за уход от показаний гироскопа. Меняет rot, возвращает итоговый угол обзора.
 */
function align(shots, px, rot, fov0, fitFov, progress) {
  const n = shots.length; if (n < 2) return fov0;
  // пирамида: крупные шаги — по сильно уменьшенным (размытым) кадрам, у них шире «зона притяжения», мелкие — по детальным
  const pyr = [60, 120, 240].map((L) => shots.map((s, i) => lowGray(s, px[i], L))), N = 40000, dirs = sphereDirs(N), T2 = 35 * 35;
  let lows = pyr[0];
  const fr = new Float64Array(n * 10), tmp = new Float64Array(n * 10);
  let fov = fov0;
  const setAll = (target, fv) => shots.forEach((s, i) => frameInto(target, i, s, rot[i], focal(lows[i].w, lows[i].h, fv)));
  const manual = shots.some((s) => s.manual);
  const lam = manual ? 0.4 : 3;                            // доверие к датчикам: в ручном режиме кадр может сдвигаться сильнее
  const prior = (r) => lam * (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  // кэш для кадра i: направления перекрытий и значения соседей в них (соседи на время подбора неподвижны)
  const cx = new Float64Array(N * 4), cy = new Float64Array(N * 4), cz = new Float64Array(N * 4), cb = new Float64Array(N * 4);
  // направление, ушедшее за край кадра, считается максимальной ошибкой — иначе выгодно «уехать» из перекрытия
  // stride — берём каждую stride-ю пару: при широком объективе перекрытия большие, всех пар не нужно
  function cost(i, M, gi, stride = 1) {
    let e = 0, m = 0, all = 0;
    for (let k = 0; k < M; k += stride) {
      all++;
      const a = sampleLow(tmp, i, lows[i], cx[k], cy[k], cz[k]);
      if (a < 0) { e += T2; continue; }
      const q = a * gi - cb[k]; e += q < 35 && q > -35 ? q * q : T2; m++;
    }
    return m * stride < 25 ? Infinity : e / all;
  }
  const steps = manual ? [4, 2, 1, 0.5, 0.25, 0.12] : [1, 0.5, 0.25, 0.12], sweeps = 2;
  const total = steps.length * sweeps * (n - 1) + (fitFov ? steps.length : 0);
  // общий угол обзора: ошибка по всем парам кадров во всех направлениях
  const full = (fv) => {
    setAll(tmp, fv); let e = 0, m = 0; const vals = new Float64Array(n);
    for (let d = 0; d < N; d += 2) {
      const x = dirs[d * 3], y = dirs[d * 3 + 1], z = dirs[d * 3 + 2]; let c = 0;
      for (let j = 0; j < n; j++) { const b = sampleLow(tmp, j, lows[j], x, y, z); if (b >= 0) vals[c++] = b; }
      for (let a = 0; a < c; a++) for (let b = a + 1; b < c; b++) { const q = vals[a] - vals[b]; e += q < 35 && q > -35 ? q * q : T2; m++; }
    }
    return m < 300 ? Infinity : e / m;
  };
  // угол обзора — сначала, грубым перебором ±15 % (повороты потом подстроятся под него, а не наоборот)
  if (fitFov) {
    lows = pyr[0];
    let best = Infinity;
    for (let k = -6; k <= 6; k++) { const fv = fov0 * (1 + k * 0.025), c = full(fv); if (c < best) { best = c; fov = fv; } }
  }
  let done = 0;
  // порядок обхода: каждый раз берём кадр, ближе всего смотрящий к уже обработанным (начиная с первого кадра)
  const placed = new Uint8Array(n), order = [], used = new Uint8Array(n); used[0] = placed[0] = 1;
  for (let k = 1; k < n; k++) {
    let bi = -1, bd = -2;
    for (let i = 1; i < n; i++) if (!used[i]) for (let j = 0; j < n; j++) if (used[j]) {
      const d = shots[i].fwd[0] * shots[j].fwd[0] + shots[i].fwd[1] * shots[j].fwd[1] + shots[i].fwd[2] * shots[j].fwd[2];
      if (d > bd) { bd = d; bi = i; }
    }
    used[bi] = 1; order.push(bi);
  }
  for (const st of steps) {
    lows = pyr[st >= 1 ? 0 : st >= 0.5 ? 1 : 2]; setAll(fr, fov);
    for (let sw = 0; sw < sweeps; sw++) for (const i of order) {
      // самый первый проход — «наращивание» от первого кадра: кадр подгоняется только под уже выровненных соседей,
      // иначе он подстраивается под ещё сбитые кадры и застревает на компромиссе
      const grow = st === steps[0] && sw === 0;
      const o = i * 10;
      let M = 0, sa = 0, sb = 0;
      for (let d = 0; d < N; d++) {
        const x = dirs[d * 3], y = dirs[d * 3 + 1], z = dirs[d * 3 + 2];
        if (x * fr[o] + y * fr[o + 1] + z * fr[o + 2] < 0.6) continue;
        const a = sampleLow(fr, i, lows[i], x, y, z); if (a < 0) continue;
        for (let j = 0; j < n && M < cb.length; j++) {
          if (j === i || (grow && !placed[j])) continue;
          const b = sampleLow(fr, j, lows[j], x, y, z); if (b < 0) continue;
          cx[M] = x; cy[M] = y; cz[M] = z; cb[M] = b; M++;
          sa += a; sb += b;
        }
      }
      // яркость кадра i приводим к соседям — разница экспозиции не мешает выравниванию
      const gi = sa > 0 ? Math.max(0.6, Math.min(1.6, sb / sa)) : 1;
      tmp.set(fr);
      const fine = Math.max(1, Math.ceil(M / 12000)), coarse = Math.max(1, Math.ceil(M / 3000));
      let r = rot[i].slice(), best = cost(i, M, gi, coarse) + prior(r);
      if (best !== Infinity) {
        // первый (самый грубый) шаг — перебор по сетке ±3 шага по всем трём углам: покоординатный спуск
        // от нуля застревает в ложных минимумах (повторяющиеся фермы потолка, ряды кресел)
        if (st === steps[0]) {
          const r0 = r.slice();
          for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) for (let c = -3; c <= 3; c++) {
            const r2 = [r0[0] + a * st, r0[1] + b * st, r0[2] + c * st];
            frameInto(tmp, i, shots[i], r2, fr[o + FL]);
            const v = cost(i, M, gi, coarse) + prior(r2);
            if (v < best) { best = v; r = r2; }
          }
        }
        frameInto(tmp, i, shots[i], r, fr[o + FL]); best = cost(i, M, gi, fine) + prior(r);
        for (let pass = 0; pass < 3; pass++) {
          let moved = false;
          for (let k = 0; k < 3; k++) for (const sg of [1, -1]) {
            const r2 = r.slice(); r2[k] += sg * st;
            frameInto(tmp, i, shots[i], r2, fr[o + FL]);
            const c = cost(i, M, gi, fine) + prior(r2);
            if (c < best) { best = c; r = r2; moved = true; }
          }
          if (!moved) break;
        }
        rot[i] = r; frameInto(fr, i, shots[i], r, fr[o + FL]);
      }
      placed[i] = 1;
      progress(++done / total);
    }
    if (fitFov) {
      let best = full(fov), next = fov;
      for (const sg of [1, -1]) {
        const f2 = Math.max(fov0 * 0.85, Math.min(fov0 * 1.15, fov + sg * st * 2)), c = full(f2);
        if (c < best) { best = c; next = f2; }
      }
      fov = next; setAll(fr, fov);
      progress(++done / total);
    }
  }
  return fov;
}

/**
 * Поправка яркости и цвета: для каждого кадра и канала — множитель, при котором его перекрытия совпадают с соседями.
 * Несколько итераций, затем нормировка (средний множитель = 1), пределы 0,7–1,45.
 */
function exposure(shots, px, fr, gains) {
  const n = shots.length; if (n < 2) return;
  const N = 3000, dirs = sphereDirs(N);
  // наблюдения: в каждой общей точке — номер кадра и его цвет; по каналам копим суммы для каждой пары
  const S = new Float64Array(n * n * 3), C = new Float64Array(n * n * 3), seen = new Int32Array(n), col = new Float64Array(n * 3);
  let pairs = 0;
  for (let d = 0; d < N; d++) {
    const x = dirs[d * 3], y = dirs[d * 3 + 1], z = dirs[d * 3 + 2]; let c = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 10, zf = x * fr[o] + y * fr[o + 1] + z * fr[o + 2]; if (zf < 0.4) continue;
      const sw = shots[i].w, sh = shots[i].h, f = fr[o + FL];
      const u = sw / 2 + ((x * fr[o + RT] + y * fr[o + RT + 1] + z * fr[o + RT + 2]) / zf) * f;
      const v = sh / 2 - ((x * fr[o + UP] + y * fr[o + UP + 1] + z * fr[o + UP + 2]) / zf) * f;
      if (u < 4 || v < 4 || u >= sw - 5 || v >= sh - 5) continue;
      const j = ((v | 0) * sw + (u | 0)) * 4, p = px[i];
      seen[c] = i; col[c * 3] = p[j]; col[c * 3 + 1] = p[j + 1]; col[c * 3 + 2] = p[j + 2]; c++;
    }
    for (let a = 0; a < c; a++) for (let b = 0; b < c; b++) if (a !== b) {
      const k = (seen[a] * n + seen[b]) * 3;
      for (let ch = 0; ch < 3; ch++) { S[k + ch] += col[a * 3 + ch]; C[k + ch] += col[b * 3 + ch]; }
      pairs++;
    }
  }
  if (pairs < 100) return;
  // g[i]·Σ свой = Σ g[j]·соседа  (по всем перекрытиям кадра i)
  const g = Float64Array.from(gains);
  for (let it = 0; it < 15; it++) for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) {
    let num = 0, den = 0;
    for (let j = 0; j < n; j++) { if (j === i) continue; const k = (i * n + j) * 3 + ch; num += g[j * 3 + ch] * C[k]; den += S[k]; }
    if (den > 0) g[i * 3 + ch] = 0.5 * g[i * 3 + ch] + 0.5 * (num / den);
  }
  for (let ch = 0; ch < 3; ch++) {
    let mean = 0; for (let i = 0; i < n; i++) mean += Math.log(Math.max(1e-3, g[i * 3 + ch])) / n;
    const k = Math.exp(-mean);
    for (let i = 0; i < n; i++) gains[i * 3 + ch] = Math.max(0.7, Math.min(1.45, g[i * 3 + ch] * k));
  }
}

/**
 * Места, не попавшие ни в один кадр (полюса, стыки рядов при обычном объективе), заполняем «push-pull»:
 * строим пирамиду уменьшенных копий из снятых пикселей, а дыры берём из ближайшего уровня, где они уже закрыты.
 * Получается плавное продолжение соседних цветов без резких пятен.
 */
function fillGaps(px, W, H) {
  const levels = [{ w: W, h: H, c: new Float32Array(W * H * 3), a: new Float32Array(W * H) }];
  for (let i = 0, o = 0; i < W * H; i++, o += 4) if (px[o + 3]) { const L = levels[0]; L.c[i * 3] = px[o]; L.c[i * 3 + 1] = px[o + 1]; L.c[i * 3 + 2] = px[o + 2]; L.a[i] = 1; }
  // вниз: среднее по снятым пикселям 2×2 (долгота закольцована)
  while (levels.at(-1).w > 8) {
    const P = levels.at(-1), w = P.w >> 1, h = Math.max(1, P.h >> 1), c = new Float32Array(w * h * 3), a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = (x * 2 + dx) % P.w, sy = Math.min(P.h - 1, y * 2 + dy), j = sy * P.w + sx, k = P.a[j];
        r += P.c[j * 3] * k; g += P.c[j * 3 + 1] * k; b += P.c[j * 3 + 2] * k; n += k;
      }
      const j = y * w + x;
      if (n > 0) { c[j * 3] = r / n; c[j * 3 + 1] = g / n; c[j * 3 + 2] = b / n; a[j] = Math.min(1, n); }
    }
    levels.push({ w, h, c, a });
  }
  // верх: дыры уровня заполняем из следующего (уже заполненного) уровня с билинейной выборкой
  const top = levels.at(-1);
  let mr = 0, mg = 0, mb = 0, mn = 0;
  for (let j = 0; j < top.w * top.h; j++) if (top.a[j]) { mr += top.c[j * 3]; mg += top.c[j * 3 + 1]; mb += top.c[j * 3 + 2]; mn++; }
  for (let j = 0; j < top.w * top.h; j++) if (!top.a[j]) { top.c[j * 3] = mn ? mr / mn : 128; top.c[j * 3 + 1] = mn ? mg / mn : 128; top.c[j * 3 + 2] = mn ? mb / mn : 128; top.a[j] = 1; }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], U = levels[l + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const j = y * L.w + x, k = L.a[j]; if (k >= 1) continue;
      const fx = ((x + 0.5) * U.w) / L.w - 0.5, fy = Math.max(0, Math.min(U.h - 1, ((y + 0.5) * U.h) / L.h - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, y1 = Math.min(U.h - 1, y0 + 1);
      const X0 = ((x0 % U.w) + U.w) % U.w, X1 = (X0 + 1) % U.w;
      for (let ch = 0; ch < 3; ch++) {
        const v = (U.c[(y0 * U.w + X0) * 3 + ch] * (1 - tx) + U.c[(y0 * U.w + X1) * 3 + ch] * tx) * (1 - ty) + (U.c[(y1 * U.w + X0) * 3 + ch] * (1 - tx) + U.c[(y1 * U.w + X1) * 3 + ch] * tx) * ty;
        L.c[j * 3 + ch] = L.c[j * 3 + ch] * k + v * (1 - k);
      }
      L.a[j] = 1;
    }
  }
  const L = levels[0];
  for (let i = 0, o = 0; i < W * H; i++, o += 4) if (!px[o + 3]) { px[o] = L.c[i * 3]; px[o + 1] = L.c[i * 3 + 1]; px[o + 2] = L.c[i * 3 + 2]; px[o + 3] = 255; }
}
