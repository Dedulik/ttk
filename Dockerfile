FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY frontend frontend
ENV DB_PATH=/data/app.db UPLOAD_DIR=/data/uploads PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
WORKDIR /app/backend
# --preload: приложение (миграции, первый администратор, ключ) создаётся один раз до запуска воркеров;
# --timeout 120: загрузка фото 360° и видео переходов дольше стандартных 30 с
CMD ["gunicorn", "--preload", "-w", "2", "--timeout", "120", "-b", "0.0.0.0:8000", "--access-logfile", "-", "run:app"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)" || exit 1
