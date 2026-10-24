// «Спроси маскота» — помощник в духе Telegram-бота, но прямо в карте и без сервера:
// понимает простые вопросы («где туалет?», «как пройти на регистрацию», «хочу кофе») и отвечает
// местами с этой карты — с кнопками «На карте», «Маршрут», «Панорама». Ничего никуда не отправляет.
import { dist, nearestPano, placeOf, search } from '../core/model.js';

// слова → типы меток и зон карты (корни, чтобы ловить «туалет», «туалеты», «туалета»)
const TOPICS = [
  { re: /туалет|уборн|wc|санузел|туалэ/, poi: ['wc'], shape: ['wc'], n: 'Туалет' },
  { re: /поесть|еда|еду|кафе|столов|буфет|перекус|голод|фудкорт|ресторан/, poi: ['food', 'coffee'], shape: ['food'], n: 'Еда' },
  { re: /коф|чай|напит/, poi: ['coffee', 'food'], shape: ['food'], n: 'Кофе' },
  { re: /вход|войти|зайти|выход|выйти/, poi: ['gate', 'hall'], shape: ['entrance'], n: 'Вход' },
  { re: /регистрац|бейдж|аккредит/, poi: ['registration'], shape: [], n: 'Регистрация' },
  { re: /гардероб|куртк|одежд|раздевал/, poi: ['wardrobe'], shape: [], n: 'Гардероб' },
  { re: /медпункт|врач|аптеч|плохо|травм|медик/, poi: ['med'], shape: [], n: 'Медпункт' },
  { re: /касс|билет|оплат/, poi: ['ticket'], shape: ['service'], n: 'Кассы' },
  { re: /сцен|выступлен|концерт|шоу/, poi: ['stage'], shape: ['stage'], n: 'Сцена' },
  { re: /партн[её]р|стенд|выставк/, poi: ['partners'], shape: ['expo', 'events'], n: 'Партнёры' },
  { re: /участник/, poi: ['participants'], shape: [], n: 'Зона участников' },
  { re: /встреч|встретиться|потерял/, poi: ['meet'], shape: [], n: 'Место встречи' },
  { re: /парковк|машин|авто/, poi: ['transport'], shape: ['parking'], n: 'Парковка' },
  { re: /спорт|бег|дорожк|трениров|манеж|арен/, poi: [], shape: ['sport'], n: 'Спортивные зоны' },
];
export const SUGGEST = ['Где туалет?', 'Хочу кофе', 'Как пройти на регистрацию?', 'Где вход?', 'Покажи панорамы', 'Что такое пиксельная охота?'];

const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = /^(где|как|куда|пройти|пройду|найти|мне|хочу|можно|покажи|подскажи|тут|здесь|есть|ли|а|в|на|до|к|ко|у|по|с|и|ближайший|ближайшая|ближайшее|пожалуйста|дорогу)$/;

/**
 * Ответ на вопрос. ctx.from — где сейчас посетитель (точка плана) — по нему сортируем по близости.
 * Возвращает { text, items: [{ ref, name, sub, d }], act? }.
 */
export function answer(map, question, ctx = {}) {
  const q = norm(question), from = ctx.from;
  if (!q) return { text: 'Напишите, что ищете: например, «где туалет» или «хочу кофе».' };
  if (/^(привет|здравств|добр(ый|ое)|хай|hello|hi)/.test(q)) return { text: `Привет! Я помогу сориентироваться в «${ctx.title}». Спросите, где что находится, — покажу на карте и проложу маршрут.` };
  if (/спасиб|благодар/.test(q)) return { text: 'Всегда пожалуйста! Если что — я рядом 🙂' };
  if (/охот|пиксел/.test(q)) {
    return ctx.quest
      ? { text: `«Пиксельная охота»: в панорамах спрятаны пиксели ТТК — осматривайтесь и нажимайте на них. Найдено ${ctx.quest.found} из ${ctx.quest.total}. Зарегистрированные попадают в таблицу лидеров.`, act: 'leaders' }
      : { text: 'На этой карте охоты пока нет — организаторы ещё не спрятали пиксели.' };
  }
  if (/панорам|360|осмотр|посмотреть вокруг/.test(q)) {
    const items = rank(map.panos.map((p) => placeOf(map, p.id)), from).slice(0, 6);
    return items.length ? { text: `Точек обзора 360°: ${map.panos.length}. Откройте любую — по стрелкам можно ходить дальше.`, items, kind: 'pano' } : { text: 'Панорам на этой карте пока нет.' };
  }
  if (/^(что (тут|здесь)|о месте|расскажи|помощь|помоги|что ты умеешь|help)/.test(q)) {
    return { text: `${ctx.description ? ctx.description + '. ' : ''}Я ищу места на карте и прокладываю маршруты. Попробуйте: ${SUGGEST.slice(0, 3).map((s) => `«${s}»`).join(', ')}.` };
  }
  const route = /как (пройти|дойти|попасть|добраться)|маршрут|дорог|проведи|веди/.test(q);
  const topic = TOPICS.find((t) => t.re.test(q));
  let items = [];
  if (topic) {
    items = [
      ...map.pois.filter((p) => topic.poi.includes(p.cat)).map((p) => placeOf(map, p.id)),
      ...map.shapes.filter((s) => topic.shape.includes(s.cat)).map((s) => placeOf(map, s.id)),
    ];
  }
  if (!items.length) {
    // по словам вопроса: «где зал 2», «покажи сцену» → обычный поиск по названиям
    const words = q.split(' ').filter((w) => w.length > 2 && !STOP.test(w));
    for (const w of [words.join(' '), ...words]) { if (!w) continue; items = search(map, w.slice(0, Math.max(3, w.length - 2))); if (items.length) break; }
  }
  items = rank(items.filter(Boolean), from).slice(0, 5);
  if (!items.length) return { text: `Не нашёл такого на карте «${ctx.title}». Попробуйте другими словами или выберите подсказку ниже.` };
  const first = items[0], np = nearestPano(map, first);
  const where = from && first.d !== undefined ? ` — примерно ${Math.max(5, Math.round(first.d / 5) * 5)} м ${ctx.fromLabel || 'от вас'}` : '';
  const text = items.length === 1 || route
    ? `${route ? 'Проложу маршрут' : 'Нашёл'}: «${first.name}»${where}.${np && dist(np, first) < 40 ? ` Рядом есть панорама «${np.name}».` : ''}`
    : `Нашёл ${items.length}${from ? `: ближайшее — «${first.name}»${where}` : ''}.`;
  return { text, items, route };
}

function rank(list, from) {
  if (!from) return list;
  return list.map((p) => ({ ...p, d: dist(p, from) })).sort((a, b) => a.d - b.d);
}

