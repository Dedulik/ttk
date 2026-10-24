"""Пароли, токены, ролевой доступ и защита входа.

Роли по возрастанию прав:
    viewer  — наблюдатель: видит черновик и историю версий, ничего не меняет
    editor  — редактор: рисует помещения, ставит точки, сохраняет черновик, загружает фото
    admin   — администратор: всё выше + публикация, объекты, сотрудники, журнал и резервные копии
Посетители карты не входят в систему и видят только опубликованную версию.

Защита:
    · пароли — PBKDF2-SHA256, 200 000 итераций, своя соль у каждого;
    · 5 неверных паролей подряд — учётная запись блокируется на 15 минут;
    · с одного IP не больше 20 неудачных входов за 10 минут;
    · в токене номер «поколения» сессий: смена пароля, блокировка или «выйти везде» отзывают все старые токены;
    · роль и активность проверяются по базе при каждом запросе.
"""
import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import jwt
from flask import current_app, g, request

from .db import one
from .errors import ApiError

ROLES = ("viewer", "editor", "admin")
LEVEL = {r: i for i, r in enumerate(ROLES)}
ROLE_NAMES = {"viewer": "наблюдатель", "editor": "редактор", "admin": "администратор"}
DEFAULT_SECRET = "dev-only-change-me"
_ITER = 200_000
MAX_FAILS, LOCK_MIN = 5, 15
IP_FAILS, IP_WINDOW = 20, 600


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITER)
    return f"pbkdf2${_ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(it))
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


def check_password(pw: str) -> str:
    """Требования к новому паролю: от 8 символов, есть буквы и цифры."""
    pw = str(pw or "")
    if len(pw) < 8 or len(pw) > 200 or not re.search(r"[^\W\d_]", pw) or not re.search(r"\d", pw):
        raise ApiError(422, "Пароль — от 8 символов, нужны буквы и цифры")
    return pw


def load_secret(cfg: dict) -> str:
    """Секрет для подписи токенов. Если он не задан в окружении, создаётся случайный и хранится рядом с базой."""
    if cfg["SECRET_KEY"] != DEFAULT_SECRET:
        cfg["SECRET_SOURCE"] = "env"
        return cfg["SECRET_KEY"]
    path = Path(cfg["DB_PATH"]).parent / "secret.key"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        restrict(path)
    cfg["SECRET_SOURCE"] = "file"
    return path.read_text(encoding="utf-8").strip()


def restrict(path: Path) -> None:
    """Файл доступен только владельцу (на Windows права наследуются от профиля пользователя)."""
    if os.name == "posix" and path.exists():
        os.chmod(path, 0o600)


# ---------- ограничение частоты входа ----------
_ip_fails: dict[str, list[float]] = {}
_lock = threading.Lock()


def ip_blocked(ip: str) -> bool:
    with _lock:
        recent = [t for t in _ip_fails.get(ip, []) if time.time() - t < IP_WINDOW]
        _ip_fails[ip] = recent
        return len(recent) >= IP_FAILS


def ip_failed(ip: str) -> None:
    with _lock:
        _ip_fails.setdefault(ip, []).append(time.time())


def lock_until() -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=LOCK_MIN)).isoformat(timespec="seconds")


def is_locked(user) -> bool:
    return bool(user["locked_until"]) and datetime.fromisoformat(user["locked_until"]) > datetime.now(timezone.utc)


# ---------- токены ----------
def create_token(user) -> str:
    payload = {
        "sub": str(user["id"]),
        "tv": user["token_version"],
        "exp": datetime.now(timezone.utc) + timedelta(minutes=current_app.config["TOKEN_TTL_MIN"]),
    }
    return jwt.encode(payload, current_app.config["SECRET_KEY"], algorithm="HS256")


def _decode(header: str):
    if not header.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(header[7:], current_app.config["SECRET_KEY"], algorithms=["HS256"])
    except jwt.PyJWTError:
        raise ApiError(401, "Сессия истекла, войдите снова")
    user = one("SELECT * FROM users WHERE id = ?", int(payload["sub"]))
    if not user or payload.get("tv") != user["token_version"]:
        raise ApiError(401, "Сессия завершена, войдите снова")
    if not user["is_active"]:
        raise ApiError(401, "Учётная запись отключена администратором")
    return user


def _load_user():
    user = _decode(request.headers.get("Authorization", ""))
    if not user:
        raise ApiError(401, "Нужно войти")
    return user


def optional_user():
    """Пользователь, если запрос пришёл с действующим токеном, иначе None (для открытых адресов)."""
    try:
        return _decode(request.headers.get("Authorization", ""))
    except ApiError:
        return None


def require_role(min_role: str):
    """Декоратор: пускает пользователя с ролью не ниже min_role, кладёт его в g.user.
    Роль берётся из базы, а не из токена — понижение прав действует сразу."""

    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = _load_user()
            if LEVEL.get(user["role"], -1) < LEVEL[min_role]:
                raise ApiError(403, f"Недостаточно прав: нужна роль «{ROLE_NAMES[min_role]}»")
            g.user = user
            return fn(*args, **kwargs)

        return wrapper

    return deco


def public_user(row, full: bool = False) -> dict:
    u = {"id": row["id"], "email": row["email"], "name": row["name"], "role": row["role"], "created_at": row["created_at"], "handle": row["handle"]}
    if full:
        u.update(last_login_at=row["last_login_at"], is_active=bool(row["is_active"]), locked=is_locked(row),
                 failed_logins=row["failed_logins"], password_changed_at=row["password_changed_at"])
    return u
