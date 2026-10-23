"""Локальный запуск: python run.py  →  http://localhost:8000"""
import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), debug=os.environ.get("DEBUG") == "1")
