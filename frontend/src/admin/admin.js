// Конструктор карты объекта: построение, точки и панорамы, стадион (если есть), публикация, версии, цвета.
// Открывается из админ-панели (admin.html#/edit/<адрес объекта>), вход и кабинет — в cabinet.js.
import { ROLE_NAMES, can } from '../core/api.js';
import { CATS, KINDS, LAYERS, PALETTE, PCATS, SLUG_RE, arrowItems, catColor, slugify, startView, uniqueSlug, clone, elevOf, floorById, floorOf, floorsSorted, kindOf, layersFor, visitorLayerMode, mapsEmbed, moveShape, neighbors, poiColor, shapeArea, shapeBox, shapeCenter, shapeLayer, standColor, uid } from '../core/model.js';
import { Plan2D } from '../core/plan2d.js';
import { SECTORS, STANDS, ST, secMid, sector, setStadiumCenter } from '../core/stadium.js';
import { $, Sheet, badge, confirmBox, esc, fmtDate, icon, photo, themeButton, toast } from '../core/ui.js';
import { ICON_CHOICES, ICON_FILES, iconUrl, pointIconUrl } from '../core/icons.js';
import { DEFAULT_PHRASES, createMascot, mascotSettings } from '../core/mascot.js';
import { HINTS, TOOLS, createTools } from './tools.js';
import { checkPanoFile, previewPano } from '../core/panopreview.js';

