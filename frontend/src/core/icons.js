// Значки ТТК для меток и точек обзора (assets/icons). Один реестр на 2D-план, 3D-сцену и списки.
// Для типов без своего значка остаётся прежний кружок с буквой.

const BASE = new URL('../../assets/icons/', import.meta.url).href;
export const ICON_FILES = {
  pano: '360.png', marker: 'marker.png',
  info: 'marker.png', gate: 'main-entrance.png', hall: 'hall-entrance.png', registration: 'registration.png', ticket: 'cashier.png',
  wardrobe: 'wardrobe.png', wc: 'wc.png', food: 'food.png', coffee: 'coffee.png', stage: 'stage.png',
  partners: 'partners.png', participants: 'participants.png', custom: '360.png',
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
