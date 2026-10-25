// 3D-сцена: территория, «Ростов Арена» по фото, метки, панорамы, маршрут.
// Два режима камеры:
//   orbit — как в картах: один палец двигает карту, два пальца — масштаб и поворот (MapControls);
//   look  — взгляд из точки (панорама, вид с места): палец крутит взгляд, щипок — приближение.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CATS, PCATS, catColor, elevOf, floorById, floorsSorted, kindOf, mapBox, neighbors, poiColor, sectorColor, shapeBox, shapeCenter, shapeLayer, shapePoints, standColor, wallSegments } from './model.js';
import { RANGES, SECTORS, ST, STANDS, TIERS, ring, secMid, sp } from './stadium.js';
import { iconImage, iconsReady, pointIconImage } from './icons.js';
import { hideTip, showTip } from './ui.js';

const PI = Math.PI;

/**
 * Отрезки стен, лежащие на одной прямой (общие стены соседних комнат, стена здания вдоль стены комнаты), сливаются:
 * перекрывающиеся интервалы объединяются, толщина и высота — наибольшие. Так в одном месте строится одна стена.
 */
export function mergeWalls(segs) {
  const groups = new Map(), out = [];
  for (const s of segs) {
    let dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1]; const L = Math.hypot(dx, dy); if (L < 0.01) continue;
    dx /= L; dy /= L;
    if (dx < -1e-9 || (Math.abs(dx) < 1e-9 && dy < 0)) { dx = -dx; dy = -dy; }          // одно направление для обеих ориентаций
    const off = -dy * s.a[0] + dx * s.a[1];                                                // расстояние прямой от начала координат
    const key = `${s.floor}|${Math.round(Math.atan2(dy, dx) * 2000)}|${Math.round(off * 50)}`;
    const t0 = dx * s.a[0] + dy * s.a[1], t1 = dx * s.b[0] + dy * s.b[1];
    if (!groups.has(key)) groups.set(key, { dx, dy, off, list: [] });
    groups.get(key).list.push({ lo: Math.min(t0, t1), hi: Math.max(t0, t1), s });
  }
  for (const g of groups.values()) {
    g.list.sort((a, b) => a.lo - b.lo);
    let cur = null;
    const P = (t) => [g.dx * t - g.dy * g.off, g.dy * t + g.dx * g.off];
    const flush = () => { if (cur) out.push({ ...cur.s, a: P(cur.lo), b: P(cur.hi), t: cur.t, h: cur.h }); };
    for (const it of g.list) {
      if (cur && it.lo <= cur.hi + 0.02) { cur.hi = Math.max(cur.hi, it.hi); cur.t = Math.max(cur.t, it.s.t); cur.h = Math.max(cur.h, it.s.h); }
      else { flush(); cur = { lo: it.lo, hi: it.hi, s: it.s, t: it.s.t, h: it.s.h }; }
    }
    flush();
  }
  return out;
}
const NEAR_ORBIT = 1.5, NEAR_LOOK = 0.2;
const C = { x: 400, y: 262 };
const W = (x, y, h = 0) => new THREE.Vector3(x - C.x, h, y - C.y);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class Scene3D {
  constructor(el, { onPick, onLook } = {}) {
    this.el = el; this.onPick = onPick; this.onLook = onLook;
    this.map = null; this.roof = true; this.anim = null; this.look = null; this.route = null; this.active = false;
    this.screenSprites = []; this.culled = [];
    // «лёгкий» режим для слабых телефонов: без теней и с меньшим разрешением (или ?lite в адресе)
    this.lite = new URLSearchParams(location.search).has('lite') || (navigator.hardwareConcurrency || 8) <= 4;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: !this.lite, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(this.lite ? 1.25 : 2, devicePixelRatio));
    r.shadowMap.enabled = !this.lite; r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.dirty = true;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    el.append(r.domElement);
    // браузер может отобрать WebGL-контекст (нехватка видеопамяти, сворачивание вкладки на телефоне);
    // без обработки сцена навсегда замирает. preventDefault разрешает восстановление, после него пересобираем сцену.
    r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    r.domElement.addEventListener('webglcontextrestored', () => {
      this.lost = false; this.texCache?.clear();
      if (this.map) this.setMap(this.map);
      if (this.look && this.lastPhoto) this.setPhoto(this.lastPhoto.url, this.lastPhoto.rot);
      this.dirty = true;
    });
    this.scene = new THREE.Scene();
    // ближняя плоскость 1,5 м в обзоре (точнее буфер глубины, нет мерцания), 0,2 м — во взгляде из точки
    this.camera = new THREE.PerspectiveCamera(45, 1, NEAR_ORBIT, 5000);
    this.controls = new MapControls(this.camera, r.domElement);
    this.controls.addEventListener('change', () => (this.dirty = true));
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.09, maxPolarAngle: 1.32, minDistance: 14, maxDistance: 1100, zoomToCursor: true, screenSpacePanning: false, rotateSpeed: 0.6 });
    this.groups = {};
    for (const k of ['world', 'stadium', 'roof', 'labels', 'pois', 'panos', 'route', 'arrows', 'quest']) { this.groups[k] = new THREE.Group(); this.scene.add(this.groups[k]); }
    this.addLights();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
  }

  // ---------- база ----------
  addLights() {
    this.hemi = new THREE.HemisphereLight(0xeaf1f8, 0x8b857c, 1.25); this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xfff4e6, 2.4));
    // normalBias убирает полосы «самозатенения» на стенах (shadow acne)
    sun.position.set(-260, 420, 300); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.35;
    Object.assign(sun.shadow.camera, { left: -440, right: 440, top: 300, bottom: -300, near: 10, far: 1400 });
    this.scene.add(sun);
  }
  theme() {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const sky = new THREE.Color(dark ? '#14171b' : '#d6e1ec');
    this.scene.background = sky; this.scene.fog = new THREE.Fog(sky, 900, 2600);
    this.hemi.intensity = dark ? 0.75 : 1.25; this.sun.intensity = dark ? 1.2 : 2.4;
    this.dark = dark;
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
    for (const s of this.screenSprites) this.sizeSprite(s);
  }
  setActive(on) { this.active = on; if (on) this.resize(); this.dirty = true; }
  /**
   * Буфер глубины точен пропорционально near: при фиксированных near = 1,5 м и far = 5 км на расстоянии 1 км
   * глубина различалась лишь с шагом ~4 см — слои пола и стыки стен «дрались» (рябь). Теперь near ≈ 1 % от
   * расстояния до цели (камера всё равно не подлетает ближе), far — сколько нужно, чтобы видеть всю сцену и туман.
   */
  fitDepth() {
    const c = this.camera, d = c.position.distanceTo(this.controls.target);
    const near = Math.min(40, Math.max(NEAR_ORBIT, d * 0.012)), far = Math.max(1500, d * 6 + 1200);
    if (Math.abs(c.near - near) / near > 0.05 || Math.abs(c.far - far) / far > 0.1) { c.near = near; c.far = far; c.updateProjectionMatrix(); }
  }

  // ---------- помощники ----------
  mat(color, o = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.88, ...o }); }
  add(group, geo, mat, pos, opts = {}) {
    const m = new THREE.Mesh(geo, mat); if (pos) m.position.copy(pos);
    m.castShadow = opts.cast ?? true; m.receiveShadow = true; Object.assign(m.userData, opts.data || {});
    this.groups[group].add(m); return m;
  }
  /** Плоская фигура на высоте y. lay — высота слоя над полом своего этажа (для смещения глубины). */
  flat(points, mat, y, group, hole, lay = y, order = 0) {
    const sh = new THREE.Shape(points.map((p) => new THREE.Vector2(p[0] - C.x, p[1] - C.y)));
    if (hole) sh.holes.push(new THREE.Path([...hole].reverse().map((p) => new THREE.Vector2(p[0] - C.x, p[1] - C.y))));
    const g = new THREE.ShapeGeometry(sh, 2); g.rotateX(PI / 2);
    mat.side = THREE.DoubleSide;
    // слои пола лежат в сантиметрах друг над другом: каждый получает свой уровень смещения глубины (order),
    // поэтому перекрывающиеся зоны всегда рисуются в одном порядке — меньшая поверх большей
    if (lay < 1) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -(2 + Math.round(lay * 60) + order * 3) });
    const m = new THREE.Mesh(g, mat); m.position.y = y; m.receiveShadow = true; m.renderOrder = order; this.groups[group].add(m); return m;
  }
  beam(group, a, b, r, mat) {
    const d = new THREE.Vector3().subVectors(b, a), L = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 6), mat);
    m.position.copy(a).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    m.castShadow = true; this.groups[group].add(m); return m;
  }
  /** Лента вокруг чаши: от отступа off0 на высоте y0 до off1 на y1. zig — гранёный фасад. */
  ribbon(group, off0, y0, off1, y1, mat, zig = 0, n = 224) {
    const pos = [];
    for (let i = 0; i < n; i++) {
      const t0 = (2 * PI * i) / n, t1 = (2 * PI * (i + 1)) / n;
      const z0 = i % 2 ? zig : 0, z1 = (i + 1) % 2 ? zig : 0;
      const a = sp(t0, off0), b = sp(t1, off0), c = sp(t1, off1 + z1), d = sp(t0, off1 + z0);
      const A = [a[0] - C.x, y0, a[1] - C.y], B = [b[0] - C.x, y0, b[1] - C.y], Cc = [c[0] - C.x, y1, c[1] - C.y], Dd = [d[0] - C.x, y1, d[1] - C.y];
      pos.push(...A, ...B, ...Cc, ...A, ...Cc, ...Dd);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; this.groups[group].add(m); return m;
  }

  // ---------- подписи и значки постоянного экранного размера ----------
  canvasSprite(draw, w, h, pxHeight, opts = {}) {
    const c = document.createElement('canvas'), dpr = 2; c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr); draw(g, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, sizeAttenuation: false, depthTest: opts.depthTest ?? true, fog: false }));
    s.center.set(opts.cx ?? 0.5, opts.cy ?? 0.5); s.renderOrder = opts.order ?? 10;
    s.userData.px = pxHeight; s.userData.aspect = w / h; this.screenSprites.push(s); this.sizeSprite(s);
    return s;
  }
  /** Спрайт без перспективы: его высота в пикселях = px при любом зуме и угле обзора камеры. */
  sizeSprite(s) { const h = (2 * s.userData.px * Math.tan((this.camera.fov * PI) / 360)) / Math.max(1, this.el.clientHeight); s.scale.set(h * s.userData.aspect, h, 1); }
  resizeSprites() { for (const s of this.screenSprites) this.sizeSprite(s); }
  label(text, { px = 13, bg = 'rgba(255,255,255,.94)', fg = '#17181a', weight = 600, maxDist = 400 } = {}) {
    const font = `${weight} 26px "PT Sans", "Segoe UI", Roboto, sans-serif`;
    const g0 = document.createElement('canvas').getContext('2d'); g0.font = font;
    const w = Math.ceil(g0.measureText(text).width / 2) + 18, h = 22;
    const s = this.canvasSprite((g) => {
      g.font = font.replace('26px', '13px'); g.fillStyle = bg; roundRect(g, 0, 0, w, h, 7); g.fill();
      g.fillStyle = fg; g.textBaseline = 'middle'; g.fillText(text, 9, h / 2 + 0.5);
    }, w, h, px * 1.65);
    s.userData.maxDist = maxDist; this.culled.push(s); return s;
  }

  // ---------- сборка карты ----------
  setMap(map) {
    this.map = map;
    // значки и шрифт рисуются на холсте — когда они догрузятся, пересобираем один раз
    if (!this.assetsReady) { this.assetsReady = true; Promise.all([iconsReady, document.fonts?.ready]).then(() => this.map && this.setMap(this.map)); }
    // центр сцены — середина стадиона «Ростов Арены» или рамка объекта, собранного с нуля
    const b = mapBox(map);
    if (map.stadium) { C.x = 400; C.y = 262; this.span = 1; }
    else { C.x = b.x + b.w / 2; C.y = b.y + b.h / 2; this.span = Math.max(0.3, Math.max(b.w, b.h) / 520); }
    this.half = { x: Math.max(480, b.w * 0.6), z: Math.max(340, b.h * 0.6) };
    // карта теней — по размеру объекта: на небольшом здании тени резче и без полос
    const sh = this.sun.shadow.camera, ext = map.stadium ? 440 : Math.max(60, Math.max(b.w, b.h) * 0.6 + 30);
    Object.assign(sh, { left: -ext, right: ext, top: ext, bottom: -ext }); sh.updateProjectionMatrix();
    this.sun.position.set(-260 * (ext / 440), 420, 300 * (ext / 440)); this.sun.target.position.set(0, 0, 0);
    this.theme();
    for (const k of ['world', 'stadium', 'roof', 'labels', 'pois', 'panos', 'quest']) clear(this.groups[k]);
    this.screenSprites = this.screenSprites.filter((s) => this.groups.arrows.getObjectById(s.id) || this.groups.route.getObjectById(s.id));
    this.culled = [];
    const on = this.on, ground = floorsSorted(map)[0].id;
    // срез по этажу: выше выбранного ничего не строим — так видно, что внутри
    const top = this.topFloor ? floorById(map, this.topFloor).elev : Infinity;
    this.z0 = (o) => elevOf(map, o);
    this.vis = (o) => this.z0(o) <= top + 0.01;
    this.buildGround(); this.buildShapes(); if (map.stadium && on('stadium') && this.vis({ floor: ground })) this.buildStadium(); if (on('pois')) this.buildPois(); if (on('panos')) this.buildPanos();
    this.buildQuest(); this.syncMarkers();
    if (this.route) this.setRoute(this.route);
    this.groups.roof.visible = this.roof; this.dirty = true;
  }

  buildGround() {
    const m = this.map;
    const ground = this.add('world', new THREE.PlaneGeometry(4000, 4000), this.mat(this.dark ? '#22252a' : '#b5b0a6'), W(C.x, C.y, -0.05), { cast: false });
    ground.rotation.x = -PI / 2;
    const site = m.shapes.find((s) => s.cat === 'plaza');
    if (site) this.flat(shapePoints(site), this.mat(this.dark ? '#2b2e33' : '#d9d5cd'), 0, 'world').userData.ref = site.id;
    if (!m.stadium) return;
    // площадь вокруг стадиона и газоны, как на аэрофото
    this.flat(ring(118, 120), this.mat(this.dark ? '#33363b' : '#e7e4de'), 0.02, 'world');
    for (const k of [0, 1, 2, 3]) {
      const t = (k * PI) / 2 + PI / 4, pts = [];
      for (let i = -6; i <= 6; i++) pts.push(sp(t + i * 0.045, 96));
      for (let i = 6; i >= -6; i--) pts.push(sp(t + i * 0.045, 114));
      this.flat(pts, this.mat('#4f7f45'), 0.05, 'world');
    }
  }

  buildShapes() {
    const m = this.map, white = this.mat('#ffffff'), ref = (id) => ({ data: { ref: id } }), on = this.on;
    const shapes = [...m.shapes].filter((s) => s.cat !== 'plaza' && on(shapeLayer(s)) && this.vis(s)).sort((a, b) => shapeBox(b).w * shapeBox(b).h - shapeBox(a).w * shapeBox(a).h);
    const shown = new Set(shapes.map((s) => s.id)), freeWall = new Set(m.walls.map((w) => w.id));
    // фигуры отсортированы от большой к маленькой: каждая следующая лежит на 1 см выше и с большим смещением глубины
    let layer = 0;
    for (const s of shapes) {
      const k = kindOf(s), col = new THREE.Color(s.color || catColor(m, s.cat)), z0 = this.z0(s), li = ++layer, dz = Math.min(li, 40) * 0.01;
      if (!k.walls) {
        let base = new THREE.Color(this.dark ? '#2b2e33' : '#d9d5cd').lerp(col, s.cat === 'leisure' || s.cat === 'expo' ? 0.35 : 0.6);
        if (s.cat === 'parking' && !s.color) base = new THREE.Color('#5d6167');
        if (s.cat === 'sport' && !s.color) base = new THREE.Color('#3f8f46');
        if (s.cat === 'ice' && !s.color) base = new THREE.Color('#e3f1ff');
        const lay = 0.04 + dz;
        const z = this.flat(shapePoints(s), this.mat(base), z0 + lay, 'world', null, lay, li);
        z.userData.ref = s.id;
        this.decorate(s, col, white, z0 + dz);   // разметка и макеты — над своим слоем пола
      } else {
        const floor = this.flat(shapePoints(s), this.mat(this.dark ? '#3a3d42' : '#efede8'), z0 + 0.04 + dz, 'world', null, 0.04 + dz, li); floor.userData.ref = s.id;
        if (k.roof) {
          // крыша на 3 см выше верха стен: раньше она лежала ровно в плоскости их торцов и мерцала по периметру
          const roof = this.flat(shapePoints(s), this.mat(this.dark ? '#565a60' : '#e9ebee', { roughness: 0.6 }), z0 + (s.height || k.height) + 0.03, 'world', null, 9);
          roof.userData.ref = s.id; roof.userData.roofOf = s.id; roof.castShadow = true;
        }
      }
      // названия зон не висят над моделью — всплывают подсказкой при наведении (hoverTip)
    }
    // Стены. Раньше: у соседних помещений общая стена приходила дважды (и частично совпадала), а боксы удлинялись на
    // толщину стены — в углах и на общих участках получались совпадающие грани, которые мерцали (маскировалось
    // чередованием polygonOffset). Теперь: отрезки на одной прямой сливаются в один (mergeWalls), бокс — ровно
    // длины отрезка, а стыки закрывает восьмигранный столбик — у него нет граней в плоскости стен.
    const mats = {}, wmat = (c) => (mats[c || ''] ||= this.mat(c || (this.dark ? '#5d6066' : '#f2f1ee')));
    const posts = new Map();
    for (const seg of mergeWalls(wallSegments(m).filter((sg) => (freeWall.has(sg.owner) ? on('walls') && this.vis(sg) : shown.has(sg.owner))))) {
      const dx = seg.b[0] - seg.a[0], dz = seg.b[1] - seg.a[1], L = Math.hypot(dx, dz); if (L < 0.05) continue;
      const z0 = this.z0(seg), w = this.add('world', new THREE.BoxGeometry(L, seg.h, seg.t), wmat(seg.color), W((seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, z0 + seg.h / 2), ref(seg.owner));
      w.rotation.y = Math.atan2(-dz, dx);
      for (const p of [seg.a, seg.b]) {
        const k = `${seg.floor}|${Math.round(p[0] * 50)}|${Math.round(p[1] * 50)}`, o = posts.get(k);
        if (!o || o.t < seg.t || o.h < seg.h) posts.set(k, { p, t: Math.max(seg.t, o?.t || 0), h: Math.max(seg.h, o?.h || 0), z0, color: seg.color, owner: seg.owner });
      }
    }
    for (const o of posts.values()) {
      // радиус чуть больше половины толщины: столбик закрывает щель в углу, его грани не совпадают с гранями стен
      this.add('world', new THREE.CylinderGeometry(o.t * 0.56, o.t * 0.56, o.h, 8), wmat(o.color), W(o.p[0], o.p[1], o.z0 + o.h / 2), ref(o.owner));
    }
    for (const st of on('stairs') ? m.stairs.filter(this.vis) : []) {
      const z0 = this.z0(st), n = Math.max(3, Math.round((st.dir === 'x' ? st.w : st.h) / 0.5)), rise = (st.rise || 3) / n;
      for (let i = 0; i < n; i++) {
        const along = st.dir === 'x' ? st.w : st.h, u = (along * (i + 0.5)) / n;
        const geo = st.dir === 'x' ? new THREE.BoxGeometry(along / n, rise * (i + 1), st.h) : new THREE.BoxGeometry(st.w, rise * (i + 1), along / n);
        const pos = st.dir === 'x' ? W(st.x + u, st.y + st.h / 2, z0 + (rise * (i + 1)) / 2) : W(st.x + st.w / 2, st.y + u, z0 + (rise * (i + 1)) / 2);
        this.add('world', geo, this.mat('#cfccc6'), pos, ref(st.id));
      }
    }
  }

  decorate(s, col, white, z0 = 0) {
    if (s.type !== 'rect') return;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2, add = (geo, mat, pos) => { pos.y += z0; return this.add('world', geo, mat, pos, { data: { ref: s.id } }); };
    if (s.cat === 'sport') for (const [w, d, x, y] of [[s.w, 0.3, cx, s.y + 0.6], [s.w, 0.3, cx, s.y + s.h - 0.6], [0.3, s.h, s.x + 0.6, cy], [0.3, s.h, s.x + s.w - 0.6, cy], [s.w - 1.2, 0.3, cx, cy]]) add(new THREE.BoxGeometry(w, 0.04, d), white, W(x, y, 0.2));
    if (s.cat === 'ice') for (const [w, d, x, y] of [[s.w, 0.3, cx, s.y], [s.w, 0.3, cx, s.y + s.h], [0.3, s.h, s.x, cy], [0.3, s.h, s.x + s.w, cy]]) add(new THREE.BoxGeometry(w, 1.1, d), white, W(x, y, 0.55));
    if (s.cat === 'parking') {
      const cols = Math.floor(s.w / 2.7), rows = Math.floor(s.h / 15), cars = [];
      for (let r = 0; r < rows; r++) for (let i = 0; i < cols; i++) if ((i * 7 + r * 13) % 10 < 6) cars.push([s.x + 1.4 + i * 2.7, s.y + 7 + r * 15]);
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 1.45, 4.4), this.mat('#ffffff', { roughness: 0.4, metalness: 0.2 }), cars.length);
      const palette = ['#9aa3ad', '#e4e6e8', '#2f353c', '#a33a3a', '#3b5b8c'].map((h) => new THREE.Color(h)), mx = new THREE.Matrix4();
      cars.forEach(([x, y], i) => { mx.makeTranslation(x - C.x, z0 + 0.9, y - C.y); inst.setMatrixAt(i, mx); inst.setColorAt(i, palette[i % palette.length]); });
      inst.castShadow = true; inst.userData.ref = s.id; this.groups.world.add(inst);
    }
    if (s.cat === 'stage') { add(new THREE.BoxGeometry(s.w, 1.5, s.h), this.mat(col), W(cx, cy, 0.75)); add(new THREE.BoxGeometry(0.6, 9, s.h * 0.8), this.mat('#1d2027', { emissive: '#23345e', emissiveIntensity: 0.7 }), W(s.x + s.w - 0.5, cy, 6)); }
    if (s.cat === 'entrance') {
      const al = s.w >= s.h, m = this.mat(col);
      for (const k of [-1, 1]) add(new THREE.BoxGeometry(0.8, 4.5, 0.8), m, W(cx + (al ? (k * s.w) / 2.3 : 0), cy + (al ? 0 : (k * s.h) / 2.3), 2.25));
      add(new THREE.BoxGeometry(al ? s.w * 0.92 : 1, 0.8, al ? 1 : s.h * 0.92), m, W(cx, cy, 4.8));
    }
    if (s.cat === 'service' || s.cat === 'food') add(new THREE.BoxGeometry(s.w * 0.9, 3, s.h * 0.7), this.mat(col), W(cx, cy, 1.5));
  }

  // ---------- стадион по фотографиям ----------
  buildStadium() {
    const m = this.map, real = m.style.realSeats !== false;
    const concrete = this.mat('#d7d5d0'), podium = this.mat('#eeede9'), glass = this.mat('#2a3038', { roughness: 0.25, metalness: 0.5 });
    // подиум с остеклением и четыре парадные лестницы
    this.flat(ring(88), podium.clone(), 6, 'stadium', ring(66));
    this.ribbon('stadium', 88, 0, 88, 6, podium.clone());
    this.ribbon('stadium', 88.2, 0.9, 88.2, 4.9, glass);
    for (let i = 0; i < 4; i++) {
      const t = (i * PI) / 2, n = 12;
      for (let k = 0; k < n; k++) {
        const off = 88 + (n - k) * 1.1, [x, y] = sp(t, off), step = this.add('stadium', new THREE.BoxGeometry(14, (6 * (k + 1)) / n, 1.1), podium, W(x, y, (3 * (k + 1)) / n));
        step.rotation.y = -Math.atan2(y - ST.cy, x - ST.cx) + PI / 2;
      }
    }
    // поле, бровка, рекламные борта
    this.flat(ring(7), this.mat('#2f6f37'), 0.12, 'stadium');
    const pg = new THREE.PlaneGeometry(68, 105); pg.rotateX(-PI / 2);
    const pitch = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ map: pitchTexture(), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -14 })); pitch.position.copy(W(ST.cx, ST.cy, 0.16)); pitch.receiveShadow = true; this.groups.stadium.add(pitch);
    this.ribbon('stadium', 3.2, 0.1, 3.2, 1.0, this.mat('#1c3f8f', { emissive: '#1c3f8f', emissiveIntensity: 0.25 }), 0, 120);
    // трибуны
    for (const s of SECTORS) this.groups.stadium.add(this.sectorMesh(s, real));
    this.ribbon('stadium', 7, 0, 7, 0.8, concrete.clone());
    this.ribbon('stadium', 33.2, 11.8, 33.2, 15, glass.clone());                          // пояс лож
    this.ribbon('stadium', 33.2, 11.8, 34.6, 11.9, this.mat('#c43a2f'));                   // красные кресла лож
    this.ribbon('stadium', 68, 0, 68, 31, concrete.clone());
    // гранёный фасад: серые треугольные панели над подиумом
    const fac = this.ribbon('stadium', 70, 6, 73.5, 31, this.mat('#bfc5cb', { roughness: 0.45, metalness: 0.35, flatShading: true }), 1.6, 112);
    fac.userData.facade = true;
    this.ribbon('stadium', 73.5, 31, 74, 32.2, this.mat('#f4f4f2'));
    // табло по углам под крышей
    for (const t of [PI / 4 + 0.02, (5 * PI) / 4 + 0.02]) {
      const [x, y] = sp(t, 26), scr = this.add('stadium', new THREE.BoxGeometry(14, 6, 0.8), this.mat('#101418', { emissive: '#1a3a7a', emissiveIntensity: 0.9 }), W(x, y, 24));
      scr.lookAt(W(ST.cx, ST.cy, 18));
    }
    // мембранная крыша с проёмом над полем
    const N = 168, R = 6, pos = [], idx = [];
    for (let r = 0; r <= R; r++) {
      const u = r / R, off = 74 - u * 61;
      for (let i = 0; i < N; i++) {
        const [x, y] = sp((2 * PI * i) / N, off), bulge = 0.9 * Math.sin((PI * (i % 6)) / 6) * Math.sin(PI * Math.min(1, u * 1.15));
        pos.push(x - C.x, 32 + u * 3.6 + bulge, y - C.y);
      }
    }
    for (let r = 0; r < R; r++) for (let i = 0; i < N; i++) { const a = r * N + i, b = r * N + ((i + 1) % N), c = (r + 1) * N + ((i + 1) % N), d = (r + 1) * N + i; idx.push(a, b, c, a, c, d); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setIndex(idx); rg.computeVertexNormals();
    const roof = new THREE.Mesh(rg, this.mat('#fbfbf9', { roughness: 0.55, side: THREE.DoubleSide })); roof.castShadow = true; roof.receiveShadow = true; this.groups.roof.add(roof);
    this.ribbon('roof', 13, 35.4, 13, 34.2, this.mat('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.6 }));
    // треугольные мачты по кромке крыши и тросы
    const mastMat = this.mat('#ffffff', { roughness: 0.4 }), cables = [];
    for (let i = 0; i < 28; i++) {
      const t = (2 * PI * (i + 0.5)) / 28, [bx, by] = sp(t, 73.5), [ax, ay] = sp(t, 77), [ix, iy] = sp(t, 60);
      const tx = -Math.sin(t) * 2.2, ty = Math.cos(t) * 2.2;
      const apex = W(ax, ay, 47), b1 = W(bx + tx, by + ty, 32), b2 = W(bx - tx, by - ty, 32), b3 = W(ix, iy, 34.6);
      this.beam('roof', b1, apex, 0.35, mastMat); this.beam('roof', b2, apex, 0.35, mastMat); this.beam('roof', b3, apex, 0.25, mastMat);
      const [cx, cy] = sp(t, 22); cables.push(apex, W(cx, cy, 34.8));
    }
    const lg = new THREE.BufferGeometry().setFromPoints(cables);
    this.groups.roof.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xc9cdd2 })));
    // подписи трибун и секторов
    if (!this.on('labels')) return;
    for (const k of ['A', 'B', 'C', 'D']) {
      const [a, b] = RANGES[k], [x, y] = sp((a + b) / 2, 50), l = this.label(`${STANDS[k].short} · ${k}`, { px: 13, bg: standColor(m, k), fg: '#fff', maxDist: 900 });
      l.position.copy(W(x, y, 40)); l.userData.ref = 'sec:' + SECTORS.find((s) => s.stand === k && s.tier === 'lower').id; this.groups.labels.add(l);
    }
    for (const s of SECTORS) { const md = secMid(s), l = this.label(s.id, { px: 11, bg: 'rgba(23,24,26,.82)', fg: '#fff', maxDist: 190 }); l.position.copy(W(md.xy[0], md.xy[1], md.z + 2)); l.userData.ref = 'sec:' + s.id; this.groups.labels.add(l); }
  }

  sectorMesh(s, real) {
    const T = TIERS[s.tier], m = 6, pos = [], col = [], idx = [];
    const way = new THREE.Color(sectorColor(this.map, s)), blue = new THREE.Color('#1f4aa6'), blue2 = new THREE.Color('#1a3f90'), yellow = new THREE.Color('#f1c21b'), riser = new THREE.Color('#d9d6d0');
    const custom = !!this.map.sectors[s.id]?.color;
    const P = (t, o, z) => { const [x, y] = sp(t, o); return [x - C.x, z, y - C.y]; };
    const quad = (a, b, c, d, cl) => { const n = pos.length / 3; for (const p of [a, b, c, d]) { pos.push(...p); col.push(cl.r, cl.g, cl.b); } idx.push(n, n + 1, n + 2, n, n + 2, n + 3); };
    for (let r = 0; r < T.rows; r++) {
      const o0 = T.o0 + ((T.o1 - T.o0) * r) / T.rows, o1 = T.o0 + ((T.o1 - T.o0) * (r + 1)) / T.rows, z = T.z0 + T.dz * r, z1 = z + T.dz;
      for (let i = 0; i < m; i++) {
        const ta = s.t0 + ((s.t1 - s.t0) * i) / m, tb = s.t0 + ((s.t1 - s.t0) * (i + 1)) / m;
        let cl;
        if (real && !custom) cl = (i + r * 2 + s.index * 3) % 13 === 0 || (s.tier === 'upper' && r === T.rows - 1) ? yellow : r % 2 ? blue2 : blue;
        else cl = way.clone().multiplyScalar(r % 2 ? 0.88 : 1);
        quad(P(ta, o0, z), P(tb, o0, z), P(tb, o1, z), P(ta, o1, z), cl);
        quad(P(ta, o1, z), P(tb, o1, z), P(tb, o1, z1), P(ta, o1, z1), real && !custom ? riser : cl.clone().multiplyScalar(0.62));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
    mesh.castShadow = mesh.receiveShadow = true; mesh.userData.ref = 'sec:' + s.id; return mesh;
  }

  // метки: булавка со значком ТТК на белом круге; названия на карте не пишем — они всплывают при наведении
  /**
   * Высота, на которую ставить маркер в точке плана: верх стойки, сцены или макета, если маркер стоит на них,
   * иначе пол своего этажа. Крыши и стены выше 6 м над полом не считаем — иначе маркер «повиснет» над зданием.
   */
  anchorY(x, y, floorY) {
    this.scene.updateMatrixWorld();
    const ray = (this._anchorRay ||= new THREE.Raycaster()), from = W(x, y, floorY + 6);
    ray.set(from, new THREE.Vector3(0, -1, 0)); ray.far = 6.2;
    const hit = ray.intersectObjects([this.groups.world, this.groups.stadium], true).find((h) => !h.object.userData.roofOf && h.object.visible !== false);
    return Math.max(floorY, hit ? hit.point.y : floorY);
  }
  buildPois() {
    for (const p of this.map.pois.filter((q) => q.cat !== 'quest' && this.vis(q))) {
      const pz = this.z0(p) + (p.z || 0), c = poiColor(this.map, p), g = (PCATS[p.cat] || PCATS.info).g, img = pointIconImage(p, p.cat, () => this.map && this.setMap(this.map)), red = css('--accent') || '#e30613';
      // выбранная метка — чуть больше, обводка заменена зелёным неоновым свечением (поле P под свечение)
      const sel = p.id === this.selId, P = sel ? 9 : 0, k = sel ? 1.22 : 1;
      const pin = this.canvasSprite((x, w, h) => {
        x.translate(P, P); w -= 2 * P; h -= 2 * P;
        x.fillStyle = 'rgba(0,0,0,.25)'; x.beginPath(); x.ellipse(w / 2, h - 2, 6, 2.2, 0, 0, 2 * PI); x.fill();
        x.fillStyle = sel ? NEON : img ? red : c; x.beginPath(); x.moveTo(w / 2 - 6, 26); x.lineTo(w / 2, h - 3); x.lineTo(w / 2 + 6, 26); x.fill();
        if (sel) neonRing(x, w / 2, 16, 13.5);
        x.fillStyle = img ? '#fff' : c; x.strokeStyle = sel ? NEON : img ? red : '#fff'; x.lineWidth = 2.5; x.beginPath(); x.arc(w / 2, 16, 13.5, 0, 2 * PI); x.fill(); x.stroke();
        if (img) x.drawImage(img, w / 2 - 9.5, 6.5, 19, 19);
        else { x.fillStyle = '#fff'; x.font = `700 ${g.length > 1 ? 10 : 13}px "PT Sans", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(g, w / 2, 16.5); }
      }, 34 + 2 * P, 46 + 2 * P, (33 * (46 + 2 * P) / 46) * k, { cy: P / (46 + 2 * P), order: sel ? 262 : 260, depthTest: false });
      // Раньше: 0,3 м над полом и проверка глубины — внутри стойки, сцены или комнаты с крышей маркер пропадал.
      // Теперь: остриё на верхней грани того, что стоит в этой точке, и маркер рисуется поверх модели и фото 360°
      // (renderOrder 260 > сфера 50 и стрелки 200–202); ближние маркеры перекрывают дальние (сортировка по глубине).
      pin.position.copy(W(p.x, p.y, this.anchorY(p.x, p.y, pz) + 0.05)); pin.userData.ref = p.id; pin.userData.tip = p.name; this.groups.pois.add(pin);
    }
  }
  /** Выделить точку (метку или точку обзора) на 3D-карте; null — снять выделение. */
  setSelected(id) {
    if ((id || null) === (this.selId || null)) return;
    this.selId = id || null;
    if (!this.map) return;
    const old = new Set([...this.groups.pois.children, ...this.groups.panos.children]);
    this.screenSprites = this.screenSprites.filter((s) => !old.has(s)); this.culled = this.culled.filter((s) => !old.has(s));
    clear(this.groups.pois); clear(this.groups.panos);
    if (this.on('pois')) this.buildPois();
    if (this.on('panos')) this.buildPanos();
    this.syncMarkers();
  }
  // «Пиксельная охота»: пиксели ТТК видны только в панорамах, в радиусе 35 м (в конструкторе — всегда)
  buildQuest() {
    const items = this.map.pois.filter((p) => p.cat === 'quest' && this.vis(p) && !this.questFound?.has(p.id));
    if (!items.length) return;
    if (!this.questTex) {
      this.questTex = new THREE.TextureLoader().load(new URL('../../assets/icons/pixel.png', import.meta.url).href, () => (this.dirty = true));
      this.questTex.magFilter = THREE.NearestFilter; this.questTex.colorSpace = THREE.SRGBColorSpace;
    }
    for (const p of items) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.questTex, transparent: true, depthTest: false, fog: false }));
      s.scale.set(0.5, 0.5, 1); s.renderOrder = 205;
      s.position.copy(W(p.x, p.y, this.z0(p) + (Number.isFinite(p.z) ? p.z : 1.3)));
      s.userData.ref = p.id; s.userData.quest = true; s.userData.tip = 'Пиксель ТТК!';
      this.groups.quest.add(s);
    }
    this.syncQuest();
  }
  setQuestFound(ids) { this.questFound = new Set(ids); if (this.map) { clear(this.groups.quest); this.buildQuest(); } this.dirty = true; }
  /** Маркеры мест (туалет, еда и т. п.) видны в обзоре карты; в панораме их нет — они загромождали фото. */
  syncMarkers() {
    this.groups.pois.visible = !this.look;
    this.dirty = true;
  }
  syncQuest() {
    const L = this.look;
    this.groups.quest.visible = !!L || !!this.questAlways;
    for (const s of this.groups.quest.children) s.visible = !L || s.position.distanceTo(L.pos) < 35;
    this.dirty = true;
  }
  /** Снимок того, что сейчас на экране (JPEG data URL). Бросает ошибку, если холст «заражён» чужими картинками. */
  snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/jpeg', 0.92); }
  /** Загрузить фото с ограничением по времени; при ошибке — null, а неудачный адрес не остаётся в кэше (можно повторить). */
  async tryTex(url, ms = 25000) {
    let timer;
    const t = await Promise.race([this.loadTex(url), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]).catch(() => null);
    clearTimeout(timer);
    if (!t) this.texCache?.delete(url);
    return t;
  }

  buildPanos() {
    const red = css('--pano') || '#c4121c';
    for (const p of this.map.panos.filter(this.vis)) {
      const img = pointIconImage(p, 'pano', () => this.map && this.setMap(this.map));
      const sel = p.id === this.selId, P = sel ? 8 : 0;
      const s = this.canvasSprite((x, w, h) => {
        x.translate(P, P); w -= 2 * P; h -= 2 * P;
        if (sel) neonRing(x, w / 2, h / 2, w / 2 - 1.5);
        x.fillStyle = '#fff'; x.strokeStyle = sel ? NEON : red; x.lineWidth = 2; x.beginPath(); x.arc(w / 2, h / 2, w / 2 - 1.5, 0, 2 * PI); x.fill(); x.stroke();
        if (img) x.drawImage(img, 3.5, 3.5, w - 7, h - 7);
      }, 26 + 2 * P, 26 + 2 * P, (19 * (26 + 2 * P) / 26) * (sel ? 1.25 : 1), { order: sel ? 252 : 250, depthTest: false });
      s.userData.tip = p.name;
      s.position.copy(W(p.x, p.y, this.anchorY(p.x, p.y, this.z0(p) + (p.z || 0)) + 0.6)); s.userData.ref = p.id; s.userData.maxDist = 520; this.culled.push(s); this.groups.panos.add(s);
    }
  }

  setRoute(route) { this.dirty = true;
    this.route = route; clear(this.groups.route);
    if (!route) return;
    const path = new THREE.CurvePath(), v = route.pts.map(([x, y, z]) => W(x, y, (z || 0) + 0.6));
    for (let i = 1; i < v.length; i++) path.add(new THREE.LineCurve3(v[i - 1], v[i]));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(64, v.length * 24), 0.9, 8), new THREE.MeshBasicMaterial({ color: 0xe3242b }));
    this.groups.route.add(tube);
  }
  setRoof(on) { this.dirty = true; this.roof = on; this.groups.roof.visible = on && !this.look; }
  /** Показать этажи до этого включительно (null — все). */
  setFloorView(id) { this.topFloor = id || null; if (this.map) this.setMap(this.map); }
  /** Скрыть слои карты (ключи из LAYERS): сцена пересобирается без них, крыша просто прячется. */
  setHidden(hidden) {
    this.hidden = new Set(hidden);
    this.roof = !this.hidden.has('roof');
    if (this.map) this.setMap(this.map);
  }
  get on() { const h = this.hidden || new Set(); return (k) => !h.has(k); }

  // ---------- камера: обзор ----------
  overview(now) {
    // на узком (вертикальном) экране телефона отходим дальше, чтобы объект поместился по ширине
    const a = this.camera.aspect || 1, k = (this.span || 1) * (a < 1 ? Math.min(2.2, 0.85 / a) : 1);
    this.flyTo(W(C.x, C.y), new THREE.Vector3(-150 * k, 330 * k, 360 * k), now);
  }
  /** Точка плана (метры) под позицией камеры. */
  planOf(v) { return { x: v.x + C.x, y: v.z + C.y }; }
  stadiumView() { this.flyTo(W(ST.cx, ST.cy, 6), new THREE.Vector3(-150, 125, 170)); }
  focus(x, y, d = 70, h = 0) { this.flyTo(W(x, y, h), new THREE.Vector3(-0.55 * d, 0.85 * d, d)); }
  flyTo(target, offset, now) {
    if (this.look) this.exitLook(true);
    this.dirty = true;
    const p1 = target.clone().add(offset);
    if (now) { this.camera.position.copy(p1); this.controls.target.copy(target); this.controls.update(); return; }
    this.anim = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1, t1: target, s: performance.now(), dur: 900 };
  }
  /** Смотреть на точку (x, y, h) со стороны (fx, fy) — например, на сектор со стороны поля. */
  focusFrom(x, y, h, fx, fy, d = 120) {
    const dx = fx - x, dy = fy - y, L = Math.hypot(dx, dy) || 1;
    this.flyTo(W(x, y, h), new THREE.Vector3((dx / L) * d, d * 0.55, (dy / L) * d));
  }
  northUp() { const t = this.controls.target, d = this.camera.position.distanceTo(t); this.flyTo(t.clone(), new THREE.Vector3(0, d * 0.75, d * 0.66)); }

  // ---------- камера: взгляд из точки ----------
  enterLook(x, y, z, face, opts = {}) {
    this.anim = null; this.controls.enabled = false;
    const yaw = Number.isFinite(opts.yaw) ? opts.yaw : face ? Math.atan2(face.y - y, face.x - x) : this.look?.yaw ?? 0;
    this.look = { pos: W(x, y, z), yaw, pitch: opts.pitch ?? -0.05, fov: Math.max(32, Math.min(90, opts.fov || 72)), plan: { x, y }, kind: opts.kind || 'pano' };
    this.camera.near = NEAR_LOOK; this.camera.far = 3000; this.camera.updateProjectionMatrix();
    this.groups.panos.visible = false; this.groups.route.visible = false; this.groups.roof.visible = this.roof;
    this.applyLook(); this.syncQuest(); this.syncMarkers();
  }
  exitLook(silent) {
    if (!this.look) return;
    const { plan } = this.look; this.look = null; this.anim = null; this.gliding = false; this.setPhoto(null); clear(this.groups.arrows);
    this.controls.enabled = true; this.groups.panos.visible = true; this.groups.route.visible = true; this.groups.roof.visible = this.roof;
    this.camera.fov = 45; this.camera.near = NEAR_ORBIT; this.camera.updateProjectionMatrix(); this.resizeSprites(); this.dirty = true; this.syncQuest(); this.syncMarkers();
    if (!silent) { const t = W(plan.x, plan.y); this.camera.position.copy(t.clone().add(new THREE.Vector3(-40, 60, 60))); this.controls.target.copy(t); this.focus(plan.x, plan.y, 60); }
  }
  applyLook() {
    const L = this.look, cp = Math.cos(L.pitch);
    this.camera.position.copy(L.pos);
    this.camera.lookAt(L.pos.clone().add(new THREE.Vector3(Math.cos(L.yaw) * cp, Math.sin(L.pitch), Math.sin(L.yaw) * cp)));
    if (this.camera.fov !== L.fov) { this.camera.fov = L.fov; this.camera.updateProjectionMatrix(); this.resizeSprites(); }
    this.dirty = true; this.onLook?.(L);
  }
  /**
   * Плавный переход взгляда в другую точку. next = { url, rot } — фото следующей точки.
   * Между двумя фото 3D-модель не показываем: сначала дожидаемся загрузки следующего фото,
   * потом камера едет, а старое фото растворяется в новом.
   */
  async glideTo(x, y, z, done, next = {}) {
    const L = this.look; if (!L || this.gliding) return;
    this.gliding = true;
    const nextTex = next.url ? await this.loadTex(next.url).catch(() => null) : null;
    if (!this.look) { this.gliding = false; return; }
    const from = L.pos.clone(), to = W(x, y, z), d = from.distanceTo(to);
    const both = !!(this.sphere && nextTex), dur = both ? Math.max(700, Math.min(1500, 500 + d * 6)) : Math.max(900, Math.min(2600, 650 + d * 9));
    const old = this.sphere; this.sphere = null; this.fading = old;
    if (nextTex) {
      this.sphere = this.makeSphere(nextTex, next.rot, to); this.sphere.material.opacity = 0;
      if (!old) this.setWorldVisible(true);   // из вида-3D в фото — модель видна, пока фото проявляется
    } else this.setWorldVisible(true);
    this.anim = { look: true, from, to, s: performance.now(), dur, fov: L.fov, both, done: () => { L.plan = { x, y }; this.gliding = false; if (this.sphere) this.setWorldVisible(false); this.syncQuest(); this.syncMarkers(); done?.(); } };
  }
  setWorldVisible(on) { for (const k of ['world', 'stadium', 'labels']) this.groups[k].visible = on; this.groups.roof.visible = on && this.roof; this.dirty = true; }

  // ---------- фото 360°: загрузка с кэшем и сфера вокруг камеры ----------
  /**
   * Фото 360° 4096×2048 — 32 МБ видеопамяти каждое. Раньше: кэш на 10 фото с mipmap-уровнями (~450 МБ — на телефоне
   * WebGL терял контекст), а вытесненное фото сразу удалялось — даже то, что сейчас на сфере (чёрный кадр).
   * Теперь: без mipmap (панораме они не нужны), фото сразу передаётся в видеокарту (без подвисания при первом показе),
   * в кэше 4 фото на телефоне и 8 на компьютере, а показываемые сейчас и только что запрошенные не вытесняются.
   */
  loadTex(url) {
    this.texCache ||= new Map();
    if (this.texCache.has(url)) { const p = this.texCache.get(url); this.texCache.delete(url); this.texCache.set(url, p); return p; }   // свежее — в конец очереди
    const p = new Promise((res, rej) => new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
      t.anisotropy = 1; t.userData.url = url;
      try { this.renderer.initTexture(t); } catch { /* загрузится при первом кадре */ }
      res(t);
    }, undefined, rej));
    this.texCache.set(url, p);
    this.trimTex();
    return p;
  }
  trimTex() {
    const limit = this.lite || matchMedia('(pointer: coarse)').matches ? 4 : 8;
    const inUse = new Set([this.sphere, this.fading].filter(Boolean).map((s) => s.material.map?.userData.url));
    for (const [k, v] of this.texCache) {
      if (this.texCache.size <= limit) break;
      if (inUse.has(k)) continue;
      this.texCache.delete(k);
      v.then((t) => { if (![this.sphere, this.fading].some((s) => s?.material.map === t)) t.dispose(); }).catch(() => {});
    }
  }
  /** Заранее подгрузить фото соседних точек — переход к ним начнётся без задержки. */
  preload(urls) { for (const u of urls.filter(Boolean).slice(0, this.lite || matchMedia('(pointer: coarse)').matches ? 2 : 4)) this.loadTex(u).catch(() => {}); }
  makeSphere(tex, rotDeg, pos) {
    // сфера большая: камера при переходе едет внутри обеих сфер, и фото не «рвётся»
    const g = new THREE.SphereGeometry(400, 64, 40); g.scale(-1, 1, 1);
    const s = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, fog: false, transparent: true, opacity: 1, depthWrite: false, depthTest: false }));
    // поверх модели (она под фото скрыта), но под стрелками переходов
    s.renderOrder = 50; s.position.copy(pos); s.rotation.y = ((rotDeg || 0) * PI) / 180; this.scene.add(s);
    return s;
  }
  dropSphere(s) { if (!s) return; this.scene.remove(s); s.geometry.dispose(); s.material.dispose(); }   // текстура остаётся в кэше
  /**
   * Стрелки переходов на полу. items — соседние точки; it.yaw — направление по фото (если админ поставил вручную),
   * it.next — следующая точка маршрута: её стрелка ярче и чуть крупнее, остальные приглушены.
   */
  setArrows(items) { this.dirty = true;
    clear(this.groups.arrows);
    if (!this.look) return;
    const shape = new THREE.Shape([[0, 0.62], [0.56, 0], [0.34, 0], [0, 0.36], [-0.34, 0], [-0.56, 0]].map(([a, b]) => new THREE.Vector2(a, b)));
    const { x, y } = this.look.plan, routeOn = items.some((it) => it.next), R = 2.6;
    for (const it of items) {
      const dx = it.x - x, dy = it.y - y, L = Math.hypot(dx, dy) || 1, g = new THREE.Group();
      const ux = Number.isFinite(it.yaw) ? Math.cos(it.yaw) : dx / L, uy = Number.isFinite(it.yaw) ? Math.sin(it.yaw) : dy / L;
      const dim = routeOn && !it.next, k = it.next ? 0.36 : 0.28;
      g.userData.to = it.id;
      const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-PI / 2);
      const arrow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: dim ? 0x8a8d93 : 0xe30613, side: THREE.DoubleSide, depthTest: false, fog: false, transparent: true, opacity: dim ? 0.7 : 1 }));
      arrow.scale.setScalar(k); arrow.rotation.y = Math.atan2(-ux, -uy); arrow.renderOrder = 201;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(k * 0.78, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: dim ? 0.55 : 0.85, depthTest: false, fog: false }));
      disc.rotation.x = -PI / 2; disc.position.y = -0.01; disc.renderOrder = 200;
      // стрелка маленькая, а нажимать на неё по-прежнему удобно — невидимый круг побольше
      const hit = new THREE.Mesh(new THREE.CircleGeometry(0.75, 24), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false })); hit.rotation.x = -PI / 2;
      g.add(hit, disc, arrow);
      // одно и то же расстояние по обеим осям — стрелка лежит точно в направлении перехода
      g.position.copy(this.look.pos.clone().add(new THREE.Vector3(ux * R, -this.look.pos.y + 0.2 + Math.max(0, this.look.pos.y - 1.6), uy * R)));
      const l = this.label(`${it.next ? 'Дальше: ' : ''}${it.name}`, { px: 9, bg: it.next ? 'rgba(227,6,19,.92)' : 'rgba(23,24,26,.78)', fg: '#fff', maxDist: 1e9 });
      l.material.depthTest = false; l.renderOrder = 202; l.position.set(0, 0.22, 0); g.add(l);
      this.groups.arrows.add(g);
    }
  }
  /** Показать фото 360° в текущей точке (rotDeg — поворот фото, чтобы оно совпало с планом и стрелками). */
  async setPhoto(url, rotDeg) {
    this.dirty = true; this.lastPhoto = url ? { url, rot: rotDeg } : null;
    this.dropSphere(this.sphere); this.sphere = null; this.dropSphere(this.fading); this.fading = null;
    if (!url || !this.look) { this.setWorldVisible(true); return true; }
    this.setWorldVisible(false);   // сразу прячем 3D, чтобы до загрузки фото не мелькала модель
    const token = (this.photoToken = (this.photoToken || 0) + 1);
    const tex = await this.loadTex(url).catch(() => null);
    if (token !== this.photoToken || !this.look) return false;
    if (!tex) { this.texCache?.delete(url); this.setWorldVisible(true); return false; }
    this.sphere = this.makeSphere(tex, rotDeg, this.look.pos); this.dirty = true; return true;
  }
  /** Повернуть фото текущей точки (настройка в конструкторе). */
  setPhotoRot(rotDeg) { if (this.sphere) { this.sphere.rotation.y = ((rotDeg || 0) * PI) / 180; this.dirty = true; } }

  // ---------- указатель ----------
  bindPointer() {
    const el = this.renderer.domElement, ptr = new Map();
    let g = null;
    el.addEventListener('pointerdown', (e) => {
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      g = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      if (this.look) {
        el.setPointerCapture(e.pointerId);
        if (ptr.size === 2) { const [a, b] = [...ptr.values()]; g.pinch = Math.hypot(a.x - b.x, a.y - b.y); g.fov = this.look.fov; }
        g.yaw = this.look.yaw; g.pitch = this.look.pitch;
      }
    });
    // наведение без нажатия: название метки или точки обзора — подсказкой у курсора (не чаще раза за кадр)
    let tipQ = null;
    el.addEventListener('pointerleave', () => hideTip());
    el.addEventListener('pointermove', (e) => {
      if (ptr.size || e.pointerType === 'touch') return;
      if (!tipQ) requestAnimationFrame(() => { const q = tipQ; tipQ = null; this.hoverTip(q.x, q.y); });
      tipQ = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointermove', (e) => {
      if (!ptr.has(e.pointerId) || !g) return;
      hideTip();
      const prev = ptr.get(e.pointerId); ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6) g.moved = true;
      if (!this.look || this.anim?.look) return;
      if (ptr.size === 2 && g.pinch) { const [a, b] = [...ptr.values()]; this.look.fov = Math.max(32, Math.min(90, (g.fov * g.pinch) / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)))); this.applyLook(); return; }
      const k = ((this.look.fov * PI) / 180) / el.clientHeight;
      this.look.yaw -= (e.clientX - prev.x) * k * 1.1; this.look.pitch = Math.max(-1.25, Math.min(1.25, this.look.pitch + (e.clientY - prev.y) * k));
      this.applyLook();
    });
    const up = (e) => {
      if (!ptr.has(e.pointerId)) return;
      ptr.delete(e.pointerId);
      if (g && !g.moved && ptr.size === 0 && performance.now() - g.t < 450) this.tap(e.clientX, e.clientY);
      if (ptr.size === 0) g = null;
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => { if (!this.look) return; e.preventDefault(); this.look.fov = Math.max(32, Math.min(90, this.look.fov * (e.deltaY > 0 ? 1.08 : 0.93))); this.applyLook(); }, { passive: false });
  }
  hoverTip(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(v, this.camera);
    const pools = (this.look ? [this.groups.quest, this.groups.pois] : [this.groups.pois, this.groups.panos]).filter((g) => g.visible);
    const hit = ray.intersectObjects(pools, true).find((h) => h.object.visible !== false && h.object.userData.tip);
    let tip = hit?.object.userData.tip;
    if (!tip && !this.look && this.groups.world.visible) {
      // зона или помещение под курсором: ближайший объект модели, у которого есть ссылка на фигуру карты
      let o = ray.intersectObjects([this.groups.world], true).find((h) => h.object.visible !== false)?.object;
      while (o && !o.userData.ref) o = o.parent;
      const s = o && this.map.shapes.find((x) => x.id === o.userData.ref && x.cat !== 'plaza');
      tip = s?.name;
    }
    if (tip) { showTip(tip, cx, cy); this.renderer.domElement.style.cursor = 'pointer'; }
    else { hideTip(); this.renderer.domElement.style.cursor = ''; }
  }
  tap(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(v, this.camera);
    const pools = this.look ? [this.groups.quest, this.groups.arrows, this.groups.pois] : [this.groups.quest, this.groups.pois, this.groups.panos, this.groups.labels];
    if (!this.sphere) pools.push(this.groups.stadium, this.groups.world);
    const hits = ray.intersectObjects(pools.filter((g) => g.visible), true).filter((h) => h.object.visible !== false && (h.object.isSprite ? h.object.parent?.visible !== false : true));
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.to && !o.userData.ref) o = o.parent;
      if (!o) continue;
      if (o.userData.to) return this.onPick?.({ type: 'arrow', id: o.userData.to });
      if (o.userData.roofOf && this.look) continue;
      return this.onPick?.({ type: 'ref', ref: o.userData.ref, point: { x: h.point.x + C.x, y: h.point.z + C.y } });
    }
    if (this.look) {
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -Math.max(0, this.look.pos.y - 1.6)), p)) this.onPick?.({ type: 'ground', point: { x: p.x + C.x, y: p.z + C.y } });
    }
  }

  // ---------- кадр ----------
  loop(now) {
    requestAnimationFrame(this.loop);
    if (!this.active || !this.map) return;
    const a = this.anim;
    if (a) {
      const k = Math.min(1, (now - a.s) / a.dur), e = ease(k);
      if (a.look) {
        // фото → фото: лёгкий «наезд» и перекрёстное растворение; иначе — старое фото быстро уходит в модель
        this.look.pos.lerpVectors(a.from, a.to, e); this.look.fov = a.fov - (a.both ? 4 : 7) * Math.sin(PI * k);
        if (this.fading) this.fading.material.opacity = a.both ? 1 - e : Math.max(0, 1 - k * 2.5);
        if (this.sphere && this.sphere.material.opacity < 1) this.sphere.material.opacity = a.both ? e : Math.min(1, Math.max(0, (k - 0.6) / 0.4));
        this.applyLook();
      } else { this.camera.position.lerpVectors(a.p0, a.p1, e); this.controls.target.lerpVectors(a.t0, a.t1, e); this.camera.lookAt(this.controls.target); }
      if (k >= 1) {
        this.anim = null;
        this.dropSphere(this.fading); this.fading = null;
        if (this.sphere) this.sphere.material.opacity = 1;
        if (a.look) { this.look.fov = a.fov; this.applyLook(); }
        a.done?.();
      }
    } else if (!this.look) {
      this.controls.update();
      const t = this.controls.target, H = this.half || { x: 480, z: 340 }; t.x = Math.max(-H.x, Math.min(H.x, t.x)); t.z = Math.max(-H.z, Math.min(H.z, t.z)); t.y = 0;
    }
    if (a) this.dirty = true;
    if (!this.dirty || this.lost) return;  // рисуем только когда что-то изменилось — бережём батарею
    this.dirty = false;
    if (!this.look) this.fitDepth();
    const cam = this.camera.position;
    for (const s of this.culled) s.visible = cam.distanceTo(s.getWorldPosition(tmpV)) < (s.userData.maxDist || 1e9);
    this.renderer.render(this.scene, this.camera);
  }
}

const tmpV = new THREE.Vector3();
function clear(g) {
  while (g.children.length) {
    const o = g.children.pop();
    o.traverse((n) => { n.geometry?.dispose(); if (n.material) { n.material.map?.dispose(); n.material.dispose(); } });
  }
}
const NEON = '#39ff14';
/** Зелёное неоновое свечение вокруг значка выбранной точки (рисуется под самим значком). */
function neonRing(g, x, y, r) {
  g.save(); g.strokeStyle = NEON; g.shadowColor = NEON; g.lineWidth = 3;
  for (const b of [10, 6, 3]) { g.shadowBlur = b; g.beginPath(); g.arc(x, y, r + 1, 0, 2 * PI); g.stroke(); }
  g.restore();
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function pitchTexture() {
  const c = document.createElement('canvas'); c.width = 680; c.height = 1050; const g = c.getContext('2d');
  for (let i = 0; i < 14; i++) { g.fillStyle = i % 2 ? '#3d8f45' : '#47a04f'; g.fillRect(0, i * 75, 680, 75); }
  g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 4;
  g.strokeRect(2, 2, 676, 1046); g.beginPath(); g.moveTo(0, 525); g.lineTo(680, 525); g.stroke(); g.beginPath(); g.arc(340, 525, 91.5, 0, 2 * PI); g.stroke();
  g.strokeRect(138.5, 2, 403, 165); g.strokeRect(138.5, 883, 403, 165); g.strokeRect(248.5, 2, 183, 55); g.strokeRect(248.5, 993, 183, 55);
  g.fillStyle = '#fff'; for (const y of [110, 525, 940]) { g.beginPath(); g.arc(340, y, 4, 0, 2 * PI); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export { CATS, neighbors };
