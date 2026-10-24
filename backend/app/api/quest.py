"""«Пиксельная охота» — игра поверх карты: администратор прячет на ней пиксели ТТК (метки типа quest),
посетитель находит их в панорамах. Без входа прогресс живёт в браузере; после входа — на сервере
и попадает в таблицу лидеров. Сервер засчитывает только пиксели, которые реально есть на опубликованной карте."""
import json

from flask import Blueprint, g, request

from ..db import get_db, many, now, one, run
from ..errors import ApiError
from ..security import rate, require_role
from .maps import venue

bp = Blueprint("quest", __name__, url_prefix="/api/quest")


def quest_items(v) -> set[str]:
    ver = one("SELECT data FROM map_versions WHERE venue_id = ? ORDER BY number DESC LIMIT 1", v["id"])
    if not ver:
        return set()
    return {p["id"] for p in json.loads(ver["data"]).get("pois", []) if isinstance(p, dict) and p.get("cat") == "quest"}


@bp.get("/<slug>/me")
@require_role("user")
def my_progress(slug):
    v = venue(slug)
    return {"found": [r["item_id"] for r in many("SELECT item_id FROM quest_finds WHERE user_id = ? AND venue_id = ?", g.user["id"], v["id"])],
            "total": len(quest_items(v))}


@bp.post("/<slug>/found")
@require_role("user")
def found(slug):
    """Засчитать найденные пиксели (можно сразу несколько — например, собранные до входа)."""
    rate(f"quest:{g.user['id']}", 60, 600)
    v = venue(slug)
    items = quest_items(v)
    ids = (request.get_json(silent=True) or {}).get("items", [])
    if not isinstance(ids, list) or len(ids) > 200:
        raise ApiError(422, "Неверный список")
    added = 0
    for i in {str(x)[:64] for x in ids} & items:
        if not one("SELECT 1 FROM quest_finds WHERE user_id = ? AND venue_id = ? AND item_id = ?", g.user["id"], v["id"], i):
            run("INSERT INTO quest_finds (user_id, venue_id, item_id, found_at) VALUES (?,?,?,?)", g.user["id"], v["id"], i, now())
            added += 1
    get_db().commit()
    return {**my_progress.__wrapped__(slug), "added": added}


@bp.get("/<slug>/leaders")
def leaders(slug):
    """Таблица лидеров: больше найдено — выше; при равенстве — кто собрал раньше. Почта не показывается."""
    v = venue(slug)
    items = quest_items(v)
    if not items:
        return {"total": 0, "leaders": []}
    marks = ",".join("?" * len(items))
    rows = many(f"""SELECT u.name, u.handle, COUNT(*) AS n, MAX(q.found_at) AS last FROM quest_finds q JOIN users u ON u.id = q.user_id
                    WHERE q.venue_id = ? AND u.is_active = 1 AND q.item_id IN ({marks}) GROUP BY q.user_id ORDER BY n DESC, last ASC LIMIT 10""",
                v["id"], *items)
    return {"total": len(items), "leaders": [{"name": r["name"] or r["handle"], "found": r["n"], "done": r["n"] >= len(items), "at": r["last"]} for r in rows]}
