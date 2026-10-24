// Конструктор карты объекта: построение, точки и панорамы, стадион (если есть), публикация, версии, цвета.
// Открывается из админ-панели (admin.html#/edit/<адрес объекта>), вход и кабинет — в cabinet.js.
import { ROLE_NAMES, can } from '../core/api.js';
import { CATS, KINDS, PALETTE, PCATS, catColor, clone, kindOf, mapsEmbed, neighbors, poiColor, shapeArea, shapeBox, shapeCenter, standColor } from '../core/model.js';
import { Plan2D } from '../core/plan2d.js';
import { SECTORS, STANDS, ST, secMid, sector, setStadiumCenter } from '../core/stadium.js';
import { $, Sheet, esc, fmtDate, icon, photo, toast } from '../core/ui.js';
import { HINTS, TOOLS, createTools } from './tools.js';

// ---------------- редактор ----------------
export function editor(root, api, user, draft) {
  const isEditor = can(user, 'editor'), isAdmin = can(user, 'admin');
  const venue = draft.venue || { slug: api.slug, name: 'Ростов Арена' };
  let map = draft.data, undo = [], redo = [], saveT = null, rebuildT = null, scene = null;
  const state = {
    mode: 'build', tool: 'select', sel: null, view: '2d', panel: null, readonly: !isEditor,
    newKind: 'room', snap: 0.5, wallThick: 0.2, doorWidth: 1.6, stairDir: 'x', poiCat: 'info',
    dirty: false, saving: false, savedAt: draft.updated_at, savedBy: draft.updated_by, rev: draft.revision, conflict: false,
    under: underlayOf(map), underOp: 0.3,
  };
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
      <button class="iconbtn flat" data-act="redo" aria-label="Повторить" title="Повторить (Ctrl+Shift+Z)">${icon('redo')}</button>
      <button class="iconbtn flat" data-act="view3d" aria-label="3D-просмотр" title="3D-просмотр">${icon('cube')}</button>
      ${isAdmin ? `<button class="btn sm primary" data-act="panel" data-p="publish">${icon('publish')}<span class="hide-s">Опубликовать</span></button>` : ''}
      <button class="iconbtn flat" data-act="panel" data-p="menu" aria-label="Меню">${icon('more')}</button>
    </header>
    <nav class="modes" role="tablist">
      <button role="tab" data-mode="build" aria-selected="true">Построение</button>
      <button role="tab" data-mode="points" aria-selected="false">Точки и панорамы</button>
      ${hasStadium() ? '<button role="tab" data-mode="stadium" aria-selected="false">Стадион</button>' : ''}
      <span class="role-tag">${esc(user.name && user.name !== ROLE_NAMES[user.role] ? user.name : user.email)} · ${ROLE_NAMES[user.role]}</span>
    </nav>
    <div class="workspace">
      <div class="toolbar" id="tb" role="toolbar" aria-label="Инструменты"></div>
      <div class="canvas">
        <svg class="plan" aria-label="Редактируемый план"></svg>
        <div class="three" hidden></div>
        <div class="optbar" id="opt"></div>
        <div class="zoombox"><button class="iconbtn" data-act="zin" aria-label="Приблизить">+</button><button class="iconbtn" data-act="zout" aria-label="Отдалить">−</button><button class="iconbtn" data-act="zfit" aria-label="Вся территория">${icon('target')}</button></div>
        <div class="coords" id="xy">x — · y —</div>
        ${state.readonly ? '<div class="readonly-banner">Режим наблюдателя: только просмотр</div>' : ''}
        <button class="iconbtn look-exit" data-act="exitLook" hidden aria-label="Выйти из панорамы">${icon('back')}</button>
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
  };
  const tools = createTools(ed);
  const plan = new Plan2D(svg, {
    down: (w, hit) => tools.down(w, hit), move: (w) => tools.move(w), up: (w) => tools.up(w), cancel: () => tools.cancel(),
    tap: (w, hit) => tools.tap(w, hit),
    hover: (w) => { $('#xy').textContent = `x ${w.x.toFixed(1)} · y ${w.y.toFixed(1)} м`; tools.hover(w); },
  });
  plan.setMap(map);
  plan.set({ admin: true, grid: true, underlay: state.under, underlayOpacity: state.underOp, overlay: (px) => tools.overlay(px), linkFrom: () => tools.linkFrom });
  requestAnimationFrame(() => plan.fitAll());

  // ---------- состояние сохранения ----------
  function markDirty() { state.dirty = true; status(); if (isEditor) { clearTimeout(saveT); saveT = setTimeout(save, 2500); } }
  function status() {
    const el = $('#st');
    el.className = state.dirty || state.conflict ? 'dirty' : '';
    el.innerHTML = '<i></i>' + (state.readonly ? 'Черновик · только просмотр' : state.conflict ? 'Конфликт версий — обновите' : state.saving ? 'Сохраняю…' : state.dirty ? 'Есть несохранённые изменения' : `Черновик сохранён${state.savedAt ? ' · ' + new Date(state.savedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}`);
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
  function redraw() { state.under = underlayOf(map); plan.set({ underlay: state.under, sel: selRef(), showPanos: state.mode !== 'build' || state.sel?.type === 'pano', underlayOpacity: state.mode === 'build' ? state.underOp : Math.min(state.underOp, 0.12) }); }
  function rebuildLater() { if (!scene) return; clearTimeout(rebuildT); rebuildT = setTimeout(() => scene.setMap(map), 450); }
  function toolbar() {
    const list = state.readonly ? [TOOLS.build[0]] : TOOLS[state.mode];
    $('#tb').innerHTML = list.map((t) => `<button class="tool${t.pano ? ' pano' : ''}" data-tool="${t.id}" aria-pressed="${state.tool === t.id}" title="${t.n} (${t.key.toUpperCase()})">${icon(t.ic)}${t.n}</button>`).join('');
    svg.classList.toggle('tool-draw', state.tool !== 'select');
  }
  const seg = (name, cur, items) => `<div class="seg">${items.map(([v, n]) => `<button data-opt="${name}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${n}</button>`).join('')}</div>`;
  function optbar() {
    const t = state.tool, el = $('#opt');
    let h = '';
    if (state.view === '3d') { el.hidden = true; return; }
    if (['rect', 'poly', 'ellipse'].includes(t)) h += `<span class="cap">Что рисуем</span>${seg('newKind', state.newKind, Object.entries(KINDS).map(([k, v]) => [k, v.n]))}`;
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
        ${state.readonly ? '' : `<div class="row">${o.cat === 'plaza' ? '' : `<button class="btn sm" data-act="dup">${icon('copy')}Дублировать</button><button class="btn sm" data-act="del">${icon('erase')}Удалить</button>`}<button class="btn sm" data-act="show3d">${icon('cube')}В 3D</button></div>`}`;
    } else if (s.type === 'wall') {
      h = `<div class="insp-head"><span class="glyph sm" style="background:var(--wall-line)">${icon('wall')}</span><h2>Стена</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        <div class="grid2">${field('Толщина, м', num('f-thick', o.thick || 0.2, 0.05, 0.05))}${field('Высота, м', num('f-wh', o.height || 3, 0.5, 1))}</div>
        <div class="field"><span class="lbl">Цвет</span>${swatches(o.color || '#3d3b38', 'wallColor')}</div>
        <p class="cap">${o.pts.length} точек · длина ${o.pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - o.pts[i][0], p[1] - o.pts[i][1]), 0).toFixed(1)} м. Проёмы добавляются инструментом «Дверь».</p>
        ${state.readonly ? '' : `<button class="btn sm" data-act="del">${icon('erase')}Удалить стену</button>`}`;
    } else if (s.type === 'door') {
      h = `<div class="insp-head"><span class="glyph sm" style="background:var(--accent)">${icon('door')}</span><h2>Проём</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Ширина, м', num('f-dw', o.w, 0.1, 0.6))}${state.readonly ? '' : `<button class="btn sm" data-act="del">${icon('erase')}Удалить проём</button>`}`;
    } else if (s.type === 'stairs') {
      h = `<div class="insp-head"><span class="glyph sm" style="background:var(--ink-2)">${icon('stairs')}</span><h2>Лестница</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        <div class="field"><span class="lbl">Подъём</span><div class="chips"><button class="opt" data-act="sdir" data-v="x" aria-pressed="${o.dir === 'x'}" ${dis()}>→ вправо</button><button class="opt" data-act="sdir" data-v="y" aria-pressed="${o.dir === 'y'}" ${dis()}>↓ вниз</button></div></div>
        <div class="grid2">${field('Высота подъёма, м', num('f-rise', o.rise || 3, 0.5, 0.5))}${field('Ширина, м', num('f-w', o.w, 0.5, 0.5))}</div>
        ${state.readonly ? '' : `<button class="btn sm" data-act="del">${icon('erase')}Удалить лестницу</button>`}`;
    } else if (s.type === 'poi') {
      const col = poiColor(map, o);
      h = `<div class="insp-head"><span class="glyph" style="background:${col}">${esc(PCATS[o.cat]?.g || 'i')}</span><h2>${esc(o.name)}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Название', `<input class="inp" id="f-mname" value="${esc(o.name)}" ${dis()}>`)}
        ${field('Текст для посетителей', `<textarea class="inp" id="f-mtext" placeholder="Что увидит посетитель, нажав на метку" ${dis()}>${esc(o.text || '')}</textarea>`)}
        <div class="field"><span class="lbl">Тип</span><div class="chips">${Object.entries(PCATS).map(([c, v]) => `<button class="opt" data-act="pcat" data-v="${c}" aria-pressed="${o.cat === c}" ${dis()}><span class="glyph sm" style="width:18px;height:18px;font-size:9px;background:${map.style.poi[c] || v.c}">${esc(v.g)}</span>${v.n}</button>`).join('')}</div></div>
        <div class="field"><span class="lbl">Цвет</span>${swatches(col, 'poiColor')}</div>
        <div class="grid3">${field('X, м', num('f-mx', o.x))}${field('Y, м', num('f-my', o.y))}${field('Уровень, м', num('f-mz', o.z || 0, 0.5, 0))}</div>
        <div class="field"><span class="lbl">Фото</span>${photoBlock(o.photo, 'photo', 'Добавить фото')}</div>
        ${state.readonly ? '' : `<div class="row"><button class="btn sm" data-act="del">${icon('erase')}Удалить метку</button><button class="btn sm" data-act="show3d">${icon('cube')}В 3D</button></div>`}`;
    } else if (s.type === 'pano') {
      const nb = neighbors(map, o.id);
      h = `<div class="insp-head"><span class="glyph" style="background:var(--pano)">${icon('pano')}</span><h2>${esc(o.name)}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        ${field('Название точки', `<input class="inp" id="f-pname" value="${esc(o.name)}" ${dis()}>`)}
        <button class="btn blue full" data-act="lookPano">${icon('eye')}Посмотреть панораму</button>
        <div class="field"><span class="lbl">Фото 360°</span><span class="cap">${o.img ? 'Посетители видят это фото.' : 'Сейчас вид строится из 3D-модели. Загрузите сферическое фото (формат 2:1) с камеры 360° или склейку с телефона.'}</span>${photoBlock(o.img, 'pano360', 'Загрузить фото 360°')}</div>
        ${field('Панорама Google Maps или видео YouTube', `<textarea class="inp" id="f-pembed" placeholder="Код &lt;iframe&gt; из Google Maps (Поделиться → Встраивание карты) или ссылка на видео YouTube — обычное или 360°" ${dis()}>${esc(o.embed || '')}</textarea>`)}
        ${o.embed && !mapsEmbed(o.embed) ? '<p class="cap">Не похоже на код Google Maps или ссылку YouTube — посетители увидят обычную панораму.</p>' : ''}
        <p class="cap" style="margin:0">Берите только материалы, которые можно показывать: свои съёмки или ролики, где автор разрешил встраивание.</p>
        <div class="grid2">${field('Уровень пола, м', num('f-pz', o.z || 0, 0.5, 0))}</div>
        <div class="field"><span class="lbl">Переходы · ${nb.length}</span><div class="list">${nb.map((q) => `<div class="item"><span class="glyph sm" style="background:var(--pano)"></span><span class="t"><b>${esc(q.name)}</b><span>${Math.round(Math.hypot(q.x - o.x, q.y - o.y))} м</span></span>${state.readonly ? '' : `<button class="iconbtn flat" data-act="unlink" data-id="${q.id}" aria-label="Убрать переход">${icon('close')}</button>`}</div>`).join('') || '<p class="cap">Нет переходов. Включите «Связь» и нажмите на две точки.</p>'}</div></div>
        ${state.readonly ? '' : `<button class="btn sm" data-act="del">${icon('erase')}Удалить точку</button>`}`;
    } else if (s.type === 'sector') {
      const sec = sector(s.id), col = map.sectors[s.id]?.color || standColor(map, sec.stand);
      h = `<div class="insp-head"><span class="glyph" style="background:${col}">${sec.stand}</span><h2>Сектор ${sec.id}</h2><button class="iconbtn flat" data-act="desel" aria-label="Закрыть">${icon('close')}</button></div>
        <dl class="kv"><dt>Трибуна</dt><dd>${STANDS[sec.stand].n}</dd><dt>Ярус</dt><dd>${sec.tier === 'lower' ? 'нижний' : 'верхний'}</dd></dl>
        ${field('Текст для посетителей', `<textarea class="inp" id="f-stext" placeholder="Например: козырёк над рядами 1–5, вход через лестницу 3А" ${dis()}>${esc(map.sectors[s.id]?.text || '')}</textarea>`)}
        <div class="field"><span class="lbl">Цвет сектора на схеме</span>${swatches(col, 'secColor')}${map.sectors[s.id]?.color && !state.readonly ? '<button class="txt-btn" data-act="secColorReset" style="align-self:flex-start">Как у трибуны</button>' : ''}</div>
        <button class="btn sm" data-act="show3d">${icon('cube')}Показать в 3D</button>`;
    } else if (s.type === 'stadium') { h = stadiumPanel(); }
    sheet.set(`<div class="insp">${h}</div>`, sheet.state === 'peek' ? 'half' : undefined);
  }

  function home() {
    const m = state.mode;
    if (m === 'stadium') return `<div class="insp">${stadiumPanel()}</div>`;
    const list = m === 'build'
      ? map.shapes.filter((s) => s.cat !== 'plaza').map((s) => `<button class="item" data-sel="shape:${s.id}"><span class="dot" style="background:${s.color || catColor(map, s.cat)};width:12px;height:12px"></span><span class="t"><b>${esc(s.name)}</b><span>${KINDS[s.kind]?.n || ''} · ${CATS[s.cat]?.n || ''} · ${Math.round(shapeArea(s))} м²</span></span></button>`).join('')
      : map.pois.map((p) => `<button class="item" data-sel="poi:${p.id}"><span class="glyph sm" style="background:${poiColor(map, p)}">${esc(PCATS[p.cat]?.g || 'i')}</span><span class="t"><b>${esc(p.name)}</b><span>${esc(p.text || PCATS[p.cat]?.n || '')}</span></span></button>`).join('')
        + `<h3 class="h-sec" style="margin:12px 0 4px">Точки обзора</h3>` + map.panos.map((p) => `<button class="item" data-sel="pano:${p.id}"><span class="glyph sm" style="background:var(--pano)"></span><span class="t"><b>${esc(p.name)}</b><span>${p.img ? 'фото 360°' : 'вид из 3D'} · переходов: ${neighbors(map, p.id).length}</span></span></button>`).join('');
    return `<div class="insp">
      <div><h2 style="font-size:16px">${m === 'build' ? 'Построение помещений' : 'Ключевые точки и панорамы'}</h2>
      <p class="cap" style="margin:4px 0 0">${state.readonly ? 'У вас роль «Наблюдатель»: можно смотреть черновик и историю версий.' : m === 'build' ? 'Сначала нарисуйте помещения инструментами слева: прямоугольник, контур, овал, стены, двери и лестницы. Потом перейдите во вкладку «Точки и панорамы».' : 'Ставьте метки (входы, кафе, туалеты), точки обзора 360° и связывайте их — по связям посетители ходят в панорамах и строят маршруты.'}</p></div>
      ${m === 'build' ? underlayBlock() : ''}
      <h3 class="h-sec">${m === 'build' ? `Объекты · ${map.shapes.length - 1}` : `Метки · ${map.pois.length}`}</h3><div class="list">${list}</div></div>`;
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
    let h = `<div class="row nowrap"><button class="iconbtn flat" data-act="${name === 'menu' ? 'closePanel' : 'panel'}" data-p="menu" aria-label="Назад">${icon('back')}</button><h2 style="font-size:17px">${{ menu: 'Меню', publish: 'Публикация', versions: 'История версий', colors: 'Цвета карты' }[name]}</h2></div>`;
    if (name === 'menu') {
      const items = [
        isAdmin && ['publish', 'publish', 'Публикация', 'Выпустить черновик для посетителей'],
        ['versions', 'history', 'История версий', isAdmin ? 'Посмотреть и откатить' : 'Посмотреть'],
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
        <a class="item" href="index.html?object=${encodeURIComponent(venue.slug)}" target="_blank" rel="noopener">${icon('eye')}<span class="t"><b>Открыть карту как посетитель</b><span>Опубликованная версия, в новой вкладке</span></span></a>
        ${state.conflict ? `<button class="item" data-act="reload">${icon('history')}<span class="t"><b>Загрузить свежий черновик</b><span>Ваши несохранённые правки пропадут</span></span></button>` : ''}</div>
        ${api.demo ? '<p class="demo-note"><b>Демо без сервера.</b> Черновик, версии и пользователи хранятся в этом браузере. Запустите бэкенд, чтобы работать командой.</p>' : ''}`;
    }
    if (name === 'publish') {
      h += `<div class="card"><span class="status-pill ${state.dirty ? 'warn' : 'ok'}">${state.dirty ? 'Есть несохранённые изменения' : 'Черновик сохранён'}</span>
        <p class="cap" style="margin:0">После публикации посетители сразу увидят этот черновик по обычной ссылке на карту. Прошлая версия останется в истории.</p>
        ${field('Что изменилось', '<input class="inp" id="f-comment" placeholder="Например: добавили фудкорты на галерее">')}
        <button class="btn primary full" data-act="publishNow">${icon('publish')}Опубликовать</button></div>
        <dl class="kv"><dt>Объектов</dt><dd>${map.shapes.length}</dd><dt>Меток</dt><dd>${map.pois.length}</dd><dt>Точек обзора</dt><dd>${map.panos.length} (с фото: ${map.panos.filter((p) => p.img).length})</dd><dt>Переходов</dt><dd>${map.links.length}</dd></dl>`;
    }
    if (name === 'versions') { h += '<div class="list" id="vers"><p class="cap">Загружаю…</p></div>'; loadVersions(); }
    if (name === 'colors') {
      h += `<div class="field"><span class="lbl">Готовые схемы</span><div class="row"><button class="btn sm" data-act="preset" data-v="scheme">Как на схеме</button><button class="btn sm" data-act="preset" data-v="club">Жёлто-синяя</button><button class="btn sm" data-act="preset" data-v="calm">Спокойная</button></div></div>
        <div class="field"><span class="lbl">Типы объектов</span>${Object.entries(CATS).filter(([c]) => c !== 'plaza').map(([c, v]) => `<div class="row nowrap" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:5px 0"><span class="row nowrap"><span class="dot" style="background:${catColor(map, c)}"></span>${v.n}</span><input type="color" data-catcolor="${c}" value="${catColor(map, c)}" ${dis()}></div>`).join('')}</div>
        <div class="field"><span class="lbl">Типы меток</span>${Object.entries(PCATS).map(([c, v]) => `<div class="row nowrap" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:5px 0"><span class="row nowrap"><span class="glyph sm" style="background:${map.style.poi[c] || v.c}">${esc(v.g)}</span>${v.n}</span><input type="color" data-poicolor="${c}" value="${map.style.poi[c] || v.c}" ${dis()}></div>`).join('')}</div>`;
    }
    sheet.set(`<div class="insp">${h}</div>`, 'full');
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
    }
    svg.toggleAttribute('hidden', v !== '2d'); three.hidden = v !== '3d';
    $('.zoombox', root).hidden = v !== '2d'; $('#tb').style.visibility = v === '3d' ? 'hidden' : '';
    if (scene) { scene.setActive(v === '3d'); if (v === '3d') { scene.setMap(map); if (!scene._init) { scene.overview(true); scene._init = true; } } }
    $('[data-act="view3d"]', root).style.color = v === '3d' ? 'var(--pano)' : '';
    if (v === '2d') { $('.look-exit', root).hidden = true; plan.render(); }
    optbar();
  }
  function pick3d(hit) {
    if (scene.look) {
      if (hit.type === 'arrow') { const q = map.panos.find((p) => p.id === hit.id); scene.setArrows([]); scene.glideTo(q.x, q.y, (q.z || 0) + 1.6, () => { scene.setPhoto(q.img || null); scene.setArrows(neighbors(map, q.id)); state.sel = { type: 'pano', id: q.id }; inspector(); }); }
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
    scene.enterLook(p.x, p.y, (p.z || 0) + 1.6, faceOf(p, nb)); scene.setPhoto(p.img || null); scene.setArrows(nb);
    $('.look-exit', root).hidden = false;
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

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tool],[data-mode],[data-opt],[data-act],[data-sel]'); if (!t) return;
    if (t.dataset.tool) return setTool(t.dataset.tool);
    if (t.dataset.mode) return setMode(t.dataset.mode);
    if (t.dataset.opt) { const k = t.dataset.opt, v = t.dataset.v; state[k] = ['snap', 'wallThick', 'doorWidth'].includes(k) ? +v : v; optbar(); return; }
    if (t.dataset.sel) { const [type, id] = t.dataset.sel.split(':'); ed.select({ type, id }); const o = ed.find(state.sel); if (o) { const c = type === 'shape' ? shapeCenter(o) : o; plan.focus(c.x, c.y, Math.max(120, type === 'shape' ? shapeBox(o).w * 2.2 : 120)); } return; }
    const a = t.dataset.act, s = state.sel, o = ed.find(s);
    if (a === 'undo' && undo.length) { redo.push(JSON.stringify(map)); map = JSON.parse(undo.pop()); plan.setMap(map); if (!ed.find(state.sel)) state.sel = null; ed.changed(); toast('Отменено'); }
    if (a === 'redo' && redo.length) { undo.push(JSON.stringify(map)); map = JSON.parse(redo.pop()); plan.setMap(map); ed.changed(); }
    if (a === 'view3d') setView(state.view === '3d' ? '2d' : '3d');
    if (a === 'zin') plan.zoomAt({ x: plan.view.x + plan.view.w / 2, y: plan.view.y + plan.view.h / 2 }, 1 / 1.4);
    if (a === 'zout') plan.zoomAt({ x: plan.view.x + plan.view.w / 2, y: plan.view.y + plan.view.h / 2 }, 1.4);
    if (a === 'zfit') plan.fitAll();
    if (a === 'finish') tools.finish();
    if (a === 'undoPoint') tools.undoPoint();
    if (a === 'escape') tools.escape();
    if (a === 'desel') ed.select(null);
    if (a === 'panel') panel(t.dataset.p);
    if (a === 'closePanel') { state.panel = null; inspector(); }
    if (a === 'exitLook' && scene) { scene.exitLook(); $('.look-exit', root).hidden = true; }
    if (state.readonly && !['panel', 'closePanel', 'reload', 'show3d', 'lookPano', 'desel'].includes(a)) return;
    if (a === 'kind') ed.change(() => { o.kind = t.dataset.v; if (KINDS[o.kind].walls && !o.height) o.height = KINDS[o.kind].height; });
    if (a === 'cat') ed.change(() => { o.cat = t.dataset.v; });
    if (a === 'pcat') ed.change(() => { if (o.name === 'Новая метка' || o.name === PCATS[o.cat]?.n) o.name = PCATS[t.dataset.v].n; o.cat = t.dataset.v; });
    if (a === 'sdir') ed.change(() => { o.dir = t.dataset.v; });
    if (a === 'shapeColor' || a === 'poiColor' || a === 'wallColor') ed.change(() => { o.color = t.dataset.c; });
    if (a === 'shapeColorReset') ed.change(() => { delete o.color; });
    if (a === 'secColor') ed.change(() => { map.sectors[s.id] = { ...map.sectors[s.id], color: t.dataset.c }; plan.stadCache.key = null; });
    if (a === 'secColorReset') ed.change(() => { delete map.sectors[s.id].color; plan.stadCache.key = null; });
    if (a === 'dup') { const n = { ...clone(o), id: 's' + Math.random().toString(36).slice(2, 8), name: o.name + ' (копия)' }; if (n.type === 'rect') { n.x += 3; n.y += 3; } else if (n.type === 'ellipse') { n.cx += 3; n.cy += 3; } else n.pts = n.pts.map(([x, y]) => [x + 3, y + 3]); ed.change(() => map.shapes.push(n), 'Скопировано'); ed.select({ type: 'shape', id: n.id }); }
    if (a === 'del') { const list = { shape: 'shapes', wall: 'walls', door: 'doors', stairs: 'stairs', poi: 'pois', pano: 'panos' }[s.type]; ed.change(() => { map[list] = map[list].filter((x) => x.id !== s.id); if (s.type === 'pano') map.links = map.links.filter((l) => !l.includes(s.id)); }, 'Удалено'); ed.select(null); }
    if (a === 'unlink') ed.change(() => { map.links = map.links.filter((l) => !(l.includes(s.id) && l.includes(t.dataset.id))); }, 'Переход убран');
    if (a === 'photo') upload((url) => (o.photo = url));
    if (a === 'photoRm') ed.change(() => delete o.photo);
    if (a === 'pano360') upload((url) => (o.img = url));
    if (a === 'pano360Rm') ed.change(() => delete o.img);
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
    const map1 = { 'f-name': ['name'], 'f-desc': ['desc'], 'f-mname': ['name'], 'f-mtext': ['text'], 'f-pname': ['name'] };
    if (map1[t.id]) { o[map1[t.id][0]] = v; const h2 = $('.insp-head h2', root); if (h2 && /name/.test(t.id)) h2.textContent = v; }
    if (t.id === 'f-stext') map.sectors[state.sel.id] = { ...map.sectors[state.sel.id], text: v };
    if (t.id === 'f-pembed') { if (v.trim()) o.embed = mapsEmbed(v) || v.trim(); else delete o.embed; }
    if (ok) {
      const nums = { 'f-w': 'w', 'f-h': 'h', 'f-x': 'x', 'f-y': 'y', 'f-height': 'height', 'f-thick': 'thick', 'f-wh': 'height', 'f-dw': 'w', 'f-rise': 'rise', 'f-mx': 'x', 'f-my': 'y', 'f-mz': 'z', 'f-pz': 'z' };
      if (nums[t.id]) o[nums[t.id]] = ['w', 'h', 'height', 'thick', 'rise'].includes(nums[t.id]) ? Math.max(0.05, n) : n;
      if (t.id === 'f-rx2') o.rx = Math.max(0.5, n / 2);
      if (t.id === 'f-ry2') o.ry = Math.max(0.5, n / 2);
    }
    markDirty(); redraw(); rebuildLater();
  });
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'f-real') ed.change(() => { map.style.realSeats = t.checked; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); $(`[data-act="${e.shiftKey ? 'redo' : 'undo'}"]`, root).click(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Escape') { if (scene?.look) { scene.exitLook(); $('.look-exit', root).hidden = true; } else if (tools.busy()) tools.escape(); else ed.select(null); return; }
    if (e.key === 'Enter' && tools.busy()) { tools.finish(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel && !state.readonly && state.sel.type !== 'sector') { $('[data-act="del"]', root)?.click(); return; }
    const t = keyMap[e.key.toLowerCase()];
    if (t && !mod && !state.readonly && TOOLS[state.mode].some((x) => x.id === t)) setTool(t);
  }, { signal: window.__ac?.signal });
  window.addEventListener('beforeunload', (e) => { if (state.dirty && isEditor) { save(); e.preventDefault(); } }, { signal: window.__ac?.signal });

  toolbar(); optbar(); status(); inspector();
}
