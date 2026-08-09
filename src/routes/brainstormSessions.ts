import type { FastifyInstance } from "fastify";
import { validate as isUuid } from "uuid";

// Static imports, not `await import(new URL('%2E%2E/...'))`. That percent-encoded form is a
// non-literal specifier, so TypeScript typed every one of these modules as `any` and
// `npm run typecheck` validated nothing across this entire file — which is also why the local
// helpers below were forced to take `reply: any`. teacherRooms.ts has always used plain static
// imports from this same directory; there is no cycle to avoid.
import * as contract from "../brainstorm/contracts.js";
import * as db from "../db/sessions.js";
import * as sse from "../brainstorm/sse.js";
import * as turnRunner from "../brainstorm/turnRunner.js";
import { requireTeacher } from "../brainstorm/teacherContext.js";

function currentSnapshot(sessionId: string) {
  const session = db.getSession(sessionId);
  if (!session) return null;
  // `failed` is folded in after `interrupted` so a client reloading after a failed turn sees the
  // same operation POST /turns is answering 409 turn_failed about. `state` stays 'idle' for both:
  // neither is running, and only `processing`/`accepted` mean work is in flight.
  const active =
    db.getActiveOperation(sessionId) ??
    db.getLatestInterruptedOperation(sessionId) ??
    db.getLatestFailedOperation(sessionId);
  return {
    sessionId,
    voiceId: contract.isVoiceId(session.voice_id)
      ? session.voice_id
      : contract.DEFAULT_VOICE_ID,
    engineStep: session.engine_step,
    phaseKey: session.current_phase,
    state:
      active?.status === "processing" || active?.status === "accepted"
        ? "processing"
        : "idle",
    transcript: db.getPublicTranscript(sessionId),
    activeTurn: active && {
      turnId: active.turn_id,
      clientTurnId: active.client_turn_id,
      status: active.status,
      userMessageId: active.user_message_id,
      assistantMessageId: active.assistant_message_id,
      lastSeq: active.final_seq,
    },
  };
}
function valid(reply: any, id: string) {
  return isUuid(id)
    ? true
    : (reply
        .code(422)
        .send(
          contract.apiError("invalid_session_id", "sessionId must be a UUID"),
        ),
      false);
}

