"""Сотрудники и администраторы: список, создание, роли, блокировка, сброс пароля. Только для администратора."""
from flask import Blueprint, g, request

from ..db import audit, free_handle, get_db, many, now, one, run
from ..errors import ApiError
from ..security import ROLES, check_password, hash_password, public_user, require_role

bp = Blueprint("users", __name__, url_prefix="/api/users")


def admins() -> int:
    return one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1")["n"]


@bp.get("")
@require_role("admin")
def list_users():
    return [public_user(u, full=True) for u in many("SELECT * FROM users ORDER BY role = 'admin' DESC, created_at")]


@bp.post("")
@require_role("admin")
def create_user():
    b = request.get_json(silent=True) or {}
    email, name, role = str(b.get("email", "")).strip().lower(), str(b.get("name", "")).strip()[:120], b.get("role", "editor")
    if "@" not in email or len(email) > 200:
        raise ApiError(422, "Укажите почту")
    pw = check_password(b.get("password"))
    if role not in ROLES:
        raise ApiError(422, "Неизвестная роль")
    if one("SELECT id FROM users WHERE email = ?", email):
        raise ApiError(409, "Пользователь с такой почтой уже есть")
    uid = run("INSERT INTO users (email, name, password_hash, role, created_at, password_changed_at, handle) VALUES (?,?,?,?,?,?,?)",
              email, name, hash_password(pw), role, now(), now(), free_handle(get_db(), email.split("@")[0]))
    audit(g.user["id"], "user_create", f"{email} {role}")
    get_db().commit()
    return public_user(one("SELECT * FROM users WHERE id = ?", uid), full=True), 201


@bp.patch("/<int:user_id>")
@require_role("admin")
def update_user(user_id):
    u = one("SELECT * FROM users WHERE id = ?", user_id)
    if not u:
        raise ApiError(404, "Пользователь не найден")
    b = request.get_json(silent=True) or {}
    role, changes = b.get("role"), []
    last_admin = u["role"] == "admin" and u["is_active"] and admins() <= 1
    if role is not None and role != u["role"]:
        if role not in ROLES:
            raise ApiError(422, "Неизвестная роль")
        if last_admin and role != "admin":
            raise ApiError(400, "Нельзя снять права с последнего администратора")
        run("UPDATE users SET role = ? WHERE id = ?", role, user_id)
        changes.append(f"роль → {role}")
    if b.get("name") is not None:
        run("UPDATE users SET name = ? WHERE id = ?", str(b["name"]).strip()[:120], user_id)
    if b.get("password"):
        pw = check_password(b["password"])
        run("UPDATE users SET password_hash = ?, password_changed_at = ?, token_version = token_version + 1 WHERE id = ?", hash_password(pw), now(), user_id)
        changes.append("новый пароль")
    if b.get("is_active") is not None:
        active = bool(b["is_active"])
        if not active and (u["id"] == g.user["id"] or last_admin):
            raise ApiError(400, "Нельзя отключить себя или последнего администратора")
        # отключение сразу завершает все сессии человека
        run("UPDATE users SET is_active = ?, token_version = token_version + ? WHERE id = ?", int(active), 0 if active else 1, user_id)
        changes.append("включён" if active else "отключён")
    if b.get("unlock"):
        run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", user_id)
        changes.append("разблокирован")
    audit(g.user["id"], "user_update", f"{u['email']}: {', '.join(changes) or 'имя'}")
    get_db().commit()
    return public_user(one("SELECT * FROM users WHERE id = ?", user_id), full=True)


@bp.delete("/<int:user_id>")
@require_role("admin")
def delete_user(user_id):
    u = one("SELECT * FROM users WHERE id = ?", user_id)
    if not u:
        raise ApiError(404, "Пользователь не найден")
    if u["id"] == g.user["id"]:
        raise ApiError(400, "Нельзя удалить самого себя")
    if u["role"] == "admin" and u["is_active"] and admins() <= 1:
        raise ApiError(400, "Нельзя удалить последнего администратора")
    for table, col in (("map_drafts", "updated_by"), ("map_versions", "published_by"), ("uploads", "uploaded_by"), ("audit_events", "user_id"), ("venues", "created_by")):
        run(f"UPDATE {table} SET {col} = NULL WHERE {col} = ?", user_id)
    run("DELETE FROM users WHERE id = ?", user_id)
    audit(g.user["id"], "user_delete", u["email"])
    get_db().commit()
    return "", 204
