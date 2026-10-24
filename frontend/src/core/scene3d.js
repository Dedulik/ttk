// 3D-сцена: территория, «Ростов Арена» по фото, метки, панорамы, маршрут.
// Два режима камеры:
//   orbit — как в картах: один палец двигает карту, два пальца — масштаб и поворот (MapControls);
//   look  — взгляд из точки (панорама, вид с места): палец крутит взгляд, щипок — приближение.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CATS, PCATS, catColor, kindOf, mapBox, neighbors, poiColor, sectorColor, shapeBox, shapeCenter, shapePoints, standColor, wallSegments } from './model.js';
import { RANGES, SECTORS, ST, STANDS, TIERS, ring, secMid, sp } from './stadium.js';

const PI = Math.PI;
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
    this.scene = new THREE.Scene();
    // ближняя плоскость 1,5 м в обзоре (точнее буфер глубины, нет мерцания), 0,2 м — во взгляде из точки
    this.camera = new THREE.PerspectiveCamera(45, 1, NEAR_ORBIT, 5000);
    this.controls = new MapControls(this.camera, r.domElement);
    this.controls.addEventListener('change', () => (this.dirty = true));
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.09, maxPolarAngle: 1.32, minDistance: 14, maxDistance: 1100, zoomToCursor: true, screenSpacePanning: false, rotateSpeed: 0.6 });
    this.groups = {};
    for (const k of ['world', 'stadium', 'roof', 'labels', 'pois', 'panos', 'route', 'arrows']) { this.groups[k] = new THREE.Group(); this.scene.add(this.groups[k]); }
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
    sun.position.set(-260, 420, 300); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004;
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

  // ---------- помощники ----------
  mat(color, o = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.88, ...o }); }
  add(group, geo, mat, pos, opts = {}) {
    const m = new THREE.Mesh(geo, mat); if (pos) m.position.copy(pos);
    m.castShadow = opts.cast ?? true; m.receiveShadow = true; Object.assign(m.userData, opts.data || {});
    this.groups[group].add(m); return m;
  }
  flat(points, mat, y, group, hole) {
    const sh = new THREE.Shape(points.map((p) => new THREE.Vector2(p[0] - C.x, p[1] - C.y)));
    if (hole) sh.holes.push(new THREE.Path([...hole].reverse().map((p) => new THREE.Vector2(p[0] - C.x, p[1] - C.y))));
    const g = new THREE.ShapeGeometry(sh, 2); g.rotateX(PI / 2);
    mat.side = THREE.DoubleSide;
    // слои земли лежат в сантиметрах друг над другом: без смещения глубины они мерцают при обзоре издалека
    if (y < 1) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -(2 + Math.round(y * 60)) });
    const m = new THREE.Mesh(g, mat); m.position.y = y; m.receiveShadow = true; this.groups[group].add(m); return m;
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
    const font = `${weight} 26px -apple-system, "Segoe UI", Roboto, sans-serif`;
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
    // центр сцены — середина стадиона «Ростов Арены» или рамка объекта, собранного с нуля
    const b = mapBox(map);
    if (map.stadium) { C.x = 400; C.y = 262; this.span = 1; }
    else { C.x = b.x + b.w / 2; C.y = b.y + b.h / 2; this.span = Math.max(0.25, Math.max(b.w, b.h) / 760); }
    this.half = { x: Math.max(480, b.w * 0.6), z: Math.max(340, b.h * 0.6) };
    this.theme();
    for (const k of ['world', 'stadium', 'roof', 'labels', 'pois', 'panos']) clear(this.groups[k]);
    this.screenSprites = this.screenSprites.filter((s) => this.groups.arrows.getObjectById(s.id) || this.groups.route.getObjectById(s.id));
    this.culled = [];
    this.buildGround(); this.buildShapes(); if (map.stadium) this.buildStadium(); this.buildPois(); this.buildPanos();
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
    const m = this.map, white = this.mat('#ffffff'), ref = (id) => ({ data: { ref: id } });
    const shapes = [...m.shapes].sort((a, b) => shapeBox(b).w * shapeBox(b).h - shapeBox(a).w * shapeBox(a).h);
    for (const s of shapes) {
      if (s.cat === 'plaza') continue;
      const k = kindOf(s), col = new THREE.Color(s.color || catColor(m, s.cat)), c = shapeCenter(s), b = shapeBox(s);
      if (!k.walls) {
        let base = new THREE.Color(this.dark ? '#2b2e33' : '#d9d5cd').lerp(col, s.cat === 'leisure' || s.cat === 'expo' ? 0.35 : 0.6);
        if (s.cat === 'parking' && !s.color) base = new THREE.Color('#5d6167');
        if (s.cat === 'sport' && !s.color) base = new THREE.Color('#3f8f46');
        if (s.cat === 'ice' && !s.color) base = new THREE.Color('#e3f1ff');
        const z = this.flat(shapePoints(s), this.mat(base), s.cat === 'leisure' || s.cat === 'expo' ? 0.08 : 0.16, 'world');
        z.userData.ref = s.id;
        this.decorate(s, col, white);
      } else {
        const floor = this.flat(shapePoints(s), this.mat(this.dark ? '#3a3d42' : '#efede8'), 0.12, 'world'); floor.userData.ref = s.id;
        if (k.roof) {
          const roof = this.flat(shapePoints(s), this.mat(this.dark ? '#565a60' : '#e9ebee', { roughness: 0.6 }), s.height || k.height, 'world');
          roof.userData.ref = s.id; roof.userData.roofOf = s.id; roof.castShadow = true;
        }
      }
      if (s.name) { const l = this.label(s.name, { px: 12, maxDist: k.walls ? 650 : Math.max(220, Math.min(520, b.w * 4)) }); l.position.copy(W(c.x, c.y, (s.height || k.height || 0) + 3)); l.userData.ref = s.id; this.groups.labels.add(l); }
    }
    const wallMat = this.mat(this.dark ? '#5d6066' : '#f2f1ee'), byColor = {};
    for (const seg of wallSegments(m)) {
      const dx = seg.b[0] - seg.a[0], dz = seg.b[1] - seg.a[1], L = Math.hypot(dx, dz); if (L < 0.05) continue;
      const mat = seg.color ? (byColor[seg.color] ||= this.mat(seg.color)) : wallMat;
      const w = this.add('world', new THREE.BoxGeometry(L + seg.t, seg.h, seg.t), mat, W((seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, seg.h / 2), ref(seg.owner));
      w.rotation.y = Math.atan2(-dz, dx);
    }
    for (const st of m.stairs) {
      const n = Math.max(3, Math.round((st.dir === 'x' ? st.w : st.h) / 0.5)), rise = (st.rise || 3) / n;
      for (let i = 0; i < n; i++) {
        const along = st.dir === 'x' ? st.w : st.h, u = (along * (i + 0.5)) / n;
        const geo = st.dir === 'x' ? new THREE.BoxGeometry(along / n, rise * (i + 1), st.h) : new THREE.BoxGeometry(st.w, rise * (i + 1), along / n);
        const pos = st.dir === 'x' ? W(st.x + u, st.y + st.h / 2, (rise * (i + 1)) / 2) : W(st.x + st.w / 2, st.y + u, (rise * (i + 1)) / 2);
        this.add('world', geo, this.mat('#cfccc6'), pos, ref(st.id));
      }
    }
  }

  decorate(s, col, white) {
    if (s.type !== 'rect') return;
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2, add = (geo, mat, pos) => this.add('world', geo, mat, pos, { data: { ref: s.id } });
    if (s.cat === 'sport') for (const [w, d, x, y] of [[s.w, 0.3, cx, s.y + 0.6], [s.w, 0.3, cx, s.y + s.h - 0.6], [0.3, s.h, s.x + 0.6, cy], [0.3, s.h, s.x + s.w - 0.6, cy], [s.w - 1.2, 0.3, cx, cy]]) add(new THREE.BoxGeometry(w, 0.04, d), white, W(x, y, 0.2));
    if (s.cat === 'ice') for (const [w, d, x, y] of [[s.w, 0.3, cx, s.y], [s.w, 0.3, cx, s.y + s.h], [0.3, s.h, s.x, cy], [0.3, s.h, s.x + s.w, cy]]) add(new THREE.BoxGeometry(w, 1.1, d), white, W(x, y, 0.55));
    if (s.cat === 'parking') {
      const cols = Math.floor(s.w / 2.7), rows = Math.floor(s.h / 15), cars = [];
      for (let r = 0; r < rows; r++) for (let i = 0; i < cols; i++) if ((i * 7 + r * 13) % 10 < 6) cars.push([s.x + 1.4 + i * 2.7, s.y + 7 + r * 15]);
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 1.45, 4.4), this.mat('#ffffff', { roughness: 0.4, metalness: 0.2 }), cars.length);
      const palette = ['#9aa3ad', '#e4e6e8', '#2f353c', '#a33a3a', '#3b5b8c'].map((h) => new THREE.Color(h)), mx = new THREE.Matrix4();
      cars.forEach(([x, y], i) => { mx.makeTranslation(x - C.x, 0.9, y - C.y); inst.setMatrixAt(i, mx); inst.setColorAt(i, palette[i % palette.length]); });
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
    const roof = new THREE.Mesh(rg, this.mat('#fbfbf9', { roughness: 0.55, side: THREE.DoubleSide, transparent: true, opacity: 0.96 })); roof.castShadow = true; roof.receiveShadow = true; this.groups.roof.add(roof);
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

  buildPois() {
    for (const p of this.map.pois) {
      const c = poiColor(this.map, p), g = (PCATS[p.cat] || PCATS.info).g;
      const pin = this.canvasSprite((x, w, h) => {
        x.fillStyle = 'rgba(0,0,0,.25)'; x.beginPath(); x.ellipse(w / 2, h - 2, 5, 2, 0, 0, 2 * PI); x.fill();
        x.fillStyle = c; x.strokeStyle = '#fff'; x.lineWidth = 2.5; x.beginPath(); x.arc(w / 2, 14, 11.5, 0, 2 * PI); x.fill(); x.stroke();
        x.beginPath(); x.moveTo(w / 2 - 5, 23); x.lineTo(w / 2, h - 3); x.lineTo(w / 2 + 5, 23); x.fill();
        x.fillStyle = '#fff'; x.font = `700 ${g.length > 1 ? 9 : 12}px -apple-system, "Segoe UI", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(g, w / 2, 14.5);
      }, 30, 40, 34, { cy: 0, order: 20 });
      pin.position.copy(W(p.x, p.y, (p.z || 0) + 0.3)); pin.userData.ref = p.id; this.groups.pois.add(pin);
      const l = this.label(p.name, { px: 12, maxDist: 260 }); l.center.set(0.5, -1.15); l.position.copy(W(p.x, p.y, (p.z || 0) + 0.3)); l.userData.ref = p.id; this.groups.pois.add(l);
    }
  }
  buildPanos() {
    for (const p of this.map.panos) {
      const s = this.canvasSprite((x, w, h) => { x.fillStyle = '#2f6fe0'; x.strokeStyle = '#fff'; x.lineWidth = 2.5; x.beginPath(); x.arc(w / 2, h / 2, 7.5, 0, 2 * PI); x.fill(); x.stroke(); }, 20, 20, 16, { order: 15 });
      s.position.copy(W(p.x, p.y, (p.z || 0) + 0.6)); s.userData.ref = p.id; s.userData.maxDist = 520; this.culled.push(s); this.groups.panos.add(s);
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

  // ---------- камера: обзор ----------
  overview(now) { const k = this.span || 1; this.flyTo(W(C.x, C.y), new THREE.Vector3(-150 * k, 330 * k, 360 * k), now); }
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
    const yaw = face ? Math.atan2(face.y - y, face.x - x) : this.look?.yaw ?? 0;
    this.look = { pos: W(x, y, z), yaw, pitch: opts.pitch ?? -0.05, fov: 72, plan: { x, y }, kind: opts.kind || 'pano' };
    this.camera.near = NEAR_LOOK; this.camera.updateProjectionMatrix();
    this.groups.panos.visible = false; this.groups.route.visible = false; this.groups.roof.visible = this.roof;
    this.applyLook();
  }
  exitLook(silent) {
    if (!this.look) return;
    const { plan } = this.look; this.look = null; this.setPhoto(null); clear(this.groups.arrows);
    this.controls.enabled = true; this.groups.panos.visible = true; this.groups.route.visible = true; this.groups.roof.visible = this.roof;
    this.camera.fov = 45; this.camera.near = NEAR_ORBIT; this.camera.updateProjectionMatrix(); this.resizeSprites(); this.dirty = true;
    if (!silent) { const t = W(plan.x, plan.y); this.camera.position.copy(t.clone().add(new THREE.Vector3(-40, 60, 60))); this.controls.target.copy(t); this.focus(plan.x, plan.y, 60); }
  }
  applyLook() {
    const L = this.look, cp = Math.cos(L.pitch);
    this.camera.position.copy(L.pos);
    this.camera.lookAt(L.pos.clone().add(new THREE.Vector3(Math.cos(L.yaw) * cp, Math.sin(L.pitch), Math.sin(L.yaw) * cp)));
    if (this.camera.fov !== L.fov) { this.camera.fov = L.fov; this.camera.updateProjectionMatrix(); this.resizeSprites(); }
    this.dirty = true; this.onLook?.(L);
  }
  /** Плавный переход взгляда в другую точку. */
  glideTo(x, y, z, done) {
    const L = this.look, from = L.pos.clone(), to = W(x, y, z), d = from.distanceTo(to), dur = Math.max(900, Math.min(2600, 650 + d * 9));
    this.setPhoto(null, true);
    this.anim = { look: true, from, to, s: performance.now(), dur, fov: L.fov, done: () => { L.plan = { x, y }; done?.(); } };
  }
  setArrows(items) { this.dirty = true;
    clear(this.groups.arrows);
    if (!this.look) return;
    const shape = new THREE.Shape([[0, 0.62], [0.56, 0], [0.34, 0], [0, 0.36], [-0.34, 0], [-0.56, 0]].map(([a, b]) => new THREE.Vector2(a, b)));
    const { x, y } = this.look.plan;
    for (const it of items) {
      const dx = it.x - x, dy = it.y - y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, g = new THREE.Group();
      g.userData.to = it.id;
      const geo = new THREE.ShapeGeometry(shape); geo.rotateX(-PI / 2);
      const arrow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x2f6fe0, side: THREE.DoubleSide, depthTest: false, fog: false })); arrow.scale.setScalar(1.25); arrow.rotation.y = Math.atan2(-ux, -uy); arrow.renderOrder = 30;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 36), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, fog: false })); disc.rotation.x = -PI / 2; disc.position.y = -0.01; disc.renderOrder = 29;
      g.add(disc, arrow); g.position.copy(this.look.pos.clone().add(new THREE.Vector3(ux * 2.7, -this.look.pos.y + 0.25 + Math.max(0, this.look.pos.y - 1.6), uy * 2.7)));
      const l = this.label(`${it.name} · ${Math.round(L)} м`, { px: 11, bg: 'rgba(23,24,26,.84)', fg: '#fff', maxDist: 1e9 }); l.material.depthTest = false; l.renderOrder = 31; l.position.set(0, 0.7, 0); g.add(l);
      this.groups.arrows.add(g);
    }
  }
  setPhoto(url, fadeOnly) { this.dirty = true;
    if (this.sphere) {
      const old = this.sphere; this.sphere = null;
      if (fadeOnly) { this.fading = old; } else { this.scene.remove(old); old.geometry.dispose(); old.material.map?.dispose(); old.material.dispose(); }
    }
    for (const k of ['world', 'stadium', 'labels']) this.groups[k].visible = true;
    this.groups.roof.visible = this.roof;
    if (!url || !this.look) return;
    const tex = new THREE.TextureLoader().load(url); tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.SphereGeometry(60, 64, 40); g.scale(-1, 1, 1);
    this.sphere = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, fog: false, transparent: true, opacity: 1 }));
    this.sphere.position.copy(this.look.pos); this.sphere.rotation.y = -this.look.yaw0 || 0; this.scene.add(this.sphere);
    for (const k of ['world', 'stadium', 'roof', 'labels']) this.groups[k].visible = false;
  }

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
    el.addEventListener('pointermove', (e) => {
      if (!ptr.has(e.pointerId) || !g) return;
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
  tap(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect(), v = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(v, this.camera);
    const pools = this.look ? [this.groups.arrows, this.groups.pois] : [this.groups.pois, this.groups.panos, this.groups.labels];
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
        this.look.pos.lerpVectors(a.from, a.to, e); this.look.fov = a.fov - 7 * Math.sin(PI * k);
        if (this.fading) this.fading.material.opacity = Math.max(0, 1 - k * 2.5);
        this.applyLook();
      } else { this.camera.position.lerpVectors(a.p0, a.p1, e); this.controls.target.lerpVectors(a.t0, a.t1, e); this.camera.lookAt(this.controls.target); }
      if (k >= 1) {
        this.anim = null;
        if (this.fading) { this.scene.remove(this.fading); this.fading.geometry.dispose(); this.fading.material.map?.dispose(); this.fading.material.dispose(); this.fading = null; }
        if (a.look) { this.look.fov = a.fov; this.applyLook(); }
        a.done?.();
      }
    } else if (!this.look) {
      this.controls.update();
      const t = this.controls.target, H = this.half || { x: 480, z: 340 }; t.x = Math.max(-H.x, Math.min(H.x, t.x)); t.z = Math.max(-H.z, Math.min(H.z, t.z)); t.y = 0;
    }
    if (a) this.dirty = true;
    if (!this.dirty) return;               // рисуем только когда что-то изменилось — бережём батарею
    this.dirty = false;
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
