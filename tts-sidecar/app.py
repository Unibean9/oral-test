#!/usr/bin/env python3
"""TTS sidecar. Loads VieNeu-TTS-v3-Turbo ONCE at startup. Localhost-only.

Run: uvicorn app:app --host 127.0.0.1 --port 8765
"""
import asyncio
import io
import queue
import struct
import sys
import threading
import time
from contextlib import asynccontextmanager

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from vieneu import Vieneu
import soundfile as sf

# generate() polls the queue with this timeout so it can also poll request.is_disconnected()
# between items — a bare blocking get() would never notice a dead client.
_QUEUE_POLL_SECONDS = 0.5

MAX_TEXT_LEN = 4000
MIN_CHUNK_SECONDS = 0.5

# Confirmed deployment shape: normally 1 room, rare 2-room overlap (3+ rooms out of scope).
# Anything beyond this cap gets an instant 429 rather than unbounded queueing — this is the
# sidecar's only load-shedding mechanism on an unauthenticated, localhost-only endpoint
# (CLAUDE.md), so it must gate both acquire sites before any wait begins.
#
# Named for what it actually bounds: the permit spans the ENTIRE wait-then-synthesize window,
# not just the wait, so this caps total concurrent in-flight requests (1 lock-holder + 1
# waiter), not "waiters" on top of an unbounded holder count. Raising this expecting it to
# only add waiters would silently admit a 3rd simultaneous synthesis — matches the confirmed
# 2-room shape exactly; do not raise without re-deriving the wait timeouts below.
MAX_CONCURRENT_REQUESTS = 2
_ADMISSION_SEMAPHORE = threading.Semaphore(MAX_CONCURRENT_REQUESTS)
# Poll slice for the cancellation-aware lock acquire below. Short enough that a cancelled
# waiter (client disconnect) stops promptly instead of potentially winning the lock ahead of
# a live room; long enough to keep polling overhead negligible against the wait budgets below.
_LOCK_POLL_SECONDS = 0.25
# Sized from a live contended-latency measurement: a real `claude` CLI child actively
# streaming, alongside repeated /synthesize/stream calls, measured 2.8s-6.3s per sentence. The
# constraint is time-to-FIRST-byte, not total synthesis time: the client's 10s idle timer resets
# on the first byte, and this sidecar flushes a frame after 0.5s of audio (MIN_CHUNK_SECONDS), so
# a fresh synthesis's first-byte latency under contention is ~0.7-0.8s. Budget = wait (covers
# being blocked behind one full contended synthesis) + this room's own first-byte latency, both
# against the 10s idle deadline: 7.0s + ~1.0s leaves ~2s of margin.
STREAM_WAIT_TIMEOUT_SECONDS = 7.0
# The standard path's real budget is LIMITS.ttsTimeoutMs (90s, contracts.ts) per sentence —
# far more headroom than the streaming path, so this can be more generous while still
# leaving room for a slow contended synth on top of it.
STANDARD_WAIT_TIMEOUT_SECONDS = 8.0

_tts = None
_infer_lock = threading.Lock()


def _try_admit() -> bool:
    """Non-blocking semaphore acquire. False means the waiter cap is already full — the
    caller must fail fast (existing instant-busy contract), not queue behind it."""
    return _ADMISSION_SEMAPHORE.acquire(blocking=False)


