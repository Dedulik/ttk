"""Приглашения сотрудников и администраторов по электронной почте.

Безопасность:
  · пригласить может только администратор (проверка на сервере, роль берётся из базы);
  · токен — 32 случайных байта, в базе хранится только его SHA-256: утечка базы не даёт рабочих ссылок;
  · ссылка одноразовая и живёт INVITE_TTL_HOURS часов, её можно отозвать;
  · принять приглашение может только владелец почты, на которую оно выписано: для существующей учётной записи
    нужен её пароль, для новой — пароль задаётся при принятии;
  · роль только повышается, понизить через приглашение нельзя; роль берётся из приглашения, а не из запроса.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, g, request

from ..db import audit, free_handle, get_db, many, now, one, run
from ..errors import ApiError
from ..mailer import mail_configured, send_mail
from ..security import (LEVEL, ROLE_NAMES, STAFF_ROLES, check_password, create_token, hash_password, ip_blocked,
                        ip_failed, public_user, rate, require_role, verify_password)
from .auth import EMAIL_RE

bp = Blueprint("invites", __name__, url_prefix="/api/invites")
digest = lambda token: hashlib.sha256(token.encode()).hexdigest()


def link_for(token: str) -> str:
    base = current_app.config["PUBLIC_URL"].rstrip("/") or request.host_url.rstrip("/")
    return f"{base}/admin.html#/invite/{token}"     # токен в «#»: он не попадает в журналы сервера и Referer


def invite_out(r) -> dict:
    state = "used" if r["used_at"] else "revoked" if r["revoked_at"] else "expired" if r["expires_at"] < now() else "pending"
    by = one("SELECT name, email FROM users WHERE id = ?", r["created_by"]) if r["created_by"] else None
    return {"id": r["id"], "email": r["email"], "role": r["role"], "state": state, "created_at": r["created_at"],
            "expires_at": r["expires_at"], "used_at": r["used_at"], "by": (by["name"] or by["email"]) if by else None}


def valid_invite(token: str):
    """Действующее приглашение по токену или понятная ошибка. Неверные токены считаем попытками перебора."""
    ip = request.remote_addr or ""
    if ip_blocked(ip):
        raise ApiError(429, "Слишком много попыток. Подождите 10 минут")
    r = one("SELECT * FROM invites WHERE token_hash = ?", digest(str(token)[:200]))
    if not r:
        ip_failed(ip)
        raise ApiError(404, "Приглашение не найдено. Проверьте ссылку или попросите прислать новую")
    if r["used_at"]:
        raise ApiError(410, "Это приглашение уже использовано. Войдите со своей почтой и паролем")
    if r["revoked_at"]:
        raise ApiError(410, "Приглашение отозвано администратором")
    if r["expires_at"] < now():
        raise ApiError(410, "Срок приглашения истёк. Попросите администратора прислать новое")
    return r


@bp.post("")
@require_role("admin")
def create_invite():
    rate(f"invite:{g.user['id']}", 30, 3600)
    b = request.get_json(silent=True) or {}
    email, role = str(b.get("email", "")).strip().lower(), b.get("role", "editor")
    if not EMAIL_RE.match(email) or len(email) > 200:
        raise ApiError(422, "Проверьте адрес почты")
    if role not in STAFF_ROLES:
        raise ApiError(422, "Можно пригласить наблюдателя, редактора или администратора")
    u = one("SELECT role FROM users WHERE email = ?", email)
    if u and LEVEL[u["role"]] >= LEVEL[role]:
        raise ApiError(409, f"У {email} уже есть роль «{ROLE_NAMES[u['role']]}» или выше")
    # прошлые неиспользованные приглашения на эту почту больше не действуют
    run("UPDATE invites SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL", now(), email)
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(hours=current_app.config["INVITE_TTL_HOURS"])).isoformat(timespec="seconds")
    iid = run("INSERT INTO invites (email, role, token_hash, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)",
              email, role, digest(token), g.user["id"], now(), expires)
    audit(g.user["id"], "invite_create", f"{email} {role}")
    get_db().commit()
    link = link_for(token)
    who = g.user["name"] or g.user["email"]
    sent = send_mail(email, "Приглашение в админ-панель «Карта пространства»",
                     f"Здравствуйте!\n\n{who} приглашает вас в админ-панель «Карта пространства» с ролью «{ROLE_NAMES[role]}».\n\n"
                     f"Принять приглашение: {link}\n\nСсылка одноразовая и действует {current_app.config['INVITE_TTL_HOURS']} ч. "
                     "Если вы не ждали этого письма — просто проигнорируйте его.")
    out = {"invite": invite_out(one("SELECT * FROM invites WHERE id = ?", iid)), "emailed": sent, "mail_configured": mail_configured()}
    if not sent:
        out["link"] = link            # почты нет — ссылку видит только пригласивший администратор
    return out, 201


@bp.get("")
@require_role("admin")
def list_invites():
    return [invite_out(r) for r in many("SELECT * FROM invites ORDER BY id DESC LIMIT 100")]


@bp.delete("/<int:invite_id>")
@require_role("admin")
def revoke_invite(invite_id):
    r = one("SELECT * FROM invites WHERE id = ?", invite_id)
    if not r:
        raise ApiError(404, "Приглашение не найдено")
    if not r["used_at"] and not r["revoked_at"]:
        run("UPDATE invites SET revoked_at = ? WHERE id = ?", now(), invite_id)
        audit(g.user["id"], "invite_revoke", r["email"])
        get_db().commit()
    return "", 204


@bp.get("/accept/<token>")
def check_invite(token):
    r = valid_invite(token)
    return {"email": r["email"], "role": r["role"], "role_name": ROLE_NAMES[r["role"]], "expires_at": r["expires_at"],
            "exists": bool(one("SELECT 1 FROM users WHERE email = ?", r["email"]))}


@bp.post("/accept/<token>")
def accept_invite(token):
    rate(f"accept:{request.remote_addr}", 20, 600)
    r = valid_invite(token)
    b = request.get_json(silent=True) or {}
    u = one("SELECT * FROM users WHERE email = ?", r["email"])
    if u:
        # учётная запись уже есть (например, посетитель) — подтверждаем владение её паролем
        if not verify_password(str(b.get("password", "")), u["password_hash"]):
            ip_failed(request.remote_addr or "")
            raise ApiError(403, "Неверный пароль от учётной записи с этой почтой")
        if not u["is_active"]:
            raise ApiError(403, "Учётная запись отключена администратором")
        if LEVEL[r["role"]] > LEVEL[u["role"]]:
            run("UPDATE users SET role = ? WHERE id = ?", r["role"], u["id"])
        uid = u["id"]
    else:
        name = str(b.get("name", "")).strip()[:80]
        if len(name) < 2:
            raise ApiError(422, "Укажите имя — от 2 символов")
        pw = check_password(b.get("password"))
        uid = run("INSERT INTO users (email, name, password_hash, role, created_at, password_changed_at, handle) VALUES (?,?,?,?,?,?,?)",
                  r["email"], name, hash_password(pw), r["role"], now(), now(), free_handle(get_db(), r["email"].split("@")[0]))
    run("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?", now(), uid, r["id"])
    run("UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?", now(), uid)
    audit(uid, "invite_accept", f"{r['email']} {r['role']}")
    get_db().commit()
    user = one("SELECT * FROM users WHERE id = ?", uid)
    return {"token": create_token(user), "user": public_user(user, full=True)}
