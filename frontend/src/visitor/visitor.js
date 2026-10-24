// Экран посетителя: карта во весь экран, поиск, шторка с карточкой места, маршрут и панорамы.
import { Plan2D } from '../core/plan2d.js';
import { Scene3D } from '../core/scene3d.js';
import { CATS, LAYERS, PCATS, arrowItems, dist, slugify, startView, elevOf, embedKind, floorById, floorsSorted, kindOf, layersFor, mapsEmbed, visitorLayerMode, nearestPano, neighbors, placeOf, poiColor, route, search, shapeCenter, shapePoints } from '../core/model.js';
import { SECTORS, ST, STANDS, NUMS, neighbours, otherTier, ring, secMid, sector, setStadiumCenter } from '../core/stadium.js';
import { $, Sheet, badge, esc, icon, photo, themeButton, toast } from '../core/ui.js';
import { iconUrl, pointIconUrl } from '../core/icons.js';
import { createMascot, mascotSettings, setSound, soundOn } from '../core/mascot.js';
import { playTransition } from '../core/transition.js';
import { palmWipe, preloadPalm } from '../core/palm.js';
import { SUGGEST, answer } from './assistant.js';

const LOADER_GIF = new URL('../../assets/mascot/full.gif', import.meta.url).href;
const PIXEL = new URL('../../assets/icons/pixel.png', import.meta.url).href;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* без памяти браузера */ } },
};

const QUICK = [
  { k: 'gate', n: 'Входы', g: '→' }, { k: 'food', n: 'Еда', g: 'Е' }, { k: 'wc', n: 'Туалеты', g: 'WC' }, { k: 'med', n: 'Медпункт', g: '+' },
  { k: 'ticket', n: 'Кассы', g: '₽' }, { k: 'parking', n: 'Парковки', g: 'P' }, { k: 'panos', n: 'Панорамы', g: '360' }, { k: 'stands', n: 'Трибуны', g: 'A' },
];