export async function brainstormSessionRoutes(app: FastifyInstance) {
  app.get<{ Params: { sessionId: string } }>(
    `${contract.API_PREFIX}/sessions/:sessionId`,
    async (req, reply) => {
      if (!valid(reply, req.params.sessionId)) return;
      const result = currentSnapshot(req.params.sessionId);
      return result
        ? reply.send(contract.apiOk(result))
        : reply
            .code(404)
            .send(
              contract.apiError("session_not_found", "Session was not found"),
            );
    },
  );
  // PATCH /sessions/:id/voice removed: it persisted nothing. It validated that voiceId equalled
  // SUPPORTED_VOICE_ID — the only value that exists — and echoed it back, while skipping both
  // requireTeacher and the unknown-key rejection every other body route applies. Clients could
  // reasonably believe it changed state. Voice is now a session-creation-time property fixed for
  // the session's lifetime, deliberately with no mutation endpoint — do not reinstate this route.
  app.post<{
    Params: { sessionId: string };
    Body: { clientTurnId?: string; text?: string; audioMode?: string };
  }>(`${contract.API_PREFIX}/sessions/:sessionId/turns`, async (req, reply) => {
    const { sessionId } = req.params,
      body = req.body ?? {};
    if (!valid(reply, sessionId)) return;
    if (!requireTeacher(req, reply)) return;
    const session = db.getSession(sessionId);
    if (!session)
      return reply
        .code(404)
        .send(contract.apiError("session_not_found", "Session was not found"));
    if (session.status === "wrapped")
      return reply
        .code(409)
        .send(
          contract.apiError(
            "session_wrapped",
            "This session is closed after PRD generation",
          ),
        );
    if (
      typeof body !== "object" ||
      Object.keys(body).some(
        (key) =>
          key !== "clientTurnId" && key !== "text" && key !== "audioMode",
      ) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      typeof body.clientTurnId !== "string" ||
      !body.clientTurnId.trim() ||
      (body.audioMode !== undefined &&
        !contract.AUDIO_MODES.includes(body.audioMode as contract.AudioMode))
    )
      return reply
        .code(422)
        .send(
          contract.apiError(
            "invalid_turn",
            "Turn requires clientTurnId and text, and an optional audioMode of streaming/text",
          ),
        );
    if (
      contract.byteLength(body.text) > contract.LIMITS.textBytes ||
      contract.byteLength(body.clientTurnId) > contract.LIMITS.clientTurnIdBytes
    )
      return reply
        .code(413)
        .send(
          contract.apiError(
            "input_too_large",
            "Turn exceeds the contract limit",
          ),
        );
    // Bound to consts so the narrowing above survives into the async callback below, where TS
    // otherwise widens the optional body fields back to `string | undefined`.
    const turnText: string = body.text,
      clientTurnId: string = body.clientTurnId;
    // Defaults to 'streaming' so existing clients that never sent audioMode keep today's behavior.
    const audioMode: contract.AudioMode =
      (body.audioMode as contract.AudioMode) ?? "streaming";
    let operation: { operation: any; created: boolean };
    // `turn_in_progress` is the only expected failure here; anything else is a local SQLite or
    // programming fault, which is a 500. 502 told the client "the upstream is flaky, retry" and
    // sent it into a retry loop against a bug that will never resolve on its own.
    try {
      operation = db.createOrLoadOperation(sessionId, clientTurnId, turnText);
    } catch (error) {
      const busy = (error as Error).message === "turn_in_progress";
      return reply
        .code(busy ? 409 : 500)
        .send(
          contract.apiError(
            busy ? "turn_in_progress" : "operation_create_failed",
            "Could not accept turn",
            busy,
          ),
        );
    }
    if (!operation.created) {
      const status = operation.operation.status;
      if (status === "interrupted")
        return reply
          .code(409)
          .send(
            contract.apiError(
              "turn_interrupted",
              "The prior turn was interrupted; submit a new clientTurnId to retry",
              true,
            ),
          );
      const replay = {
        operation: {
          turnId: operation.operation.turn_id,
          status,
          assistantMessageId: operation.operation.assistant_message_id,
          lastSeq: operation.operation.final_seq,
        },
        snapshot: currentSnapshot(sessionId),
      };
      // `failed` used to fall into the generic 409 below, which told the client "Turn is already
      // in progress" forever for that key — with no hint that a NEW clientTurnId would work, while
      // GET /sessions/:id simultaneously reported state 'idle'. Two contradictory answers. The
      // room was never actually wedged (`failed` is outside selectActiveOperation's status list);
      // only the message was wrong. Placed above the generic branch so that one keeps its literal
      // meaning. Reattaching to a still-live turn (mid-turn reconnect) is the GET .../stream route
      // below; a finished turn has no result store, replay it via this same idempotent POST.
      if (status === "failed") {
        return reply.code(409).send({
          ...contract.apiError(
            "turn_failed",
            "The prior turn with this clientTurnId failed; submit a new clientTurnId to retry",
            true,
          ),
          data: replay,
        });
      }
      // A 409 must not carry `isSuccess: true`. It previously used apiOk for both branches, so a
      // client discriminating on isSuccess read "your duplicate submit was rejected" as success.
      if (status !== "completed")
        return reply
          .code(409)
          .send({
            ...contract.apiError(
              "turn_in_progress",
              "Turn is already in progress",
              true,
            ),
            data: replay,
          });
      return reply.send(contract.apiOk(replay, "Replayed completed turn"));
    }
    // The turn now runs inside an in-process TurnRun, independent of this request's lifetime:
    // the room lock is acquired inside the run and released in its own `finally`, and a client
    // disconnect below stops only this subscriber's audio, never the run itself. See
    // brainstorm/turnRunner.ts.
    const run = turnRunner.startTurn(
      sessionId,
      operation.operation,
      turnText,
      audioMode,
    );
    let writer: sse.SseWriter;
    try {
      writer = new sse.SseWriter(reply, sessionId, operation.operation.turn_id);
    } catch (err) {
      // The client is already gone — the socket was destroyed before headers could even flush.
      // The run keeps going regardless; there is simply no response left to write to. It will
      // never gain a subscriber, so stop its audio now rather than relying on `detach()`, which
      // only fires when the *last* subscriber of a run that had at least one leaves.
      req.log.warn(
        { err },
        "SSE writer could not attach to the response; the turn continues without a subscriber",
      );
      run.audioAbort.abort();
      return reply;
    }
    run.attach(writer);
    // Stops only this subscriber (and, if it was the last one, the run's TTS) — never the run.
    reply.raw.on("close", () => run.detach(writer));
    try {
      await run.done;
    } catch (err) {
      req.log.error({ err }, "turn run failed unexpectedly");
    }
    return reply;
  });

  // Reconnect mid-turn: a client that lost its POST .../turns stream reattaches here and
  // receives the text/state it missed, then keeps reading live. Audio does not resume — recovery
  // is text-only by design; audio for this turn stays off once the last subscriber has detached.
  app.get<{
    Params: { sessionId: string; clientTurnId: string };
    Querystring: { fromSeq?: string };
  }>(
    `${contract.API_PREFIX}/sessions/:sessionId/turns/:clientTurnId/stream`,
    async (req, reply) => {
      const { sessionId, clientTurnId } = req.params;
      if (!valid(reply, sessionId)) return;
      // Deliberately NOT gated by requireTeacher. This is not because EventSource can't send
      // custom headers — this route is meant to be read with fetch()+getReader(), which CAN send
      // arbitrary headers (X-Teacher-Id, Last-Event-ID) just like the POST turn route already
      // does. The actual reason: this server binds loopback-only, and X-Teacher-Id is an identity
      // label for attribution/cloud-path routing, not a trust boundary — the same reasoning
      // GET /sessions/:sessionId above already relies on.
      const run = turnRunner.getRun(sessionId);
      if (!run)
        return reply
          .code(404)
          .send(
            contract.apiError("turn_not_live", "No live turn for this session"),
          );
      if (run.clientTurnId !== clientTurnId)
        return reply
          .code(409)
          .send(
            contract.apiError(
              "turn_superseded",
              "This clientTurnId is not the live turn for this session",
            ),
          );
      const queryFromSeq = Number(req.query?.fromSeq);
      const headerFromSeq = Number(req.headers["last-event-id"]);
      const rawFromSeq = Number.isFinite(queryFromSeq)
        ? queryFromSeq
        : Number.isFinite(headerFromSeq)
          ? headerFromSeq
          : 0;
      const fromSeq = Math.min(Math.max(rawFromSeq, 0), run.lastSeq);
      let writer: sse.SseWriter;
      try {
        writer = new sse.SseWriter(reply, sessionId, run.turnId);
      } catch (err) {
        req.log.warn(
          { err },
          "SSE writer could not attach to the response for a reconnect",
        );
        return reply;
      }
      // Zero-await invariant (CRITICAL): from `getRun` above through `replayInto`+`attach` here,
      // nothing may `await`. execute()'s finally (turnRunner.ts) synchronously clears
      // subscribers/deletes the registry entry in one block when a run settles; an await anywhere
      // in this stretch (an async preHandler, a teacher lookup, anything) opens a window where
      // that could happen between the lookup and attach — this writer would then be attached to a
      // run that has already finished tearing down, never receive `done()`, and the socket would
      // hang. `replayInto` itself is synchronous by construction (see turnRunner.ts) for the same
      // reason.
      run.replayInto(writer, fromSeq);
      run.attach(writer);
      // Defensive backstop for the same race, in case a future edit ever violates the zero-await
      // invariant above without this check tripping instead of hanging silently.
      if (turnRunner.getRun(sessionId) !== run) {
        writer.done();
        return reply;
      }
      reply.raw.on("close", () => run.detach(writer));
      try {
        await run.done;
      } catch (err) {
        req.log.error({ err }, "turn run failed unexpectedly during reconnect");
      }
      return reply;
    },
  );
}
