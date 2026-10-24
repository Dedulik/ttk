// Экран посетителя: карта во весь экран, поиск, шторка с карточкой места, маршрут и панорамы.
import { Plan2D } from '../core/plan2d.js';
import { Scene3D } from '../core/scene3d.js';
import { CATS, LAYERS, PCATS, dist, elevOf, embedKind, floorById, floorsSorted, kindOf, layersFor, mapsEmbed, visitorLayerMode, nearestPano, neighbors, placeOf, poiColor, route, search, shapeCenter, shapePoints } from '../core/model.js';
import { SECTORS, ST, STANDS, NUMS, neighbours, otherTier, ring, secMid, sector, setStadiumCenter } from '../core/stadium.js';
import { $, Sheet, badge, esc, icon, photo, themeButton, toast } from '../core/ui.js';
import { iconUrl } from '../core/icons.js';
import { createMascot, mascotSettings } from '../core/mascot.js';

const QUICK = [
  { k: 'gate', n: 'Входы', g: '→' }, { k: 'food', n: 'Еда', g: 'Е' }, { k: 'wc', n: 'Туалеты', g: 'WC' }, { k: 'med', n: 'Медпункт', g: '+' },
  { k: 'ticket', n: 'Кассы', g: '₽' }, { k: 'parking', n: 'Парковки', g: 'P' }, { k: 'panos', n: 'Панорамы', g: '360' }, { k: 'stands', n: 'Трибуны', g: 'A' },
];