def _acquire_lock_polling(timeout_seconds: float, cancel_check=None) -> bool:
    """Cancellation-aware poll-loop acquire of `_infer_lock`. Polls in short slices instead of
    one long blocking `acquire(timeout=N)` so a cancelled/abandoned waiter can stop between
    slices rather than potentially winning the lock ahead of a live room. Returns True iff the
    lock was acquired within budget; False on timeout or cancellation (lock not held either way)."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if cancel_check is not None and cancel_check():
            return False
        remaining = max(0.0, min(_LOCK_POLL_SECONDS, deadline - time.monotonic()))
        if _infer_lock.acquire(timeout=remaining):
            return True
    return False


# Repo-owned voice ids. These strings are the API contract with the backend
# (SUPPORTED_VOICES in src/brainstorm/contracts.ts) — they are NOT vieneu's internal preset
# names. This dict is the single place that knows what vieneu wants. Confirmed against
# vieneu==3.2.3 on 2026-07-31 (see docs/journals/journal.md): presets are selected via the
# `voice` kwarg on `Vieneu.infer`/`infer_stream`, accepting either the preset name string or the
# dict from `get_preset_voice(name)`; switching voices costs no extra latency (no per-voice
# checkpoint reload).
VOICE_PRESETS = {
    "vi-female-01": {"voice": "Trúc Ly"},
    "vi-male-01": {"voice": "Phạm Tuyên"},
}
DEFAULT_VOICE_ID = "vi-female-01"


class SynthesizeRequest(BaseModel):
    # Enforced by pydantic before the handler runs, so an oversized or absent body is rejected
    # as a 422 rather than reaching the model. The explicit length checks in the handlers stay
    # as the post-strip guard (whitespace-only input passes max_length but must still 400).
    text: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    # Required, no default: a defaulted field would make "old backend, new sidecar" fail
    # silently (every request omits voice_id, every room gets the same voice with no error)
    # while "new backend, old sidecar" fails loudly instead — the cheaper failure mode.
    voice_id: str = Field(min_length=1, max_length=32)

    model_config = {"extra": "forbid"}


def _resolve_voice(voice_id: str) -> dict:
    preset = VOICE_PRESETS.get(voice_id)
    if preset is None:
        raise HTTPException(status_code=422, detail=f"unknown voice_id: {voice_id}")
    return preset


# `@app.on_event("startup")` is deprecated and slated for removal; the lifespan context manager
# is the supported replacement and gives the model load a defined teardown point.
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _tts
    print("[tts-sidecar] loading VieNeu-TTS-v3-Turbo...")
    _tts = Vieneu(mode="v3turbo")
    print(f"[tts-sidecar] loaded — backend={_tts.backend}, sample_rate={_tts.sample_rate}")
    yield
    _tts = None


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    if _tts is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {
        "ok": True,
        "backend": _tts.backend,
        "sample_rate": _tts.sample_rate,
        "busy": _infer_lock.locked(),
        "voices": sorted(VOICE_PRESETS.keys()),
    }


class _SynthesizeBusy(Exception):
    pass


class _SynthesizeCancelled(Exception):
    pass


def _synthesize_sync(text: str, voice_kwargs: dict, cancel_event: threading.Event):
    """Runs on FastAPI's threadpool (`run_in_threadpool`), not the event loop — the wait and
    `_tts.infer()` are both blocking calls. Raises instead of returning a sentinel so the async
    caller's except-branches read the same way `/synthesize/stream`'s frame tags do."""
    if not _acquire_lock_polling(STANDARD_WAIT_TIMEOUT_SECONDS, cancel_check=cancel_event.is_set):
        raise _SynthesizeCancelled() if cancel_event.is_set() else _SynthesizeBusy()
    try:
        if cancel_event.is_set():
            raise _SynthesizeCancelled()
        return _tts.infer(text, **voice_kwargs)
    finally:
        _infer_lock.release()


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest, request: Request):
    if _tts is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail=f"text exceeds max length of {MAX_TEXT_LEN} chars")
    voice_kwargs = _resolve_voice(req.voice_id)

    if not _try_admit():
        print(f"[tts-sidecar] /synthesize 429: waiter cap ({MAX_CONCURRENT_REQUESTS}) exhausted", file=sys.stderr)
        raise HTTPException(status_code=429, detail="model busy")

    # Async wrapper around the blocking wait+infer so a disconnected client's request can be
    # cancelled instead of holding an admission permit (one of only MAX_CONCURRENT_REQUESTS) for
    # the full wait AND a subsequent multi-second `_tts.infer()` on text nobody will read —
    # this is the same abandoned-client exposure `/synthesize/stream` already guards against via
    # `cancel_event`, applied here now that the endpoint can wait long enough for it to matter.
    cancel_event = threading.Event()

    async def watch_disconnect():
        while not cancel_event.is_set():
            if await request.is_disconnected():
                cancel_event.set()
                return
            await asyncio.sleep(_QUEUE_POLL_SECONDS)

    watcher = asyncio.ensure_future(watch_disconnect())
    try:
        wav = await run_in_threadpool(_synthesize_sync, text, voice_kwargs, cancel_event)
    except _SynthesizeBusy:
        print(f"[tts-sidecar] /synthesize 429: admitted but lock wait ({STANDARD_WAIT_TIMEOUT_SECONDS}s) timed out", file=sys.stderr)
        raise HTTPException(status_code=429, detail="model busy")
    except _SynthesizeCancelled:
        # The client is already gone — this response body will never be read either way.
        raise HTTPException(status_code=503, detail="client disconnected before synthesis completed")
    finally:
        cancel_event.set()
        watcher.cancel()
        try:
            await watcher
        except asyncio.CancelledError:
            pass
        _ADMISSION_SEMAPHORE.release()
    buffer = io.BytesIO()
    sf.write(buffer, wav, _tts.sample_rate, format="WAV")
    return Response(content=buffer.getvalue(), media_type="audio/wav")


def _stream_frames(text: str, voice_kwargs: dict):
    min_samples = int(MIN_CHUNK_SECONDS * _tts.sample_rate)
    acc: list = []
    acc_len = 0

    def flush_frame():
        nonlocal acc, acc_len
        if not acc:
            return None
        wav = np.concatenate(acc)
        acc, acc_len = [], 0
        buffer = io.BytesIO()
        sf.write(buffer, wav, _tts.sample_rate, format="WAV")
        payload = buffer.getvalue()
        return b"\x00" + struct.pack(">I", len(payload)) + payload

    try:
        for chunk in _tts.infer_stream(text, **voice_kwargs):
            if chunk is None or len(chunk) == 0:
                continue
            acc.append(chunk)
            acc_len += len(chunk)
            if acc_len >= min_samples:
                frame = flush_frame()
                if frame:
                    yield frame
        tail_frame = flush_frame()
        if tail_frame:
            yield tail_frame
        yield b"\x01"
    except Exception as e:
        print(f"[tts-sidecar] /synthesize/stream failed: {e}", file=sys.stderr)
        yield b"\x02"


_STREAM_BUSY = object()
_STREAM_DONE = object()


def _run_stream_worker(text: str, voice_kwargs: dict, out_queue: "queue.Queue", cancel_event: threading.Event):
    # Runs on its own thread, independent of the ASGI request/response lifecycle: a sync
    # generator paused mid-execution on another thread can't be closed from the main thread if
    # the client disconnects, so the lock must be acquired/released here inside a plain `finally`
    # that nothing can silently abandon. `out_queue` must stay unbounded — a blocking put() would
    # deadlock once the reader is gone. `cancel_event` lets an abandoned client stop the worker
    # between chunks. The caller already holds one `_ADMISSION_SEMAPHORE` permit; this `finally`
    # releases it on every exit path.
    try:
        if not _acquire_lock_polling(STREAM_WAIT_TIMEOUT_SECONDS, cancel_check=cancel_event.is_set):
            reason = "cancelled" if cancel_event.is_set() else f"lock wait ({STREAM_WAIT_TIMEOUT_SECONDS}s) timed out"
            print(f"[tts-sidecar] /synthesize/stream busy-frame: {reason}", file=sys.stderr)
            out_queue.put(_STREAM_BUSY)
            return
        try:
            # Re-checked immediately after acquiring the lock, before any inference work: a
            # cancelled waiter must never proceed to synthesis (Requirements).
            if cancel_event.is_set():
                print("[tts-sidecar] /synthesize/stream: cancelled after lock acquired, before inference", file=sys.stderr)
                return
            for frame in _stream_frames(text, voice_kwargs):
                if cancel_event.is_set():
                    break
                out_queue.put(frame)
        except Exception as e:
            print(f"[tts-sidecar] stream worker crashed: {e}", file=sys.stderr)
            out_queue.put(b"\x02")
        finally:
            _infer_lock.release()
            out_queue.put(_STREAM_DONE)
    finally:
        _ADMISSION_SEMAPHORE.release()


@app.post("/synthesize/stream")
async def synthesize_stream(req: SynthesizeRequest, request: Request):
    if _tts is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail=f"text exceeds max length of {MAX_TEXT_LEN} chars")
    voice_kwargs = _resolve_voice(req.voice_id)

    # Admission is checked HERE, before the worker thread is spawned — not inside it — so
    # exhausting the waiter cap costs nothing beyond this instant 429: no thread, no queue, no
    # StreamingResponse ever starts. `_run_stream_worker` releases this permit in its own
    # `finally` once admitted.
    if not _try_admit():
        print(f"[tts-sidecar] /synthesize/stream 429: waiter cap ({MAX_CONCURRENT_REQUESTS}) exhausted", file=sys.stderr)
        raise HTTPException(status_code=429, detail="model busy")

    # `_run_stream_worker`'s own `finally` is the only releaser of the permit acquired above —
    # if construction or `start()` itself raises (e.g. thread-creation failure), that `finally`
    # never runs and the permit leaks permanently (no lease/timeout heals a leaked semaphore
    # slot). Release explicitly on that narrow failure window before propagating.
    try:
        out_queue: "queue.Queue" = queue.Queue()
        cancel_event = threading.Event()
        threading.Thread(
            target=_run_stream_worker, args=(text, voice_kwargs, out_queue, cancel_event), daemon=True, name="tts-stream"
        ).start()
    except Exception:
        _ADMISSION_SEMAPHORE.release()
        raise

    async def generate():
        loop = asyncio.get_event_loop()
        try:
            while True:
                if await request.is_disconnected():
                    print("[tts-sidecar] /synthesize/stream: request.is_disconnected() reported True", file=sys.stderr)
                    cancel_event.set()
                    return
                try:
                    item = await loop.run_in_executor(None, out_queue.get, True, _QUEUE_POLL_SECONDS)
                except queue.Empty:
                    continue
                if item is _STREAM_BUSY:
                    yield b"\x03"  # busy — distinct from \x02 (synthesis failure), so callers can retry
                    return
                if item is _STREAM_DONE:
                    return
                yield item
        finally:
            # Runs reliably even on client disconnect: this is a plain async generator, not
            # a sync one pinned mid-execution on a worker thread, so Starlette's cancellation
            # path can and does deliver GeneratorExit here.
            cancel_event.set()

    return StreamingResponse(generate(), media_type="application/octet-stream")
