"""Карта пространства · Ростов Арена — бэкенд (Flask + SQLite).

Один процесс отдаёт и API (/api/...), и сайт (frontend/), и загруженные фото (/uploads/...).
"""
import base64
import mimetypes
import hashlib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from . import config
from .api import admin, auth, invites, maps, quest, uploads, users
from .db import close_db, connect, migrate, now
from .errors import ApiError
from .security import hash_password, load_secret, restrict


def seed(cfg: dict) -> None:
    con = connect(cfg["DB_PATH"])
    migrate(con)
    v = con.execute("SELECT id FROM venues WHERE slug = ?", (cfg["VENUE_SLUG"],)).fetchone()
    vid = v["id"] if v else con.execute("INSERT INTO venues (slug, name, created_at) VALUES (?, ?, ?)", (cfg["VENUE_SLUG"], "Ростов Арена", now())).lastrowid
    if not con.execute("SELECT 1 FROM map_drafts WHERE venue_id = ?", (vid,)).fetchone():
        raw = json.dumps(json.loads(Path(cfg["TEMPLATE_PATH"]).read_text(encoding="utf-8")), ensure_ascii=False)
        con.execute("INSERT INTO map_drafts (venue_id, data, updated_at) VALUES (?,?,?)", (vid, raw, now()))
        con.execute("INSERT INTO map_versions (venue_id, number, data, comment, published_at) VALUES (?,1,?,?,?)", (vid, raw, "Шаблон по генплану", now()))
    if not con.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        people = [(cfg["ADMIN_EMAIL"], "Администратор", cfg["ADMIN_PASSWORD"], "admin")]
        if cfg["SEED_DEMO_USERS"]:
            people += [("editor@arena.local", "Редактор", "editor12345", "editor"), ("viewer@arena.local", "Наблюдатель", "viewer12345", "viewer")]
        for email, name, pw, role in people:
            con.execute("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)", (email, name, hash_password(pw), role, now()))
    migrate(con)   # адреса ссылок для только что созданных записей
    # у объектов без автора автором становится первый администратор — его ссылка покажет их посетителям
    first = con.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
    if first:
        con.execute("UPDATE venues SET created_by = ? WHERE created_by IS NULL", (first["id"],))
    con.commit()
    con.close()
    restrict(Path(cfg["DB_PATH"]))


def backup_on_start(cfg: dict) -> None:
    """Копия базы при каждом запуске сервера, хранятся последние BACKUP_KEEP штук."""
    db = Path(cfg["DB_PATH"])
    if not cfg["BACKUP_KEEP"] or not db.exists() or db.stat().st_size == 0:
        return
    folder = db.parent / "backups"
    folder.mkdir(exist_ok=True)
    dst = folder / f"app-{datetime.now():%Y%m%d-%H%M%S}.db"
    src, out = sqlite3.connect(db), sqlite3.connect(dst)
    with out:
        src.backup(out)
    out.close(); src.close()
    restrict(dst)
    for old in sorted(folder.glob("app-*.db"), reverse=True)[cfg["BACKUP_KEEP"]:]:
        old.unlink(missing_ok=True)


def inline_script_hashes(front: Path) -> str:
    """CSP разрешает только свои скрипты; встроенные importmap пропускаем по хэшу содержимого."""
    out = set()
    for page in front.glob("*.html"):
        for body in re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", page.read_text(encoding="utf-8"), re.S):
            out.add("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
    return " ".join(sorted(out))


mimetypes.add_type("application/manifest+json", ".webmanifest")


def create_app(overrides: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.update(config.load())
    app.config.update(overrides or {})
    app.config["MAX_CONTENT_LENGTH"] = (app.config["MAX_UPLOAD_MB"] + 1) * 1024 * 1024
    app.config["SECRET_KEY"] = load_secret(app.config)
    backup_on_start(app.config)
    seed(app.config)
    csp = ("default-src 'self'; script-src 'self' " + inline_script_hashes(Path(app.config["FRONTEND_DIR"])) +
           "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; "
           "frame-src https://www.google.com https://maps.google.com https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; base-uri 'self'; "
           "form-action 'self'; frame-ancestors 'self'")

    for bp in (auth.bp, maps.bp, users.bp, uploads.bp, admin.bp, invites.bp, quest.bp):
        app.register_blueprint(bp)
    app.teardown_appcontext(close_db)

    @app.errorhandler(ApiError)
    def api_error(e: ApiError):
        return jsonify(detail=e.detail), e.status

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(detail="Файл слишком большой"), 413

    @app.after_request
    def headers(resp):
        origin = request.headers.get("Origin")
        if origin and origin in app.config["CORS_ORIGINS"]:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        if request.path.endswith("/sw.js"):
            resp.headers["Cache-Control"] = "no-cache"      # новая версия сервис-воркера подхватывается сразу
        if resp.mimetype == "text/html":
            resp.headers["Content-Security-Policy"] = csp
        return resp

    @app.route("/api/<path:_any>", methods=["OPTIONS"])
    def preflight(_any):
        return "", 204

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/uploads/<path:name>")
    def uploaded(name):
        return send_from_directory(app.config["UPLOAD_DIR"], name, max_age=86400)

    @app.get("/")
    @app.get("/<path:path>")
    def site(path="index.html"):
        front = Path(app.config["FRONTEND_DIR"])
        if path.startswith("api/"):
            raise ApiError(404, "Нет такого адреса API")
        if path.rstrip("/") == "admin":
            path = "admin.html"
        if not (front / path).is_file():
            path = "index.html"
        return send_from_directory(front, path)

    return app
