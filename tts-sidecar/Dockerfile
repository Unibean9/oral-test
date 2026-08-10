# syntax=docker/dockerfile:1

# --- Stage 1: build a venv with all deps -------------------------------------
FROM python:3.11-slim AS build
WORKDIR /app

# build-essential + libsndfile1-dev cover soundfile/vieneu transitive deps that
# ship without a manylinux wheel for this Python/arch combo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libsndfile1-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Stage 2: runtime ----------------------------------------------------------
FROM python:3.11-slim AS runtime
WORKDIR /app

# libsndfile1 (runtime .so, not -dev) is required by soundfile at import time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY app.py ./

RUN groupadd --system app && useradd --system --gid app --home /app app \
    && mkdir -p /home/app/.cache && chown -R app:app /app /home/app
USER app
ENV HOME=/home/app

EXPOSE 8765

# start-period is long: the model loads once at boot (13-17s warm, ~100s cold
# on first run while it downloads from Hugging Face — see README.md) and the
# health endpoint only reports ready once that finishes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fs http://127.0.0.1:8765/health || exit 1

# 0.0.0.0 so the container is reachable from the backend over the Docker
# network — this service still never gets a published port, so it stays
# unreachable from outside the compose network (see docker/README.md).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
