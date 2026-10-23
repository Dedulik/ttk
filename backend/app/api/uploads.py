"""Фото объектов и панорамы 360° (эквиректангулярные, соотношение 2:1)."""
import uuid
from pathlib import Path

from flask import Blueprint, current_app, g, request

from ..db import get_db, now, run
from ..errors import ApiError
from ..security import require_role

bp = Blueprint("uploads", __name__, url_prefix="/api/uploads")
ALLOWED = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAGIC = {".jpg": b"\xff\xd8", ".png": b"\x89PNG", ".webp": b"RIFF"}


@bp.post("")
@require_role("editor")
def upload():
    f = request.files.get("file")
    if not f:
        raise ApiError(422, "Файл не передан")
    ext = ALLOWED.get(f.mimetype or "")
    data = f.read()
    if not ext or not data.startswith(MAGIC[ext]):
        raise ApiError(415, "Можно загружать только JPG, PNG или WebP")
    if len(data) > current_app.config["MAX_UPLOAD_MB"] * 1024 * 1024:
        raise ApiError(413, f"Файл больше {current_app.config['MAX_UPLOAD_MB']} МБ")
    folder = Path(current_app.config["UPLOAD_DIR"])
    folder.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex + ext
    (folder / name).write_bytes(data)
    uid = run("INSERT INTO uploads (filename, stored_as, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?)",
              (f.filename or name)[:200], name, f.mimetype, len(data), g.user["id"], now())
    get_db().commit()
    return {"id": uid, "url": f"/uploads/{name}", "filename": f.filename, "size": len(data)}, 201
