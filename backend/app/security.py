"""Пароли, токены и ролевой доступ.

Роли по возрастанию прав:
    viewer  — наблюдатель: видит черновик и историю версий, ничего не меняет
    editor  — редактор: рисует помещения, ставит точки, сохраняет черновик, загружает фото
    admin   — администратор: всё выше + публикация, откат версий, управление пользователями
Посетители карты не входят в систему и видят только опубликованную версию.
"""
import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from flask import current_app, g, request

from .db import one
from .errors import ApiError

ROLES = ("viewer", "editor", "admin")
LEVEL = {r: i for i, r in enumerate(ROLES)}
ROLE_NAMES = {"viewer": "наблюдатель", "editor": "редактор", "admin": "администратор"}
_ITER = 200_000


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


def create_token(user) -> str:
    payload = {
        "sub": str(user["id"]),
        "role": user["role"],
        "exp": datetime.now(timezone.utc) + timedelta(minutes=current_app.config["TOKEN_TTL_MIN"]),
    }
    return jwt.encode(payload, current_app.config["SECRET_KEY"], algorithm="HS256")


def _load_user():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise ApiError(401, "Нужно войти")
    try:
        payload = jwt.decode(header[7:], current_app.config["SECRET_KEY"], algorithms=["HS256"])
    except jwt.PyJWTError:
        raise ApiError(401, "Сессия истекла, войдите снова")
    user = one("SELECT * FROM users WHERE id = ?", int(payload["sub"]))
    if not user:
        raise ApiError(401, "Пользователь не найден")
    return user


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


def public_user(row) -> dict:
    return {"id": row["id"], "email": row["email"], "name": row["name"], "role": row["role"], "created_at": row["created_at"]}
