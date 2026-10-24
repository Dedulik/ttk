// Съёмка панорамы 360° камерой телефона прямо в конструкторе (по образцу Raya 360):
// 16 кадров по точкам-целям — 8 по горизонту, 4 вверх, 4 вниз. Гироскоп подсказывает, куда повернуть телефон,
// и сам делает снимок, когда точка совпала с прицелом. Каждый кадр сразу сохраняется в браузере (IndexedDB),
// поэтому съёмку можно прервать и продолжить. Любой кадр можно переснять. Потом кадры склеиваются в панораму 2:1.
// Без гироскопа (компьютер, запрет доступа) работает ручной режим: кнопка спуска и подсказки по порядку.
import { esc, icon, toast } from '../core/ui.js';

const RAD = Math.PI / 180;
/** 16 целей: [поворот, наклон] в градусах относительно первого кадра. */
export const TARGETS = [
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((y) => [y, 0]),
  ...[45, 135, 225, 315].map((y) => [y, 55]),
  ...[45, 135, 225, 315].map((y) => [y, -55]),
];
const HINT_ROW = (i) => (i < 8 ? 'по горизонту' : i < 12 ? 'наклоните телефон вверх' : 'наклоните телефон вниз');
const STORE_W = 1280;            // длинная сторона сохранённого кадра
const STITCH_W = 960;            // длинная сторона кадра при склейке (память телефона)
const OUT_W = 4096;              // панорама 4096 × 2048
// Угол обзора длинной стороны кадра, градусы. 16 кадров закрывают всю сферу только широкоугольной камерой
// (0,5×, от ~85°) — как в Raya 360. Обычная камера (~66°) оставит ~7% у полюсов и в стыках рядов: их заполнит размытием.
const DEF_FOV = 66, WIDE_FOV = 100;
const WIDE_RE = /ultra|сверхшир|ультра|0[.,]5|wide angle|широкоуг/i;

// ---------- сохранение процесса в IndexedDB ----------
const DB = 'arena-capture', ST = 'sessions';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function dbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(ST, mode), q = fn(t.objectStore(ST)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); });
}
export const loadSession = (key) => dbDo('readonly', (s) => s.get(key)).catch(() => null);
const saveSession = (key, v) => dbDo('readwrite', (s) => s.put(v, key)).catch(() => toast('Не удалось сохранить кадр в памяти браузера — не закрывайте страницу', 5000));
export const dropSession = (key) => dbDo('readwrite', (s) => s.delete(key)).catch(() => {});

// ---------- ориентация телефона ----------
/** Матрица поворота устройства (W3C DeviceOrientation, Z-X'-Y''): столбцы — оси телефона в системе «восток, север, вверх». */
function deviceAxes(a, b, g) {
  const cA = Math.cos(a * RAD), sA = Math.sin(a * RAD), cB = Math.cos(b * RAD), sB = Math.sin(b * RAD), cG = Math.cos(g * RAD), sG = Math.sin(g * RAD);
  const X = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG];
  const Y = [-cB * sA, cA * cB, sB];
  const Z = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
  return { X, Y, Z };
}
const screenAngle = () => (screen.orientation?.angle ?? window.orientation ?? 0) * RAD;
/** Направление задней камеры и оси кадра (верх, право) с учётом поворота экрана. */
function cameraFrame(o) {
  const { X, Y, Z } = deviceAxes(o.alpha || 0, o.beta || 0, o.gamma || 0), t = screenAngle(), c = Math.cos(t), s = Math.sin(t);
  const fwd = Z.map((v) => -v);
  const up = Y.map((v, i) => c * v + s * X[i]);
  const right = X.map((v, i) => c * v - s * Y[i]);
  return { fwd, up, right };
}
const yawOf = (v) => Math.atan2(v[0], v[1]) / RAD;              // от «севера» по часовой
const pitchOf = (v) => Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD;
const rotZ = (v, deg) => { const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; };
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
/** Идеальная ориентация цели (для ручного режима и подсказок). */
function idealFrame(yaw, pitch) {
  const y = yaw * RAD, p = pitch * RAD;
  return { fwd: [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)], up: [-Math.sin(y) * Math.sin(p), -Math.cos(y) * Math.sin(p), Math.cos(p)], right: [Math.cos(y), -Math.sin(y), 0] };
}

