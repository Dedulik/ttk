// Склейка панорамы в отдельном потоке: 16 кадров с известной ориентацией → эквидистантная проекция 2:1.
// Для каждого пикселя панорамы берём направление, проецируем его в каждый кадр (модель «точечной» камеры),
// смешиваем попавшие кадры с весом, плавно убывающим к краям кадра (без видимых швов).
// Сообщения: { w, h, shots: [{ data, w, h, fwd, up, right, gain }], fovLong } → { progress } … { done, data }.

self.onmessage = (e) => {
  const { w: W, h: H, shots, fovLong } = e.data;
  const out = new Uint8ClampedArray(W * H * 4);
  // фокусное расстояние в долях кадра: длинная сторона кадра видит fovLong градусов
  const prep = shots.map((s) => {
    const long = Math.max(s.w, s.h), f = (long / 2) / Math.tan((fovLong * Math.PI) / 360);
    return { ...s, f, cx: s.w / 2, cy: s.h / 2, px: new Uint8ClampedArray(s.data) };
  });
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      // направление: восток, север, вверх (lon = 0 — направление первого кадра)
      const dx = Math.sin(lon) * cl, dy = Math.cos(lon) * cl, dz = sl;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (const s of prep) {
        const zf = dx * s.fwd[0] + dy * s.fwd[1] + dz * s.fwd[2];
        if (zf < 0.35) continue;                                   // кадр смотрит в другую сторону
        const u = s.cx + ((dx * s.right[0] + dy * s.right[1] + dz * s.right[2]) / zf) * s.f;
        const v = s.cy - ((dx * s.up[0] + dy * s.up[1] + dz * s.up[2]) / zf) * s.f;
        if (u < 0 || v < 0 || u >= s.w - 1 || v >= s.h - 1) continue;
        // вес: 0 на краю кадра, 1 в центре — швы растворяются
        const ex = Math.min(u, s.w - 1 - u) / (s.w / 2), ey = Math.min(v, s.h - 1 - v) / (s.h / 2);
        const wt = Math.min(1, ex * 2.2) * Math.min(1, ey * 2.2) * zf * zf + 1e-6;
        // билинейная выборка
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i00 = (y0 * s.w + x0) * 4, i01 = i00 + 4, i10 = i00 + s.w * 4, i11 = i10 + 4, p = s.px;
        const k00 = (1 - fx) * (1 - fy), k01 = fx * (1 - fy), k10 = (1 - fx) * fy, k11 = fx * fy;
        r += wt * s.gain * (p[i00] * k00 + p[i01] * k01 + p[i10] * k10 + p[i11] * k11);
        g += wt * s.gain * (p[i00 + 1] * k00 + p[i01 + 1] * k01 + p[i10 + 1] * k10 + p[i11 + 1] * k11);
        b += wt * s.gain * (p[i00 + 2] * k00 + p[i01 + 2] * k01 + p[i10 + 2] * k10 + p[i11 + 2] * k11);
        wsum += wt;
      }
      const o = (y * W + x) * 4;
      if (wsum > 0) { out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = 255; }
      else out[o + 3] = 0;                                         // не снято — заполним ниже
    }
    if (y % 64 === 0) self.postMessage({ progress: y / H });
  }
  fillGaps(out, W, H);
  self.postMessage({ done: true, data: out.buffer }, [out.buffer]);
};

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
