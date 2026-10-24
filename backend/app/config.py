"""Настройки. Любое значение переопределяется переменной окружения (см. .env.example)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
REPO_DIR = BASE_DIR.parent


def env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def load() -> dict:
    return {
        # не задан — сервер сам создаст случайный ключ в data/secret.key
        "SECRET_KEY": env("SECRET_KEY", "dev-only-change-me"),
        "BACKUP_KEEP": int(env("BACKUP_KEEP", "10")),
        "TOKEN_TTL_MIN": int(env("TOKEN_TTL_MIN", "720")),
        "DB_PATH": env("DB_PATH", str(BASE_DIR / "data" / "app.db")),
        "UPLOAD_DIR": env("UPLOAD_DIR", str(BASE_DIR / "data" / "uploads")),
        "FRONTEND_DIR": env("FRONTEND_DIR", str(REPO_DIR / "frontend")),
        "TEMPLATE_PATH": env("TEMPLATE_PATH", str(REPO_DIR / "frontend" / "data" / "template_map.json")),
        "MAX_UPLOAD_MB": int(env("MAX_UPLOAD_MB", "15")),
        "MAX_VIDEO_MB": int(env("MAX_VIDEO_MB", "60")),   # видео переходов между точками
        "MAX_MAP_BYTES": int(env("MAX_MAP_BYTES", str(2 * 1024 * 1024))),
        "CORS_ORIGINS": [o.strip() for o in env("CORS_ORIGINS", "").split(",") if o.strip()],
        # первый администратор создаётся при пустой базе — смените пароль после входа
        "ADMIN_EMAIL": env("ADMIN_EMAIL", "admin@arena.local"),
        "ADMIN_PASSWORD": env("ADMIN_PASSWORD", "admin12345"),
        "SEED_DEMO_USERS": env("SEED_DEMO_USERS", "1") == "1",
        # регистрация посетителей (роль «посетитель», без доступа к админке)
        "ALLOW_REGISTRATION": env("ALLOW_REGISTRATION", "1") == "1",
        # приглашения сотрудников и администраторов: срок жизни ссылки, адрес сайта для писем
        "INVITE_TTL_HOURS": int(env("INVITE_TTL_HOURS", "72")),
        "PUBLIC_URL": env("PUBLIC_URL", ""),
        # почта для приглашений; не задано — админ получает ссылку и передаёт её сам
        "SMTP_HOST": env("SMTP_HOST", ""),
        "SMTP_PORT": int(env("SMTP_PORT", "587")),
        "SMTP_USER": env("SMTP_USER", ""),
        "SMTP_PASSWORD": env("SMTP_PASSWORD", ""),
        "SMTP_FROM": env("SMTP_FROM", ""),
        "SMTP_SSL": env("SMTP_SSL", "0") == "1",
        "VENUE_SLUG": "rostov-arena",
        # главный объект сайта: на пустой базе создаётся из frontend/data/manezh_dgtu_map.json
        "MAIN_SLUG": "manezh-dgtu",
        "MAIN_NAME": "Манеж ДГТУ",
        "MAIN_PATH": env("MAIN_PATH", str(REPO_DIR / "frontend" / "data" / "manezh_dgtu_map.json")),
    }
