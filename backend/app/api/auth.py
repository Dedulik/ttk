"""Вход и личный кабинет: профиль, адрес личной ссылки, смена пароля, выход на всех устройствах, своя история действий."""
import re

from flask import Blueprint, current_app, g, request

from ..db import audit, free_handle, get_db, many, now, one, run
from ..errors import ApiError
from ..security import (MAX_FAILS, check_password, create_token, hash_password, ip_blocked, ip_failed, is_locked,
                        lock_until, public_user, rate, require_role, verify_password)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,29}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")


@bp.post("/register")
def register():
    """Регистрация посетителя. Роль всегда 'user': поля role/is_admin из запроса игнорируются —
    сотрудником или администратором можно стать только по приглашению."""
    if not current_app.config["ALLOW_REGISTRATION"]:
        raise ApiError(403, "Регистрация сейчас закрыта")
    ip = request.remote_addr or ""
    rate(f"reg:{ip}", 5, 3600)                       # не больше 5 регистраций в час с одного адреса
    body = request.get_json(silent=True) or {}
    if body.get("website"):                          # скрытое поле-ловушка: его заполняют только боты
        raise ApiError(400, "Не удалось зарегистрироваться")
    email = str(body.get("email", "")).strip().lower()
    name = str(body.get("name", "")).strip()[:80]
    if not EMAIL_RE.match(email) or len(email) > 200:
        raise ApiError(422, "Проверьте адрес почты")
    if len(name) < 2:
        raise ApiError(422, "Как к вам обращаться? Имя — от 2 символов")
    pw = check_password(body.get("password"))
    if one("SELECT 1 FROM users WHERE email = ?", email):
        raise ApiError(409, "Эта почта уже зарегистрирована — войдите или восстановите доступ у администратора")
    uid = run("INSERT INTO users (email, name, password_hash, role, created_at, password_changed_at, handle, last_login_at) VALUES (?,?,?,?,?,?,?,?)",
              email, name, hash_password(pw), "user", now(), now(), free_handle(get_db(), email.split("@")[0]), now())
    audit(uid, "register", email)
    get_db().commit()
    user = one("SELECT * FROM users WHERE id = ?", uid)
    return {"token": create_token(user), "user": public_user(user, full=True)}, 201


@bp.post("/login")
def login():
    ip = request.remote_addr or ""
    if ip_blocked(ip):
        raise ApiError(429, "Слишком много неудачных попыток входа. Подождите 10 минут")
    body = request.get_json(silent=True) or {}
    email = str(body.get("email", "")).strip().lower()
    user = one("SELECT * FROM users WHERE email = ?", email)
    if user and is_locked(user):
        raise ApiError(423, "Учётная запись временно заблокирована после неверных паролей. Попробуйте через 15 минут или попросите администратора")
    if not user or not verify_password(str(body.get("password", "")), user["password_hash"]):
        ip_failed(ip)
        if user:
            fails = (0 if user["locked_until"] else user["failed_logins"]) + 1   # прошлая блокировка истекла — счёт заново
            run("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", fails, lock_until() if fails >= MAX_FAILS else None, user["id"])
            audit(user["id"], "login_failed", f"попытка {fails}")
            if fails >= MAX_FAILS:
                audit(user["id"], "account_locked", f"{MAX_FAILS} неверных паролей подряд")
            get_db().commit()
        raise ApiError(401, "Неверная почта или пароль")
    if not user["is_active"]:
        raise ApiError(403, "Учётная запись отключена администратором")
    run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", now(), user["id"])
    audit(user["id"], "login")
    get_db().commit()
    user = one("SELECT * FROM users WHERE id = ?", user["id"])
    return {"token": create_token(user), "user": public_user(user, full=True)}


@bp.get("/me")
@require_role("user")
def me():
    return public_user(g.user, full=True)


@bp.patch("/me")
@require_role("user")
def update_me():
    """Своё имя и пароль. Новый пароль требует текущий и завершает остальные сессии."""
    b = request.get_json(silent=True) or {}
    out = {}
    if b.get("name") is not None:
        run("UPDATE users SET name = ? WHERE id = ?", str(b["name"]).strip()[:120], g.user["id"])
    if b.get("handle") is not None:
        h = str(b["handle"]).strip().lower()
        if not HANDLE_RE.match(h):
            raise ApiError(422, "Адрес ссылки: латинские буквы, цифры и дефис, от 3 до 30 символов")
        if one("SELECT 1 FROM users WHERE handle = ? AND id != ?", h, g.user["id"]):
            raise ApiError(409, "Такой адрес уже занят")
        run("UPDATE users SET handle = ? WHERE id = ?", h, g.user["id"])
        audit(g.user["id"], "handle_change", h)
    if b.get("new_password"):
        if not verify_password(str(b.get("password", "")), g.user["password_hash"]):
            raise ApiError(403, "Текущий пароль указан неверно")
        pw = check_password(b["new_password"])
        run("UPDATE users SET password_hash = ?, password_changed_at = ?, token_version = token_version + 1 WHERE id = ?", hash_password(pw), now(), g.user["id"])
        audit(g.user["id"], "password_change")
    get_db().commit()
    user = one("SELECT * FROM users WHERE id = ?", g.user["id"])
    if b.get("new_password"):
        out["token"] = create_token(user)   # эта вкладка остаётся в системе, остальные выходят
    return {**out, "user": public_user(user, full=True)}


@bp.post("/logout-all")
@require_role("user")
def logout_all():
    run("UPDATE users SET token_version = token_version + 1 WHERE id = ?", g.user["id"])
    audit(g.user["id"], "logout_all")
    get_db().commit()
    return "", 204


@bp.get("/me/activity")
@require_role("user")
def my_activity():
    rows = many("SELECT action, details, ip, created_at FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 50", g.user["id"])
    return [dict(r) for r in rows]
