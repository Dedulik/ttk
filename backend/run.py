"""Локальный запуск: python run.py  →  http://localhost:8000

Камера телефона (съёмка панорам) работает только по HTTPS. Для проверки с телефона в своей сети:
  SSL_CERT=cert.pem SSL_KEY=key.pem python run.py   — свой сертификат (например, из mkcert)
  HTTPS=adhoc python run.py                          — временный самоподписанный (нужен пакет cryptography)
На сервере HTTPS обычно даёт прокси (nginx, Caddy) — тогда эти переменные не нужны.
"""
import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    cert, key = os.environ.get("SSL_CERT"), os.environ.get("SSL_KEY")
    ssl = (cert, key) if cert and key else "adhoc" if os.environ.get("HTTPS") == "adhoc" else None
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), debug=os.environ.get("DEBUG") == "1", ssl_context=ssl)
