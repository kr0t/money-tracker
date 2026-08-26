FROM python:3.14-slim-bookworm

WORKDIR /app

COPY app.py db.py ./
COPY static/ static/

ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["python", "app.py"]
