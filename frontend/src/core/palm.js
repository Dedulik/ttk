// Переход между панорамами «ладошкой»: пиксельная ладонь маскота закрывает кадр, под ней меняется панорама,
// ладонь уходит. Ролик assets/video/ladoshka.mp4 (0,72 с, чёрный фон) — фон вырезаем на лету,
// ролик растягиваем на весь экран без размытия (пиксель-арт), поэтому качество не зависит от его размера.
const SRC = new URL('../../assets/video/ladoshka.mp4', import.meta.url).href;
const COVER_AT = 0.29;      // с этого момента ладонь закрывает весь кадр (до ~0,44 с)

let video = null;
function getVideo() {
  if (video) return video;
  video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = SRC;
  video.load();
  return video;
}
/** Заранее подгрузить ролик, чтобы первый переход начался без задержки. */
export function preloadPalm() { getVideo(); }

/**
 * Проиграть переход поверх host. swap() вызывается, когда ладонь закрыла кадр; если он вернул Promise
 * (следующая панорама ещё грузится) — ладонь держит кадр закрытым, пока Promise не выполнится.
 * Возвращает Promise, который выполняется, когда ладонь ушла. Без поддержки видео — просто swap().
 */
export function palmWipe(host, swap) {
  const v = getVideo();
  return new Promise((resolve) => {
    const cv = document.createElement('canvas');
    cv.className = 'palm-wipe'; cv.width = 320; cv.height = 180;
    host.append(cv);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let swapped = false, held = false, done = false, raf = 0;
    const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); v.pause(); cv.remove(); resolve(); };
    const doSwap = () => {
      if (swapped) return; swapped = true;
      let r; try { r = swap(); } catch { r = null; }
      if (r && typeof r.then === 'function') { held = true; v.pause(); r.finally(() => { held = false; if (!done) v.play().catch(finish); }); }
    };
    const draw = () => {
      if (done) return;
      if (v.readyState >= 2) {
        ctx.drawImage(v, 0, 0, 320, 180);
        // чёрный фон ролика → прозрачный: вокруг ладони видно панораму
        const img = ctx.getImageData(0, 0, 320, 180), d = img.data;
        for (let i = 0; i < d.length; i += 4) { const s = d[i] + d[i + 1] + d[i + 2]; if (s < 54) d[i + 3] = 0; else if (s < 90) d[i + 3] = (s - 54) * 7; }
        ctx.putImageData(img, 0, 0);
      }
      if (!swapped && v.currentTime >= COVER_AT) doSwap();
      raf = requestAnimationFrame(draw);
    };
    v.onended = () => { if (!swapped) doSwap(); if (!held) finish(); };
    v.onerror = () => { doSwap(); finish(); };
    // ролик не стартовал за 1,5 с (нет видео в браузере) — переходим без анимации
    const slow = setTimeout(() => { if (v.currentTime === 0 && !done) { doSwap(); finish(); } }, 1500);
    v.currentTime = 0;
    v.play().then(() => { clearTimeout(slow); draw(); }).catch(() => { clearTimeout(slow); doSwap(); finish(); });
  });
}
