"""Фото объектов, подложки, иконки и панорамы 360° (эквиректангулярные, соотношение 2:1).

Проверки на сервере: тип по содержимому файла (а не по имени), размер, разрешение картинки,
для панорам 360° — пропорция 2:1. Файл сохраняется под случайным именем, отдаётся с nosniff."""
import struct
import uuid
from pathlib import Path

from flask import Blueprint, current_app, g, request

from ..db import get_db, now, run
from ..errors import ApiError
from ..security import rate, require_role

bp = Blueprint("uploads", __name__, url_prefix="/api/uploads")
ALLOWED = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAGIC = {".jpg": b"\xff\xd8", ".png": b"\x89PNG", ".webp": b"RIFF"}
MAX_SIDE = 16384


def image_size(data: bytes, ext: str):
    """Ширина и высота из заголовка PNG / JPEG / WebP без сторонних библиотек; None — файл повреждён."""
    try:
        if ext == ".png":
            return struct.unpack(">II", data[16:24])
        if ext == ".webp" and data[8:12] == b"WEBP":
            kind = data[12:16]
            if kind == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30]); return w & 0x3FFF, h & 0x3FFF
            if kind == b"VP8L":
                b = data[21:25]; return 1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
            if kind == b"VP8X":
                return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if ext == ".jpg":
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1; continue
                marker = data[i + 1]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9]); return w, h
                i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    except (struct.error, IndexError):
        return None
    return None


@bp.post("")
@require_role("editor")
def upload():
    rate(f"upload:{g.user['id']}", 120, 600)                 # не больше 120 файлов за 10 минут
    f = request.files.get("file")
    if not f:
        raise ApiError(422, "Файл не передан")
    ext = ALLOWED.get(f.mimetype or "")
    data = f.read()
    if not ext or not data.startswith(MAGIC[ext]):
        raise ApiError(415, "Можно загружать только JPG, PNG или WebP")
    if len(data) > current_app.config["MAX_UPLOAD_MB"] * 1024 * 1024:
        raise ApiError(413, f"Файл больше {current_app.config['MAX_UPLOAD_MB']} МБ")
    size = image_size(data, ext)
    if not size or min(size) < 16 or max(size) > MAX_SIDE:
        raise ApiError(415, f"Картинка повреждена или слишком большая (до {MAX_SIDE} px по стороне)")
    w, h = size
    if request.form.get("kind") == "pano360":
        # панорама 360° в эквидистантной проекции — ровно в два раза шире, чем выше
        if abs(w / h - 2) > 0.04:
            raise ApiError(422, f"Для панорамы 360° нужно фото с пропорцией 2:1 (эквиректангулярное). У этого файла {w}×{h}")
        if w < 2000:
            raise ApiError(422, f"Панорама слишком маленькая ({w}×{h}). Нужно от 2000×1000, лучше 4096×2048 и больше")
    folder = Path(current_app.config["UPLOAD_DIR"])
    folder.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex + ext
    (folder / name).write_bytes(data)
    uid = run("INSERT INTO uploads (filename, stored_as, mime, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?)",
              (f.filename or name)[:200], name, f.mimetype, len(data), g.user["id"], now())
    get_db().commit()
    return {"id": uid, "url": f"/uploads/{name}", "filename": f.filename, "size": len(data), "width": w, "height": h}, 201
