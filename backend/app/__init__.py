"""Карта пространства · Ростов Арена — бэкенд (Flask + SQLite).

Один процесс отдаёт и API (/api/...), и сайт (frontend/), и загруженные фото (/uploads/...).
"""
import base64
import mimetypes
import hashlib
import json
import re
import secrets
import sqlite3
import string
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from . import config
from .api import admin, auth, invites, maps, quest, uploads, users
from .db import close_db, connect, migrate, now
from .errors import ApiError
from .security import hash_password, load_secret, restrict


def seed_venue(con, slug: str, name: str, path: str, comment: str) -> None:
    """Объект из файла карты: создаёт его (черновик и версия 1) или обновляет, если карту в базе никто не правил."""
    v = con.execute("SELECT id FROM venues WHERE slug = ?", (slug,)).fetchone()
    vid = v["id"] if v else con.execute("INSERT INTO venues (slug, name, created_at) VALUES (?, ?, ?)", (slug, name, now())).lastrowid
    if not Path(path).is_file():
        return
    raw = json.dumps(json.loads(Path(path).read_text(encoding="utf-8")), ensure_ascii=False)
    if not con.execute("SELECT 1 FROM map_drafts WHERE venue_id = ?", (vid,)).fetchone():
        con.execute("INSERT INTO map_drafts (venue_id, data, updated_at) VALUES (?,?,?)", (vid, raw, now()))
        con.execute("INSERT INTO map_versions (venue_id, number, data, comment, published_at) VALUES (?,1,?,?,?)", (vid, raw, comment, now()))
        return
    # Файл карты в репозитории обновился (новые фото, точки), а база создана раньше — раньше она навсегда оставалась
    # со старой картой. Обновляем, только если карту никто не трогал: все версии выпущены сервером из файла
    # (published_by пуст), а черновик совпадает с последней версией. Карты, которые правили в конструкторе, не трогаем.
    last = con.execute("SELECT number, data FROM map_versions WHERE venue_id = ? ORDER BY number DESC LIMIT 1", (vid,)).fetchone()
    draft = con.execute("SELECT data FROM map_drafts WHERE venue_id = ?", (vid,)).fetchone()
    untouched = not con.execute("SELECT 1 FROM map_versions WHERE venue_id = ? AND published_by IS NOT NULL", (vid,)).fetchone()
    if last and untouched and json.loads(draft["data"]) == json.loads(last["data"]) and json.loads(last["data"]) != json.loads(raw):
        con.execute("UPDATE map_drafts SET data = ?, updated_at = ?, revision = revision + 1 WHERE venue_id = ?", (raw, now(), vid))
        con.execute("INSERT INTO map_versions (venue_id, number, data, comment, published_at) VALUES (?,?,?,?,?)",
                    (vid, last["number"] + 1, raw, comment + " · обновлено из репозитория", now()))


def new_password() -> str:
    """Случайный пароль из 14 символов: буквы и цифры (проходит правила сложности сайта)."""
    abc = string.ascii_letters + string.digits
    while True:
        pw = "".join(secrets.choice(abc) for _ in range(14))
        if any(c.isdigit() for c in pw) and any(c.isalpha() for c in pw):
            return pw


def save_admin_password(cfg: dict, email: str, pw: str) -> Path:
    """Пароль администратора — в data/admin-password.txt рядом с базой (папка data/ не попадает в git)."""
    path = Path(cfg["DB_PATH"]).parent / "admin-password.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    site = (cfg.get("PUBLIC_URL") or "http://localhost:8000").rstrip("/")
    path.write_text(f"Админ-панель: {site}/admin\nПочта: {email}\nПароль: {pw}\n"
                    "Смените пароль в личном кабинете. Забыли — python reset_password.py "
                    "(в Docker: docker compose exec app python reset_password.py)\n", encoding="utf-8")
    restrict(path)
    return path


def seed(cfg: dict) -> None:
    con = connect(cfg["DB_PATH"])
    migrate(con)
    # BEGIN IMMEDIATE — запись в базу только у одного процесса: второй воркер gunicorn ждёт, пока первый закончит,
    # и видит уже созданного администратора. Раньше оба придумывали свой пароль: в базе оставался пароль одного,
    # а в admin-password.txt — другого, и «пароль из файла не подходил»
    con.commit()                      # закрыть неявную транзакцию миграции перед блокировкой
    con.execute("BEGIN IMMEDIATE")
    seed_venue(con, cfg["MAIN_SLUG"], cfg["MAIN_NAME"], cfg["MAIN_PATH"], "Манеж ДГТУ")
    seed_venue(con, cfg["VENUE_SLUG"], "Ростов Арена", cfg["TEMPLATE_PATH"], "Шаблон по генплану")
    if not con.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        pw = cfg["ADMIN_PASSWORD"] or new_password()
        if not cfg["ADMIN_PASSWORD"]:
            save_admin_password(cfg, cfg["ADMIN_EMAIL"], pw)
        people = [(cfg["ADMIN_EMAIL"], "Администратор", pw, "admin")]
        if cfg["SEED_DEMO_USERS"]:
            people += [("editor@arena.local", "Редактор", "editor12345", "editor"), ("viewer@arena.local", "Наблюдатель", "viewer12345", "viewer")]
        for email, name, pw, role in people:
            con.execute("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)", (email, name, hash_password(pw), role, now()))
    elif cfg["ADMIN_PASSWORD"] and cfg["ADMIN_PASSWORD_RESET"]:
        # ADMIN_PASSWORD_RESET=1: при запуске выставить администратору пароль из ADMIN_PASSWORD (и снять блокировку).
        # Без этого флага ADMIN_PASSWORD действует только при создании базы — пароль, сменённый в кабинете, не затирается
        con.execute("""UPDATE users SET password_hash = ?, password_changed_at = ?, token_version = token_version + 1,
                       failed_logins = 0, locked_until = NULL, is_active = 1 WHERE email = ?""",
                    (hash_password(cfg["ADMIN_PASSWORD"]), now(), cfg["ADMIN_EMAIL"].lower()))
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
mimetypes.add_type("video/webm", ".webm")   # на Windows реестр может не знать этих типов
mimetypes.add_type("video/mp4", ".mp4")


def create_app(overrides: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.update(config.load())
    app.config.update(overrides or {})
    app.config["MAX_CONTENT_LENGTH"] = (max(app.config["MAX_UPLOAD_MB"], app.config["MAX_VIDEO_MB"]) + 1) * 1024 * 1024
    app.config["SECRET_KEY"] = load_secret(app.config)
    if app.config["TRUST_PROXY"]:
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
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
        # камера и датчики движения — только для своего сайта (съёмка панорам в конструкторе)
        resp.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=(), gyroscope=(self), accelerometer=(self), magnetometer=(self)"
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
