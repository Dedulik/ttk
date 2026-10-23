# Архитектура

## API

Все ответы — JSON, ошибки — `{"detail": "текст"}` с кодом 4xx. Авторизация — заголовок `Authorization: Bearer <token>`.

| Метод и путь | Доступ | Что делает |
| --- | --- | --- |
| `GET /api/health` | все | проверка, что сервер жив |
| `POST /api/auth/login` | все | `{email, password}` → `{token, user}` |
| `GET /api/auth/me` | наблюдатель+ | текущий пользователь |
| `GET /api/venues/rostov-arena/map` | все | последняя опубликованная версия `{data, number, published_at}` |
| `GET /api/venues/rostov-arena/draft` | наблюдатель+ | черновик `{data, revision, updated_at, updated_by}` |
| `PUT /api/venues/rostov-arena/draft` | редактор+ | `{data, base_revision}`; 409, если ревизия устарела |
| `POST /api/venues/rostov-arena/publish` | администратор | `{comment}` → новая версия |
| `GET /api/venues/rostov-arena/versions` | наблюдатель+ | история публикаций |
| `POST /api/venues/rostov-arena/versions/<id>/restore` | администратор | копирует версию в черновик |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/<id>` | администратор | сотрудники и роли |
| `POST /api/uploads` | редактор+ | multipart `file` (JPG/PNG/WebP, до 15 МБ) → `{url}` |

## Формат карты (`frontend/data/template_map.json`)

Координаты плана — метры, ось X вправо (восток), ось Y вниз (юг). Шаблон обведён по генплану, масштаб примерный: 1 px схемы ≈ 0,5 м.

```jsonc
{
  "version": 2,
  "stadium": { "cx": 333.5, "cy": 248.5 },            // центр поля; чаша строится по схеме секторов
  "shapes": [                                          // помещения, здания, зоны
    { "id": "s1", "type": "rect", "kind": "room", "cat": "hall", "name": "Пресс-центр",
      "x": 10, "y": 20, "w": 12, "h": 8, "height": 3.2, "color": "#2c5cc5", "desc": "…", "photo": "/uploads/…" },
    { "id": "s2", "type": "poly", "kind": "zone", "cat": "parking", "pts": [[0,0],[10,0],[10,5]] },
    { "id": "s3", "type": "ellipse", "kind": "building", "cx": 50, "cy": 50, "rx": 6, "ry": 4, "height": 8 }
  ],
  "walls":  [{ "id": "w1", "pts": [[0,0],[5,0],[5,5]], "thick": 0.2, "height": 3 }],
  "doors":  [{ "id": "d1", "x": 5, "y": 2, "w": 1.6 }],           // вырезает проём в ближайшей стене
  "stairs": [{ "id": "st1", "x": 0, "y": 0, "w": 6, "h": 3, "dir": "x", "rise": 3 }],
  "pois":   [{ "id": "m1", "name": "Медпункт", "cat": "med", "x": 362, "y": 393, "z": 0, "text": "…" }],
  "panos":  [{ "id": "p1", "name": "КПП «Юг»", "x": 328, "y": 478, "z": 0, "img": "/uploads/…" }],
  "links":  [["p1", "p2"]],                                       // переходы между панорамами = граф маршрутов
  "sectors": { "A105": { "text": "…", "color": "#…" } },
  "style":  { "stands": {}, "cats": {}, "poi": {}, "realSeats": true }
}
```

- `kind`: `building` — стены и крыша, `room` — стены без крыши, `zone` — разметка на земле.
- `z` у меток и панорам — уровень пола. Например, галерея вокруг чаши стоит на подиуме высотой 6 м.
- Маршрут ищется алгоритмом Дейкстры по графу `links`: от ближайшей к старту панорамы до ближайшей к цели.

## Фронтенд

| Модуль | Ответственность |
| --- | --- |
| `core/model.js` | справочники, геометрия фигур, стены с проёмами, маршруты, поиск |
| `core/stadium.js` | чаша: суперэллипс вокруг поля, 80 секторов по схеме (A101–B138, A401–B442) |
| `core/plan2d.js` | SVG-план: подписи в экранных пикселях, жесты (сдвиг, щипок, колесо) |
| `core/scene3d.js` | three.js: территория, стадион по фото, режимы «обзор» (MapControls) и «взгляд из точки» |
| `core/api.js` | клиент API + демо-режим в localStorage с теми же ролями |
| `visitor/visitor.js` | поиск, шторка, карточки, маршрут, панорамы, вид с места, мини-карта |
| `admin/tools.js` | инструменты рисования и расстановки точек |
| `admin/admin.js` | вход, инспектор свойств, публикация, версии, пользователи, цвета |
