FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models
RUN apt-get update \
  && apt-get install --yes --no-install-recommends libsndfile1 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 oral-test \
  && useradd --uid 10001 --gid oral-test --create-home --home-dir /home/oral-test --shell /usr/sbin/nologin oral-test \
  && mkdir /models \
  && chown oral-test:oral-test /models
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
USER oral-test
EXPOSE 8765
HEALTHCHECK --interval=20s --timeout=5s --start-period=180s --retries=6 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
