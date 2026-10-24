// Значки ТТК для меток и точек обзора (assets/icons). Один реестр на 2D-план, 3D-сцену и списки.
// Для типов без своего значка остаётся прежний кружок с буквой.

const BASE = new URL('../../assets/icons/', import.meta.url).href;
export const ICON_FILES = {
  pano: '360.png', marker: 'marker.png',
  info: 'marker.png', gate: 'main-entrance.png', hall: 'hall-entrance.png', registration: 'registration.png', ticket: 'cashier.png',
  wardrobe: 'wardrobe.png', wc: 'wc.png', food: 'food.png', coffee: 'coffee.png', stage: 'stage.png',
  partners: 'partners.png', participants: 'participants.png', custom: '360.png', quest: 'pixel.png',
};
/** Адрес значка для типа метки (или 'pano', 'marker'), null — значка нет. */
export const iconUrl = (k) => (ICON_FILES[k] ? BASE + ICON_FILES[k] : null);

// картинки загружаем один раз: 3D-сцена рисует их на холсте, поэтому ждёт загрузки
const imgs = {};
export const iconsReady = Promise.all(Object.entries(ICON_FILES).map(([k, f]) => new Promise((res) => {
  const im = new Image(); im.onload = () => { imgs[k] = im; res(); }; im.onerror = () => res(); im.src = BASE + f;
})));
/** Загруженная картинка значка или null. */
export const iconImage = (k) => imgs[k] || null;

/** Набор значков, из которых админ выбирает значок метки или точки обзора. */
export const ICON_CHOICES = [
  ['marker', 'Метка'], ['pano', '360°'], ['gate', 'Главный вход'], ['hall', 'Вход в зал'], ['registration', 'Регистрация'], ['ticket', 'Касса'],
  ['wardrobe', 'Гардероб'], ['wc', 'Туалет'], ['food', 'Еда'], ['coffee', 'Кофе'], ['stage', 'Сцена'], ['partners', 'Партнёры'], ['participants', 'Участники'],
];
/** Адрес значка точки: свой загруженный (iconUrl), выбранный из набора (icon) или по типу. */
export const pointIconUrl = (p, kind) => p?.iconUrl || iconUrl(p?.icon) || iconUrl(kind);

const own = {};
/** Картинка значка точки для 3D. Свой значок догружается; когда он готов — вызывается onload (сцена перерисует метку). */
export function pointIconImage(p, kind, onload) {
  if (p?.iconUrl) {
    const im = own[p.iconUrl];
    if (im?.complete && im.naturalWidth) return im;
    if (!im) { const n = new Image(); n.onload = () => onload?.(); n.src = p.iconUrl; own[p.iconUrl] = n; }
  }
  return iconImage(p?.icon) || iconImage(kind);
}
