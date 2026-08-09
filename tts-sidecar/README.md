# TTS sidecar

Localhost-only FastAPI service wrapping VieNeu-TTS-v3-Turbo (the TTS engine chosen after
benchmarking RTF and Vietnamese/English code-switch quality — see
`spikes/tts-latency/RESULTS.md` for the full comparison).

## Setup

Use an isolated Python environment scoped to this folder (do not install into the machine's
global Python — installing multiple TTS engine candidates into a shared environment during
benchmarking caused dependency conflicts; see `spikes/tts-latency/RESULTS.md` for details).

```
python -m venv .pyenv-tts-sidecar
.pyenv-tts-sidecar\Scripts\activate   # Windows
pip install -r requirements.txt
```

## Run

```
uvicorn app:app --host 127.0.0.1 --port 8765
```

Model loads once at startup (13-17s warm, ~100s on first run including the Hugging Face
download). Endpoints:

- `GET /health` — model-loaded check; also reports `busy` (whether `_infer_lock` is currently held).
- `POST /synthesize` `{"text": "..."}` → WAV audio bytes (48kHz). Whole-buffer synthesis. The
  backend does not call this endpoint (it only uses the streaming mode below); the sidecar
  still serves it for any other direct caller.
- `POST /synthesize/stream` — sentence-pipelined synthesis used by the backend's streaming audio
  mode (`src/tts/streamClient.ts`), the only audio mode the backend uses today. Accepts one
  sentence at a time and streams the response as tagged binary frames: `0x00` audio frame, `0x01`
  end-ok, `0x02` end-error, `0x03` busy (admitted but the model lock was still contended after the
  bounded wait).

HTTP status contract (both endpoints): `503` means "model not loaded" (still booting — retrying
immediately will not help); `429` means "busy" (waiter cap exhausted, or admitted but the wait
for the model lock timed out — safe to retry after a short delay). Callers must not treat these
the same: `src/tts/errors.ts`'s `SIDECAR_BUSY_STATUS` (429) is the only status mapped to the
retryable `TtsBusyError`, shared by both of the backend's TTS transport modules. At most
`MAX_CONCURRENT_REQUESTS` (2, `app.py`) requests are admitted past the instant-429 waiter cap at
any time — this is the sidecar's only load-shedding mechanism on an unauthenticated endpoint, see
`app.py`'s admission-control comments.

Bound to `127.0.0.1` only — never exposed beyond localhost, matching the backend's own
loopback-only binding (no auth layer; internal tool).
