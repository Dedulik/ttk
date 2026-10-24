"""Безопасность для администратора: журнал действий, проверка настроек, резервные копии базы."""
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path

from flask import Blueprint, after_this_request, current_app, g, request, send_file

from ..db import audit, get_db, many, now, one
from ..security import require_role, verify_password

bp = Blueprint("admin", __name__, url_prefix="/api/admin")
DEMO_PASSWORDS = {"admin@arena.local": "admin12345", "editor@arena.local": "editor12345", "viewer@arena.local": "viewer12345"}


def backup_to(dst: Path) -> Path:
    """Согласованная копия SQLite (через backup API — безопасно при работающем сервере)."""
    src = sqlite3.connect(current_app.config["DB_PATH"])
    out = sqlite3.connect(dst)
    with out:
        src.backup(out)
    out.close(); src.close()
    return dst


def backups_dir() -> Path:
    return Path(current_app.config["DB_PATH"]).parent / "backups"


@bp.get("/audit")
@require_role("admin")
def audit_log():
    limit = max(1, min(500, int(request.args.get("limit", 200))))
    rows = many("""SELECT a.id, a.action, a.details, a.ip, a.created_at, u.email, u.name FROM audit_events a
                   LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?""", limit)
    return [dict(r) for r in rows]


@bp.get("/security")
@require_role("admin")
def security_report():
    """Сводка для страницы «Безопасность»: что уже защищено и что стоит поправить."""
    weak = [u["email"] for u in many("SELECT email, password_hash FROM users WHERE is_active = 1")
            if u["email"] in DEMO_PASSWORDS and verify_password(DEMO_PASSWORDS[u["email"]], u["password_hash"])]
    db = Path(current_app.config["DB_PATH"])
    bdir = backups_dir()
    files = sorted(bdir.glob("*.db"), reverse=True) if bdir.exists() else []
    today = now()[:10]
    return {
        "secret_source": current_app.config.get("SECRET_SOURCE", "env"),
        "default_passwords": weak,
        "admins": one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1")["n"],
        "users": one("SELECT COUNT(*) AS n FROM users")["n"],
        "locked": [r["email"] for r in many("SELECT email FROM users WHERE locked_until > ?", now())],
        "failed_today": one("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'login_failed' AND created_at >= ?", today)["n"],
        "db_size": db.stat().st_size if db.exists() else 0,
        "token_ttl_min": current_app.config["TOKEN_TTL_MIN"],
        "backups": [{"name": f.name, "size": f.stat().st_size} for f in files[:10]],
    }


@bp.get("/backup")
@require_role("admin")
def download_backup():
    tmp = Path(tempfile.mkdtemp()) / f"arena-backup-{datetime.now():%Y%m%d-%H%M%S}.db"
    backup_to(tmp)
    audit(g.user["id"], "backup_download")
    get_db().commit()

    @after_this_request
    def cleanup(resp):
        resp.call_on_close(lambda: tmp.unlink(missing_ok=True))
        return resp

    return send_file(tmp, as_attachment=True, download_name=tmp.name, mimetype="application/octet-stream", max_age=0)
