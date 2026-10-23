"""SQLite: схема и короткие помощники. Для продакшена можно заменить на PostgreSQL — запросы простые."""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor','admin')),
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
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
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
    run("INSERT INTO audit_events (user_id, action, details, created_at) VALUES (?,?,?,?)", user_id, action, details[:500], now())