/**
 * Открыть съёмку. key — ключ сохранения (объект + точка), title — название точки.
 * Возвращает Promise<File | null>: готовую панораму JPEG 4096×2048 или null, если вышли без неё.
 */
export function openCapture({ key, title }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'cam360';
    el.innerHTML = `
      <video class="cap-video" playsinline muted autoplay></video>
      <svg class="cap-aim" aria-hidden="true"><circle class="cap-cross" r="26"/><g class="cap-target"><circle class="cap-ring" r="22"/><circle class="cap-fill" r="22"/><text class="cap-num" dy="5"></text></g><path class="cap-arrow" d="M0-14L12 10H-12Z"/></svg>
      <div class="cap-top">
        <button class="iconbtn" data-c="close" aria-label="Сохранить и выйти">${icon('back')}</button>
        <div class="look-title"><b id="capTitle">Съёмка панорамы</b><span id="capSub">${esc(title)}</span></div>
        <button class="iconbtn" data-c="settings" aria-label="Настройки съёмки">${icon('more')}</button>
      </div>
      <div class="cap-hint" id="capHint" role="status" aria-live="polite"></div>
      <div class="pop cap-set" id="capSet" hidden>
        <label class="row nowrap" style="justify-content:space-between">Автоспуск по гироскопу <input type="checkbox" class="switch" id="capAuto" checked></label>
        <label class="field"><span class="lbl">Камера</span><select class="inp sm" id="capCam"></select></label>
        <label class="field"><span class="lbl">Угол обзора камеры · <b id="capFovV"></b>°</span><input type="range" id="capFov" min="50" max="120" step="1"></label>
        <span class="cap" style="font-size:12px">Если на панораме видны швы или двоение — подберите угол и соберите заново.</span>
        <button class="btn sm danger" data-c="reset">Начать съёмку заново</button>
      </div>
      <div class="cap-start" id="capStart">
        <div class="card">
          <h2 style="font-size:18px">Панорама камерой телефона</h2>
          <p class="cap" style="margin:0">16 кадров: 8 по кругу, 4 вверх и 4 вниз. Встаньте в точке и поворачивайтесь <b>вокруг телефона</b>, а не вокруг себя — держите его у груди на одном месте. Наведите прицел на точку — снимок сделается сам.</p>
          <p class="cap" id="capResume" style="margin:0" hidden></p>
          <p class="err" id="capErr" hidden></p>
          <div class="row"><button class="btn primary" data-c="start">${icon('pano')}Начать</button><button class="btn" data-c="close">Отмена</button></div>
        </div>
      </div>
      <div class="cap-bottom">
        <div class="cap-thumbs" id="capThumbs"></div>
        <div class="cap-actions"><button class="btn" data-c="stitch" id="capStitch" disabled>Собрать</button><button class="cap-shutter" data-c="shoot" aria-label="Сделать снимок"></button><span class="cap-count" id="capCount">0/16</span></div>
      </div>
      <div class="cap-busy" id="capBusy" hidden><div class="card"><b id="capBusyT">Собираю панораму…</b><div class="qbar"><i id="capBar" style="width:0%"></i></div><span class="cap" id="capBusyS"></span></div></div>`;
    document.body.append(el);
    document.documentElement.classList.add('cap-open');
    const $ = (s) => el.querySelector(s), video = $('.cap-video');
    const S = { shots: Array(16).fill(null), cur: 0, yaw0: null, fov: DEF_FOV, auto: true, sensors: false, o: null, hold: 0, stream: null, busy: false, retake: false };
    let raf = 0, wake = null, gotEvent = false;

    // ---------- восстановление сохранённой съёмки ----------
    loadSession(key).then((v) => {
      if (!v) return;
      S.shots = v.shots || S.shots; S.fov = v.fov || DEF_FOV; S.fovSet = !!v.fovSet; S.camId = v.camId || '';
      const n = S.shots.filter(Boolean).length;
      // гироскоп после перезагрузки считает повороты от нового нуля — направление первого кадра надо «привязать» заново
      S.needAnchor = n > 0 && !!S.shots[0];
      if (n) { $('#capResume').hidden = false; $('#capResume').textContent = `Есть сохранённая съёмка: ${n} из 16 кадров. Продолжим с места остановки.`; }
      next(); thumbs();
    });
    const persist = () => saveSession(key, { shots: S.shots, fov: S.fov, fovSet: S.fovSet, camId: S.camId, updated: Date.now() });

    // ---------- подсказки и прицел ----------
    function next() { const i = S.shots.findIndex((x) => !x); S.cur = i < 0 ? S.cur : i; S.retake = false; }
    function thumbs() {
      $('#capThumbs').innerHTML = S.shots.map((s, i) => `<button class="cap-th${i === S.cur ? ' on' : ''}${s ? ' done' : ''}" data-t="${i}" aria-label="Кадр ${i + 1}${s ? ' — переснять' : ''}">${s ? `<img src="${s.thumb}" alt="">` : i + 1}</button>`).join('');
      const n = S.shots.filter(Boolean).length;
      $('#capCount').textContent = `${n}/16`;
      $('#capStitch').disabled = n < 8 || S.shots.slice(0, 8).some((x) => !x);
      $('#capStitch').classList.toggle('primary', n === 16);
      $('#capTitle').textContent = n === 16 && !S.retake ? 'Все кадры сняты' : `${S.retake ? 'Пересъёмка' : 'Кадр'} ${S.cur + 1} из 16`;
    }
    function hint(t) { $('#capHint').textContent = t; }
    function aim() {
      raf = requestAnimationFrame(aim);
      const svg = $('.cap-aim'), w = svg.clientWidth, h = svg.clientHeight, cx = w / 2, cy = h / 2;
      $('.cap-cross').setAttribute('cx', cx); $('.cap-cross').setAttribute('cy', cy);
      const all = S.shots.every(Boolean) && !S.retake;
      const [ty, tp] = TARGETS[S.cur];
      $('.cap-num').textContent = S.cur + 1;
      if (!S.sensors || !S.o) {
        // ручной режим: цель всегда в центре, подсказка — словами
        place(cx, cy, 0, false);
        hint(all ? 'Все 16 кадров сняты — нажмите «Собрать»' : S.cur === 0 ? 'Держите телефон вертикально на уровне глаз и нажмите кнопку' : `Повернитесь на ${S.cur < 8 ? 45 : 90}° вправо, ${HINT_ROW(S.cur)} — и нажмите кнопку`);
        return;
      }
      const f = cameraFrame(S.o), yaw = yawOf(f.fwd), pitch = pitchOf(f.fwd);
      if (S.needAnchor) {
        place(cx, cy, 0, false); S.hold = 0;
        return hint('Продолжаем съёмку: повернитесь туда, где снимали первый кадр (миниатюра «1» внизу), и нажмите кнопку');
      }
      if (S.yaw0 === null && S.cur === 0) {
        // первый кадр задаёт направление «вперёд»: нужен только ровный наклон
        const dp = tp - pitch;
        place(cx, cy - dp * (h / 60), Math.abs(dp), true);
        hint(all ? '' : Math.abs(dp) > 4 ? (dp > 0 ? 'Поднимите телефон чуть выше' : 'Опустите телефон чуть ниже') : 'Держите ровно…');
        return tryAuto(Math.abs(dp) < 3.5);
      }
      const dy = wrap(ty - (yaw - (S.yaw0 || 0))), dp = tp - pitch, k = w / 55;
      const x = cx + dy * k, y = cy - dp * k, off = Math.hypot(dy, dp);
      place(x, y, off, true);
      if (all) return hint('Все 16 кадров сняты — нажмите «Собрать» или выберите кадр, чтобы переснять');
      hint(off > 4 ? `${Math.abs(dy) > 4 ? (dy > 0 ? 'Поворачивайтесь вправо' : 'Поворачивайтесь влево') : ''}${Math.abs(dy) > 4 && Math.abs(dp) > 4 ? ' · ' : ''}${Math.abs(dp) > 4 ? (dp > 0 ? 'наклоните вверх' : 'наклоните вниз') : ''}` : 'Держите ровно…');
      tryAuto(off < 3.5);
    }
    function place(x, y, off, sensors) {
      const svg = $('.cap-aim'), w = svg.clientWidth, h = svg.clientHeight, m = 34;
      const inside = x > m && x < w - m && y > m && y < h - m;
      const px = Math.max(m, Math.min(w - m, x)), py = Math.max(m, Math.min(h - m, y));
      $('.cap-target').setAttribute('transform', `translate(${px} ${py})`);
      $('.cap-target').classList.toggle('near', sensors && off < 3.5);
      const ar = $('.cap-arrow'); ar.style.display = inside ? 'none' : '';
      if (!inside) ar.setAttribute('transform', `translate(${px} ${py}) rotate(${(Math.atan2(y - h / 2, x - w / 2) / RAD) + 90})`);
      $('.cap-fill').style.strokeDashoffset = String(138 * (1 - Math.min(1, S.hold / 600)));
    }
    let last = 0;
    function tryAuto(ok) {
      const now = performance.now(), dt = last ? now - last : 0; last = now;
      if (!S.auto || S.busy || (S.shots.every(Boolean) && !S.retake)) { S.hold = 0; return; }
      S.hold = ok ? S.hold + dt : 0;
      if (S.hold > 600) { S.hold = 0; shoot(); }
    }

    // ---------- снимок ----------
    async function shoot() {
      if (S.busy || !video.videoWidth) return;
      if (S.needAnchor && S.sensors && S.o) {
        const f = cameraFrame(S.o); S.yaw0 = yawOf(f.fwd) - TARGETS[0][0]; S.needAnchor = false;
        toast('Направление привязано — снимайте дальше'); return;
      }
      if (S.shots.every(Boolean) && !S.retake) return toast('Все кадры сняты. Чтобы переснять, выберите кадр внизу');
      S.busy = true;
      const i = S.cur, vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, STORE_W / Math.max(vw, vh));
      const cv = document.createElement('canvas'); cv.width = Math.round(vw * k); cv.height = Math.round(vh * k);
      cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
      let fr;
      if (S.sensors && S.o) {
        const f = cameraFrame(S.o);
        if (S.yaw0 === null) S.yaw0 = yawOf(f.fwd);
        fr = { fwd: rotZ(f.fwd, -S.yaw0), up: rotZ(f.up, -S.yaw0), right: rotZ(f.right, -S.yaw0) };    // относительно первого кадра
      } else fr = idealFrame(...TARGETS[i]);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
      const th = document.createElement('canvas'); th.width = 48; th.height = Math.round((48 * cv.height) / cv.width); th.getContext('2d').drawImage(cv, 0, 0, th.width, th.height);
      S.shots[i] = { blob, w: cv.width, h: cv.height, ...fr, manual: !(S.sensors && S.o), thumb: th.toDataURL('image/jpeg', 0.6) };
      el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 160);
      if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(30);   // лёгкий отклик на снимок
      await persist();
      next(); thumbs(); S.busy = false;
    }

    // ---------- камера и датчики ----------
    /** Запустить поток с камеры: заданное устройство или задняя (по возможности — широкоугольная). */
    async function openStream(deviceId) {
      S.stream?.getTracks().forEach((t) => t.stop());
      const want = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
      S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...want, width: { ideal: 1920 }, height: { ideal: 1440 } } });
      video.srcObject = S.stream; await video.play().catch(() => {});
      const tr = S.stream.getVideoTracks()[0], set = tr.getSettings?.() || {};
      S.camId = set.deviceId || deviceId || '';
      // названия камер видны только после разрешения; ищем широкоугольную заднюю
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      $('#capCam').innerHTML = cams.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === S.camId ? 'selected' : ''}>${esc(d.label || `Камера ${i + 1}`)}</option>`).join('');
      const label = cams.find((d) => d.deviceId === S.camId)?.label || '';
      if (!deviceId && !WIDE_RE.test(label)) {
        const wide = cams.find((d) => WIDE_RE.test(d.label) && !/front|передн|user/i.test(d.label));
        if (wide) return openStream(wide.deviceId);
        // Chrome на Android: у «логической» камеры широкий угол включается приближением 0,5×
        const caps = tr.getCapabilities?.() || {};
        if (caps.zoom && caps.zoom.min < 1) { try { await tr.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] }); S.wide = true; } catch { /* остаёмся на основной */ } }
      }
      S.wide = S.wide || WIDE_RE.test(label);
      if (!S.fovSet) { S.fov = S.wide ? WIDE_FOV : DEF_FOV; $('#capFov').value = S.fov; $('#capFovV').textContent = S.fov; }
      if (!S.wide) toast('Широкоугольная камера (0,5×) не найдена: полюса панорамы будут размыты. Если она есть — выберите её в настройках ⋯', 6000);
    }

    async function start() {
      const err = $('#capErr'); err.hidden = true;
      if (!window.isSecureContext) { err.hidden = false; err.textContent = 'Камера работает только по защищённому адресу (https://) или на localhost. Откройте админ-панель по HTTPS.'; return; }
      if (!navigator.mediaDevices?.getUserMedia) { err.hidden = false; err.textContent = 'Этот браузер не даёт доступ к камере. Обновите Safari или Chrome.'; return; }
      // iOS 13+: доступ к гироскопу спрашивается отдельно и только по нажатию
      try { if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') S.sensorPerm = await DeviceOrientationEvent.requestPermission(); } catch { S.sensorPerm = 'denied'; }
      try {
        await openStream(S.camId);
      } catch (e) {
        err.hidden = false;
        err.textContent = e.name === 'NotAllowedError' ? 'Доступ к камере запрещён. Разрешите его: iPhone — «Настройки → Safari → Камера»; Android — значок замка в адресной строке → «Разрешения» → «Камера». Потом нажмите «Начать» ещё раз.'
          : e.name === 'NotFoundError' ? 'Камера не найдена.' : e.name === 'NotReadableError' ? 'Камера занята другим приложением — закройте его и попробуйте снова.' : 'Не удалось включить камеру: ' + e.message;
        return;
      }
      window.addEventListener('deviceorientation', onOrient);
      setTimeout(() => {
        if (!gotEvent) { S.sensors = false; toast(S.sensorPerm === 'denied' ? 'Доступ к датчикам движения запрещён — снимайте вручную кнопкой' : 'Гироскоп недоступен — снимайте вручную кнопкой, поворачиваясь по подсказкам', 5000); }
      }, 1200);
      try { wake = await navigator.wakeLock?.request('screen'); } catch { /* экран может погаснуть — не страшно */ }
      $('#capStart').hidden = true; el.classList.add('live');
      next(); thumbs(); aim();
    }
    function onOrient(e) { if (e.alpha === null && e.beta === null) return; gotEvent = true; S.sensors = true; S.o = { alpha: e.alpha, beta: e.beta, gamma: e.gamma }; }

    // ---------- склейка ----------
    async function stitch() {
      if (S.busy) return;
      S.busy = true; $('#capBusy').hidden = false; $('#capBar').style.width = '0%'; $('#capBusyS').textContent = 'Подготавливаю кадры…';
      try {
        const shots = [];
        for (const s of S.shots.filter(Boolean)) {
          const bmp = await createImageBitmap(s.blob), k = Math.min(1, STITCH_W / Math.max(bmp.width, bmp.height));
          const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
          const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
          const d = x.getImageData(0, 0, cv.width, cv.height);
          let sum = 0; for (let i = 0; i < d.data.length; i += 64) sum += d.data[i] + d.data[i + 1] + d.data[i + 2];
          shots.push({ data: d.data.buffer, w: cv.width, h: cv.height, fwd: s.fwd, up: s.up, right: s.right, mean: sum / (d.data.length / 64) });
        }
        // выравниваем яркость кадров (автоэкспозиция телефона): мягко к общей средней
        const avg = shots.reduce((a, s) => a + s.mean, 0) / shots.length;
        for (const s of shots) s.gain = Math.max(0.8, Math.min(1.25, Math.sqrt(avg / Math.max(1, s.mean))));
        $('#capBusyS').textContent = 'Склеиваю 360°…';
        const data = await runStitch(shots, S.fov, (p) => { $('#capBar').style.width = `${Math.round(p * 100)}%`; });
        const cv = document.createElement('canvas'); cv.width = OUT_W; cv.height = OUT_W / 2;
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), OUT_W, OUT_W / 2), 0, 0);
        const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
        const file = new File([blob], `pano-${Date.now()}.jpg`, { type: 'image/jpeg' });
        $('#capBusy').hidden = true; S.busy = false;
        close(file);
      } catch (e) {
        console.error(e); $('#capBusy').hidden = true; S.busy = false;
        toast('Не удалось собрать панораму: ' + (e.message || e) + '. Кадры сохранены — попробуйте ещё раз.', 6000);
      }
    }

    function close(file) {
      cancelAnimationFrame(raf);
      window.removeEventListener('deviceorientation', onOrient);
      S.stream?.getTracks().forEach((t) => t.stop());
      wake?.release?.().catch(() => {});
      document.documentElement.classList.remove('cap-open');
      el.remove(); document.removeEventListener('keydown', onKey, true);
      resolve(file || null);
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } if (e.key === ' ' && el.classList.contains('live')) { e.preventDefault(); shoot(); } };
    document.addEventListener('keydown', onKey, true);
    $('#capFov').value = S.fov; $('#capFovV').textContent = S.fov;
    el.addEventListener('input', (e) => { if (e.target.id === 'capFov') { S.fov = +e.target.value; S.fovSet = true; $('#capFovV').textContent = S.fov; persist(); } });
    el.addEventListener('change', async (e) => {
      if (e.target.id === 'capAuto') S.auto = e.target.checked;
      if (e.target.id === 'capCam') {
        // сменили объектив — угол обзора тоже другой; кадры, снятые прежней камерой, лучше переснять
        S.fovSet = false; S.wide = false;
        try { await openStream(e.target.value); persist(); } catch (ex) { toast('Не удалось включить эту камеру: ' + ex.message, 5000); }
        if (S.shots.some(Boolean)) toast('Камера сменилась — кадры, снятые прежней, лучше переснять (настройки → «Начать заново»)', 6000);
      }
    });
    el.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-c],[data-t]'); if (!t) return;
      if (t.dataset.t) { S.cur = +t.dataset.t; S.retake = !!S.shots[S.cur]; thumbs(); return; }
      const c = t.dataset.c;
      if (c === 'close') close(null);
      if (c === 'start') start();
      if (c === 'shoot') shoot();
      if (c === 'stitch') stitch();
      if (c === 'settings') { $('#capSet').hidden = !$('#capSet').hidden; $('#capFov').value = S.fov; $('#capFovV').textContent = S.fov; }
      if (c === 'reset') { S.shots = Array(16).fill(null); S.yaw0 = null; S.cur = 0; await dropSession(key); thumbs(); $('#capSet').hidden = true; toast('Съёмка начата заново'); }
    });
    thumbs();
  });
}

/** Склейка в Web Worker (не подвешивает интерфейс); если воркеры недоступны — бросает ошибку с понятным текстом. */
function runStitch(shots, fovLong, onProgress) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./stitch-worker.js', import.meta.url)); } catch (e) { reject(new Error('браузер не поддерживает фоновую обработку')); return; }
    w.onmessage = (e) => {
      if (e.data.progress !== undefined) onProgress(e.data.progress);
      if (e.data.done) { w.terminate(); resolve(e.data.data); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'ошибка склейки')); };
    w.postMessage({ w: OUT_W, h: OUT_W / 2, shots, fovLong }, shots.map((s) => s.data));
  });
}
