from flask import Blueprint, g, request

from ..db import audit, get_db, one
from ..errors import ApiError
from ..security import create_token, public_user, require_role, verify_password

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email", "")).strip().lower()
    user = one("SELECT * FROM users WHERE email = ?", email)
    if not user or not verify_password(str(body.get("password", "")), user["password_hash"]):
        raise ApiError(401, "Неверная почта или пароль")
    audit(user["id"], "login")
    get_db().commit()
    return {"token": create_token(user), "user": public_user(user)}


@bp.get("/me")
@require_role("viewer")
def me():
    return public_user(g.user)
