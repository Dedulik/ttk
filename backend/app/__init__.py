"""Карта пространства · Ростов Арена — бэкенд (Flask + SQLite).

Один процесс отдаёт и API (/api/...), и сайт (frontend/), и загруженные фото (/uploads/...).
"""
import json
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from . import config
from .api import auth, maps, uploads, users
from .db import SCHEMA, close_db, connect, now
from .errors import ApiError
from .security import hash_password


def seed(cfg: dict) -> None:
    con = connect(cfg["DB_PATH"])
    con.executescript(SCHEMA)
    v = con.execute("SELECT id FROM venues WHERE slug = ?", (cfg["VENUE_SLUG"],)).fetchone()
    vid = v["id"] if v else con.execute("INSERT INTO venues (slug, name) VALUES (?, ?)", (cfg["VENUE_SLUG"], "Ростов Арена")).lastrowid
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
    con.commit()
    con.close()


def create_app(overrides: dict | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.update(config.load())
    app.config.update(overrides or {})
    app.config["MAX_CONTENT_LENGTH"] = (app.config["MAX_UPLOAD_MB"] + 1) * 1024 * 1024
    seed(app.config)

    for bp in (auth.bp, maps.bp, users.bp, uploads.bp):
        app.register_blueprint(bp)
    app.teardown_appcontext(close_db)

    @app.errorhandler(ApiError)
    def api_error(e: ApiError):
        return jsonify(detail=e.detail), e.status

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(detail="Файл слишком большой"), 413

    @app.after_request
    def cors(resp):
        origin = request.headers.get("Origin")
        if origin and origin in app.config["CORS_ORIGINS"]:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
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
        if not (front / path).is_file():
            path = "index.html"
        return send_from_directory(front, path)

    return app
