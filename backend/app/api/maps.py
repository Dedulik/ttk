"""Карта площадки: опубликованная версия (для всех), черновик (для сотрудников), публикация и история."""
import json

from flask import Blueprint, current_app, g, request

from ..db import audit, get_db, many, now, one, run
from ..errors import ApiError
from ..security import require_role

bp = Blueprint("maps", __name__, url_prefix="/api/venues")
LISTS = ("shapes", "walls", "doors", "stairs", "pois", "panos", "links")


def venue(slug: str):
    v = one("SELECT * FROM venues WHERE slug = ?", slug)
    if not v:
        raise ApiError(404, "Площадка не найдена")
    return v


def who(user_id):
    if not user_id:
        return None
    u = one("SELECT name, email FROM users WHERE id = ?", user_id)
    return (u["name"] or u["email"]) if u else None


def validate_map(data) -> str:
    if not isinstance(data, dict):
        raise ApiError(422, "Карта должна быть объектом")
    for key in LISTS:
        if not isinstance(data.setdefault(key, []), list):
            raise ApiError(422, f"Поле «{key}» должно быть списком")
    ids = [x.get("id") for key in LISTS if key != "links" for x in data[key] if isinstance(x, dict)]
    if None in ids or len(ids) != len(set(ids)):
        raise ApiError(422, "У каждого объекта карты должен быть свой уникальный id")
    panos = {p["id"] for p in data["panos"]}
    for link in data["links"]:
        if not (isinstance(link, list) and len(link) == 2 and link[0] in panos and link[1] in panos):
            raise ApiError(422, "Связь ссылается на несуществующую панораму")
    raw = json.dumps(data, ensure_ascii=False)
    if len(raw.encode()) > current_app.config["MAX_MAP_BYTES"]:
        raise ApiError(413, "Карта слишком большая")
    return raw


def draft_out(d):
    return {"data": json.loads(d["data"]), "revision": d["revision"], "updated_at": d["updated_at"], "updated_by": who(d["updated_by"])}


@bp.get("/<slug>/map")
def published(slug):
    v = venue(slug)
    ver = one("SELECT * FROM map_versions WHERE venue_id = ? ORDER BY number DESC LIMIT 1", v["id"])
    if not ver:
        raise ApiError(404, "Карта ещё не опубликована")
    return {"data": json.loads(ver["data"]), "number": ver["number"], "published_at": ver["published_at"]}


@bp.get("/<slug>/draft")
@require_role("viewer")
def get_draft(slug):
    return draft_out(one("SELECT * FROM map_drafts WHERE venue_id = ?", venue(slug)["id"]))


@bp.put("/<slug>/draft")
@require_role("editor")
def save_draft(slug):
    v = venue(slug)
    body = request.get_json(silent=True) or {}
    d = one("SELECT * FROM map_drafts WHERE venue_id = ?", v["id"])
    if body.get("base_revision") != d["revision"]:
        raise ApiError(409, f"Черновик уже изменил(а) {who(d['updated_by']) or 'другой редактор'}. Обновите карту — ваши правки не потеряются, если сохранить их заново.")
    raw = validate_map(body.get("data"))
    run("UPDATE map_drafts SET data = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE venue_id = ?", raw, g.user["id"], now(), v["id"])
    get_db().commit()
    return draft_out(one("SELECT * FROM map_drafts WHERE venue_id = ?", v["id"]))


@bp.post("/<slug>/publish")
@require_role("admin")
def publish(slug):
    v = venue(slug)
    comment = str((request.get_json(silent=True) or {}).get("comment", ""))[:300]
    d = one("SELECT * FROM map_drafts WHERE venue_id = ?", v["id"])
    num = (one("SELECT MAX(number) AS n FROM map_versions WHERE venue_id = ?", v["id"])["n"] or 0) + 1
    vid = run("INSERT INTO map_versions (venue_id, number, data, comment, published_by, published_at) VALUES (?,?,?,?,?,?)",
              v["id"], num, d["data"], comment, g.user["id"], now())
    audit(g.user["id"], "publish", f"v{num} {comment}")
    get_db().commit()
    r = one("SELECT * FROM map_versions WHERE id = ?", vid)
    return {"id": vid, "number": num, "comment": comment, "published_at": r["published_at"], "published_by": who(g.user["id"])}


@bp.get("/<slug>/versions")
@require_role("viewer")
def versions(slug):
    rows = many("SELECT id, number, comment, published_at, published_by FROM map_versions WHERE venue_id = ? ORDER BY number DESC LIMIT 50", venue(slug)["id"])
    return [{"id": r["id"], "number": r["number"], "comment": r["comment"], "published_at": r["published_at"], "published_by": who(r["published_by"])} for r in rows]


@bp.post("/<slug>/versions/<int:version_id>/restore")
@require_role("admin")
def restore(slug, version_id):
    """Копирует старую версию в черновик. Посетители увидят её после публикации."""
    v = venue(slug)
    ver = one("SELECT * FROM map_versions WHERE id = ? AND venue_id = ?", version_id, v["id"])
    if not ver:
        raise ApiError(404, "Версия не найдена")
    run("UPDATE map_drafts SET data = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE venue_id = ?", ver["data"], g.user["id"], now(), v["id"])
    audit(g.user["id"], "restore", f"v{ver['number']}")
    get_db().commit()
    return draft_out(one("SELECT * FROM map_drafts WHERE venue_id = ?", v["id"]))
