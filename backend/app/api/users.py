from flask import Blueprint, g, request

from ..db import audit, get_db, many, now, one, run
from ..errors import ApiError
from ..security import ROLES, hash_password, public_user, require_role

bp = Blueprint("users", __name__, url_prefix="/api/users")


def admins() -> int:
    return one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")["n"]


@bp.get("")
@require_role("admin")
def list_users():
    return [public_user(u) for u in many("SELECT * FROM users ORDER BY created_at")]


@bp.post("")
@require_role("admin")
def create_user():
    b = request.get_json(silent=True) or {}
    email, name, pw, role = str(b.get("email", "")).strip().lower(), str(b.get("name", ""))[:120], str(b.get("password", "")), b.get("role", "editor")
    if "@" not in email or len(email) > 200:
        raise ApiError(422, "Укажите почту")
    if len(pw) < 6:
        raise ApiError(422, "Пароль — минимум 6 символов")
    if role not in ROLES:
        raise ApiError(422, "Неизвестная роль")
    if one("SELECT id FROM users WHERE email = ?", email):
        raise ApiError(409, "Пользователь с такой почтой уже есть")
    uid = run("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)", email, name, hash_password(pw), role, now())
    audit(g.user["id"], "user_create", f"{email} {role}")
    get_db().commit()
    return public_user(one("SELECT * FROM users WHERE id = ?", uid)), 201


@bp.patch("/<int:user_id>")
@require_role("admin")
def update_user(user_id):
    u = one("SELECT * FROM users WHERE id = ?", user_id)
    if not u:
        raise ApiError(404, "Пользователь не найден")
    b = request.get_json(silent=True) or {}
    role = b.get("role")
    if role is not None:
        if role not in ROLES:
            raise ApiError(422, "Неизвестная роль")
        if u["role"] == "admin" and role != "admin" and admins() <= 1:
            raise ApiError(400, "Нельзя снять права с последнего администратора")
        run("UPDATE users SET role = ? WHERE id = ?", role, user_id)
    if b.get("name") is not None:
        run("UPDATE users SET name = ? WHERE id = ?", str(b["name"])[:120], user_id)
    if b.get("password"):
        if len(b["password"]) < 6:
            raise ApiError(422, "Пароль — минимум 6 символов")
        run("UPDATE users SET password_hash = ? WHERE id = ?", hash_password(b["password"]), user_id)
    audit(g.user["id"], "user_update", f"{u['email']} {role or ''}")
    get_db().commit()
    return public_user(one("SELECT * FROM users WHERE id = ?", user_id))


@bp.delete("/<int:user_id>")
@require_role("admin")
def delete_user(user_id):
    u = one("SELECT * FROM users WHERE id = ?", user_id)
    if not u:
        raise ApiError(404, "Пользователь не найден")
    if u["id"] == g.user["id"]:
        raise ApiError(400, "Нельзя удалить самого себя")
    if u["role"] == "admin" and admins() <= 1:
        raise ApiError(400, "Нельзя удалить последнего администратора")
    for table, col in (("map_drafts", "updated_by"), ("map_versions", "published_by"), ("uploads", "uploaded_by"), ("audit_events", "user_id")):
        run(f"UPDATE {table} SET {col} = NULL WHERE {col} = ?", user_id)
    run("DELETE FROM users WHERE id = ?", user_id)
    audit(g.user["id"], "user_delete", u["email"])
    get_db().commit()
    return "", 204