// ---------------- редактор ----------------
export function editor(root, api, user, draft, lock = { mine: true }) {
  const isEditor = can(user, 'editor'), isAdmin = can(user, 'admin');
  // объект занят другим админом — смотрим его сохранённые изменения, но править не можем
  const lockedBy = isEditor && !lock.mine ? lock.holder : null;
  const venue = draft.venue || { slug: api.slug, name: 'Ростов Арена' };
  let map = draft.data, undo = [], redo = [], saveT = null, rebuildT = null, scene = null;
  const state = {
    mode: 'build', tool: 'select', sel: null, view: '2d', panel: null, readonly: !isEditor || !!lockedBy,
    newKind: 'room', newW: 8, newH: 6, snap: 0.5, wallThick: 0.2, doorWidth: 1.6, stairDir: 'x', poiCat: 'info',
    dirty: false, saving: false, savedAt: draft.updated_at, savedBy: draft.updated_by, rev: draft.revision, conflict: false,
    under: underlayOf(map), underOp: 0.3, hidden: new Set(), cursor: null, floor: floorsSorted(map)[0].id,
  };
  const groundId = () => floorsSorted(map)[0].id;
  const here = (o) => floorOf(o) === state.floor;
  const layersKey = 'arena.layers.edit.' + venue.slug;
  try { state.hidden = new Set(JSON.parse(localStorage.getItem(layersKey) || '[]')); } catch { /* все слои видны */ }
  const hasStadium = () => !!map.stadium;
  // подложка: генплан «Ростов Арены» или своя картинка, которую админ загрузил для нового объекта
  function underlayOf(m) { return m.underlay || (m.stadium ? { src: photo('genplan'), x: 0, y: 0, w: 793, h: 523 } : null); }
  const faceOf = (p, nb) => nb[0] || (hasStadium() ? { x: ST.cx, y: ST.cy } : { x: p.x + 1, y: p.y });
  setStadiumCenter(map);

  root.innerHTML = `
  <div class="adm">
    <header class="appbar">
      <a class="iconbtn flat" href="#/" aria-label="К объектам" title="К списку объектов">${icon('back')}</a>
      <div class="title"><b>Конструктор · ${esc(venue.name)}</b><span id="st"><i></i>Черновик</span></div>
      <button class="iconbtn flat" data-act="undo" aria-label="Отменить" title="Отменить (Ctrl+Z)">${icon('undo')}</button>
      <button class="iconbtn flat" data-act="redo" aria-label="Повторить" title="Повторить (Ctrl+Y)">${icon('redo')}</button>
      ${themeButton('iconbtn flat')}
      <button class="iconbtn flat${state.hidden.size ? ' on' : ''}" data-act="layers" aria-label="Слои" title="Слои: что показывать на плане и в 3D">${icon('layers')}</button>
      <button class="iconbtn flat" data-act="view3d" aria-label="3D-просмотр" title="3D-просмотр">${icon('cube')}</button>
      <a class="btn sm" href="index.html?object=${encodeURIComponent(venue.slug)}&preview=1" target="_blank" rel="noopener" data-act="preview" title="Посмотреть черновик глазами посетителя — без публикации">${icon('eye')}<span class="hide-s">Как посетитель</span></a>
      ${isAdmin ? `<button class="btn sm primary" data-act="panel" data-p="publish">${icon('publish')}<span class="hide-s">Опубликовать</span></button>` : ''}
      <button class="iconbtn flat" data-act="panel" data-p="menu" aria-label="Меню">${icon('more')}</button>
    </header>
    <nav class="modes" role="tablist">
      <button role="tab" data-mode="build" aria-selected="true">Построение</button>
      <button role="tab" data-mode="points" aria-selected="false">Точки и панорамы</button>
      ${hasStadium() ? '<button role="tab" data-mode="stadium" aria-selected="false">Стадион</button>' : ''}
      <div class="floor-bar" id="floorBar" aria-label="Этажи"></div>
      <span class="role-tag">${esc(user.name && user.name !== ROLE_NAMES[user.role] ? user.name : user.email)} · ${ROLE_NAMES[user.role]}</span>
    </nav>
    <div class="workspace">
      <div class="toolbar" id="tb" role="toolbar" aria-label="Инструменты"></div>
      <div class="canvas">
        <svg class="plan" aria-label="Редактируемый план"></svg>
        <div class="three" hidden></div>
        <div class="optbar" id="opt"></div>
        <div class="pop layers-pop" id="lyPop" hidden></div>
        <div class="zoombox"><button class="iconbtn" data-act="zin" aria-label="Приблизить">+</button><button class="iconbtn" data-act="zout" aria-label="Отдалить">−</button><button class="iconbtn" data-act="zfit" aria-label="Вся территория">${icon('target')}</button></div>
        <div class="coords" id="xy">x — · y —</div>
        ${lockedBy ? `<div class="readonly-banner lock-banner">${icon('user')}Сейчас объект редактирует <b>${esc(lockedBy.name)}</b> — вы видите его сохранённые изменения. Править можно будет, когда он выйдет</div>`
          : state.readonly ? '<div class="readonly-banner">Режим наблюдателя: только просмотр</div>' : ''}
        <button class="iconbtn look-exit" data-act="exitLook" hidden aria-label="Выйти из панорамы">${icon('back')}</button>
        <div class="pano-tune" id="tune" hidden></div>
      </div>
      <section class="sheet"><div class="sheet-grip"><i></i></div><div class="sheet-body"></div></section>
    </div>
  </div>`;
  const svg = $('.plan', root), three = $('.three', root), sheet = new Sheet($('.sheet', root));
  sheet.peek = 92;

  const ed = {
    state, toast,
    get map() { return map; },
    get plan() { return plan; },
    find(sel) {
      if (!sel) return null;
      const list = { shape: 'shapes', wall: 'walls', door: 'doors', stairs: 'stairs', poi: 'pois', pano: 'panos' }[sel.type];
      return list ? map[list].find((x) => x.id === sel.id) : sel;
    },
    select(sel) { state.sel = sel; state.panel = null; redraw(); inspector(); },
    snapshot() { undo.push(JSON.stringify(map)); if (undo.length > 100) undo.shift(); redo = []; },
    change(fn, msg) { ed.snapshot(); fn(); ed.changed(); if (msg) toast(msg); },
    changed() { markDirty(); redraw(); rebuildLater(); if (!state.panel) inspector(true); },
    changedLive() { markDirty(); redraw(); syncFields(); },
    redraw, refreshOpt: optbar,
    /** Спросить перед удалением; у точки обзора — сколько переходов пропадёт. */
    confirmDelete(sel, o) {
      const n = sel.type === 'pano' ? map.links.filter((l) => l.includes(sel.id)).length : 0;
      return confirmBox(`Удалить «${o?.name || NAMES[sel.type]}»?${n ? ` Вместе с ней пропадут переходы: ${n}.` : ''} Отменить можно кнопкой ↶.`);
    },
  };
  const tools = createTools(ed);
  const plan = new Plan2D(svg, {
    down: (w, hit) => tools.down(w, hit), move: (w) => tools.move(w), up: (w) => tools.up(w), cancel: () => tools.cancel(),
    tap: (w, hit) => tools.tap(w, hit),
    hover: (w) => { state.cursor = w; $('#xy').textContent = `x ${w.x.toFixed(1)} · y ${w.y.toFixed(1)} м`; tools.hover(w); },
  });
  plan.setMap(map);
  svg.addEventListener('pointerleave', () => (state.cursor = null));
  root.addEventListener('pointerdown', (e) => { if (!e.target.closest('#lyPop, [data-act="layers"]')) $('#lyPop', root).hidden = true; });   // вне плана Ctrl+V вставляет со сдвигом
  plan.set({ floor: state.floor, hidden: state.hidden, admin: true, grid: true, underlay: state.under, underlayOpacity: state.underOp, overlay: (px) => tools.overlay(px), linkFrom: () => tools.linkFrom });
  requestAnimationFrame(() => plan.fitAll());

  // ---------- состояние сохранения ----------
  function markDirty() { state.dirty = true; status(); if (isEditor) { clearTimeout(saveT); saveT = setTimeout(save, 2500); } }
  function status() {
    const el = $('#st');
    el.className = state.dirty || state.conflict ? 'dirty' : '';
    el.innerHTML = '<i></i>' + (lockedBy ? `Только просмотр · редактирует ${esc(lockedBy.name)}` : state.readonly ? 'Черновик · только просмотр' : state.conflict ? 'Конфликт версий — обновите' : state.saving ? 'Сохраняю…' : state.dirty ? 'Есть несохранённые изменения' : `Черновик сохранён${state.savedAt ? ' · ' + new Date(state.savedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}`);
  }
  async function save() {
    if (!isEditor || !state.dirty || state.saving) return;
    state.saving = true; status();
    try {
      const r = await api.saveDraft(map, state.rev);
      state.rev = r.revision; state.savedAt = r.updated_at; state.dirty = false; state.conflict = false;
    } catch (e) {
      if (e.status === 409) { state.conflict = true; toast(e.message, 5000); }
      else toast('Не сохранилось: ' + e.message, 4000);
    }
    state.saving = false; status();
  }
  async function reloadDraft() {
    const d = await api.draft(); map = d.data; state.rev = d.revision; state.dirty = false; state.conflict = false; state.savedAt = d.updated_at;
    undo = []; redo = []; plan.setMap(map); if (scene) scene.setMap(map); ed.select(null); status();
  }

  // ---------- отрисовка ----------
  function selRef() { const s = state.sel; return !s ? null : s.type === 'sector' ? 'sec:' + s.id : s.type === 'stadium' ? null : s.id; }
  function redraw() {
    // после отмены этаж мог исчезнуть — возвращаемся на нижний
    if (!map.floors.some((f) => f.id === state.floor)) { state.floor = groundId(); scene?.setFloorView(map.floors.length > 1 ? state.floor : null); }
    if ($('#floorBar')) floorBar();
    state.under = underlayOf(map); plan.set({ floor: state.floor, underlay: state.under, sel: selRef(), showPanos: state.mode !== 'build' || state.sel?.type === 'pano', underlayOpacity: state.mode === 'build' ? state.underOp : Math.min(state.underOp, 0.12) }); }
  function rebuildLater() { if (!scene) return; clearTimeout(rebuildT); rebuildT = setTimeout(() => scene.setMap(map), 450); }
  function toolbar() {
    const list = state.readonly ? [TOOLS.build[0]] : TOOLS[state.mode];
    $('#tb').innerHTML = list.map((t) => `<button class="tool${t.pano ? ' pano' : ''}" data-tool="${t.id}" aria-pressed="${state.tool === t.id}" title="${t.n} (${t.key.toUpperCase()})">${t.img ? `<img class="tool-img" src="${iconUrl(t.img)}" alt="">` : icon(t.ic)}${t.n}</button>`).join('');
    svg.classList.toggle('tool-draw', state.tool !== 'select');
  }
  const seg = (name, cur, items) => `<div class="seg">${items.map(([v, n]) => `<button data-opt="${name}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${n}</button>`).join('')}</div>`;
  function optbar() {
    const t = state.tool, el = $('#opt');
    let h = '';
    if (state.view === '3d') { el.hidden = true; return; }
    if (['rect', 'poly', 'ellipse'].includes(t)) h += `<span class="cap">Что рисуем</span>${seg('newKind', state.newKind, Object.entries(KINDS).map(([k, v]) => [k, v.n]))}`;
    if (['rect', 'ellipse'].includes(t)) h += `<label class="cap opt-num">Ширина <input class="inp sm mono" id="o-nw" type="number" min="0.5" max="2000" step="0.5" value="${state.newW}"></label><label class="cap opt-num">Глубина <input class="inp sm mono" id="o-nh" type="number" min="0.5" max="2000" step="0.5" value="${state.newH}"></label><span class="cap">м — по нажатию</span>`;
    if (t === 'wall') h += `<span class="cap">Толщина</span>${seg('wallThick', state.wallThick, [[0.12, '12 см'], [0.2, '20 см'], [0.4, '40 см']])}`;
    if (t === 'door') h += `<span class="cap">Ширина проёма</span>${seg('doorWidth', state.doorWidth, [[0.9, '0,9 м'], [1.6, '1,6 м'], [3, '3 м'], [6, '6 м']])}`;
    if (t === 'stairs') h += `<span class="cap">Подъём</span>${seg('stairDir', state.stairDir, [['x', '→ вправо'], ['y', '↓ вниз']])}`;
    if (t === 'poi') h += `<span class="cap">Тип метки</span>${seg('poiCat', state.poiCat, Object.entries(PCATS).map(([k, v]) => [k, v.n]))}`;
    if (['rect', 'poly', 'ellipse', 'wall', 'stairs', 'select'].includes(t) && state.mode === 'build' && !state.readonly) h += `<span class="cap">Шаг</span>${seg('snap', state.snap, [[0.5, '0,5 м'], [1, '1 м'], [0, 'выкл']])}`;
    if (tools.busy()) h += `<button class="btn sm primary" data-act="finish">${icon('check')}Готово</button><button class="btn sm" data-act="undoPoint">Убрать точку</button><button class="btn sm ghost" data-act="escape">Отмена</button>`;
    if (!h) h = `<span class="cap">${state.readonly ? 'Нажмите на объект, чтобы посмотреть его свойства' : HINTS[t] || ''}</span>`;
    el.innerHTML = h; el.hidden = false;
  }

  // ---------- инспектор и панели ----------
  const field = (label, inner) => `<label class="field"><span class="lbl">${label}</span>${inner}</label>`;
  const dis = () => (state.readonly ? 'disabled' : '');
  const num = (id, v, step = 0.5, min) => `<input class="inp mono" id="${id}" type="number" step="${step}" ${min !== undefined ? `min="${min}"` : ''} value="${+(+v).toFixed(2)}" ${dis()}>`;
  const swatches = (cur, act) => `<div class="swatches">${PALETTE.map((c) => `<button class="sw" style="background:${c}" data-act="${act}" data-c="${c}" aria-pressed="${cur === c}" aria-label="Цвет ${c}" ${dis()}></button>`).join('')}<input type="color" data-color="${act}" value="${cur}" aria-label="Свой цвет" ${dis()}></div>`;
  // рассказ маскота о месте: показывается, когда посетитель открывает панораму этой точки
  const guideField = (o) => `<div class="field guide-field"><span class="lbl">${icon('chat')}Рассказ маскота</span>
    <textarea class="inp" id="f-guide" rows="4" placeholder="Что маскот расскажет об этом месте. Каждая строка — новая реплика и новая поза" ${dis()}>${esc(o.guide || '')}</textarea>
    <div class="row"><span class="cap">Печатается по букве в облаке, со звуком. Пусто — маскот молчит.</span>${o.guide ? `<button class="btn sm" data-act="mascotGuide">${icon('volume')}Послушать</button>` : ''}</div></div>`;
  // значок точки: из набора ТТК или свой (PNG/SVG-картинка); по умолчанию — значок типа
  const iconField = (o, kind) => {
    const cur = o.iconUrl ? null : o.icon || (ICON_FILES[kind] ? kind : null);
    return `<div class="field"><span class="lbl">Значок</span><div class="icon-pick">${ICON_CHOICES.map(([k, n]) => `<button class="ipk" data-act="setIcon" data-v="${k}" aria-pressed="${cur === k || (k === 'marker' && cur === 'info')}" title="${n}" aria-label="${n}" ${dis()}><img src="${iconUrl(k)}" alt=""></button>`).join('')}
      ${o.iconUrl ? `<span class="ipk" aria-pressed="true" title="Свой значок"><img src="${esc(o.iconUrl)}" alt=""></span>` : ''}</div>
      ${state.readonly ? '' : `<div class="row"><button class="btn sm" data-act="iconUp">${icon('upload')}Свой значок</button>${o.icon || o.iconUrl ? '<button class="btn sm ghost" data-act="iconReset">Как у типа</button>' : ''}</div>`}</div>`;
  };
  const photoBlock = (url, act, label) => `${url ? `<img class="thumb" src="${url}" alt="">` : ''}${state.readonly ? '' : `<div class="row"><button class="btn sm" data-act="${act}">${icon('upload')}${url ? 'Заменить' : label}</button>${url ? `<button class="btn sm ghost" data-act="${act}Rm">Убрать</button>` : ''}</div>`}`;

  function inspector(keepFocus) {
    if (keepFocus && root.querySelector('.sheet-body :focus')) return;
    const s = state.sel, o = ed.find(s);
    if (!s || !o) { sheet.set(home(), sheet.state === 'full' ? 'half' : undefined); if (!s) sheet.snap('peek'); return; }
    let h = '';
    if (s.type === 'shape') {
      const k = kindOf(o), col = o.color || catColor(map, o.cat);
      h = `<div class="insp-head"><span class="dot" style="background:${col};width:14px;height:14px"></span><h2>${esc(o.name)}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Название', `<input class="inp" id="f-name" value="${esc(o.name)}" ${dis()}>`)}
        ${o.cat === 'plaza' ? '' : `<div class="field"><span class="lbl">Что это</span><div class="chips">${Object.entries(KINDS).map(([kk, v]) => `<button class="opt" data-act="kind" data-v="${kk}" aria-pressed="${o.kind === kk}" ${dis()}>${v.n}</button>`).join('')}</div><span class="cap">${k.hint}</span></div>
        <div class="field"><span class="lbl">Назначение</span><div class="chips">${Object.entries(CATS).filter(([c]) => c !== 'plaza').map(([c, v]) => `<button class="opt" data-act="cat" data-v="${c}" aria-pressed="${o.cat === c}" ${dis()}><span class="dot" style="background:${catColor(map, c)}"></span>${v.n}</button>`).join('')}</div></div>`}
        <div class="field"><span class="lbl">Цвет</span>${swatches(col, 'shapeColor')}${o.color && !state.readonly ? '<button class="txt-btn" data-act="shapeColorReset" style="align-self:flex-start">Цвет по назначению</button>' : ''}</div>
        ${o.type === 'rect' ? `<div class="grid2">${field('Ширина, м', num('f-w', o.w, 0.5, 0.5))}${field('Глубина, м', num('f-h', o.h, 0.5, 0.5))}${field('X, м', num('f-x', o.x))}${field('Y, м', num('f-y', o.y))}</div>` : ''}
        ${o.type === 'ellipse' ? `<div class="grid2">${field('Ширина, м', num('f-rx2', o.rx * 2, 0.5, 1))}${field('Глубина, м', num('f-ry2', o.ry * 2, 0.5, 1))}</div>` : ''}
        ${o.type === 'poly' ? `<p class="cap">Контур из ${o.pts.length} вершин · ${Math.round(shapeArea(o))} м². Тяните белые квадраты на плане, чтобы поправить форму.</p>` : ''}
        ${k.walls ? field('Высота стен, м', num('f-height', o.height || k.height, 0.5, 2)) : ''}
        ${field('Текст для посетителей', `<textarea class="inp" id="f-desc" placeholder="Что здесь, часы работы, как пройти" ${dis()}>${esc(o.desc || '')}</textarea>`)}
        <div class="field"><span class="lbl">Фото</span>${photoBlock(o.photo, 'photo', 'Добавить фото')}</div>
        ${state.readonly ? '' : `<div class="row">${o.cat === 'plaza' ? '' : `<button class="btn sm danger" data-act="del">${icon('erase')}Удалить</button>`}<button class="btn sm" data-act="show3d">${icon('cube')}В 3D</button></div>`}`;
    } else if (s.type === 'wall') {
      h = `<div class="insp-head"><span class="glyph sm" style="background:var(--wall-line)">${icon('wall')}</span><h2>Стена</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        <div class="grid2">${field('Толщина, м', num('f-thick', o.thick || 0.2, 0.05, 0.05))}${field('Высота, м', num('f-wh', o.height || 3, 0.5, 1))}</div>
        <div class="field"><span class="lbl">Цвет</span>${swatches(o.color || '#3d3b38', 'wallColor')}</div>
        <p class="cap">${o.pts.length} точек · длина ${o.pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - o.pts[i][0], p[1] - o.pts[i][1]), 0).toFixed(1)} м. Проёмы добавляются инструментом «Дверь».</p>
        ${state.readonly ? '' : `<button class="btn sm danger" data-act="del">${icon('erase')}Удалить стену</button>`}`;
    } else if (s.type === 'door') {
      h = `<div class="insp-head"><span class="glyph sm" style="background:var(--accent)">${icon('door')}</span><h2>Проём</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Ширина, м', num('f-dw', o.w, 0.1, 0.6))}${state.readonly ? '' : `<button class="btn sm danger" data-act="del">${icon('erase')}Удалить проём</button>`}`;
    } else if (s.type === 'stairs') {
      h = `<div class="insp-head"><span class="glyph sm" style="background:var(--ink-2)">${icon('stairs')}</span><h2>Лестница</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        <div class="field"><span class="lbl">Подъём</span><div class="chips"><button class="opt" data-act="sdir" data-v="x" aria-pressed="${o.dir === 'x'}" ${dis()}>→ вправо</button><button class="opt" data-act="sdir" data-v="y" aria-pressed="${o.dir === 'y'}" ${dis()}>↓ вниз</button></div></div>
        <div class="grid2">${field('Высота подъёма, м', num('f-rise', o.rise || 3, 0.5, 0.5))}${field('Ширина, м', num('f-w', o.w, 0.5, 0.5))}</div>
        ${state.readonly ? '' : `<button class="btn sm danger" data-act="del">${icon('erase')}Удалить лестницу</button>`}`;
    } else if (s.type === 'poi') {
      const col = poiColor(map, o);
      h = `<div class="insp-head">${badge(o.cat, col, PCATS[o.cat]?.g || 'i')}<h2>${esc(o.name)}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Название', `<input class="inp" id="f-mname" value="${esc(o.name)}" ${dis()}>`)}
        ${field('Текст для посетителей', `<textarea class="inp" id="f-mtext" placeholder="Что увидит посетитель, нажав на метку" ${dis()}>${esc(o.text || '')}</textarea>`)}
        <div class="field"><span class="lbl">Тип</span><div class="chips">${Object.entries(PCATS).map(([c, v]) => `<button class="opt" data-act="pcat" data-v="${c}" aria-pressed="${o.cat === c}" ${dis()}>${badge(c, map.style.poi[c] || v.c, v.g, 'sm xs')}${v.n}</button>`).join('')}</div></div>
        <div class="field"><span class="lbl">Цвет</span>${swatches(col, 'poiColor')}</div>
        ${iconField(o, o.cat)}
        <div class="grid2">${field('X, м', num('f-mx', o.x))}${field('Y, м', num('f-my', o.y))}</div>
        ${o.cat === 'quest' ? '<p class="cap" style="margin:0">Пиксель ТТК для «Пиксельной охоты»: посетители видят его только в панорамах ближе 35 м и ловят нажатием. На плане и в поиске его нет. Найденные пиксели засчитываются после публикации.</p>' : ''}
        ${o.cat === 'custom' ? guideField(o) : ''}
        ${o.cat === 'custom' ? `<div class="field cyl-field"><span class="lbl">Панорама точки</span>
          <span class="cap">Длинное фото по кругу на 360° (например, 2:1 с камеры 360° или склейка с телефона). Оно оборачивает цилиндр, посетитель стоит в центре и поворачивается в стороны.</span>
          ${o.pano ? `<img class="thumb wide" src="${esc(o.pano)}" alt=""><button class="btn blue full" data-act="viewCyl">${icon('eye')}Посмотреть панораму</button>` : ''}
          ${state.readonly ? '' : `<div class="row"><button class="btn sm${o.pano ? '' : ' primary'}" data-act="cylPano">${icon('upload')}${o.pano ? 'Заменить панораму' : 'Загрузить панораму'}</button>${o.pano ? '<button class="btn sm ghost" data-act="cylPanoRm">Убрать</button>' : ''}</div>`}</div>` : ''}
        <div class="field"><span class="lbl">Фото</span>${photoBlock(o.photo, 'photo', 'Добавить фото')}</div>
        ${state.readonly ? '' : `<div class="row"><button class="btn sm danger" data-act="del">${icon('erase')}Удалить метку</button><button class="btn sm" data-act="show3d">${icon('cube')}В 3D</button></div>`}`;
    } else if (s.type === 'pano') {
      const nb = neighbors(map, o.id);
      h = `<div class="insp-head">${badge('pano')}<h2>${esc(o.name)}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Название точки', `<input class="inp" id="f-pname" value="${esc(o.name)}" ${dis()}>`)}
        <div class="field"><span class="lbl">Адрес в ссылке · латиница, цифры, дефис</span><div class="row nowrap"><span class="cap mono nowrap">#/pano/</span><input class="inp mono" id="f-pslug" value="${esc(o.slug || '')}" placeholder="${esc(slugify(o.name))}" maxlength="64" ${dis()}>${state.readonly ? '' : '<button class="btn sm" data-act="slugFromName" title="Сделать адрес из названия">Из названия</button>'}</div>
          <span class="cap" id="slugMsg">${o.slug ? 'Название можно менять — адрес и ссылки на точку останутся прежними.' : 'Пока ссылка ведёт по внутреннему номеру точки.'}</span></div>
        <button class="btn blue full" data-act="lookPano">${icon('eye')}Посмотреть панораму</button>
        ${iconField(o, 'pano')}
        ${guideField(o)}
        <div class="field"><span class="lbl">Фото 360°</span><span class="cap">${o.img ? 'Посетители видят это фото. Поворот, вид при открытии и стрелки — в «Посмотреть панораму».' : 'Сейчас вид строится из 3D-модели. Загрузите готовую сферическую панораму 2:1 (JPEG, PNG, WebP, от 2000 px по ширине, до 15 МБ) — с камеры 360° или из приложения-склейки. Обычные фото сайт в панораму не склеивает.'}</span>${photoBlock(o.img, 'pano360', 'Загрузить фото 360°')}</div>
        ${field('Панорама Google Maps или видео YouTube', `<textarea class="inp" id="f-pembed" placeholder="Код &lt;iframe&gt; из Google Maps (Поделиться → Встраивание карты) или ссылка на видео YouTube — обычное или 360°" ${dis()}>${esc(o.embed || '')}</textarea>`)}
        ${o.embed && !mapsEmbed(o.embed) ? '<p class="cap">Не похоже на код Google Maps или ссылку YouTube — посетители увидят обычную панораму.</p>' : ''}
        <p class="cap" style="margin:0">Берите только материалы, которые можно показывать: свои съёмки или ролики, где автор разрешил встраивание.</p>
        <div class="field"><span class="lbl">Переходы · ${nb.length}</span><div class="list">${nb.map((q) => `<div class="item"><span class="glyph sm" style="background:var(--pano)"></span><span class="t"><b>${esc(q.name)}</b><span>${Math.round(Math.hypot(q.x - o.x, q.y - o.y))} м</span></span>${state.readonly ? '' : `<button class="iconbtn flat" data-act="unlink" data-id="${q.id}" aria-label="Убрать переход">${icon('close')}</button>`}</div>`).join('') || '<p class="cap">Нет переходов. Включите «Связь» и нажмите на две точки.</p>'}</div></div>
        ${state.readonly ? '' : `<button class="btn sm danger" data-act="del">${icon('erase')}Удалить точку</button>`}`;
    } else if (s.type === 'sector') {
      const sec = sector(s.id), col = map.sectors[s.id]?.color || standColor(map, sec.stand);
      h = `<div class="insp-head"><span class="glyph" style="background:${col}">${sec.stand}</span><h2>Сектор ${sec.id}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        <dl class="kv"><dt>Трибуна</dt><dd>${STANDS[sec.stand].n}</dd><dt>Ярус</dt><dd>${sec.tier === 'lower' ? 'нижний' : 'верхний'}</dd></dl>
        ${field('Текст для посетителей', `<textarea class="inp" id="f-stext" placeholder="Например: козырёк над рядами 1–5, вход через лестницу 3А" ${dis()}>${esc(map.sectors[s.id]?.text || '')}</textarea>`)}
        <div class="field"><span class="lbl">Цвет сектора на схеме</span>${swatches(col, 'secColor')}${map.sectors[s.id]?.color && !state.readonly ? '<button class="txt-btn" data-act="secColorReset" style="align-self:flex-start">Как у трибуны</button>' : ''}</div>
        <button class="btn sm" data-act="show3d">${icon('cube')}Показать в 3D</button>`;
    } else if (s.type === 'stadium') { h = stadiumPanel(); }
    if (LISTS[s.type] && !(s.type === 'shape' && o.cat === 'plaza')) h += clipRow();
    sheet.set(`<div class="insp">${h}</div>`, sheet.state === 'peek' ? 'half' : undefined);
  }

  function home() {
    const m = state.mode;
    if (m === 'stadium') return `<div class="insp">${stadiumPanel()}</div>`;
    const shapesHere = map.shapes.filter((s) => s.cat !== 'plaza' && here(s)), poisHere = map.pois.filter(here), panosHere = map.panos.filter(here);
    const fname = map.floors.length > 1 ? ` · ${esc(floorById(map, state.floor).name)}` : '';
    const list = m === 'build'
      ? shapesHere.map((s) => `<button class="item" data-sel="shape:${s.id}"><span class="dot" style="background:${s.color || catColor(map, s.cat)};width:12px;height:12px"></span><span class="t"><b>${esc(s.name)}</b><span>${KINDS[s.kind]?.n || ''} · ${CATS[s.cat]?.n || ''} · ${Math.round(shapeArea(s))} м²</span></span></button>`).join('')
      : poisHere.map((p) => `<button class="item" data-sel="poi:${p.id}">${badge(p.cat, poiColor(map, p), PCATS[p.cat]?.g || 'i', 'sm')}<span class="t"><b>${esc(p.name)}</b><span>${esc(p.text || PCATS[p.cat]?.n || '')}</span></span></button>`).join('')
        + panoLists(panosHere);
    return `<div class="insp">
      <div><h2 style="font-size:16px">${m === 'build' ? 'Построение помещений' : 'Ключевые точки и панорамы'}</h2>
      <p class="cap" style="margin:4px 0 0">${state.readonly ? 'У вас роль «Наблюдатель»: можно смотреть черновик и историю версий.' : m === 'build' ? 'Рисуйте помещения инструментами слева, затем переходите к точкам и панорамам.' : 'Метки, точки обзора 360° и переходы между ними — по переходам строятся маршруты.'}</p></div>
      ${pasteCard()}
      ${m === 'build' ? underlayBlock() : ''}
      <h3 class="h-sec">${m === 'build' ? `Объекты · ${shapesHere.length}` : `Метки · ${poisHere.length}`}${fname}</h3><div class="list">${list}</div></div>`;
  }

  function panoLists(list) {
    const WEEK = 7 * 864e5, now = Date.now(), at = (p) => p.created || 0;
    const sorted = [...list].sort((a, b) => at(b) - at(a) || map.panos.indexOf(b) - map.panos.indexOf(a));
    const fresh = sorted.filter((p) => now - at(p) < WEEK), old = sorted.filter((p) => now - at(p) >= WEEK);
    const row = (p) => `<button class="item" data-sel="pano:${p.id}">${badge('pano', '', '', 'sm', pointIconUrl(p, 'pano'))}<span class="t"><b>${esc(p.name)}</b><span>${p.img ? 'фото 360°' : 'вид из 3D'} · переходов: ${neighbors(map, p.id).length}${p.created ? ' · ' + fmtDate(new Date(p.created).toISOString()) : ''}</span></span></button>`;
    const col = (title, l) => `<div class="pano-col"><h3 class="h-sec">${title} · ${l.length}</h3><div class="list">${l.map(row).join('') || '<p class="cap">Пока нет</p>'}</div></div>`;
    return `<div class="pano-cols">${fresh.length ? col('Новые точки обзора', fresh) + col('Добавлены раньше', old) : col('Точки обзора', old)}</div>`;
  }

  // ---------- проверка карты: что сломано или забыто ----------
  function mapIssues() {
    const out = [], ids = new Set(map.panos.map((p) => p.id)), seen = new Set();
    const site = map.shapes.find((s) => s.cat === 'plaza'), sb = site && shapeBox(site);
    const off = (o) => sb && (o.x < sb.x - 0.01 || o.y < sb.y - 0.01 || o.x > sb.x + sb.w + 0.01 || o.y > sb.y + sb.h + 0.01);
    for (const l of map.links) {
      const k = [...l].sort().join('|');
      if (!ids.has(l[0]) || !ids.has(l[1])) out.push({ bad: true, t: 'Переход ведёт на удалённую точку обзора', fix: 'brokenLinks' });
      else if (seen.has(k)) out.push({ bad: false, t: 'Один и тот же переход записан дважды', fix: 'brokenLinks' });
      seen.add(k);
    }
    if (map.panos.length > 1) for (const p of map.panos) if (!neighbors(map, p.id).length) out.push({ bad: true, t: `«${p.name}» ни с чем не связана — в неё нельзя перейти из других панорам`, sel: 'pano:' + p.id });
    const near = (list, type, n) => list.forEach((a, i) => list.slice(i + 1).forEach((b) => {
      if (floorOf(a) === floorOf(b) && Math.hypot(a.x - b.x, a.y - b.y) < 0.6) out.push({ bad: false, t: `Две ${n} почти в одном месте: «${a.name}» и «${b.name}»`, sel: `${type}:${b.id}` });
    }));
    near(map.panos, 'pano', 'точки обзора'); near(map.pois, 'poi', 'метки');
    const names = {};
    for (const p of map.panos) (names[p.name] ||= []).push(p);
    for (const [n, l] of Object.entries(names)) if (l.length > 1) out.push({ bad: false, t: `${l.length} точки обзора с одинаковым названием «${n}» — посетитель их спутает`, sel: 'pano:' + l[1].id });
    for (const o of [...map.pois, ...map.panos]) if (off(o)) out.push({ bad: true, t: `«${o.name}» стоит за границей участка`, sel: (map.pois.includes(o) ? 'poi:' : 'pano:') + o.id });
    for (const p of map.pois) if (!p.name?.trim() || p.name === 'Новая метка') out.push({ bad: false, t: 'Метка без названия', sel: 'poi:' + p.id });
    for (const p of map.panos) if (p.embed && !mapsEmbed(p.embed)) out.push({ bad: false, t: `«${p.name}»: ссылка на панораму не распознана`, sel: 'pano:' + p.id });
    return out;
  }

  function underlayBlock() {
    const u = state.under, own = !!map.underlay;
    if (!u) return `<div class="card"><b>Начните с подложки</b><p class="cap" style="margin:0">Загрузите план этажа, генплан или скриншот карты — и обводите его инструментами слева. Подложку видят только сотрудники.</p>
      ${state.readonly ? '' : `<button class="btn sm" data-act="underUp">${icon('image')}Загрузить подложку</button>`}</div>`;
    return `<div class="field"><span class="lbl">Подложка${own ? '' : ' — генплан'}</span><input type="range" id="f-under" min="0" max="1" step="0.05" value="${state.underOp}" aria-label="Прозрачность подложки">
      ${own ? `<div class="grid2">${field('Ширина, м', num('f-uw', u.w, 1, 5))}${field('Сдвиг X / Y, м', `<div class="row nowrap">${num('f-ux', u.x, 1)}${num('f-uy', u.y, 1)}</div>`)}</div>
        <span class="cap">Подгоните ширину под реальный размер: например, по известной длине здания.</span>` : ''}
      <span class="cap">Обводите схему по сетке. Подложку видят только сотрудники.</span>
      ${state.readonly ? '' : `<div class="row"><button class="btn sm" data-act="underUp">${icon('image')}${own ? 'Заменить' : 'Своя подложка'}</button>${own ? '<button class="btn sm ghost" data-act="underRm">Убрать</button>' : ''}</div>`}</div>`;
  }
  // ---------- проверка маскота прямо в конструкторе (с текущими, ещё не опубликованными настройками) ----------
  let tm = null;
  function testMascot(refreshOnly) {
    if (refreshOnly) { tm?.setSettings(mascotSettings(map)); return tm; }
    if (!tm) { tm = createMascot(root, mascotSettings(map), { sound: () => true }); window.__ac?.signal.addEventListener('abort', () => tm.destroy()); }
    else tm.setSettings(mascotSettings(map));
    return tm;
  }

  // ---------- буфер обмена: Ctrl+C / Ctrl+V / Ctrl+D ----------
  // Хранится в браузере, поэтому объект можно скопировать в одном конструкторе и вставить в другом.
  const LISTS = { shape: 'shapes', wall: 'walls', door: 'doors', stairs: 'stairs', poi: 'pois', pano: 'panos' };
  const PREFIX = { shape: 's', wall: 'w', door: 'd', stairs: 'st', poi: 'm', pano: 'p' };
  const NAMES = { shape: 'Фигура', wall: 'Стена', door: 'Проём', stairs: 'Лестница', poi: 'Метка', pano: 'Точка обзора' };
  const CLIP = 'arena.clipboard';
  let memClip = null, pasteN = 0;
  const readClip = () => { try { return JSON.parse(localStorage.getItem(CLIP)) || memClip; } catch { return memClip; } };
  function centerOf(type, o) {
    if (type === 'shape') return shapeCenter(o);
    if (type === 'wall') return { x: o.pts.reduce((a, p) => a + p[0], 0) / o.pts.length, y: o.pts.reduce((a, p) => a + p[1], 0) / o.pts.length };
    if (type === 'stairs') return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    return { x: o.x, y: o.y };
  }
  function shift(type, o, dx, dy) {
    if (type === 'shape') moveShape(o, dx, dy);
    else if (type === 'wall') o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
    else { o.x += dx; o.y += dy; }
  }
  function copySel() {
    const s = state.sel, o = ed.find(s);
    if (!o || !LISTS[s.type]) { toast(s ? 'Это часть стадиона — её нельзя скопировать' : 'Сначала выберите объект на плане'); return false; }
    if (s.type === 'shape' && o.cat === 'plaza') { toast('Границу участка не копируют — она одна на объект'); return false; }
    memClip = { type: s.type, obj: clone(o), from: venue.slug };
    try { localStorage.setItem(CLIP, JSON.stringify(memClip)); } catch { /* только в памяти этой вкладки */ }
    pasteN = 0; toast(`Скопировано: «${o.name || NAMES[s.type]}» — Ctrl+V, чтобы вставить`); inspector(true);
    return true;
  }
  /** Вставить копию: под курсор, если он над планом, иначе со сдвигом на 3 м от оригинала (каждая следующая — дальше). */
  function place(c, at) {
    if (state.readonly) return toast('У наблюдателя нет прав на изменения');
    const n = clone(c.obj), mid = centerOf(c.type, c.obj), snap = (v) => (state.snap ? Math.round(v / state.snap) * state.snap : v);
    n.id = uid(PREFIX[c.type]);
    // копия ложится на текущий этаж — так объект накладывается на другой этаж, а не проваливается в него
    if (state.floor === groundId()) delete n.floor; else n.floor = state.floor;
    if (n.name && c.type !== 'door') n.name = n.name.replace(/ \(копия( \d+)?\)$/, '') + ' (копия)';
    if (c.type === 'pano') { n.slug = uniqueSlug(map, slugify(n.name), n.id); n.created = Date.now(); delete n.arrows; }
    pasteN++;
    const dx = at ? snap(at.x - mid.x) : 3 * pasteN, dy = at ? snap(at.y - mid.y) : 3 * pasteN;
    shift(c.type, n, dx, dy);
    ed.change(() => map[LISTS[c.type]].push(n), c.from && c.from !== venue.slug ? 'Вставлено из другого объекта' : 'Вставлено');
    if (state.mode !== 'build' && ['shape', 'wall', 'door', 'stairs'].includes(c.type)) setMode('build');
    if (state.mode === 'build' && ['poi', 'pano'].includes(c.type)) setMode('points');
    ed.select({ type: c.type, id: n.id });
  }
  function paste(at) { const c = readClip(); if (!c) return toast('Буфер пуст: выберите объект и нажмите Ctrl+C'); place(c, at); }
  function duplicate() {
    const s = state.sel, o = ed.find(s);
    if (!o || !LISTS[s.type] || (s.type === 'shape' && o.cat === 'plaza')) return toast('Выберите объект, который нужно повторить');
    pasteN = 0; place({ type: s.type, obj: clone(o), from: venue.slug });
  }
  const clipRow = () => `<div class="row clip-row"><button class="btn sm" data-act="copy" title="Ctrl+C">${icon('copy')}Копировать</button>${state.readonly ? '' : `<button class="btn sm" data-act="dup" title="Ctrl+D">${icon('copy')}Дублировать</button>`}
    ${map.floors.length > 1 && !state.readonly ? `<label class="row nowrap cap">Этаж <select class="inp sm" id="f-objfloor">${floorsSorted(map).map((f) => `<option value="${f.id}" ${f.id === state.floor ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>` : ''}</div>`;
  function pasteCard() {
    const c = readClip(); if (!c || state.readonly) return '';
    return `<div class="card clip-card"><span class="cap" style="margin:0">В буфере: <b>${esc(c.obj.name || NAMES[c.type])}</b>${c.from && c.from !== venue.slug ? ' · из другого объекта' : ''}</span>
      <div class="row"><button class="btn sm dark" data-act="paste">${icon('copy')}Вставить</button><span class="cap">Ctrl+V — под курсор на плане</span></div></div>`;
  }

  // ---------- слои: что показывать в конструкторе (у каждого объекта — свой набор) ----------
  function layersPop() {
    $('#lyPop').innerHTML = `<b class="pop-h">Слои карты</b>${layersFor(map, true).map((l) => `<label>${l.n} <input type="checkbox" class="switch" data-layer="${l.k}" ${state.hidden.has(l.k) ? '' : 'checked'}></label>`).join('')}
      ${state.hidden.size ? '<button class="txt-btn" data-act="layersAll" style="padding:8px">Показать все</button>' : ''}`;
  }
  function applyLayers() {
    try { localStorage.setItem(layersKey, JSON.stringify([...state.hidden])); } catch { /* без памяти слоёв */ }
    plan.set({ hidden: state.hidden }); scene?.setHidden(state.hidden);
    // выделенный объект ушёл вместе со слоем — снимаем выделение
    const s = state.sel, o = ed.find(s);
    const layerOf = !o ? null : s.type === 'shape' ? shapeLayer(o) : { wall: 'walls', door: 'doors', stairs: 'stairs', poi: 'pois', pano: 'panos', sector: 'stadium' }[s.type];
    if (layerOf && state.hidden.has(layerOf)) ed.select(null);
    $('[data-act="layers"]', root).classList.toggle('on', state.hidden.size > 0);
  }

  function uploadUnderlay() {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        toast('Загружаю подложку…');
        const r = await api.upload(f), img = new Image();
        img.onload = () => {
          const b = map.bounds || { w: 200 }, w = map.underlay?.w || b.w || 200;
          ed.change(() => { map.underlay = { src: r.url, x: map.underlay?.x || 0, y: map.underlay?.y || 0, w, h: (w * img.naturalHeight) / img.naturalWidth }; }, 'Подложка добавлена');
          plan.fitAll(); inspector();
        };
        img.src = r.url;
      } catch (e) { toast(e.message, 4000); }
    };
    inp.click();
  }

  function stadiumPanel() {
    return `<div><h2 style="font-size:16px">Стадион «Ростов Арена»</h2><p class="cap" style="margin:4px 0 0">Чаша строится по схеме: 4 трибуны, 80 секторов. Нажмите на сектор на плане, чтобы подписать его или перекрасить.</p></div>
      <div class="field"><span class="lbl">Цвета трибун на схеме</span>${['A', 'B', 'C', 'D'].map((k) => `<div class="row nowrap" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0"><span>${STANDS[k].n} · ${k}</span><input type="color" data-stand="${k}" value="${standColor(map, k)}" ${dis()} aria-label="Цвет: ${STANDS[k].n}"></div>`).join('')}</div>
      <label class="row nowrap" style="justify-content:space-between"><span>Кресла в 3D как в жизни (синие с жёлтым)</span><input type="checkbox" class="switch" id="f-real" ${map.style.realSeats !== false ? 'checked' : ''} ${dis()}></label>
      <div class="field"><span class="lbl">Найти сектор</span><input class="inp" id="f-sec" placeholder="A105" autocomplete="off"></div>`;
  }

  function panel(name) {
    state.panel = name;
    let h = `<div class="row nowrap"><button class="iconbtn flat" data-act="${name === 'menu' ? 'closePanel' : 'panel'}" data-p="menu" aria-label="Назад">${icon('back')}</button><h2 style="font-size:17px">${{ menu: 'Меню', publish: 'Публикация', versions: 'История версий', colors: 'Цвета карты', floors: 'Этажи', visitors: 'Слои для посетителей', mascot: 'Маскот', check: 'Проверка карты' }[name]}</h2></div>`;
    if (name === 'menu') {
      const items = [
        isAdmin && ['publish', 'publish', 'Публикация', 'Выпустить черновик для посетителей'],
        ['check', 'check', 'Проверка карты', (() => { const n = mapIssues().length; return n ? `Найдено замечаний: ${n}` : 'Замечаний нет'; })()],
        ['versions', 'history', 'История версий', isAdmin ? 'Посмотреть и откатить' : 'Посмотреть'],
        ['mascot', 'chat', 'Маскот', 'Размер, громкость, фразы приветствия'],
        ['floors', 'layers', 'Этажи', `${map.floors.length} · добавить, переименовать, задать высоту`],
        ['visitors', 'eye', 'Слои для посетителей', 'Что посетитель может видеть и включать'],
        ['colors', 'palette', 'Цвета карты', hasStadium() ? 'Трибуны, типы объектов и меток' : 'Типы объектов и меток'],
      ].filter(Boolean);
      const links = [
        ['#/', 'map', 'Все объекты', 'Создать новый объект или открыть другой'],
        ['#/account', 'user', 'Личный кабинет', `${esc(user.email)} · ${ROLE_NAMES[user.role]}`],
        isAdmin && ['#/team', 'people', 'Команда и администраторы', 'Кто может редактировать'],
      ].filter(Boolean);
      h += `<div class="list menu-list">${items.map(([p, ic, n, sub]) => `<button class="item" data-act="panel" data-p="${p}">${icon(ic)}<span class="t"><b>${n}</b><span>${sub}</span></span>${icon('chevron', 'chev')}</button>`).join('')}
        ${links.map(([href, ic, n, sub]) => `<a class="item" href="${href}">${icon(ic)}<span class="t"><b>${n}</b><span>${sub}</span></span>${icon('chevron', 'chev')}</a>`).join('')}
        <button class="item" data-act="exportJson">${icon('save')}<span class="t"><b>Скачать карту (JSON)</b><span>Резервная копия или новый шаблон для репозитория</span></span></button>
        ${isEditor ? `<button class="item" data-act="importJson">${icon('upload')}<span class="t"><b>Загрузить карту из JSON</b><span>Заменит черновик, можно отменить</span></span></button>` : ''}
        <a class="item" href="index.html?object=${encodeURIComponent(venue.slug)}&preview=1" target="_blank" rel="noopener">${icon('eye')}<span class="t"><b>Черновик глазами посетителя</b><span>Без публикации, в новой вкладке</span></span></a>
        <a class="item" href="index.html?object=${encodeURIComponent(venue.slug)}" target="_blank" rel="noopener">${icon('map')}<span class="t"><b>Опубликованная карта</b><span>То, что посетители видят сейчас</span></span></a>
        ${state.conflict ? `<button class="item" data-act="reload">${icon('history')}<span class="t"><b>Загрузить свежий черновик</b><span>Ваши несохранённые правки пропадут</span></span></button>` : ''}</div>
        ${api.demo ? '<p class="demo-note"><b>Демо без сервера.</b> Черновик, версии и пользователи хранятся в этом браузере. Запустите бэкенд, чтобы работать командой.</p>' : ''}`;
    }
    if (name === 'publish') {
      h += `<div class="card"><span class="status-pill ${state.dirty ? 'warn' : 'ok'}">${state.dirty ? 'Есть несохранённые изменения' : 'Черновик сохранён'}</span>
        <p class="cap" style="margin:0">После публикации посетители сразу увидят этот черновик по обычной ссылке на карту. Прошлая версия останется в истории.</p>
        ${field('Что изменилось', '<input class="inp" id="f-comment" placeholder="Например: добавили фудкорты на галерее">')}
        ${(() => { const n = mapIssues().filter((x) => x.bad).length; return n ? `<button class="item issue bad" data-act="panel" data-p="check"><span class="ck">!</span><span class="t"><b>Перед публикацией: ${n} ${n === 1 ? 'проблема' : 'проблем'} на карте</b><span>Посмотреть</span></span></button>` : ''; })()}
        <button class="btn primary full" data-act="publishNow">${icon('publish')}Опубликовать</button></div>
        <dl class="kv"><dt>Объектов</dt><dd>${map.shapes.length}</dd><dt>Меток</dt><dd>${map.pois.length}</dd><dt>Точек обзора</dt><dd>${map.panos.length} (с фото: ${map.panos.filter((p) => p.img).length})</dd><dt>Переходов</dt><dd>${map.links.length}</dd></dl>`;
    }
    if (name === 'check') {
      const list = mapIssues();
      h += list.length ? `<p class="cap" style="margin:0">Нажмите на замечание, чтобы перейти к объекту.</p><div class="list">${list.map((x) => `<${x.sel ? `button data-sel="${x.sel}"` : 'div'} class="item issue ${x.bad ? 'bad' : ''}"><span class="ck">!</span><span class="t"><b>${esc(x.t)}</b></span></${x.sel ? 'button' : 'div'}>`).join('')}</div>
        ${list.some((x) => x.fix === 'brokenLinks') && !state.readonly ? '<button class="btn sm dark" data-act="fixLinks">Убрать битые и повторные переходы</button>' : ''}`
        : '<div class="card"><b>Всё в порядке</b><p class="cap" style="margin:0">Битых переходов, точек без связей и дублей не нашлось.</p></div>';
    }
    if (name === 'versions') { h += '<div class="list" id="vers"><p class="cap">Загружаю…</p></div>'; loadVersions(); }
    if (name === 'colors') {
      h += `<div class="field"><span class="lbl">Готовые схемы</span><div class="row"><button class="btn sm" data-act="preset" data-v="scheme">Как на схеме</button><button class="btn sm" data-act="preset" data-v="club">Жёлто-синяя</button><button class="btn sm" data-act="preset" data-v="calm">Спокойная</button></div></div>
        <div class="field"><span class="lbl">Типы объектов</span>${Object.entries(CATS).filter(([c]) => c !== 'plaza').map(([c, v]) => `<div class="row nowrap" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:5px 0"><span class="row nowrap"><span class="dot" style="background:${catColor(map, c)}"></span>${v.n}</span><input type="color" data-catcolor="${c}" value="${catColor(map, c)}" ${dis()}></div>`).join('')}</div>
        <div class="field"><span class="lbl">Типы меток</span>${Object.entries(PCATS).map(([c, v]) => `<div class="row nowrap" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:5px 0"><span class="row nowrap"><span class="glyph sm" style="background:${map.style.poi[c] || v.c}">${esc(v.g)}</span>${v.n}</span><input type="color" data-poicolor="${c}" value="${map.style.poi[c] || v.c}" ${dis()}></div>`).join('')}</div>`;
    }
    if (name === 'floors') {
      const count = (f) => ['shapes', 'walls', 'doors', 'stairs', 'pois', 'panos'].reduce((n, k) => n + map[k].filter((o) => floorOf(o) === f.id).length, 0);
      h += `<p class="cap" style="margin:0">Каждый этаж рисуется отдельно: объекты разных этажей не накладываются друг на друга. Нижний этаж виден бледным контуром — по нему удобно выравнивать. Лестница ведёт на этаж выше, по ней строится маршрут.</p>
        <div class="list">${[...floorsSorted(map)].reverse().map((f, i, all) => `<div class="floor-row">
          <span class="glyph sm mono" style="background:${f.id === state.floor ? 'var(--pano)' : 'var(--ink-3)'}">${all.length - i}</span>
          <input class="inp" data-flname="${f.id}" value="${esc(f.name)}" aria-label="Название этажа" ${dis()}>
          <label class="field fl-elev"><span class="lbl">Отметка, м</span><input class="inp mono" type="number" step="0.1" data-flelev="${f.id}" value="${f.elev}" ${dis()} ${f.id === groundId() ? 'disabled title="Нижний этаж — уровень земли"' : ''}></label>
          <span class="cap">${count(f)} объектов</span>
          ${state.readonly || f.id === groundId() ? '' : `<button class="iconbtn flat" data-act="delFloor" data-id="${f.id}" aria-label="Удалить этаж">${icon('erase')}</button>`}</div>`).join('')}</div>
        ${state.readonly ? '' : `<button class="btn dark" data-act="addFloor">${icon('layers')}Добавить этаж сверху</button>`}`;
    }
    if (name === 'mascot') {
      const ms = mascotSettings(map);
      h += `<p class="cap" style="margin:0">Маскот ТТК прячется за правым краем карты. По нажатию выходит и здоровается случайной фразой из списка, а в панорамах рассказывает о месте — текст пишется у каждой точки обзора («Рассказ маскота»). Изменения увидят после публикации.</p>
        <label class="row nowrap" style="justify-content:space-between"><span>Показывать маскота посетителям</span><input type="checkbox" class="switch" id="f-mascot-on" ${ms.enabled ? 'checked' : ''} ${dis()}></label>
        <div class="field"><span class="lbl">Размер на экране · <b id="ms-size">${Math.round(ms.size * 100)}%</b></span><input type="range" id="f-mascot-size" min="0.5" max="2" step="0.05" value="${ms.size}" ${dis()}></div>
        <div class="field"><span class="lbl">${icon('volume')}Громкость голоса · <b id="ms-vol">${Math.round(ms.volume * 100)}%</b></span><input type="range" id="f-mascot-vol" min="0" max="1" step="0.05" value="${ms.volume}" ${dis()}></div>
        <div class="field"><span class="lbl">Фразы приветствия · по одной на строку, выбираются случайно</span>
          <textarea class="inp" id="f-mascot-phrases" rows="9" ${dis()}>${esc(ms.phrases.join('\n'))}</textarea></div>
        <div class="row"><button class="btn sm dark" data-act="mascotTest">${icon('chat')}Проверить приветствие</button>${state.readonly ? '' : '<button class="btn sm ghost" data-act="mascotReset">Вернуть стандартные фразы</button>'}</div>`;
    }
    if (name === 'visitors') {
      const opt = (k, v, n) => `<option value="${v}" ${visitorLayerMode(map, k) === v ? 'selected' : ''}>${n}</option>`;
      h += `<p class="cap" style="margin:0">Выберите, какие слои посетитель видит на карте. «Скрыт» — не виден сразу, но посетитель может включить его в «Слоях». «Недоступен» — посетитель его не увидит совсем. Изменения увидят после публикации.</p>
        <div class="list">${layersFor(map, false).map((l) => `<div class="item vl-row"><span class="t"><b>${l.n}</b></span>
          <select class="inp sm" data-vl="${l.k}" ${dis()}>${opt(l.k, 'on', 'Показан')}${opt(l.k, 'off', 'Скрыт, можно включить')}${opt(l.k, 'none', 'Недоступен')}</select></div>`).join('')}</div>`;
    }
    sheet.set(`<div class="insp">${h}</div>`, 'full');
  }

  // ---------- этажи ----------
  function floorBar() {
    const fs = floorsSorted(map);
    $('#floorBar').innerHTML = fs.length < 2 && !isEditor ? '' : `<span class="cap">Этаж</span>${fs.map((f, i) => `<button data-floor="${f.id}" aria-pressed="${f.id === state.floor}" title="${esc(f.name)} · ${f.elev} м">${i + 1}</button>`).join('')}
      <button class="fl-more" data-act="panel" data-p="floors" title="Этажи: добавить, переименовать">${fs.length < 2 ? '+ этаж' : '⋯'}</button>`;
  }
  function setFloor(id) {
    state.floor = id; state.sel = null; tools.reset();
    plan.set({ floor: id }); floorBar(); redraw(); inspector();
    if (scene) scene.setFloorView(map.floors.length > 1 ? id : null);
    toast(floorById(map, id).name);
  }
  async function loadVersions() {
    try {
      const vs = await api.versions();
      $('#vers').innerHTML = vs.map((v, i) => `<div class="item"><span class="glyph sm mono" style="background:${i === 0 ? 'var(--ok)' : 'var(--ink-3)'}">${v.number}</span><span class="t"><b>${esc(v.comment || 'Без описания')}</b><span>${fmtDate(v.published_at)}${v.published_by ? ' · ' + esc(v.published_by) : ''}${i === 0 ? ' · сейчас у посетителей' : ''}</span></span>${isAdmin && i > 0 ? `<button class="btn sm" data-act="restore" data-id="${v.id}">Вернуть</button>` : ''}</div>`).join('');
    } catch (e) { $('#vers').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  function syncFields() {
    const o = ed.find(state.sel); if (!o) return;
    const set = (id, v) => { const el = $('#' + id); if (el && document.activeElement !== el) el.value = +(+v).toFixed(2); };
    if (o.type === 'rect' || state.sel.type === 'stairs') { set('f-w', o.w); set('f-h', o.h); set('f-x', o.x); set('f-y', o.y); }
    if (o.type === 'ellipse') { set('f-rx2', o.rx * 2); set('f-ry2', o.ry * 2); }
    if (state.sel.type === 'poi') { set('f-mx', o.x); set('f-my', o.y); }
  }

  // ---------- 3D-просмотр ----------
  async function setView(v) {
    state.view = v;
    if (v === '3d' && !scene) {
      const { Scene3D } = await import('../core/scene3d.js');
      scene = new Scene3D(three, { onPick: pick3d });
      scene.questAlways = true;   // в конструкторе пиксели охоты видны и в обычном 3D
      scene.setHidden(state.hidden);
      window.addEventListener('themechange', () => scene.setMap(map), { signal: window.__ac?.signal });
      if (map.floors.length > 1) scene.topFloor = state.floor;
    }
    svg.toggleAttribute('hidden', v !== '2d'); three.hidden = v !== '3d';
    $('.zoombox', root).hidden = v !== '2d'; $('#tb').style.visibility = v === '3d' ? 'hidden' : '';
    if (scene) { scene.setActive(v === '3d'); if (v === '3d') { scene.setMap(map); if (!scene._init) { scene.overview(true); scene._init = true; } } }
    $('[data-act="view3d"]', root).style.color = v === '3d' ? 'var(--pano)' : '';
    if (v === '2d') { $('.look-exit', root).hidden = true; root.querySelector('.canvas .pano-embed')?.remove(); closeTune(); plan.render(); }
    optbar();
  }
  function pick3d(hit) {
    if (scene.look) {
      if (hit.type === 'arrow') {
        const q = map.panos.find((p) => p.id === hit.id); if (!q || scene.gliding) return;
        leaveTune().then((ok) => {
          if (!ok) return;
          scene.setArrows([]);
          scene.glideTo(q.x, q.y, elevOf(map, q) + (q.z || 0) + 1.6, () => { const nb = neighbors(map, q.id); scene.setArrows(arrowItems(q, nb)); scene.preload(nb.map((n) => n.img)); state.sel = { type: 'pano', id: q.id }; inspector(); openTune(q); }, { url: q.img, rot: q.photoRot });
        });
      }
      return;
    }
    if (hit.type !== 'ref') return;
    const r = hit.ref;
    if (r.startsWith('sec:')) return ed.select({ type: 'sector', id: r.slice(4) });
    for (const [t, l] of [['shape', 'shapes'], ['poi', 'pois'], ['pano', 'panos'], ['wall', 'walls'], ['stairs', 'stairs']]) if (map[l].some((x) => x.id === r)) return ed.select({ type: t, id: r });
  }
  async function focus3d() {
    const s = state.sel, o = ed.find(s); if (!o) return;
    await setView('3d');
    if (s.type === 'sector') { const m = secMid(sector(s.id)); scene.focusFrom(m.xy[0], m.xy[1], m.z, ST.cx, ST.cy); }
    else if (s.type === 'shape') { const c = shapeCenter(o), b = shapeBox(o); scene.focus(c.x, c.y, Math.max(40, Math.max(b.w, b.h) * 1.3)); }
    else scene.focus(o.x, o.y, 50);
  }
  async function lookPano() {
    const p = ed.find(state.sel); await setView('3d');
    const nb = neighbors(map, p.id);
    scene.enterLook(p.x, p.y, elevOf(map, p) + (p.z || 0) + 1.6, faceOf(p, nb), startView(p) || {}); scene.setPhoto(p.img || null, p.photoRot); scene.setArrows(arrowItems(p, nb)); scene.preload(nb.map((n) => n.img));
    $('.look-exit', root).hidden = false; openTune(p);
    // панорама Google или видео YouTube — как у посетителя, поверх 3D
    const src = mapsEmbed(p.embed);
    if (src) { const box = Object.assign(document.createElement('div'), { className: 'pano-embed' }); box.innerHTML = `<iframe src="${esc(src)}" title="${esc(p.name)}" allow="accelerometer; gyroscope; encrypted-media; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`; $('.canvas', root).append(box); }
  }
  async function exitLook() {
    if (!scene) return;
    if (!(await leaveTune())) return;
    scene.exitLook(); $('.look-exit', root).hidden = true; root.querySelector('.canvas .pano-embed')?.remove(); closeTune();
  }

  // ---------- настройка панорамы: поворот фото, вид при открытии, стрелки по фото ----------
  // Правки сначала видны только здесь; в карту попадают по «Сохранить» (одним шагом отмены), «Отменить» — вернуть как было.
  let tune = null;
  const RADD = 180 / Math.PI, norm = (d) => +((((d % 360) + 360) % 360).toFixed(1));
  const tunePick = (p) => clone({ photoRot: p.photoRot || 0, view: p.view || null, arrows: p.arrows || {} });
  const tuneDirty = () => tune && JSON.stringify(tune.cur) !== JSON.stringify(tune.orig);
  const tunePano = () => tune && map.panos.find((x) => x.id === tune.id);
  function openTune(p) {
    if (state.readonly) return;
    tune = { id: p.id, orig: tunePick(p), cur: tunePick(p) };
    scene.onLook = () => { const el = $('#tuneAt', root); if (el && scene.look) el.textContent = `взгляд ${norm(scene.look.yaw * RADD)}° · наклон ${Math.round(scene.look.pitch * RADD)}°`; };
    renderTune();
  }
  function closeTune() { tune = null; const el = $('#tune', root); el.hidden = true; el.innerHTML = ''; if (scene) scene.onLook = null; }
  async function leaveTune() {
    if (!tuneDirty()) return true;
    const ok = await confirmBox('Настройки панорамы не сохранены. Выйти без сохранения?', { ok: 'Выйти без сохранения', cancel: 'Остаться' });
    if (ok) { tune.cur = clone(tune.orig); applyTune(); }
    return ok;
  }
  function applyTune() {
    const p = tunePano(); if (!p || !scene?.look) return;
    const v = { ...p, ...tune.cur };
    scene.setPhotoRot(v.photoRot); scene.setArrows(arrowItems(v, neighbors(map, p.id)));
    renderTune();
  }
  function renderTune() {
    const p = tunePano(), el = $('#tune', root); if (!p || !el) return;
    const c = tune.cur, nb = neighbors(map, p.id), photo = !!p.img;
    el.hidden = false;
    el.innerHTML = `<div class="row nowrap" style="justify-content:space-between"><b>Настройка панорамы</b><span class="cap mono" id="tuneAt"></span></div>
      ${photo ? `<div class="tune-row"><span class="cap">Поворот фото · <b class="mono">${norm(c.photoRot)}°</b></span><div class="row nowrap"><button class="btn sm" data-act="tuneRot" data-d="-5">↺ 5°</button><button class="btn sm" data-act="tuneRot" data-d="-1">↺ 1°</button><button class="btn sm" data-act="tuneRot" data-d="1">↻ 1°</button><button class="btn sm" data-act="tuneRot" data-d="5">↻ 5°</button><button class="btn sm" data-act="tuneRot" data-d="90">↻ 90°</button></div></div>` : '<p class="cap" style="margin:0">Вид из 3D-модели: фото нет, поворачивать нечего.</p>'}
      <div class="tune-row"><span class="cap">Вид при открытии · ${c.view ? `<b class="mono">${norm(c.view.u)}°, наклон ${Math.round(c.view.pitch)}°</b>` : 'по направлению на соседнюю точку'}</span><div class="row nowrap"><button class="btn sm" data-act="tuneView">Запомнить текущий вид</button>${c.view ? '<button class="btn sm ghost" data-act="tuneViewRm">Сбросить</button>' : ''}</div></div>
      ${photo && nb.length ? `<div class="tune-row"><span class="cap">Стрелки переходов: повернитесь туда, где на фото видна соседняя точка, и нажмите «Сюда» — стрелка встанет в центр экрана. «Совместить» поворачивает всё фото так, чтобы стрелка по плану совпала с этим местом.</span>
        <div class="tune-arrows">${nb.map((q) => `<div class="row nowrap"><span class="t2"><b>${esc(q.name)}</b><span>${Number.isFinite(c.arrows[q.id]) ? `вручную · ${norm(c.arrows[q.id])}°` : 'по плану'}</span></span>
          <button class="btn sm" data-act="tuneArrow" data-id="${q.id}">Сюда</button><button class="btn sm ghost" data-act="tuneAlign" data-id="${q.id}">Совместить</button>${Number.isFinite(c.arrows[q.id]) ? `<button class="iconbtn flat" data-act="tuneArrowRm" data-id="${q.id}" aria-label="Стрелка по плану">${icon('close')}</button>` : ''}</div>`).join('')}</div></div>` : ''}
      <div class="row"><button class="btn sm primary" data-act="tuneSave" ${tuneDirty() ? '' : 'disabled'}>${icon('check')}Сохранить</button><button class="btn sm" data-act="tuneCancel" ${tuneDirty() ? '' : 'disabled'}>Отменить изменения</button><button class="btn sm ghost danger" data-act="tuneReset">Сбросить всё</button></div>`;
    scene?.onLook?.();
  }
  function tuneAct(a, t) {
    const c = tune.cur, L = scene.look, phi = (c.photoRot || 0) / RADD;
    if (a === 'tuneRot') c.photoRot = norm(c.photoRot + +t.dataset.d);
    if (a === 'tuneView') c.view = { u: norm((L.yaw + phi) * RADD), pitch: Math.round(L.pitch * RADD), fov: Math.round(L.fov) };
    if (a === 'tuneViewRm') c.view = null;
    if (a === 'tuneArrow') c.arrows = { ...c.arrows, [t.dataset.id]: norm((L.yaw + phi) * RADD) };
    if (a === 'tuneArrowRm') { c.arrows = { ...c.arrows }; delete c.arrows[t.dataset.id]; }
    if (a === 'tuneAlign') {
      // то, что сейчас в центре экрана, ставим точно по направлению на соседнюю точку
      const p = tunePano(), q = map.panos.find((x) => x.id === t.dataset.id), psi = Math.atan2(q.y - p.y, q.x - p.x);
      c.photoRot = norm((L.yaw + phi - psi) * RADD); c.arrows = { ...c.arrows }; delete c.arrows[q.id];
      L.yaw = psi; scene.applyLook();
    }
    if (a === 'tuneReset') { c.photoRot = 0; c.view = null; c.arrows = {}; }
    if (a === 'tuneCancel') tune.cur = clone(tune.orig);
    if (a === 'tuneSave') {
      const p = tunePano(), v = clone(tune.cur);
      ed.change(() => {
        if (v.photoRot) p.photoRot = v.photoRot; else delete p.photoRot;
        if (v.view) p.view = v.view; else delete p.view;
        const ar = Object.fromEntries(Object.entries(v.arrows).filter(([id]) => map.panos.some((x) => x.id === id)));
        if (Object.keys(ar).length) p.arrows = ar; else delete p.arrows;
      }, 'Настройки панорамы сохранены');
      tune.orig = clone(v);
    }
    applyTune();
  }

  // ---------- события ----------
  const keyMap = {};
  for (const m of Object.keys(TOOLS)) for (const t of TOOLS[m]) keyMap[t.key] = t.id;
  function setTool(t) { tools.reset(); state.tool = t; toolbar(); optbar(); redraw(); if (state.view === '3d') setView('2d'); }
  function setMode(m) {
    state.mode = m; state.sel = null; state.panel = null;
    $$('[data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === m));
    setTool('select'); inspector();
    if (m === 'stadium') plan.focus(ST.cx, ST.cy, 300);
  }
  function $$(s) { return [...root.querySelectorAll(s)]; }
  function upload(onUrl) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { toast('Загружаю фото…'); const r = await api.upload(f); ed.change(() => onUrl(r.url), 'Фото добавлено'); } catch (e) { toast(e.message, 4000); } };
    inp.click();
  }

  function uploadPano360(o) {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const { w, h } = await checkPanoFile(f);
        if (!(await previewPano(f, { title: o.img ? `Новое фото для «${o.name}»` : `Фото 360° для «${o.name}»`, info: `${w} × ${h} · ${(f.size / 1048576).toFixed(1)} МБ · ведите, чтобы осмотреться` }))) return;
        toast('Загружаю фото…', 8000);
        const r = await api.upload(f, 'pano360'), had = !!o.img;
        ed.change(() => { o.img = r.url; }, had ? 'Фото заменено — поворот, вид и стрелки сохранены' : 'Фото 360° добавлено');
      } catch (e) { toast(e.message, 6000); }
    };
    inp.click();
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tool],[data-mode],[data-opt],[data-act],[data-sel],[data-floor]'); if (!t) return;
    if (t.dataset.floor) return setFloor(t.dataset.floor);
    if (t.dataset.tool) return setTool(t.dataset.tool);
    if (t.dataset.mode) return setMode(t.dataset.mode);
    if (t.dataset.opt) { const k = t.dataset.opt, v = t.dataset.v; state[k] = ['snap', 'wallThick', 'doorWidth'].includes(k) ? +v : v; optbar(); return; }
    if (t.dataset.sel) { const [type, id] = t.dataset.sel.split(':'); ed.select({ type, id }); const o = ed.find(state.sel); if (o) { const c = type === 'shape' ? shapeCenter(o) : o; plan.focus(c.x, c.y, Math.max(120, type === 'shape' ? shapeBox(o).w * 2.2 : 120)); } return; }
    const a = t.dataset.act, s = state.sel, o = ed.find(s);
    if (a === 'undo' && undo.length) { redo.push(JSON.stringify(map)); map = JSON.parse(undo.pop()); plan.setMap(map); if (!ed.find(state.sel)) state.sel = null; ed.changed(); toast('Отменено'); }
    if (a === 'redo' && redo.length) { undo.push(JSON.stringify(map)); map = JSON.parse(redo.pop()); plan.setMap(map); ed.changed(); }
    if (a === 'view3d') setView(state.view === '3d' ? '2d' : '3d');
    if (a === 'layers') { const p = $('#lyPop'); p.hidden = !p.hidden; if (!p.hidden) layersPop(); return; }
    if (a === 'layersAll') { state.hidden.clear(); applyLayers(); layersPop(); return; }
    if (a === 'copy') { copySel(); return; }
    if (a === 'zin') plan.zoomAt({ x: plan.view.x + plan.view.w / 2, y: plan.view.y + plan.view.h / 2 }, 1 / 1.4);
    if (a === 'zout') plan.zoomAt({ x: plan.view.x + plan.view.w / 2, y: plan.view.y + plan.view.h / 2 }, 1.4);
    if (a === 'zfit') plan.fitAll();
    if (a === 'finish') tools.finish();
    if (a === 'undoPoint') tools.undoPoint();
    if (a === 'escape') tools.escape();
    if (a === 'desel') ed.select(null);
    if (a === 'panel') panel(t.dataset.p);
    if (a === 'closePanel') { state.panel = null; inspector(); }
    if (a === 'exitLook') exitLook();
    if (a.startsWith('tune') && tune && scene?.look && !state.readonly) return tuneAct(a, t);
    if (a === 'viewCyl' && o?.pano) { const { openCylPano } = await import('../core/cylpano.js'); openCylPano({ url: o.pano, title: o.name }); return; }
    if (state.readonly && !['panel', 'closePanel', 'reload', 'show3d', 'lookPano', 'desel'].includes(a)) return;
    if (a === 'kind') ed.change(() => { o.kind = t.dataset.v; if (KINDS[o.kind].walls && !o.height) o.height = KINDS[o.kind].height; });
    if (a === 'cat') ed.change(() => { o.cat = t.dataset.v; });
    if (a === 'pcat') ed.change(() => { if (o.name === 'Новая метка' || o.name === PCATS[o.cat]?.n) o.name = PCATS[t.dataset.v].n; o.cat = t.dataset.v; });
    if (a === 'sdir') ed.change(() => { o.dir = t.dataset.v; });
    if (a === 'shapeColor' || a === 'poiColor' || a === 'wallColor') ed.change(() => { o.color = t.dataset.c; });
    if (a === 'shapeColorReset') ed.change(() => { delete o.color; });
    if (a === 'secColor') ed.change(() => { map.sectors[s.id] = { ...map.sectors[s.id], color: t.dataset.c }; plan.stadCache.key = null; });
    if (a === 'secColorReset') ed.change(() => { delete map.sectors[s.id].color; plan.stadCache.key = null; });
    if (a === 'dup') duplicate();
    if (a === 'paste') paste(null);
    if (a === 'del') { if (!o || !LISTS[s.type] || o.cat === 'plaza' || !(await ed.confirmDelete(s, o))) return; const list = LISTS[s.type]; ed.change(() => { map[list] = map[list].filter((x) => x.id !== s.id); if (s.type === 'pano') map.links = map.links.filter((l) => !l.includes(s.id)); }, 'Удалено'); ed.select(null); }
    if (a === 'unlink') ed.change(() => { map.links = map.links.filter((l) => !(l.includes(s.id) && l.includes(t.dataset.id))); }, 'Переход убран');
    if (a === 'photo') upload((url) => (o.photo = url));
    if (a === 'slugFromName' && o) ed.change(() => { o.slug = uniqueSlug(map, slugify(o.name), o.id); }, 'Адрес обновлён');
    if (a === 'setIcon' && o) ed.change(() => { delete o.iconUrl; if (t.dataset.v === (s.type === 'pano' ? 'pano' : o.cat)) delete o.icon; else o.icon = t.dataset.v; }, 'Значок изменён');
    if (a === 'iconUp' && o) upload((url) => { o.iconUrl = url; delete o.icon; });
    if (a === 'iconReset' && o) ed.change(() => { delete o.icon; delete o.iconUrl; }, 'Значок — как у типа');
    if (a === 'fixLinks') {
      const ids = new Set(map.panos.map((p) => p.id)), seen = new Set();
      ed.change(() => { map.links = map.links.filter((l) => { const k = [...l].sort().join('|'); if (!ids.has(l[0]) || !ids.has(l[1]) || l[0] === l[1] || seen.has(k)) return false; seen.add(k); return true; }); }, 'Переходы исправлены');
      panel('check');
    }
    if (a === 'photoRm') ed.change(() => delete o.photo);
    if (a === 'mascotTest') { testMascot().greet(); return; }
    if (a === 'mascotGuide' && o) { testMascot().guide(o.guide); return; }
    if (a === 'mascotReset') { ed.change(() => { map.mascot = { ...(map.mascot || {}), phrases: [...DEFAULT_PHRASES] }; }, 'Стандартные фразы возвращены'); testMascot(true); panel('mascot'); return; }
    if (a === 'cylPano') upload((url) => (o.pano = url));
    if (a === 'cylPanoRm') ed.change(() => delete o.pano);
    if (a === 'pano360') uploadPano360(o);
    if (a === 'pano360Rm') { if (await confirmBox(`Убрать фото 360° у «${o.name}»? Вид снова будет строиться из 3D-модели.`, { ok: 'Убрать фото' })) ed.change(() => delete o.img, 'Фото убрано'); }
    if (a === 'addFloor') {
      const fs = floorsSorted(map), top = fs.at(-1), nf = { id: uid('f'), name: `${fs.length + 1} этаж`, elev: +((top.elev || 0) + 4).toFixed(2) };
      ed.change(() => { map.floors = [...map.floors, nf]; }, `Добавлен ${nf.name} на отметке ${nf.elev} м`);
      setFloor(nf.id); panel('floors');
    }
    if (a === 'delFloor') {
      const id = t.dataset.id, f = floorById(map, id);
      if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.style.color = 'var(--accent)'; toast(`Нажмите ещё раз — удалится «${f.name}» со всем, что на нём нарисовано`); return; }
      ed.change(() => {
        for (const k of ['shapes', 'walls', 'doors', 'stairs', 'pois', 'panos']) map[k] = map[k].filter((o) => floorOf(o) !== id);
        const ids = new Set(map.panos.map((p) => p.id)); map.links = map.links.filter(([p, q]) => ids.has(p) && ids.has(q));
        map.floors = map.floors.filter((x) => x.id !== id);
      }, `«${f.name}» удалён`);
      if (state.floor === id) setFloor(groundId()); else floorBar();
      panel('floors');
    }
    if (a === 'underUp') uploadUnderlay();
    if (a === 'underRm') { ed.change(() => delete map.underlay, 'Подложка убрана'); inspector(); }
    if (a === 'show3d') focus3d();
    if (a === 'lookPano') lookPano();
    if (a === 'preset') {
      const v = t.dataset.v;
      ed.change(() => {
        map.style.cats = {}; map.style.poi = {}; map.sectors = Object.fromEntries(Object.entries(map.sectors).map(([k, x]) => [k, { text: x.text }]));
        map.style.stands = v === 'club' ? { A: '#1f4aa6', B: '#e0b100', C: '#1f4aa6', D: '#e0b100' } : v === 'calm' ? { A: '#5b7fbf', B: '#6aa77a', C: '#c27a7a', D: '#d1a85b' } : {};
        if (v === 'calm') map.style.cats = { parking: '#9a8f8f', events: '#d79b6b', entrance: '#b8708a', service: '#9682b8', leisure: '#9cc29c' };
        plan.stadCache.key = null;
      }, 'Цвета применены'); panel('colors');
    }
    if (a === 'publishNow') {
      t.disabled = true;
      try { if (state.dirty) await save(); const v = await api.publish($('#f-comment').value.trim()); toast(`Опубликована версия ${v.number} — посетители уже её видят`, 3500); panel('versions'); }
      catch (ex) { toast(ex.message, 4000); t.disabled = false; }
    }
    if (a === 'restore') {
      if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = 'Точно?'; t.classList.add('primary'); return; }
      try { const d = await api.restore(+t.dataset.id); map = d.data; state.rev = d.revision; state.dirty = false; plan.setMap(map); rebuildLater(); status(); toast('Версия скопирована в черновик. Опубликуйте, чтобы её увидели посетители', 4000); panel('publish'); } catch (ex) { toast(ex.message, 4000); }
    }
    if (a === 'exportJson') {
      const url = URL.createObjectURL(new Blob([JSON.stringify(map, null, 1)], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: `${venue.slug}.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (a === 'importJson' && isEditor) {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
      inp.onchange = async () => {
        try { const d = JSON.parse(await inp.files[0].text()); if (!Array.isArray(d.shapes) || !Array.isArray(d.panos)) throw new Error('Это не файл карты');
          ed.change(() => { map = { ...map, ...d }; }); plan.setMap(map); ed.select(null); toast('Карта загружена в черновик'); }
        catch (ex) { toast('Не получилось: ' + ex.message, 4000); }
      };
      inp.click();
    }
    if (a === 'reload') reloadDraft();
  });

  let snapped = false;
  root.addEventListener('focusin', (e) => { if (e.target.closest('.sheet-body') && e.target.matches('.inp') && !state.readonly) snapped = false; });
  root.addEventListener('input', (e) => {
    const t = e.target, o = ed.find(state.sel);
    if (t.id === 'f-under') { state.underOp = +t.value; redraw(); return; }
    if (t.id === 'o-nw' || t.id === 'o-nh') { const n = +t.value; if (n >= 0.5 && n <= 2000) state[t.id === 'o-nw' ? 'newW' : 'newH'] = n; return; }
    if (['f-mascot-size', 'f-mascot-vol', 'f-mascot-phrases'].includes(t.id) && !state.readonly) {
      if (!snapped) { ed.snapshot(); snapped = true; }
      map.mascot = { ...(map.mascot || {}) };
      if (t.id === 'f-mascot-size') { map.mascot.size = +t.value; $('#ms-size').textContent = Math.round(t.value * 100) + '%'; }
      if (t.id === 'f-mascot-vol') { map.mascot.volume = +t.value; $('#ms-vol').textContent = Math.round(t.value * 100) + '%'; }
      if (t.id === 'f-mascot-phrases') map.mascot.phrases = t.value.split('\n').map((x) => x.trim()).filter(Boolean);
      markDirty(); testMascot(true); return;
    }
    if ((t.dataset.flname || t.dataset.flelev) && !state.readonly) {
      const f = map.floors.find((x) => x.id === (t.dataset.flname || t.dataset.flelev)); if (!f) return;
      if (!snapped) { ed.snapshot(); snapped = true; }
      if (t.dataset.flname) f.name = t.value.slice(0, 60) || f.name;
      else if (t.value !== '' && !Number.isNaN(+t.value)) f.elev = +t.value;
      markDirty(); floorBar(); rebuildLater(); return;
    }
    if (['f-uw', 'f-ux', 'f-uy'].includes(t.id) && map.underlay && !state.readonly) {
      const n = +t.value, u = map.underlay; if (t.value === '' || Number.isNaN(n)) return;
      if (!snapped) { ed.snapshot(); snapped = true; }
      if (t.id === 'f-uw') { const w = Math.max(5, n); u.h = (u.h * w) / u.w; u.w = w; } else u[t.id === 'f-ux' ? 'x' : 'y'] = n;
      markDirty(); redraw(); return;
    }
    if (t.id === 'f-sec') { const sec = SECTORS.find((x) => x.id.toLowerCase() === t.value.trim().toLowerCase()); if (sec) { ed.select({ type: 'sector', id: sec.id }); const m = secMid(sec); plan.focus(m.xy[0], m.xy[1], 120); } return; }
    if (state.readonly) return;
    if (t.dataset.stand || t.dataset.catcolor || t.dataset.poicolor || t.dataset.color) {
      if (!snapped) { ed.snapshot(); snapped = true; }
      if (t.dataset.stand) map.style.stands[t.dataset.stand] = t.value;
      if (t.dataset.catcolor) map.style.cats[t.dataset.catcolor] = t.value;
      if (t.dataset.poicolor) map.style.poi[t.dataset.poicolor] = t.value;
      if (t.dataset.color === 'secColor') map.sectors[state.sel.id] = { ...map.sectors[state.sel.id], color: t.value };
      else if (t.dataset.color && o) o.color = t.value;
      plan.stadCache.key = null; markDirty(); redraw(); rebuildLater(); return;
    }
    if (!state.sel || t.type === 'checkbox') return;
    if (!snapped) { ed.snapshot(); snapped = true; }
    const v = t.value, n = +v, ok = v !== '' && !Number.isNaN(n);
    const map1 = { 'f-name': ['name'], 'f-desc': ['desc'], 'f-mname': ['name'], 'f-mtext': ['text'], 'f-pname': ['name'], 'f-guide': ['guide'] };
    if (map1[t.id]) { o[map1[t.id][0]] = v; const h2 = $('.insp-head h2', root); if (h2 && /name/.test(t.id)) h2.textContent = v; }
    if (t.id === 'f-stext') map.sectors[state.sel.id] = { ...map.sectors[state.sel.id], text: v };
    if (t.id === 'f-pslug') {
      const v2 = v.trim().toLowerCase(), msg = $('#slugMsg');
      if (!v2) { delete o.slug; msg.textContent = 'Ссылка будет вести по внутреннему номеру точки.'; }
      else if (!SLUG_RE.test(v2)) { msg.textContent = 'Только латиница, цифры и дефис, начинается с буквы или цифры'; return; }
      else if (map.panos.some((x) => x.id !== o.id && x.slug === v2)) { msg.textContent = 'Такой адрес уже у другой точки'; return; }
      else { o.slug = v2; msg.textContent = 'Адрес сохранится автоматически. Старые ссылки с прежним адресом перестанут работать.'; }
    }
    if (t.id === 'f-pembed') { if (v.trim()) o.embed = mapsEmbed(v) || v.trim(); else delete o.embed; }
    if (ok) {
      const nums = { 'f-w': 'w', 'f-h': 'h', 'f-x': 'x', 'f-y': 'y', 'f-height': 'height', 'f-thick': 'thick', 'f-wh': 'height', 'f-dw': 'w', 'f-rise': 'rise', 'f-mx': 'x', 'f-my': 'y' };
      if (nums[t.id]) o[nums[t.id]] = ['w', 'h', 'height', 'thick', 'rise'].includes(nums[t.id]) ? Math.max(0.05, n) : n;
      if (t.id === 'f-rx2') o.rx = Math.max(0.5, n / 2);
      if (t.id === 'f-ry2') o.ry = Math.max(0.5, n / 2);
    }
    if (o?.cat === 'plaza' && o.type === 'rect') map.bounds = { w: +o.w.toFixed(2), h: +o.h.toFixed(2) };
    markDirty(); redraw(); rebuildLater();
  });
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'f-real') ed.change(() => { map.style.realSeats = t.checked; });
    if (t.id === 'f-mascot-on' && !state.readonly) { ed.change(() => { map.mascot = { ...(map.mascot || {}), enabled: t.checked }; }, t.checked ? 'Маскот включён' : 'Маскот выключен'); testMascot(true); }
    if (t.dataset.layer) { state.hidden[t.checked ? 'delete' : 'add'](t.dataset.layer); applyLayers(); layersPop(); }
    if (t.dataset.vl && !state.readonly) { const k = t.dataset.vl, v = t.value; ed.change(() => { if (v === 'on') delete map.visitorLayers[k]; else map.visitorLayers[k] = v; }, 'Сохранено — посетители увидят после публикации'); }
    if (t.id === 'f-objfloor' && !state.readonly) {
      const s = state.sel, o = ed.find(s), v = t.value;
      ed.change(() => { if (v === groundId()) delete o.floor; else o.floor = v; }, `Перенесено: ${floorById(map, v).name}`);
      setFloor(v); ed.select(s);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    // буква клавиши по её месту, а не по раскладке: Ctrl+C работает и в русской раскладке (там это «с»)
    const key = e.code?.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); $(`[data-act="${e.shiftKey ? 'redo' : 'undo'}"]`, root).click(); return; }
    if (mod && key === 'y') { e.preventDefault(); $('[data-act="redo"]', root).click(); return; }
    if (mod && key === 's') { e.preventDefault(); save(); return; }
    if (mod && key === 'c') { if (window.getSelection()?.toString()) return; e.preventDefault(); copySel(); return; }
    if (mod && key === 'x') { e.preventDefault(); if (copySel()) $('[data-act="del"]', root)?.click(); return; }
    if (mod && key === 'v') { e.preventDefault(); paste(state.view === '2d' ? state.cursor : null); return; }
    if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
    if (e.key === 'Escape') { if (scene?.look) exitLook(); else if (tools.busy()) tools.escape(); else ed.select(null); return; }
    if (e.key === 'Enter' && tools.busy()) { tools.finish(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel && !state.readonly && state.sel.type !== 'sector') { $('[data-act="del"]', root)?.click(); return; }
    const t = keyMap[key];
    if (t && !mod && !e.altKey && !state.readonly && TOOLS[state.mode].some((x) => x.id === t)) setTool(t);
  }, { signal: window.__ac?.signal });
  window.addEventListener('beforeunload', (e) => { if (state.dirty && isEditor) { save(); e.preventDefault(); } }, { signal: window.__ac?.signal });

  // ---------- совместная работа: один редактор, остальные видят его сохранения ----------
  const timers = [];
  window.__ac?.signal.addEventListener('abort', () => timers.forEach(clearInterval));
  if (isEditor && !lockedBy) {
    // держим замок, пока открыт конструктор; потеряли (долго не было сети) — переходим в просмотр
    timers.push(setInterval(async () => {
      const r = await api.lock().catch(() => null);
      if (r && !r.mine) { toast(`Объект перехватил ${r.holder?.name || 'другой админ'} — открываю для просмотра`, 5000); setTimeout(() => location.reload(), 1500); }
    }, 15000));
    window.addEventListener('pagehide', () => { if (state.dirty) save(); api.unlock(); }, { signal: window.__ac?.signal });
  } else {
    // занято или роль наблюдателя: раз в 5 с подтягиваем свежие сохранения, а освободился объект — забираем его
    timers.push(setInterval(async () => {
      if (lockedBy) {
        const r = await api.lock().catch(() => null);
        if (r?.mine) { toast('Объект освободился — открываю для редактирования', 3000); setTimeout(() => location.reload(), 900); return; }
      }
      const rev = await api.revision().catch(() => null);
      if (rev && rev !== state.rev) { const keep = state.floor; await reloadDraft(); state.floor = map.floors.some((f) => f.id === keep) ? keep : groundId(); redraw(); toast(`Обновлено: новые сохранения${lockedBy ? ' · ' + lockedBy.name : ''}`); }
    }, 5000));
  }

  toolbar(); optbar(); status(); inspector(); floorBar();
}