export async function mountVisitor(root, api) {
  const pub = await api.published();
  const map = pub.data, stadium = !!map.stadium;
  const title = pub.venue?.name || map.name || 'Ростов Арена';
  // быстрые кнопки: базовые + типы меток ТТК, которые на этой карте действительно есть (регистрация, гардероб…)
  const extra = ['registration', 'wardrobe', 'hall', 'coffee', 'stage', 'partners', 'participants'].filter((k) => map.pois.some((p) => p.cat === k)).map((k) => ({ k, n: PCATS[k].n, g: PCATS[k].g }));
  const quickList = [...QUICK.filter((q) => stadium || q.k !== 'stands'), ...extra];
  const quickBadge = (q) => (iconUrl(q.k === 'panos' ? 'pano' : q.k) ? badge(q.k === 'panos' ? 'pano' : q.k, '', '', 'sm')
    : `<span class="glyph sm" style="background:${(PCATS[q.k] || {}).c || (q.k === 'parking' ? CATS.parking.c : 'var(--ink)')}">${q.g}</span>`);
  // пришли со страницы выбора карт автора — показываем дорогу обратно
  const qs = new URLSearchParams(location.search), byParam = qs.has('object') && qs.get('by');
  setStadiumCenter(map);
  document.title = title + ' · Карта';
  // скрытые слои запоминаются в браузере посетителя отдельно для каждого объекта
  const layersKey = 'arena.layers.' + (api.slug || 'map');
  let hidden, saved = null;
  try { saved = localStorage.getItem(layersKey); } catch { /* без памяти слоёв */ }
  // админ решает, что доступно: «недоступен» — скрыт всегда, «скрыт» — выключен, пока посетитель сам не включит
  const offer = layersFor(map, false).filter((l) => visitorLayerMode(map, l.k) !== 'none');
  try { hidden = new Set(saved ? JSON.parse(saved) : offer.filter((l) => visitorLayerMode(map, l.k) === 'off').map((l) => l.k)); } catch { hidden = new Set(); }
  for (const l of LAYERS) if (visitorLayerMode(map, l.k) === 'none') hidden.add(l.k);
  // этажи: в 2D виден выбранный, в 3D — все до выбранного включительно
  const floors = floorsSorted(map), multiFloor = floors.length > 1;
  root.innerHTML = `
  <div class="vis">
    <div class="stage">
      <div class="three"></div>
      <svg class="plan" hidden aria-label="План территории"></svg>
      <div class="topbar">
        <label class="search">${icon('search')}<input id="q" type="search" placeholder="Сектор, вход, кафе…" autocomplete="off" enterkeyhint="search" aria-label="Поиск по карте"><button class="iconbtn flat" id="qx" hidden aria-label="Очистить">${icon('close')}</button></label>
        ${themeButton()}
        <a class="iconbtn admin-link" href="admin.html" aria-label="Админ-панель" title="Админ-панель для сотрудников">${icon('user')}<span>Админ-панель</span></a>
      </div>
      <div class="pano-embed" hidden></div>
      ${multiFloor ? `<div class="floor-pick" role="group" aria-label="Этажи">${[...floors].reverse().map((f) => `<button data-floor="${f.id}" title="${esc(f.name)}" aria-pressed="${f.id === floors[0].id}">${floors.indexOf(f) + 1}</button>`).join('')}</div>` : ''}
      <div class="results" id="res" hidden></div>
      <div class="fabs">
        <button class="iconbtn" data-act="view" aria-label="Переключить 2D и 3D"><span class="fab-txt" id="viewLbl">2D</span></button>
        <button class="iconbtn" data-act="layers" aria-label="Слои">${icon('layers')}</button>
        <button class="iconbtn" data-act="north" aria-label="Север вверх">${icon('compass')}</button>
        <button class="iconbtn" data-act="home" aria-label="Вся территория">${icon('target')}</button>
      </div>
      <div class="pop" id="layers" hidden>
        <b class="pop-h">Слои карты</b>
        ${offer.map((l) => `<label>${l.n} <input type="checkbox" class="switch" data-layer="${l.k}" ${hidden.has(l.k) ? '' : 'checked'}></label>`).join('')}
        ${stadium ? '<label>Кресла как в жизни <input type="checkbox" class="switch" id="lySeats" checked></label>' : ''}
      </div>
      <div class="look-ui" hidden>
        <div class="look-top"><button class="iconbtn" data-act="exitLook" aria-label="Назад к карте">${icon('back')}</button><div class="look-title"><b id="lkName"></b><span id="lkSub"></span></div></div>
        <div class="look-hint" id="lkHint">Ведите пальцем — осмотреться · нажмите на землю — идти</div>
        <div class="look-bottom" id="lkChips"></div>
        <div class="mini" id="mini"></div>
      </div>
    </div>
    <section class="sheet"><div class="sheet-grip"><i></i></div><div class="sheet-body"></div></section>
  </div>`;

  const S = { view: '3d', sel: null, route: null, routeFrom: null, look: null, list: null, floor: floors[0].id };
  const three = $('.three', root), svg = $('.plan', root), sheet = new Sheet($('.sheet', root));
  const scene = new Scene3D(three, { onPick, onLook: drawMiniCone });
  // маскот ТТК: прячется за правым краем, в панорамах рассказывает о месте
  const mascot = createMascot(root, mascotSettings(map));
  window.addEventListener('themechange', () => { scene.setMap(map); plan.render(); }, { signal: window.__ac?.signal });
  const plan = new Plan2D(svg, { tap: (w, hit) => { if (hit) pickRef(hit.kind === 'sector' ? 'sec:' + hit.id : hit.kind === 'stadium' ? 'stadium' : hit.id); } });
  scene.setMap(map); scene.setActive(true); scene.overview(true);
  plan.setMap(map); plan.set({ showPanos: true, hidden, floor: S.floor, ghost: false });
  if (hidden.size) scene.setHidden(hidden);
  home();

  // ---------- шторка ----------
  function home() {
    S.sel = null; S.list = null; sync();
    const stands = ['A', 'B', 'C', 'D'].map((k) => `<button class="item stand-row" data-go="sec:${k}${NUMS.lower[k][0]}"><span class="bar" style="background:${map.style.stands[k] || STANDS[k].c}"></span><span class="t"><b>${STANDS[k].n}</b><span>${k}${NUMS.lower[k][0]}–${k}${NUMS.lower[k][1]} · ${k}${NUMS.upper[k][0]}–${k}${NUMS.upper[k][1]}</span></span>${icon('chevron', 'chev')}</button>`).join('');
    const intro = stadium ? 'Стадион, Арена Экспо и вся территория' : pub.venue?.description || 'Карта объекта';
    sheet.set(`
      <div class="home-head"><h1>${esc(title)}</h1><p>${esc(intro)} · версия карты ${pub.number}${api.demo ? ' · демо' : ''}</p>
        ${byParam ? `<a class="txt-btn" href="?by=${encodeURIComponent(byParam)}" style="align-self:flex-start">← Все карты автора</a>` : ''}</div>
      <div class="quick">${quickList.map((q) => `<button data-quick="${q.k}">${quickBadge(q)}${q.n}</button>`).join('')}</div>
      ${stadium ? `<div class="photos">
        ${[['aerial', 'Стадион и территория с высоты'], ['facade', 'Фасад и парадная лестница'], ['bowl', 'Чаша: 4 трибуны, 2 яруса'], ['seats', 'Сектора и ряды']].map(([f, c]) => `<figure><img src="${photo(f)}" alt="${c}" loading="lazy"><figcaption>${c}</figcaption></figure>`).join('')}
      </div>
      <h3 class="h-sec">Трибуны</h3><div class="list">${stands}</div>` : ''}
      ${map.pois.length ? `<h3 class="h-sec">Важное рядом</h3><div class="list">${map.pois.slice(0, 6).map(itemPoi).join('')}</div>` : ''}
      <a class="staff-link" href="admin.html">${icon('user')}<span><b>Для сотрудников</b><span>Админ-панель: конструктор карт, команда, безопасность</span></span>${icon('chevron', 'chev')}</a>`, sheet.state === 'full' ? 'half' : undefined);
  }
  function itemPoi(p) { return `<button class="item" data-go="${p.id}">${badge(p.cat, poiColor(map, p), (PCATS[p.cat] || PCATS.info).g)}<span class="t"><b>${esc(p.name)}</b><span>${esc(p.text || (PCATS[p.cat] || PCATS.info).n)}</span></span>${icon('chevron', 'chev')}</button>`; }
  function itemShape(s) { return `<button class="item" data-go="${s.id}"><span class="glyph sm" style="background:${s.color || map.style.cats[s.cat] || CATS[s.cat]?.c}"></span><span class="t"><b>${esc(s.name)}</b><span>${esc(s.desc || CATS[s.cat]?.n || '')}</span></span>${icon('chevron', 'chev')}</button>`; }

  function quick(k) {
    S.list = k; let title, html;
    if (k === 'panos') { title = 'Точки обзора 360°'; html = map.panos.map((p) => `<button class="item" data-pano="${p.id}">${badge('pano')}<span class="t"><b>${esc(p.name)}</b><span>${panoSub(p).replace(/^./, (c) => c.toLowerCase())} ·${neighbors(map, p.id).length} перехода</span></span>${icon('chevron', 'chev')}</button>`).join(''); }
    else if (k === 'stands') { title = 'Сектора'; html = SECTORS.map((s) => `<button class="item" data-go="sec:${s.id}"><span class="glyph sm mono" style="background:${map.sectors[s.id]?.color || map.style.stands[s.stand] || STANDS[s.stand].c}">${s.stand}</span><span class="t"><b>Сектор ${s.id}</b><span>${STANDS[s.stand].n} · ${s.tier === 'lower' ? 'нижний' : 'верхний'} ярус</span></span>${icon('chevron', 'chev')}</button>`).join(''); }
    else if (k === 'parking') { title = 'Парковки'; html = map.shapes.filter((s) => s.cat === 'parking').map(itemShape).join(''); }
    else {
      title = PCATS[k].n;
      const pois = map.pois.filter((p) => p.cat === k).map(itemPoi);
      const extra = k === 'gate' ? map.shapes.filter((s) => s.cat === 'entrance').map(itemShape) : k === 'ticket' ? map.shapes.filter((s) => s.cat === 'service').map(itemShape) : k === 'food' ? map.shapes.filter((s) => s.cat === 'food').map(itemShape) : [];
      html = [...pois, ...extra].join('') || '<p class="cap">Пока ничего не отмечено.</p>';
    }
    plan.set({ filter: PCATS[k] ? k : null });
    sheet.set(`<div class="row nowrap"><button class="iconbtn flat" data-act="home" aria-label="Назад">${icon('back')}</button><h2 style="font-size:17px">${title}</h2></div><div class="list">${html}</div>`, 'half');
  }

  function placePhoto(pl) {
    if (pl.photo) return pl.photo;
    if (pl.obj?.pano) return pl.obj.pano;
    if (!stadium) return null;
    if (pl.type === 'sector') return photo(pl.obj.tier === 'lower' ? 'bowl' : 'seats');
    if (pl.type === 'stadium') return photo('aerial');
    if (pl.type === 'shape' && pl.obj.cat === 'entrance' && /Вход \d/.test(pl.name)) return photo('facade');
    return null;
  }

  function card(ref) {
    const pl = placeOf(map, ref); if (!pl) return home();
    S.sel = ref; sync();
    const ph = placePhoto(pl), np = nearestPano(map, pl);
    const facts = [];
    if (pl.type === 'sector') {
      const g = map.shapes.filter((s) => s.cat === 'entrance' && /^Вход \d/.test(s.name)).map((s) => ({ s, d: dist(shapeCenter(s), pl) })).sort((a, b) => a.d - b.d)[0];
      const n = neighbours(pl.obj);
      if (g) facts.push(['Ближайший вход', `${esc(g.s.name)} · ~${Math.round(g.d)} м`]);
      facts.push(['Соседние', `<span class="mono">${n.prev.id} · ${n.next.id}</span>`]);
    }
    if (pl.obj?.pano) facts.push(['Панорама', 'вид на 360° — нажмите «Панорама»']);
    else if (np && pl.type !== 'pano') facts.push(['Панорама рядом', `${esc(np.name)} · ${Math.round(dist(np, pl))} м`]);
    const isSec = pl.type === 'sector';
    sheet.set(`
      <div class="place">
        ${ph ? `<img class="place-photo" src="${ph}" alt="">` : ''}
        <div class="place-head">${pl.type === 'poi' ? badge(pl.obj.cat, pl.color, (PCATS[pl.obj.cat] || PCATS.info).g) : pl.type === 'pano' ? badge('pano') : `<span class="glyph" style="background:${pl.color || 'var(--ink)'}">${pl.type === 'sector' ? pl.obj.stand : ''}</span>`}
          <div class="t"><h2>${esc(pl.name)}</h2><p>${esc(pl.sub)}</p></div><button class="iconbtn flat" data-act="home" aria-label="Закрыть">${icon('close')}</button></div>
        ${pl.text ? `<p class="txt">${esc(pl.text)}</p>` : ''}
        <div class="actions">
          <button class="btn primary" data-act="routeTo">${icon('route')}Маршрут</button>
          ${isSec ? `<button class="btn" data-act="seatView">${icon('eye')}Вид с места</button>` : pl.obj?.pano ? `<button class="btn" data-act="cylView">${icon('pano')}Панорама</button>` : `<button class="btn" data-act="panoNear" ${np ? '' : 'disabled'}>${icon('pano')}Панорама</button>`}
          <button class="btn" data-act="show">${icon('cube')}На карте</button>
        </div>
        ${facts.length ? `<dl class="facts">${facts.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>` : ''}
      </div>`, 'half');
  }

  function originOptions() {
    const o = [];
    for (const s of map.shapes) if (s.cat === 'entrance' || s.cat === 'parking') o.push([s.id, s.name]);
    for (const p of map.pois) if (p.cat === 'gate' || p.cat === 'transport' || p.cat === 'meet') o.push([p.id, p.name]);
    for (const p of map.panos) o.push([p.id, 'У точки «' + p.name + '»']);
    // в объекте без входов и точек обзора — от любой метки или помещения
    if (!o.length) for (const x of [...map.pois, ...map.shapes.filter((s) => s.cat !== 'plaza')]) o.push([x.id, x.name]);
    return o.filter(([v]) => v !== S.sel);
  }
  function routeSheet() {
    const to = placeOf(map, S.sel); if (!to) return;
    if (S.routeFrom === S.sel) S.routeFrom = null;
    S.routeFrom ||= map.shapes.find((s) => s.id === 'gS')?.id || originOptions()[0]?.[0];
    const from = placeOf(map, S.routeFrom), r = from && route(map, from, to);
    S.route = r; scene.setRoute(r); plan.set({ route: r });
    sheet.set(`
      <div class="row nowrap"><button class="iconbtn flat" data-act="back" aria-label="Назад">${icon('back')}</button><h2 style="font-size:17px">Маршрут</h2></div>
      <div class="route-box">
        <div class="route-pts"><i class="a"></i><select class="inp" id="rFrom" aria-label="Откуда">${originOptions().map(([v, n]) => `<option value="${v}" ${v === S.routeFrom ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <i class="b"></i><div class="inp" style="display:flex;align-items:center">${esc(to.name)}</div></div>
        ${r ? `<div class="route-sum"><b>${Math.round(r.len)} м</b><span class="cap">~${r.minutes} мин пешком${r.nodes.length ? ` · ${r.nodes.length} точек обзора по пути` : ' · в обход стен, через проёмы'}</span></div>
          ${r.nodes.length ? `<button class="btn primary full" data-act="walk">${icon('pano')}Пройти маршрут в панорамах</button>` : ''}
          <ol class="steps"><li><i></i>${esc(from.name)}</li>${r.nodes.filter((n, i) => i || n.name !== from.name).map((n) => `<li><i></i>${esc(n.name)}</li>`).join('')}${multiFloor && from.floor !== to.floor ? `<li><i style="background:var(--warn)"></i>По лестнице ${floorById(map, to.floor).elev > floorById(map, from.floor).elev ? 'наверх' : 'вниз'}: ${esc(floorById(map, to.floor).name)}</li>` : ''}<li><i style="background:var(--accent)"></i>${esc(to.name)}</li></ol>`
          : `<p class="cap">${multiFloor && from && from.floor !== to.floor ? 'Между этими этажами пока нет лестницы. Администратор может нарисовать её инструментом «Лестница».' : 'Сюда не дойти: место окружено стенами без проёмов. Администратор может добавить дверь инструментом «Дверь».'}</p>`}
      </div>`, 'half');
    if (r) { if (S.view === '2d') plan.fitBox(...bboxOf(r.pts)); else { const [x, y, w, h] = bboxOf(r.pts); scene.focus(x + w / 2, y + h / 2, Math.max(120, Math.max(w, h) * 1.1)); } }
  }
  function bboxOf(p) { const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]), x = Math.min(...xs), y = Math.min(...ys); return [x, y, Math.max(...xs) - x, Math.max(...ys) - y]; }

  function sync() { plan.set({ sel: S.sel }); }

  // ---------- выбор и камера ----------
  function pickRef(ref) {
    if (!ref) return;
    if (map.panos.some((p) => p.id === ref)) return openPano(ref);
    card(ref);
  }
  function onPick(hit) {
    if (S.look) {
      if (hit.type === 'arrow') return glide(hit.id);
      if (hit.type === 'ground' && S.look.type === 'pano') return stepToward(hit.point);
      if (hit.type === 'ref' && map.pois.some((p) => p.id === hit.ref)) { const p = map.pois.find((x) => x.id === hit.ref); toast(p.name + (p.text ? ' — ' + p.text : '')); }
      return;
    }
    if (hit.type === 'ref') pickRef(hit.ref);
  }
  function setFloor(id, quiet) {
    S.floor = id; plan.set({ floor: id }); scene.setFloorView(id);
    root.querySelectorAll('.floor-pick [data-floor]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.floor === id));
    if (!quiet) toast(floorById(map, id).name);
  }
  function show(ref) {
    const pl = placeOf(map, ref); if (!pl) return;
    if (multiFloor && pl.floor && pl.floor !== S.floor) setFloor(pl.floor);   // место на другом этаже — переходим туда
    if (S.view === '2d') plan.focus(pl.x, pl.y, pl.type === 'sector' ? 140 : 180);
    else if (pl.type === 'sector') { const m = secMid(pl.obj); scene.focusFrom(m.xy[0], m.xy[1], m.z, ST.cx, ST.cy); }
    else scene.focus(pl.x, pl.y, pl.type === 'stadium' ? 260 : 80);
  }

  // ---------- панорамы и вид с места ----------
  function enterLookUI(name, sub, chips) {
    $('.look-ui', root).hidden = false; $('.sheet', root).hidden = true; $('.topbar', root).hidden = true; $('.fabs', root).hidden = true; $('#res', root).hidden = true; $('#layers').hidden = true;
    root.querySelector('.floor-pick')?.toggleAttribute('hidden', true);
    $('#lkName').textContent = name; $('#lkSub').textContent = sub; $('#lkChips').innerHTML = chips;
    if (S.view === '2d') setView('3d', true);
    const hint = $('#lkHint'); hint.style.opacity = 1; clearTimeout(enterLookUI.t); enterLookUI.t = setTimeout(() => (hint.style.opacity = 0), 3500);
  }
  function exitLook() {
    if (!S.look) return; const wasPlan = S.look.plan; S.look = null; setEmbed(null);
    $('.look-ui', root).hidden = true; $('.sheet', root).hidden = false; $('.topbar', root).hidden = false; $('.fabs', root).hidden = false;
    root.querySelector('.floor-pick')?.toggleAttribute('hidden', false);
    scene.exitLook(true); scene.focus(wasPlan.x, wasPlan.y, 70);
    mascot.leave();   // вышли из панорамы — маскот снова прячется за край
  }
  function panoChips(p) {
    const nb = neighbors(map, p.id).map((q) => `<button class="chip" data-glide="${q.id}">${icon('chevron')}${esc(q.name)} · ${Math.round(dist(p, q))} м</button>`);
    if (S.route) { const i = S.route.nodes.findIndex((n) => n.id === p.id), nx = S.route.nodes[i + 1]; if (i >= 0 && nx) nb.unshift(`<button class="chip next" data-glide="${nx.id}">Дальше по маршруту</button>`); if (i === S.route.nodes.length - 1) nb.unshift(`<span class="chip next">Вы почти у цели</span>`); }
    return nb.join('');
  }
  function panoSub(p) { return mapsEmbed(p.embed) ? embedKind(p.embed) : p.img ? 'Фото 360°' : 'Вид из 3D-модели'; }
  // панорама Google Maps встраивается поверх 3D, переходы и мини-карта остаются сверху
  function setEmbed(p) {
    const box = $('.pano-embed', root), src = p && mapsEmbed(p.embed);
    box.hidden = !src; $('#mini').hidden = !!src; $('#lkHint').hidden = !!src;
    if (!src) { box.innerHTML = ''; return; }
    if (box.dataset.src !== src) box.innerHTML = `<iframe src="${esc(src)}" title="${esc(p.name)}" allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    box.dataset.src = src;
  }
  function openPano(id, face) {
    const p = map.panos.find((x) => x.id === id); if (!p) return;
    const nb = neighbors(map, id);
    S.look = { type: 'pano', id, plan: { x: p.x, y: p.y } };
    const center = stadium ? { x: ST.cx, y: ST.cy } : null;
    scene.enterLook(p.x, p.y, elevOf(map, p) + (p.z || 0) + 1.6, face || (center && Math.hypot(p.x - ST.cx, p.y - ST.cy) < 260 ? center : nb[0]) || center || { x: p.x + 1, y: p.y });
    scene.setPhoto(p.img || null, p.photoRot); scene.setArrows(nb); scene.preload(nb.map((q) => q.img));
    enterLookUI(p.name, panoSub(p), panoChips(p)); buildMini(); setEmbed(p);
    mascot.guide(p.guide);   // маскот рассказывает об этом месте (текст точки задаёт админ)
  }
  function glide(id) {
    if (!S.look || S.look.type !== 'pano' || scene.anim || scene.gliding) return;
    const q = map.panos.find((x) => x.id === id); if (!q) return;
    scene.setArrows([]); $('#lkChips').innerHTML = ''; setEmbed(null);
    // фото следующей точки переходит в кадр плавно, без промежуточного показа 3D-модели
    scene.glideTo(q.x, q.y, elevOf(map, q) + (q.z || 0) + 1.6, () => {
      S.look = { type: 'pano', id, plan: { x: q.x, y: q.y } };
      const nb = neighbors(map, id); scene.setArrows(nb); scene.preload(nb.map((n) => n.img));
      $('#lkName').textContent = q.name; $('#lkSub').textContent = panoSub(q); $('#lkChips').innerHTML = panoChips(q); setEmbed(q);
      mascot.guide(q.guide);
    }, { url: q.img, rot: q.photoRot });
  }
  function stepToward(pt) {
    const p = map.panos.find((x) => x.id === S.look.id), a = Math.atan2(pt.y - p.y, pt.x - p.x);
    let best = null, bd = 0.8;
    for (const q of neighbors(map, p.id)) { let d = Math.abs(Math.atan2(q.y - p.y, q.x - p.x) - a); if (d > Math.PI) d = 2 * Math.PI - d; if (d < bd) { bd = d; best = q; } }
    if (best) glide(best.id); else toast('В эту сторону переходов нет');
  }
  function seatView(id) {
    const s = sector(id); if (!s) return; const m = secMid(s);
    S.look = { type: 'sector', id, plan: { x: m.xy[0], y: m.xy[1] } };
    scene.enterLook(m.xy[0], m.xy[1], m.z + 1.2, { x: ST.cx, y: ST.cy }, { pitch: -0.18, kind: 'sector' });
    scene.setArrows([]);
    const n = neighbours(s), o = otherTier(s);
    enterLookUI(`Вид с сектора ${s.id}`, `${STANDS[s.stand].n} · ${s.tier === 'lower' ? 'нижний' : 'верхний'} ярус`,
      `<button class="chip" data-seat="${n.prev.id}">← ${n.prev.id}</button><button class="chip" data-seat="${n.next.id}">${n.next.id} →</button><button class="chip" data-seat="${o.id}">${s.tier === 'lower' ? 'Верхний ярус' : 'Нижний ярус'} · ${o.id}</button>`);
    buildMini();
  }

  // мини-карта с конусом взгляда
  function buildMini() {
    const site = map.shapes.find((s) => s.cat === 'plaza');
    const P = (a) => a.map((q) => q.join(',')).join(' ');
    let h = `<svg viewBox="0 0 200 200" aria-hidden="true"><g id="mm">${site ? `<polygon points="${P(shapePoints(site))}" fill="#3a3c41"/>` : ''}${stadium ? `<polygon points="${P(ring(74))}" fill="#5a5d63"/><rect x="${ST.cx - 34}" y="${ST.cy - 52.5}" width="68" height="105" fill="#3f8f46"/>` : ''}`;
    for (const s of map.shapes) if (kindOf(s).walls && s.type === 'rect') h += `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#7b7e84"/>`;
    for (const [i, j] of map.links) { const a = map.panos.find((p) => p.id === i), b = map.panos.find((p) => p.id === j); if (a && b) h += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#ff4d55" stroke-width="3"/>`; }
    for (const p of map.panos) h += `<circle cx="${p.x}" cy="${p.y}" r="5" fill="#ff4d55"/>`;
    h += `</g><g id="cone"><path d="M0 0L42 -20A46 46 0 0 1 42 20Z" fill="#ff3b42" fill-opacity=".45"/><circle r="6" fill="#ff3b42" stroke="#fff" stroke-width="2.5"/></g></svg>`;
    $('#mini').innerHTML = h; drawMiniCone(scene.look);
  }
  function drawMiniCone(L) {
    if (!L || !S.look) return;
    const mm = $('#mm'), cone = $('#cone'); if (!mm) return;
    const { x, y } = scene.planOf(L.pos), k = 0.55;
    mm.setAttribute('transform', `translate(100 100) scale(${k}) translate(${-x} ${-y})`);
    cone.setAttribute('transform', `translate(100 100) rotate(${(L.yaw * 180) / Math.PI})`);
  }

  // ---------- вид и слои ----------
  function setView(v, silent) {
    S.view = v; svg.toggleAttribute('hidden', v !== '2d'); three.hidden = v !== '3d'; scene.setActive(v === '3d');
    $('#viewLbl').textContent = v === '3d' ? '2D' : '3D';
    if (v === '2d') { plan.render(); if (!silent) plan.fitAll(); }
  }

  // ---------- события ----------
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-go],[data-quick],[data-pano],[data-glide],[data-seat],[data-floor]'); if (!t) return;
    const a = t.dataset.act;
    if (t.dataset.floor) return setFloor(t.dataset.floor);
    if (t.dataset.go) { card(t.dataset.go); show(t.dataset.go); $('#res').hidden = true; return; }
    if (t.dataset.quick) return quick(t.dataset.quick);
    if (t.dataset.pano) return openPano(t.dataset.pano);
    if (t.dataset.glide) return glide(t.dataset.glide);
    if (t.dataset.seat) return seatView(t.dataset.seat);
    if (a === 'home') { if (S.route) { S.route = null; scene.setRoute(null); plan.set({ route: null }); } plan.set({ filter: null }); if (t.closest('.fabs')) { S.view === '2d' ? plan.fitAll() : scene.overview(); } home(); }
    if (a === 'back') { S.route = null; scene.setRoute(null); plan.set({ route: null }); card(S.sel); }
    if (a === 'view') setView(S.view === '3d' ? '2d' : '3d');
    if (a === 'layers') $('#layers').hidden = !$('#layers').hidden;
    if (a === 'north') S.view === '3d' ? scene.northUp() : plan.fitAll();
    if (a === 'show') show(S.sel);
    if (a === 'routeTo') routeSheet();
    if (a === 'walk' && S.route) openPano(S.route.nodes[0].id, S.route.nodes[1] || placeOf(map, S.sel));
    if (a === 'panoNear') { const pl = placeOf(map, S.sel), np = nearestPano(map, pl); if (np) openPano(np.id, pl); }
    if (a === 'seatView') seatView(S.sel.slice(4));
    if (a === 'cylView') { const p = placeOf(map, S.sel); if (p?.obj?.pano) import('../core/cylpano.js').then(({ openCylPano }) => { openCylPano({ url: p.obj.pano, title: p.name, onClose: () => mascot.leave() }); mascot.guide(p.obj.guide); }); }
    if (a === 'exitLook') exitLook();
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'rFrom') { S.routeFrom = e.target.value; routeSheet(); }
    if (e.target.id === 'lySeats') { map.style.realSeats = e.target.checked; scene.setMap(map); }
    if (e.target.dataset.layer) {
      hidden[e.target.checked ? 'delete' : 'add'](e.target.dataset.layer);
      try { localStorage.setItem(layersKey, JSON.stringify([...hidden])); } catch { /* без памяти слоёв */ }
      plan.set({ hidden }); scene.setHidden(hidden);
    }
  });
  const q = $('#q'), res = $('#res');
  q.addEventListener('input', () => {
    $('#qx').hidden = !q.value;
    const found = search(map, q.value);
    res.hidden = !q.value;
    res.innerHTML = found.length ? `<div class="list">${found.map((p) => `<button class="item" data-go="${p.ref}">${p.type === 'poi' ? badge(p.obj.cat, p.color, (PCATS[p.obj.cat] || PCATS.info).g, 'sm') : `<span class="glyph sm" style="background:${p.color}">${p.type === 'sector' ? p.obj.stand : ''}</span>`}<span class="t"><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></span></button>`).join('')}</div>` : '<p class="cap" style="padding:10px 0">Ничего не нашлось. Попробуйте «A105», «туалет» или «вход 3».</p>';
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = search(map, q.value)[0]; if (f) { card(f.ref); show(f.ref); res.hidden = true; q.blur(); } } });
  $('#qx').addEventListener('click', (e) => { e.preventDefault(); q.value = ''; res.hidden = true; $('#qx').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.look) exitLook();
    if (e.key === 'ArrowUp' && S.look?.type === 'pano' && scene.look) { const L = scene.look; stepToward({ x: L.plan.x + Math.cos(L.yaw) * 10, y: L.plan.y + Math.sin(L.yaw) * 10 }); }
  }, { signal: window.__ac?.signal });
  // ссылка на место: #/place/A105 или #/place/m1
  const deep = location.hash.match(/^#\/place\/(.+)$/);
  if (deep) { const ref = /^[ABCD]\d{3}$/.test(deep[1]) ? 'sec:' + deep[1] : deep[1]; card(ref); show(ref); }
}
