// Загрузка фото 360°: проверка файла в браузере и предпросмотр на сфере до сохранения.
// Сервер проверяет то же самое ещё раз (kind=pano360) — проверке в браузере не доверяем, она только для удобства.
// Сайт не склеивает обычные фото в панораму: нужна готовая сферическая (эквидистантная) 2:1 —
// с камеры 360° или из приложения-склейки на телефоне.
import * as THREE from 'three';
import { esc, icon } from './ui.js';

export const PANO_RULES = { types: ['image/jpeg', 'image/png', 'image/webp'], minW: 2000, maxSide: 16384, maxMB: 15, ratio: 2, tol: 0.04 };

/** Проверить файл: тип, размер, пропорция 2:1, разрешение. Возвращает { w, h } или бросает понятную ошибку. */
export async function checkPanoFile(file, R = PANO_RULES) {
  if (!R.types.includes(file.type)) throw new Error('Нужен файл JPEG, PNG или WebP');
  if (file.size > R.maxMB * 1048576) throw new Error(`Файл больше ${R.maxMB} МБ — сожмите его (например, JPEG 85%)`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось прочитать картинку')); i.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight, r = w / h;
    if (Math.abs(r - R.ratio) > R.ratio * R.tol) throw new Error(`Это не сферическая панорама: пропорции ${w} × ${h}, а нужно 2:1 (например, 6000 × 3000). Обычные фото сайт не склеивает — сделайте панораму камерой 360° или приложением-склейкой.`);
    if (w < R.minW) throw new Error(`Слишком маленькое разрешение: ${w} × ${h}. Нужно хотя бы ${R.minW} × ${R.minW / 2}`);
    if (w > R.maxSide) throw new Error(`Слишком большое разрешение: ${w} × ${h}. Максимум — ${R.maxSide} по ширине`);
    return { w, h };
  } finally { URL.revokeObjectURL(url); }
}

/** Показать фото на сфере перед сохранением. Возвращает Promise<boolean>: true — «Сохранить». */
export function previewPano(file, { title = 'Предпросмотр панорамы', info = '' } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'cyl pano-preview';
    el.innerHTML = `
      <div class="cyl-top"><button class="iconbtn" data-v="0" aria-label="Отмена">${icon('back')}</button>
        <div class="look-title"><b>${esc(title)}</b><span>${esc(info || 'Ведите, чтобы осмотреться')}</span></div></div>
      <div class="cyl-msg">Загружаю…</div>
      <div class="pp-acts"><button class="btn primary" data-v="1">${icon('check')}Сохранить</button><button class="btn" data-v="0">Отмена</button></div>`;
    document.body.append(el);
    const url = URL.createObjectURL(file);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.rotation.order = 'YXZ';
    let yaw = 0, pitch = 0, alive = true, tex = null, mesh = null, dirty = true;
    new THREE.TextureLoader().load(url, (t) => {
      if (!alive) return t.dispose();
      tex = t; t.colorSpace = THREE.SRGBColorSpace;
      const g = new THREE.SphereGeometry(50, 64, 40); g.scale(-1, 1, 1);
      mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: t })); scene.add(mesh);
      el.querySelector('.cyl-msg').hidden = true; dirty = true;
    }, undefined, () => { el.querySelector('.cyl-msg').textContent = 'Не удалось показать фото'; });
    const cv = renderer.domElement, ptr = new Map();
    cv.addEventListener('pointerdown', (e) => { try { cv.setPointerCapture(e.pointerId); } catch { /* уже отпущен */ } ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
    cv.addEventListener('pointermove', (e) => {
      const p = ptr.get(e.pointerId); if (!p) return;
      const k = (camera.fov * Math.PI) / 180 / cv.clientHeight;
      yaw += (e.clientX - p.x) * k; pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - p.y) * k));
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); dirty = true;
    });
    const up = (e) => ptr.delete(e.pointerId);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); camera.fov = Math.max(30, Math.min(95, camera.fov * (e.deltaY > 0 ? 1.08 : 0.93))); camera.updateProjectionMatrix(); dirty = true; }, { passive: false });
    const size = () => { renderer.setSize(el.clientWidth, el.clientHeight); camera.aspect = el.clientWidth / Math.max(1, el.clientHeight); camera.updateProjectionMatrix(); dirty = true; };
    window.addEventListener('resize', size); size();
    const loop = () => { if (!alive) return; if (dirty) { camera.rotation.set(pitch, yaw, 0); renderer.render(scene, camera); dirty = false; } requestAnimationFrame(loop); };
    loop();
    const close = (v) => {
      alive = false; window.removeEventListener('resize', size); document.removeEventListener('keydown', key, true);
      mesh?.geometry.dispose(); mesh?.material.dispose(); tex?.dispose(); renderer.dispose(); URL.revokeObjectURL(url); el.remove(); resolve(v);
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
    document.addEventListener('keydown', key, true);
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) close(b.dataset.v === '1'); });
  });
}
