"""Объекты (площадки) и их карты: список и конструктор объектов, опубликованная версия (для всех),
черновик (для сотрудников), публикация и история."""
import json
import re
from pathlib import Path

from flask import Blueprint, current_app, g, request

from ..db import audit, get_db, many, now, one, run
from ..errors import ApiError
from ..security import optional_user, require_role

bp = Blueprint("maps", __name__, url_prefix="/api/venues")
LISTS = ("shapes", "walls", "doors", "stairs", "pois", "panos", "links")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch - y - e yu ya".split()))


def make_slug(name: str) -> str:
    s = "".join(TRANSLIT.get(c, c) for c in name.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40] or "object"
    base, n = s if len(s) > 1 else "object", 2
    s = base
    while one("SELECT 1 FROM venues WHERE slug = ?", s):
        s, n = f"{base}-{n}", n + 1
    return s


def blank_map(name: str, w: float, h: float) -> dict:
    """Пустой план: только граница участка. Всё остальное админ рисует в конструкторе."""
    return {
        "version": 2, "name": name, "stadium": None, "bounds": {"w": w, "h": h},
        "shapes": [{"id": "site", "type": "rect", "kind": "zone", "cat": "plaza", "name": "Территория", "x": 0, "y": 0, "w": w, "h": h}],
        "walls": [], "doors": [], "stairs": [], "pois": [], "panos": [], "links": [],
        "sectors": {}, "style": {"cats": {}, "stands": {}, "poi": {}, "realSeats": True},
    }


def venue_out(v, staff: bool) -> dict:
    pub = one("SELECT number, published_at FROM map_versions WHERE venue_id = ? ORDER BY number DESC LIMIT 1", v["id"])
    owner = one("SELECT name, email, handle FROM users WHERE id = ?", v["created_by"]) if v["created_by"] else None
    out = {"slug": v["slug"], "name": v["name"], "description": v["description"],
           "published": pub["number"] if pub else None, "published_at": pub["published_at"] if pub else None,
           "owner": {"name": owner["name"] or "Администратор", "handle": owner["handle"]} if owner else None}
    if staff:
        d = one("SELECT revision, updated_at, updated_by FROM map_drafts WHERE venue_id = ?", v["id"])
        out.update(created_at=v["created_at"], created_by=who(v["created_by"]), revision=d["revision"] if d else None,
                   updated_at=d["updated_at"] if d else None, updated_by=who(d["updated_by"]) if d else None)
    return out


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


@bp.get("")
def list_venues():
    """Посетителям — только опубликованные объекты, сотрудникам — все, вместе с состоянием черновика."""
    staff = optional_user() is not None
    out = [venue_out(v, staff) for v in many("SELECT * FROM venues ORDER BY id")]
    return out if staff else [v for v in out if v["published"]]


@bp.get("/by/<handle>")
def venues_by(handle):
    """Личная ссылка администратора /?by=<handle>: его опубликованные объекты."""
    u = one("SELECT id, name, handle FROM users WHERE handle = ? AND is_active = 1", handle.lower())
    if not u:
        raise ApiError(404, "Такой ссылки нет: автор не найден или отключён")
    vs = [venue_out(v, False) for v in many("SELECT * FROM venues WHERE created_by = ? ORDER BY id", u["id"])]
    return {"owner": {"name": u["name"] or "Администратор", "handle": u["handle"]}, "venues": [v for v in vs if v["published"]]}


@bp.post("")
@require_role("admin")
def create_venue():
    b = request.get_json(silent=True) or {}
    name = str(b.get("name", "")).strip()[:120]
    if len(name) < 2:
        raise ApiError(422, "Назовите объект")
    slug = str(b.get("slug") or "").strip().lower() or make_slug(name)
    if not SLUG_RE.match(slug):
        raise ApiError(422, "Адрес объекта: латинские буквы, цифры и дефис, от 2 символов")
    if one("SELECT 1 FROM venues WHERE slug = ?", slug):
        raise ApiError(409, "Объект с таким адресом уже есть")
    start = b.get("start", "blank")
    if start == "blank":
        try:
            w, h = (max(20.0, min(5000.0, float(b.get(k) or 200))) for k in ("width", "height"))
        except (TypeError, ValueError):
            raise ApiError(422, "Размер участка — число метров")
        data = blank_map(name, w, h)
    elif start == "template":
        data = json.loads(Path(current_app.config["TEMPLATE_PATH"]).read_text(encoding="utf-8"))
        data["name"] = name
    elif start == "copy":
        src = venue(str(b.get("source", "")))
        data = json.loads(one("SELECT data FROM map_drafts WHERE venue_id = ?", src["id"])["data"])
        data["name"] = name
    else:
        raise ApiError(422, "Неизвестный способ создания")
    raw = validate_map(data)
    vid = run("INSERT INTO venues (slug, name, description, created_by, created_at) VALUES (?,?,?,?,?)",
              slug, name, str(b.get("description", "")).strip()[:500], g.user["id"], now())
    run("INSERT INTO map_drafts (venue_id, data, updated_by, updated_at) VALUES (?,?,?,?)", vid, raw, g.user["id"], now())
    audit(g.user["id"], "venue_create", f"{slug} ({start})")
    get_db().commit()
    return venue_out(one("SELECT * FROM venues WHERE id = ?", vid), True), 201


@bp.patch("/<slug>")
@require_role("admin")
def update_venue(slug):
    v, b = venue(slug), request.get_json(silent=True) or {}
    if b.get("name") is not None:
        name = str(b["name"]).strip()[:120]
        if len(name) < 2:
            raise ApiError(422, "Назовите объект")
        run("UPDATE venues SET name = ? WHERE id = ?", name, v["id"])
    if b.get("description") is not None:
        run("UPDATE venues SET description = ? WHERE id = ?", str(b["description"]).strip()[:500], v["id"])
    audit(g.user["id"], "venue_update", slug)
    get_db().commit()
    return venue_out(one("SELECT * FROM venues WHERE id = ?", v["id"]), True)


@bp.delete("/<slug>")
@require_role("admin")
def delete_venue(slug):
    v = venue(slug)
    if one("SELECT COUNT(*) AS n FROM venues")["n"] <= 1:
        raise ApiError(400, "Нельзя удалить единственный объект")
    if str((request.get_json(silent=True) or {}).get("confirm", "")) != slug:
        raise ApiError(422, "Для удаления подтвердите адрес объекта")
    for table in ("map_drafts", "map_versions"):
        run(f"DELETE FROM {table} WHERE venue_id = ?", v["id"])
    run("DELETE FROM venues WHERE id = ?", v["id"])
    audit(g.user["id"], "venue_delete", f"{slug} ({v['name']})")
    get_db().commit()
    return "", 204


@bp.get("/<slug>/map")
def published(slug):
    v = venue(slug)
    ver = one("SELECT * FROM map_versions WHERE venue_id = ? ORDER BY number DESC LIMIT 1", v["id"])
    if not ver:
        raise ApiError(404, "Карта этого объекта ещё не опубликована")
    return {"data": json.loads(ver["data"]), "number": ver["number"], "published_at": ver["published_at"],
            "venue": {"slug": v["slug"], "name": v["name"], "description": v["description"]}}


@bp.get("/<slug>/draft")
@require_role("viewer")
def get_draft(slug):
    v = venue(slug)
    return {**draft_out(one("SELECT * FROM map_drafts WHERE venue_id = ?", v["id"])), "venue": venue_out(v, True)}


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