export async function mountVisitor(root, api) {
  const qs0 = new URLSearchParams(location.search), preview = qs0.get('preview') === '1', hash0 = location.hash;   // адрес до того, как шторка его перепишет
  let pub = null;
  if (preview) {
    try { const d = await api.draft(); pub = { data: d.data, venue: d.venue, number: 'черновик', draft: true }; }
    catch { toast('Черновик могут смотреть только сотрудники — показываю опубликованную версию', 5000); }
  }
  pub ||= await api.published();
  const map = pub.data, stadium = !!map.stadium;
  const visPois = map.pois.filter((p) => p.cat !== 'quest');
  const title = pub.venue?.name || map.name || 'Манеж ДГТУ';
  // быстрые кнопки: базовые + типы меток ТТК, которые на этой карте действительно есть (регистрация, гардероб…)
  const extra = ['registration', 'wardrobe', 'hall', 'coffee', 'stage', 'partners', 'participants'].filter((k) => map.pois.some((p) => p.cat === k)).map((k) => ({ k, n: PCATS[k].n, g: PCATS[k].g }));
  // на стадионе — полный набор; в манеже и других зданиях — только то, что на карте реально есть
  const has = (k) => k === 'panos' ? map.panos.length : k === 'parking' ? map.shapes.some((x) => x.cat === 'parking') : map.pois.some((x) => x.cat === k) || (k === 'gate' && map.shapes.some((x) => x.cat === 'entrance')) || (k === 'food' && map.shapes.some((x) => x.cat === 'food'));
  const quickList = [...QUICK.filter((q) => (stadium ? true : q.k !== 'stands' && has(q.k))), ...extra];
  const quickBadge = (q) => (iconUrl(q.k === 'panos' ? 'pano' : q.k) ? badge(q.k === 'panos' ? 'pano' : q.k, '', '', 'sm')
    : `<span class="glyph sm" style="background:${(PCATS[q.k] || {}).c || (q.k === 'parking' ? CATS.parking.c : 'var(--ink)')}">${q.g}</span>`);
  // пришли со страницы выбора карт автора — показываем дорогу обратно
  const qs = qs0, byParam = qs.has('object') && qs.get('by');
  const slug = api.slug || 'map', lastKey = 'arena.last.' + slug;
  // «Пиксельная охота»: пиксели ТТК спрятаны в панорамах
  const questItems = map.pois.filter((p) => p.cat === 'quest'), qKey = 'arena.quest.' + slug;
  const found = new Set(store.get(qKey, []).filter((id) => questItems.some((p) => p.id === id)));
  const me = questItems.length && !api.demo ? await api.me().catch(() => null) : null;
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
        <label class="search">${icon('search')}<input id="q" type="search" placeholder="${stadium ? 'Сектор, вход, кафе…' : 'Зал, вход, кафе…'}" autocomplete="off" enterkeyhint="search" aria-label="Поиск по карте"><button class="iconbtn flat" id="qx" hidden aria-label="Очистить">${icon('close')}</button></label>
        ${themeButton()}
        <button class="iconbtn ask-btn" data-act="ask" aria-label="Спросить маскота" title="Спросить маскота: где туалет, как пройти…">${icon('chat')}</button>
        <button class="iconbtn" data-act="sound" aria-pressed="false" aria-label="Звук" title="Звук маскота">${icon('mute')}</button>
        <a class="iconbtn admin-link" href="admin.html" aria-label="Войти" title="Вход и регистрация: личный кабинет, «Пиксельная охота», админ-панель для сотрудников">${icon('user')}<span>Войти</span></a>
      </div>
      <div class="pano-embed" hidden></div>
      ${multiFloor ? `<div class="floor-pick" role="group" aria-label="Этажи">${[...floors].reverse().map((f) => `<button data-floor="${f.id}" title="${esc(f.name)}" aria-pressed="${f.id === floors[0].id}">${floors.indexOf(f) + 1}</button>`).join('')}</div>` : ''}
      <div class="results" id="res" hidden></div>
      <div class="fabs">
        <button class="iconbtn" data-act="view" aria-label="Переключить 2D и 3D"><span class="fab-txt" id="viewLbl">2D</span></button>
        <button class="iconbtn" data-act="layers" aria-label="Слои">${icon('layers')}</button>
        <button class="iconbtn" data-act="north" aria-label="Север вверх">${icon('compass')}</button>
        <button class="iconbtn" data-act="home" aria-label="Вся территория">${icon('target')}</button>
        <button class="iconbtn" data-act="fullscreen" aria-label="Во весь экран" title="Во весь экран">${icon('full')}</button>
        <button class="iconbtn" data-act="shot" aria-label="Снимок экрана" title="Сохранить снимок 3D-вида">${icon('shot')}</button>
      </div>
      <div class="pop" id="layers" hidden>
        <b class="pop-h">Слои карты</b>
        ${offer.map((l) => `<label>${l.n} <input type="checkbox" class="switch" data-layer="${l.k}" ${hidden.has(l.k) ? '' : 'checked'}></label>`).join('')}
        ${stadium ? '<label>Кресла как в жизни <input type="checkbox" class="switch" id="lySeats" checked></label>' : ''}
      </div>
      <div class="look-ui" hidden>
        <div class="look-top"><button class="iconbtn" data-act="exitLook" aria-label="Назад к карте">${icon('back')}</button><div class="look-title"><b id="lkName"></b><span id="lkSub"></span></div>
          <div class="look-acts"><button class="iconbtn" data-act="sound" aria-pressed="false" aria-label="Звук" title="Звук маскота">${icon('mute')}</button><button class="iconbtn" data-act="share" aria-label="Поделиться ссылкой" title="Ссылка на эту панораму">${icon('share')}</button><button class="iconbtn" data-act="shot" aria-label="Снимок" title="Сохранить снимок панорамы">${icon('shot')}</button><button class="iconbtn" data-act="fullscreen" aria-label="Во весь экран" title="Во весь экран">${icon('full')}</button></div></div>
        <div class="look-hint" id="lkHint">Ведите пальцем — осмотреться · нажмите на землю — идти</div>
        <div class="look-bottom" id="lkChips"></div>
        <div class="mini" id="mini"></div>
      </div>
      <div class="pano-loader" id="ld" hidden role="status" aria-live="polite"><div class="ld-card"><img src="${LOADER_GIF}" alt=""><span id="ldTxt">Загружаю панораму…</span>
        <div class="row" id="ldActs" hidden><button class="btn sm primary" data-act="ldRetry">Повторить</button><button class="btn sm" data-act="ldSkip">Показать без фото</button></div></div></div>
      ${pub.draft ? `<div class="preview-bar">${icon('eye')}<span><b>Черновик</b> — так карту увидят после публикации</span><a class="btn sm" href="admin.html#/edit/${encodeURIComponent(slug)}">В конструктор</a></div>` : ''}
    </div>
    <section class="sheet"><div class="sheet-grip"><i></i></div><div class="sheet-body"></div></section>
  </div>`;

  const S = { view: '3d', sel: null, route: null, routeFrom: null, look: null, list: null, floor: floors[0].id, busy: false, tok: 0 };
  const three = $('.three', root), svg = $('.plan', root), sheet = new Sheet($('.sheet', root));
  const scene = new Scene3D(three, { onPick, onLook: drawMiniCone });
  // маскот ТТК: прячется за правым краем, в панорамах рассказывает о месте
  const mascot = createMascot(root, mascotSettings(map));
  window.addEventListener('themechange', () => { scene.setMap(map); plan.render(); }, { signal: window.__ac?.signal });
  const plan = new Plan2D(svg, { tap: (w, hit) => { if (hit) pickRef(hit.kind === 'sector' ? 'sec:' + hit.id : hit.kind === 'stadium' ? 'stadium' : hit.id); } });
  scene.setMap(map); scene.setActive(true); scene.overview(true);
  plan.setMap(map); plan.set({ showPanos: true, hidden, floor: S.floor, ghost: false });
  if (hidden.size) scene.setHidden(hidden);
  scene.setQuestFound(found);
  syncSound();
  home();
  if (me && questItems.length && !pub.draft) syncQuest();

  // ---------- шторка ----------
  function home() {
    S.sel = null; S.list = null; sync(); if (!S.look) setHash('');
    const stands = ['A', 'B', 'C', 'D'].map((k) => `<button class="item stand-row" data-go="sec:${k}${NUMS.lower[k][0]}"><span class="bar" style="background:${map.style.stands[k] || STANDS[k].c}"></span><span class="t"><b>${STANDS[k].n}</b><span>${k}${NUMS.lower[k][0]}–${k}${NUMS.lower[k][1]} · ${k}${NUMS.upper[k][0]}–${k}${NUMS.upper[k][1]}</span></span>${icon('chevron', 'chev')}</button>`).join('');
    const intro = stadium ? 'Стадион, Арена Экспо и вся территория' : pub.venue?.description || 'Карта объекта';
    sheet.set(`
      <div class="home-head"><h1>${esc(title)}</h1><p>${esc(intro)} · ${pub.draft ? 'черновик, ещё не опубликован' : 'версия карты ' + pub.number}${api.demo ? ' · демо' : ''}</p>
        ${byParam ? `<a class="txt-btn" href="?by=${encodeURIComponent(byParam)}" style="align-self:flex-start">← Все карты автора</a>` : ''}</div>
      ${lastPano() ? `<button class="item resume" data-pano="${lastPano().id}">${badge('pano', '', '', 'sm', pointIconUrl(lastPano(), 'pano'))}<span class="t"><b>Продолжить с «${esc(lastPano().name)}»</b><span>Последняя открытая панорама</span></span>${icon('chevron', 'chev')}</button>` : ''}
      <button class="ask-card" data-act="ask">${icon('chat')}<span><b>Спросите маскота</b><span>«Где туалет?», «Как пройти на регистрацию?» — покажу на карте и проложу маршрут</span></span></button>
      ${questCard()}
      <div class="quick">${quickList.map((q) => `<button data-quick="${q.k}">${quickBadge(q)}${q.n}</button>`).join('')}</div>
      ${stadium ? `<div class="photos">
        ${[['aerial', 'Стадион и территория с высоты'], ['facade', 'Фасад и парадная лестница'], ['bowl', 'Чаша: 4 трибуны, 2 яруса'], ['seats', 'Сектора и ряды']].map(([f, c]) => `<figure><img src="${photo(f)}" alt="${c}" loading="lazy"><figcaption>${c}</figcaption></figure>`).join('')}
      </div>
      <h3 class="h-sec">Трибуны</h3><div class="list">${stands}</div>` : ''}
      ${visPois.length ? `<h3 class="h-sec">Важное рядом</h3><div class="list">${visPois.slice(0, 6).map(itemPoi).join('')}</div>` : ''}
      <a class="staff-link" href="admin.html">${icon('user')}<span><b>Вход и регистрация</b><span>Личный кабинет и «Пиксельная охота»; для сотрудников — админ-панель</span></span>${icon('chevron', 'chev')}</a>`, sheet.state === 'full' ? 'half' : undefined);
  }
  function itemPoi(p) { return `<button class="item" data-go="${p.id}">${badge(p.cat, poiColor(map, p), (PCATS[p.cat] || PCATS.info).g, '', pointIconUrl(p, p.cat))}<span class="t"><b>${esc(p.name)}</b><span>${esc(p.text || (PCATS[p.cat] || PCATS.info).n)}</span></span>${icon('chevron', 'chev')}</button>`; }
  function itemShape(s) { return `<button class="item" data-go="${s.id}"><span class="glyph sm" style="background:${s.color || map.style.cats[s.cat] || CATS[s.cat]?.c}"></span><span class="t"><b>${esc(s.name)}</b><span>${esc(s.desc || CATS[s.cat]?.n || '')}</span></span>${icon('chevron', 'chev')}</button>`; }

  function quick(k) {
    S.list = k; let title, html;
    if (k === 'panos') { title = 'Точки обзора 360°'; html = map.panos.map((p) => `<button class="item" data-pano="${p.id}">${badge('pano', '', '', '', pointIconUrl(p, 'pano'))}<span class="t"><b>${esc(p.name)}</b><span>${panoSub(p).replace(/^./, (c) => c.toLowerCase())} ·${neighbors(map, p.id).length} перехода</span></span>${icon('chevron', 'chev')}</button>`).join(''); }
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
    S.sel = ref; sync(); setHash('place/' + (ref.startsWith('sec:') ? ref.slice(4) : ref));
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
        <div class="place-head">${pl.type === 'poi' ? badge(pl.obj.cat, pl.color, (PCATS[pl.obj.cat] || PCATS.info).g, '', pointIconUrl(pl.obj, pl.obj.cat)) : pl.type === 'pano' ? badge('pano', '', '', '', pointIconUrl(pl.obj, 'pano')) : `<span class="glyph" style="background:${pl.color || 'var(--ink)'}">${pl.type === 'sector' ? pl.obj.stand : ''}</span>`}
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
    if (hit.type === 'ref' && questItems.some((p) => p.id === hit.ref)) return catchPixel(hit.ref);
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
    root.querySelector('.vis').classList.add('looking');   // панорама — на весь экран, без пустого места под шторку
    $('.look-ui', root).hidden = false; $('.sheet', root).hidden = true; $('.topbar', root).hidden = true; $('.fabs', root).hidden = true; $('#res', root).hidden = true; $('#layers').hidden = true;
    root.querySelector('.floor-pick')?.toggleAttribute('hidden', true);
    $('#lkName').textContent = name; $('#lkSub').textContent = sub; $('#lkChips').innerHTML = chips;
    if (S.view === '2d') setView('3d', true);
    const hint = $('#lkHint'); hint.style.opacity = 1; clearTimeout(enterLookUI.t); enterLookUI.t = setTimeout(() => (hint.style.opacity = 0), 3500);
  }
  function exitLook() {
    if (!S.look) return; const wasPlan = S.look.plan; S.look = null; setEmbed(null); S.busy = false; S.tok++; loading(false); setHash(S.sel ? null : '');
    root.querySelector('.vis').classList.remove('looking');
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
  // ---------- загрузка панорамы: GIF маскота, пока фото не готово; ошибка — «Повторить» ----------
  let ldAct = {};
  function loading(state, retry, skip) {
    const ld = $('#ld', root); clearTimeout(loading.t);
    if (state === true) {
      $('#ldActs', root).hidden = true; $('#ldTxt', root).textContent = 'Загружаю панораму…';
      loading.t = setTimeout(() => (ld.hidden = false), 200);   // из кэша фото придёт сразу — тогда загрузку не показываем
      return;
    }
    if (state === 'error') { ld.hidden = false; $('#ldTxt', root).textContent = 'Не удалось загрузить панораму. Проверьте интернет и попробуйте ещё раз.'; $('#ldActs', root).hidden = false; ldAct = { retry, skip }; return; }
    ld.hidden = true; ldAct = {};
  }
  const panoKey = (p) => p.slug || p.id;
  /** Адрес страницы без перезагрузки: #/pano/<адрес>, #/place/<место> или пусто. null — не трогать. */
  function setHash(h) {
    if (h === null) return;
    try { history.replaceState(null, '', location.pathname + location.search + (h ? '#/' + h : '')); } catch { /* адрес не обновится — не страшно */ }
  }
  function lastPano() { const id = store.get(lastKey, null); return id && map.panos.find((p) => p.id === id); }
  function arrived(p) {
    setHash('pano/' + panoKey(p)); store.set(lastKey, p.id);
  }
  /** Следующая точка маршрута после точки id (если идём по маршруту). */
  function routeNext(id) { const ns = S.route?.nodes || [], i = ns.findIndex((n) => n.id === id); return i >= 0 ? ns[i + 1] || null : null; }
  /** Стрелки точки: у следующей по маршруту — пометка next (она ярче, остальные приглушены). */
  function arrowsFor(p) { const nx = routeNext(p.id); return arrowItems(p, neighbors(map, p.id)).map((q) => (nx && q.id === nx.id ? { ...q, next: true } : q)); }
  /** Открыть точку обзора. internal — вызов из самого перехода (он уже держит S.busy). */
  function openPano(id, face, internal) {
    const p = map.panos.find((x) => x.id === id);
    if (!p) return toast('Этой точки обзора больше нет на карте');
    if (S.busy && !internal) return;
    const nb = neighbors(map, id), tok = ++S.tok;
    S.look = { type: 'pano', id, plan: { x: p.x, y: p.y } };
    const center = stadium ? { x: ST.cx, y: ST.cy } : null;
    scene.enterLook(p.x, p.y, elevOf(map, p) + (p.z || 0) + 1.6, face || (center && Math.hypot(p.x - ST.cx, p.y - ST.cy) < 260 ? center : nb[0]) || center || { x: p.x + 1, y: p.y }, face ? {} : startView(p) || {});
    let ready = Promise.resolve(true);
    if (p.img) {
      loading(true);
      ready = scene.setPhoto(p.img, p.photoRot).then((ok) => {
        if (tok !== S.tok) return ok;
        if (ok) loading(false); else loading('error', () => openPano(id, face), () => loading(false));
        return ok;
      });
    } else { scene.setPhoto(null); loading(false); }
    scene.setArrows(arrowsFor(p)); scene.preload(nb.map((q) => q.img)); preloadPalm();
    enterLookUI(p.name, panoSub(p), panoChips(p)); buildMini(); setEmbed(p); arrived(p);
    mascot.guide(p.guide);   // маскот рассказывает об этом месте (текст точки задаёт админ)
    return ready;   // выполнится, когда фото точки показано — по нему ладошка открывает кадр
  }
  async function glide(id, noPhoto) {
    // один переход за раз: повторные нажатия, пока идёт загрузка или движение, игнорируются
    if (!S.look || S.look.type !== 'pano' || S.busy || scene.anim || scene.gliding) return;
    const q = map.panos.find((x) => x.id === id);
    if (!q) return toast('Переход ведёт на точку, которой уже нет');
    S.busy = true; const tok = ++S.tok;
    // у перехода есть видео прохода: показываем его, а следующее фото тем временем грузится
    const from = map.panos.find((x) => x.id === S.look.id), video = !noPhoto && from?.videos?.[id];
    if (video) {
      scene.setArrows([]); setEmbed(null);
      const tv = playTransition(video, { title: `${from.name} → ${q.name}`, sound: soundOn(), host: root.querySelector('.vis') });
      const tex = q.img ? scene.tryTex(q.img) : Promise.resolve(null);
      await tv.done;
      if (tok !== S.tok || !S.look) { tv.close(); return; }
      await tex;
      // смотрим дальше по ходу движения — как в конце видео
      const nx = routeNext(id);
      await openPano(id, nx ? { x: nx.x, y: nx.y } : { x: q.x + (q.x - from.x), y: q.y + (q.y - from.y) }, true);
      tv.close(); S.busy = false;
      return;
    }
    // переход «ладошкой»: ладонь закрывает кадр, под ней открывается следующая точка, ладонь уходит.
    // Смотрим по ходу маршрута (если он есть), иначе — дальше в направлении движения.
    scene.setArrows([]); $('#lkChips').innerHTML = ''; setEmbed(null);
    const nx = routeNext(id), face = nx ? { x: nx.x, y: nx.y } : { x: q.x + (q.x - from.x), y: q.y + (q.y - from.y) };
    // S.busy держим до конца анимации: раньше его снимали в момент смены панорамы, и повторное нажатие запускало
    // второй переход на том же видео, пока первый ещё шёл, — рывки, «залипшая» ладонь, не та панорама
    try { await palmWipe(root.querySelector('.stage'), () => (tok === S.tok && S.look ? openPano(id, face, true) : null)); }
    finally { S.busy = false; }
  }

  // ---------- звук, полный экран, снимок, ссылка ----------
  function syncSound() {
    const on = soundOn();
    root.querySelectorAll('[data-act="sound"]').forEach((b) => { b.setAttribute('aria-pressed', on); b.innerHTML = icon(on ? 'volume' : 'mute'); b.title = on ? 'Звук включён — выключить' : 'Звук выключен — включить'; });
  }
  function fullscreen() {
    const el = root.querySelector('.vis');
    if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
    if (!el.requestFullscreen || document.fullscreenEnabled === false) return toast('Полноэкранный режим недоступен: браузер или страница, куда встроена карта, его не разрешает', 5000);
    el.requestFullscreen().catch(() => toast('Браузер не разрешил полноэкранный режим', 4000));
  }
  function shot() {
    if (S.look && !$('.pano-embed', root).hidden) return toast('Панораму Google или YouTube сохранить нельзя: браузер не даёт доступа к чужому окну. Сделайте снимок экрана средствами системы.', 6000);
    if (S.view === '2d') return toast('Снимок сохраняется из 3D-вида и панорам — переключитесь на 3D', 4000);
    try {
      const href = scene.snapshot(), name = (S.look ? $('#lkName', root).textContent : title) || 'karta';
      Object.assign(document.createElement('a'), { href, download: `${slugify(name)}-${new Date().toISOString().slice(0, 10)}.jpg` }).click();
      toast('Снимок сохранён');
    } catch { toast('Не удалось сохранить снимок: фото загружено с другого сайта, браузер его не отдаёт', 5000); }
  }
  async function share() {
    const url = location.href, name = $('#lkName', root).textContent;
    try {
      if (navigator.share) await navigator.share({ title: `${name} · ${title}`, url });
      else { await navigator.clipboard.writeText(url); toast('Ссылка на панораму скопирована'); }
    } catch (e) { if (e?.name !== 'AbortError') toast('Скопируйте адрес из строки браузера', 4000); }
  }

  // ---------- «Спроси маскота»: помощник как бот, но прямо в карте ----------
  const chat = [];
  function askSheet(focus = true) {
    S.list = 'ask';
    const row = (m) => m.me ? `<div class="msg me">${esc(m.text)}</div>`
      : `<div class="msg bot"><p>${esc(m.text)}</p>${(m.items || []).map((it) => `<div class="msg-item"><span class="t"><b>${esc(it.name)}</b><span>${esc(it.sub || '')}${it.d !== undefined ? ` · ~${Math.max(5, Math.round(it.d / 5) * 5)} м` : ''}</span></span>
          <span class="row nowrap">${it.type === 'pano' ? `<button class="btn sm primary" data-pano="${it.id}">${icon('pano')}Открыть</button>` : `<button class="btn sm" data-go="${esc(it.ref)}">${icon('target')}На карте</button><button class="btn sm primary" data-routeto="${esc(it.ref)}">${icon('route')}Маршрут</button>`}</span></div>`).join('')}
          ${m.act === 'leaders' ? '<button class="btn sm" data-act="leaders">Таблица лидеров</button>' : ''}</div>`;
    sheet.set(`<div class="row nowrap"><button class="iconbtn flat" data-act="home" aria-label="Назад">${icon('back')}</button><h2 style="font-size:17px">Спросите маскота</h2></div>
      <div class="chat" id="chatLog">${chat.length ? chat.map(row).join('') : `<div class="msg bot"><p>Привет! Я знаю, где что находится в «${esc(title)}». Напишите вопрос или выберите подсказку.</p></div>`}</div>
      <div class="chips ask-sug">${SUGGEST.filter((x) => questItems.length || !/охот/.test(x)).map((x) => `<button class="opt" data-ask="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <form class="ask-form" id="askF"><input class="inp" id="askQ" placeholder="Например: где гардероб?" autocomplete="off" enterkeyhint="send" maxlength="200" aria-label="Вопрос маскоту"><button class="btn primary" aria-label="Спросить">${icon('chevron')}</button></form>`, 'full');
    const log = $('#chatLog', root); log.scrollTop = log.scrollHeight;
    if (focus && matchMedia('(pointer: fine)').matches) $('#askQ', root)?.focus();
  }
  function ask(text) {
    text = String(text || '').trim(); if (!text) return;
    // где посетитель: в панораме — там, где стоит; иначе считаем от главного входа
    const gate = map.pois.find((p) => p.cat === 'gate') || map.shapes.find((s) => s.cat === 'entrance');
    const here = S.look?.plan || lastPano(), from = here || (gate && placeOf(map, gate.id));
    const r = answer(map, text, { title, description: pub.venue?.description, from, fromLabel: here ? 'от вас' : 'от входа', quest: questItems.length ? { found: found.size, total: questItems.length } : null });
    chat.push({ me: true, text }, r);
    if (chat.length > 40) chat.splice(0, chat.length - 40);
    askSheet(false);
    // на компьютере маскот выходит и отвечает в облаке; на телефоне облако закрыло бы чат — ответ только в чате
    if (!matchMedia('(max-width: 600px)').matches) mascot.guide(r.text);
  }

  // ---------- «Пиксельная охота» ----------
  function questCard() {
    if (!questItems.length) return '';
    const n = found.size, total = questItems.length;
    return `<div class="quest-card"><img src="${PIXEL}" alt=""><div class="t"><b>Пиксельная охота · ${n} из ${total}</b>
      <span>${n === total ? 'Все пиксели найдены — вы настоящий охотник!' : 'Пиксели ТТК спрятаны в панорамах. Осматривайтесь и нажимайте на них.'}${me ? '' : ' <a href="admin.html#/register">Зарегистрируйтесь</a>, чтобы попасть в таблицу лидеров.'}</span>
      <div class="qbar"><i style="width:${Math.round((n / total) * 100)}%"></i></div></div>
      <button class="btn sm" data-act="leaders">Лидеры</button></div>`;
  }
  async function syncQuest() {
    try {
      const r = await api.questMine(), local = [...found].filter((id) => !r.found.includes(id));
      r.found.forEach((id) => found.add(id));
      if (local.length) await api.questFound(local);   // нашли до входа — засчитываем в профиль
      store.set(qKey, [...found]); scene.setQuestFound(found);
      if (!S.look && !S.sel && !S.list) home();
    } catch { /* без сети прогресс хранится в браузере */ }
  }
  function catchPixel(id) {
    if (found.has(id) || !questItems.some((p) => p.id === id)) return;
    found.add(id); store.set(qKey, [...found]); scene.setQuestFound(found);
    const n = found.size, total = questItems.length;
    if (me && !pub.draft) api.questFound([id]).catch(() => {});
    const px = (k) => `${k} ${k % 10 === 1 && k % 100 !== 11 ? 'пиксель' : [2, 3, 4].includes(k % 10) && ![12, 13, 14].includes(k % 100) ? 'пикселя' : 'пикселей'}`;
    toast(n === total ? (total === 1 ? 'Пиксель найден — охота завершена!' : `Найдены все ${px(total)}!`) : `Пиксель найден: ${n} из ${total}`, 3500);
    mascot.guide(n === total ? `Невероятно! Ты нашёл ${total === 1 ? 'пиксель' : 'все ' + px(total)} ТТК!\nЗагляни в таблицу лидеров.` : `Есть! Пиксель ТТК пойман — ${n} из ${total}.\nОстальные прячутся в других панорамах.`);
  }
  async function leaders() {
    const r = await api.questLeaders().catch(() => ({ leaders: [], total: questItems.length }));
    sheet.set(`<div class="row nowrap"><button class="iconbtn flat" data-act="home" aria-label="Назад">${icon('back')}</button><h2 style="font-size:17px">Пиксельная охота · лидеры</h2></div>
      ${r.leaders.length ? `<ol class="leaders">${r.leaders.map((l) => `<li><b>${esc(l.name)}</b><span>${l.found} из ${r.total}${l.done ? ' · все!' : ''}</span></li>`).join('')}</ol>` : '<p class="cap">Пока никто не нашёл ни одного пикселя — будьте первым!</p>'}
      <p class="cap">Показываем только имя, которое человек указал при регистрации.</p>`, 'half');
  }
  function stepToward(pt) {
    const p = map.panos.find((x) => x.id === S.look.id), a = Math.atan2(pt.y - p.y, pt.x - p.x);
    let best = null, bd = 0.8;
    // направление — как у стрелки на полу: если стрелку поставили вручную по фото, берём её угол, а не план
    for (const q of arrowItems(p, neighbors(map, p.id))) {
      const qa = Number.isFinite(q.yaw) ? q.yaw : Math.atan2(q.y - p.y, q.x - p.x);
      let d = Math.abs(qa - a) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < bd) { bd = d; best = q; }
    }
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
    const t = e.target.closest('[data-act],[data-go],[data-quick],[data-pano],[data-glide],[data-seat],[data-floor],[data-ask],[data-routeto]'); if (!t) return;
    const a = t.dataset.act;
    if (t.dataset.ask) return ask(t.dataset.ask);
    if (t.dataset.routeto) { if (S.look) exitLook(); card(t.dataset.routeto); show(t.dataset.routeto); routeSheet(); return; }
    if (a === 'ask') { if (S.look) exitLook(); return askSheet(); }
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
    if (a === 'sound') { setSound(!soundOn()); syncSound(); toast(soundOn() ? 'Звук включён' : 'Звук выключен'); }
    if (a === 'fullscreen') fullscreen();
    if (a === 'shot') shot();
    if (a === 'share') share();
    if (a === 'leaders') leaders();
    if (a === 'ldRetry') ldAct.retry?.();
    if (a === 'ldSkip') ldAct.skip?.();
  });
  document.addEventListener('fullscreenchange', () => root.querySelectorAll('[data-act="fullscreen"]').forEach((b) => b.setAttribute('aria-pressed', !!document.fullscreenElement)), { signal: window.__ac?.signal });
  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'askF') return;
    e.preventDefault(); const inp = $('#askQ', root); ask(inp.value); inp.value = '';
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
  const deep = hash0.match(/^#\/place\/([\w-]+)$/);
  if (deep) { const ref = /^[ABCD]\d{3}$/.test(deep[1]) ? 'sec:' + deep[1] : deep[1]; if (placeOf(map, ref)) { card(ref); show(ref); } else toast('Место по ссылке не найдено — возможно, его убрали с карты', 5000); }
  // ссылка на панораму: #/pano/<адрес> (или внутренний номер точки)
  const dp = hash0.match(/^#\/pano\/([\w-]+)$/);
  if (dp) {
    const p = map.panos.find((x) => x.slug === dp[1]) || map.panos.find((x) => x.id === dp[1]);
    if (p) openPano(p.id); else { setHash(''); toast('Панорама по ссылке не найдена — возможно, её удалили или сменили адрес', 5000); }
  }
}
