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
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8000", "run:app"]
