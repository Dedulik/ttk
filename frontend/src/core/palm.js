// Переход между панорамами «ладошкой»: пиксельная ладонь маскота закрывает кадр, под ней меняется панорама,
// ладонь уходит. Кадры ролика assets/video/ladoshka.mp4 (0,72 с) заранее нарезаны в одну картинку
// ladoshka-frames.png с прозрачным фоном. Раньше ролик проигрывался через <video>, и на телефонах (iOS, режим
// энергосбережения, медленная сеть) браузер не запускал его без нажатия — переход молча пропускался.
// Картинка рисуется всегда; растягиваем её на весь экран без размытия (пиксель-арт).
const SRC = new URL('../../assets/video/ladoshka-frames.png', import.meta.url).href;
const FW = 320, FH = 180, COLS = 6, FRAMES = 22, FPS = 30;
const COVER = 9;            // с этого кадра ладонь закрывает весь кадр (до 13-го)

let sheet = null;
function getSheet() {
  if (sheet) return sheet;
  sheet = new Image(); sheet.decoding = 'async'; sheet.src = SRC;
  return sheet;
}
/** Заранее подгрузить кадры, чтобы первый переход начался без задержки. */
export function preloadPalm() { getSheet(); }

/**
 * Проиграть переход поверх host. swap() вызывается, когда ладонь закрыла кадр; если он вернул Promise
 * (следующая панорама ещё грузится) — ладонь держит кадр закрытым, пока Promise не выполнится.
 * Возвращает Promise, который выполняется, когда ладонь ушла. Если кадры не загрузились — просто swap().
 */
export function palmWipe(host, swap) {
  const img = getSheet();
  return new Promise((resolve) => {
    const cv = document.createElement('canvas');
    cv.className = 'palm-wipe'; cv.width = FW; cv.height = FH;
    host.append(cv);
    const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
    let swapped = false, held = false, done = false, raf = 0, t0 = 0, heldAt = 0, frame = -1;
    const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); cv.remove(); resolve(); };
    const doSwap = () => {
      if (swapped) return; swapped = true;
      let r; try { r = swap(); } catch { r = null; }
      if (r && typeof r.then === 'function') { held = true; heldAt = performance.now(); r.finally(() => { t0 += performance.now() - heldAt; held = false; }); }
    };
    const draw = (now) => {
      if (done) return;
      if (!t0) t0 = now;
      const f = held ? COVER + 1 : Math.floor(((now - t0) / 1000) * FPS);
      if (f >= FRAMES) { if (!swapped) doSwap(); if (!held) return finish(); }
      if (f !== frame && f < FRAMES) {
        frame = f; ctx.clearRect(0, 0, FW, FH);
        ctx.drawImage(img, (f % COLS) * FW, Math.floor(f / COLS) * FH, FW, FH, 0, 0, FW, FH);
      }
      if (!swapped && f >= COVER) doSwap();
      raf = requestAnimationFrame(draw);
    };
    const start = () => { if (!done) raf = requestAnimationFrame(draw); };
    if (img.complete && img.naturalWidth) start();
    else {
      // кадры не успели загрузиться за 1,5 с (плохая сеть) — переходим без анимации
      const slow = setTimeout(() => { doSwap(); finish(); }, 1500);
      img.addEventListener('load', () => { clearTimeout(slow); start(); }, { once: true });
      img.addEventListener('error', () => { clearTimeout(slow); doSwap(); finish(); }, { once: true });
    }
  });
}
