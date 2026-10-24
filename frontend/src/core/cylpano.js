// Цилиндрическая панорама для «своей точки»: длинное фото обёрнуто по внутренней стороне цилиндра,
// камера стоит в центре. Смотреть можно только по сторонам (поворот вокруг оси) и приближать —
// наклона вверх-вниз нет. Высота цилиндра берётся из пропорций фото: ширина фото = вся окружность.
import * as THREE from 'three';
import { esc, icon } from './ui.js';

const R = 10, PI = Math.PI, DEG = 180 / PI;

/** Открыть панораму поверх страницы. Возвращает { close }. */
export function openCylPano({ url, title, sub = 'Панорама 360° · поворачивайтесь в стороны', onClose }) {
  const el = document.createElement('div');
  el.className = 'cyl';
  el.innerHTML = `
    <div class="cyl-top"><button class="iconbtn" data-x aria-label="Закрыть панораму">${icon('back')}</button>
      <div class="look-title"><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>
    <div class="cyl-msg">Загружаю панораму…</div>
    <div class="look-hint">Ведите влево-вправо, чтобы осмотреться · колесо или щипок — приблизить</div>
    <div class="cyl-zoom"><button class="iconbtn" data-z="-1" aria-label="Приблизить">+</button><button class="iconbtn" data-z="1" aria-label="Отдалить">−</button></div>`;
  document.body.append(el);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  camera.rotation.order = 'YXZ';
  scene.background = new THREE.Color('#0d0e10');
  let yaw = 0, vel = 0, fov = 70, maxFov = 70, minFov = 30, dirty = true, alive = true, mesh = null, tex = null;
  const setFov = (f) => { fov = Math.max(minFov, Math.min(maxFov, f)); camera.fov = fov; camera.updateProjectionMatrix(); dirty = true; };

  new THREE.TextureLoader().load(url, (t) => {
    if (!alive) return t.dispose();
    tex = t; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const { width, height } = t.image, H = (2 * PI * R * height) / width;
    // открытый цилиндр без крышек; зеркалим по X, чтобы изнутри фото читалось не задом наперёд
    const geo = new THREE.CylinderGeometry(R, R, H, 256, 1, true); geo.scale(-1, 1, 1);
    mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
    scene.add(mesh);
    // кадр по высоте целиком помещается в экран; сильнее 90° не раскрываем — иначе края сильно тянет
    maxFov = Math.min(90, 2 * Math.atan(H / 2 / R) * DEG); minFov = Math.max(18, maxFov * 0.4);
    setFov(maxFov);
    el.querySelector('.cyl-msg').hidden = true;
  }, undefined, () => { el.querySelector('.cyl-msg').textContent = 'Не удалось загрузить фото панорамы'; });

  // ---------- управление: только поворот вокруг вертикальной оси и масштаб ----------
  const canvas = renderer.domElement, ptr = new Map();
  let last = null, pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ }
    ptr.set(e.pointerId, e.clientX); vel = 0;
    last = { x: e.clientX, t: performance.now() };
    if (ptr.size === 2) { const [a, b] = [...ptr.values()]; pinch = { d: Math.abs(a - b) || 1, fov }; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptr.has(e.pointerId)) return;
    const prev = ptr.get(e.pointerId); ptr.set(e.pointerId, e.clientX);
    if (ptr.size === 2 && pinch) { const [a, b] = [...ptr.values()]; setFov((pinch.fov * pinch.d) / Math.max(1, Math.abs(a - b))); return; }
    // сдвиг пальца на ширину экрана = поворот на горизонтальный угол обзора
    const k = (2 * Math.atan(Math.tan((fov / DEG) / 2) * camera.aspect)) / canvas.clientWidth, d = (e.clientX - prev) * k;
    yaw += d; const now = performance.now(); vel = Math.max(-0.04, Math.min(0.04, (d / Math.max(16, now - last.t)) * 16)); last = { x: e.clientX, t: now }; dirty = true;
  });
  const up = (e) => { ptr.delete(e.pointerId); if (ptr.size < 2) pinch = null; if (performance.now() - (last?.t || 0) > 80) vel = 0; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); setFov(fov * (e.deltaY > 0 ? 1.08 : 0.93)); }, { passive: false });
  const onKey = (e) => {
    if (['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', '+', '=', '-'].includes(e.key)) e.stopPropagation();   // карта под панорамой клавиш не получает
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') { yaw += 0.12; dirty = true; }
    if (e.key === 'ArrowRight') { yaw -= 0.12; dirty = true; }
    if (e.key === '+' || e.key === '=') setFov(fov * 0.9);
    if (e.key === '-') setFov(fov * 1.1);
  };
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) close();
    const z = e.target.closest('[data-z]'); if (z) setFov(fov * (z.dataset.z === '1' ? 1.15 : 0.87));
  });
  const hint = el.querySelector('.look-hint'); setTimeout(() => (hint.style.opacity = 0), 3500);

  const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; };
  const ro = new ResizeObserver(resize); ro.observe(el); resize();
  (function loop() {
    if (!alive) return;
    requestAnimationFrame(loop);
    if (!ptr.size && Math.abs(vel) > 1e-4) { yaw += vel; vel *= 0.9; dirty = true; }   // инерция после броска
    if (!dirty) return;
    dirty = false; camera.rotation.set(0, yaw, 0); renderer.render(scene, camera);
  })();

  function close() {
    if (!alive) return; alive = false;
    window.removeEventListener('keydown', onKey, true); ro.disconnect();
    if (mesh) { mesh.geometry.dispose(); mesh.material.dispose(); }
    tex?.dispose(); renderer.dispose(); renderer.forceContextLoss(); el.remove(); onClose?.();
  }
  return { close };
}
