"""SQLite: схема и короткие помощники. Для продакшена можно заменить на PostgreSQL — запросы простые."""
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app, g, has_request_context, request

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','viewer','editor','admin')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);
-- рабочая копия карты: одна на площадку
CREATE TABLE IF NOT EXISTS map_drafts (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id),
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);
-- опубликованные версии: посетители видят последнюю
CREATE TABLE IF NOT EXISTS map_versions (
  id INTEGER PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  number INTEGER NOT NULL,
  data TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  published_by INTEGER REFERENCES users(id),
  published_at TEXT NOT NULL,
  UNIQUE (venue_id, number)
);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  stored_as TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- кто сейчас редактирует объект: один редактор за раз, замок продлевается раз в 15 с и истекает через 2 мин тишины
CREATE TABLE IF NOT EXISTS venue_locks (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  since TEXT NOT NULL,
  seen TEXT NOT NULL
);
-- приглашения администраторов и сотрудников: в базе только хэш одноразового токена
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by INTEGER REFERENCES users(id),
  revoked_at TEXT
);
-- «Пиксельная охота»: какие секреты на карте нашёл посетитель
CREATE TABLE IF NOT EXISTS quest_finds (
  user_id INTEGER NOT NULL REFERENCES users(id),
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  item_id TEXT NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (user_id, venue_id, item_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
"""

# Колонки, добавленные после первой версии. Старая база дополняется при запуске, данные не теряются.
MIGRATIONS = {
    "users": {
        "last_login_at": "TEXT",
        "failed_logins": "INTEGER NOT NULL DEFAULT 0",
        "locked_until": "TEXT",
        "token_version": "INTEGER NOT NULL DEFAULT 0",
        "is_active": "INTEGER NOT NULL DEFAULT 1",
        "password_changed_at": "TEXT",
        "handle": "TEXT",   # адрес личной ссылки для посетителей: /?by=<handle>
    },
    "venues": {
        "description": "TEXT NOT NULL DEFAULT ''",
        "created_by": "INTEGER REFERENCES users(id)",
        "created_at": "TEXT",
    },
    "audit_events": {"ip": "TEXT NOT NULL DEFAULT ''"},
}


def migrate(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    widen_roles(con)
    for table, cols in MIGRATIONS.items():
        have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        for name, ddl in cols.items():
            if name not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    con.execute("CREATE INDEX IF NOT EXISTS audit_by_time ON audit_events (created_at)")
    for u in con.execute("SELECT id, email FROM users WHERE handle IS NULL").fetchall():
        con.execute("UPDATE users SET handle = ? WHERE id = ?", (free_handle(con, u["email"].split("@")[0]), u["id"]))
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_handle ON users (handle)")


def widen_roles(con: sqlite3.Connection) -> None:
    """Старые базы знали только роли сотрудников. Для регистрации посетителей нужна роль 'user': ограничение
    CHECK в SQLite не меняется на месте, поэтому таблица пересоздаётся с теми же данными (копия базы снята при запуске)."""
    row = con.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()
    if not row or "'user'" in row["sql"]:
        return
    new_sql = row["sql"].replace("CHECK (role IN ('viewer','editor','admin'))", "CHECK (role IN ('user','viewer','editor','admin'))")
    new_sql = re.sub(r'^CREATE TABLE "?users"?', "CREATE TABLE users_new", new_sql)
    con.commit()
    con.execute("PRAGMA foreign_keys = OFF")
    try:
        con.execute("BEGIN")
        con.execute(new_sql)
        con.execute("INSERT INTO users_new SELECT * FROM users")
        con.execute("DROP TABLE users")
        con.execute("ALTER TABLE users_new RENAME TO users")
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.execute("PRAGMA foreign_keys = ON")


def free_handle(con, base: str, skip_id: int = 0) -> str:
    """Свободный адрес ссылки: латиница, цифры, дефис; при совпадении добавляется номер."""
    base = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")[:30] or "user"
    h, n = base, 2
    while con.execute("SELECT 1 FROM users WHERE handle = ? AND id != ?", (h, skip_id)).fetchone():
        h, n = f"{base}-{n}", n + 1
    return h


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA secure_delete = ON")   # удалённые записи (хэши паролей и т.п.) затираются на диске
    return con


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = connect(current_app.config["DB_PATH"])
    return g.db


def close_db(_exc=None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def one(sql: str, *args):
    return get_db().execute(sql, args).fetchone()


def many(sql: str, *args):
    return get_db().execute(sql, args).fetchall()


def run(sql: str, *args) -> int:
    cur = get_db().execute(sql, args)
    return cur.lastrowid


def audit(user_id, action: str, details: str = "") -> None:
    ip =(request.remote_addr or "") if has_request_context() else ""
    run("INSERT INTO audit_events (user_id, action, details, created_at, ip) VALUES (?,?,?,?,?)", user_id, action, details[:500], now(), ip)
