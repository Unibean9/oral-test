import { buildApp, HOST, PORT } from "./app.js";
import { checkClaudeCliAtBoot, terminateAllClaudeSessions } from "./claude-cli/spawn.js";
import { db, DB_PATH } from "./db/connection.js";
import { releaseSingleWriterLock } from "./db/singleWriterLock.js";
import { abortAllAndDrain } from "./oral-session/questionSpeechJobs.js";
import { checkVoiceDriftAtBoot } from "./tts/streamClient.js";

// Route wiring lives in app.ts for app.inject() testability without binding a port;
// everything below has a process-level side effect and stays here.
//
// db/connection.ts acquires the single-writer lock (ESM import order runs it first);
// this module only releases it on shutdown.

const app = await buildApp();

// Never throws, never blocks startup — see checkVoiceDriftAtBoot's own doc comment.
void checkVoiceDriftAtBoot().catch(() => {});
checkClaudeCliAtBoot();

// Node does not kill child processes on exit; without a signal handler, Ctrl-C leaves
// the `claude` child running and never calls app.close(), so onClose never fires.
const FORCED_EXIT_MS = 5_000;

let shuttingDown = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) {
    // A second signal forces an immediate exit — otherwise a hung app.close() leaves
    // no way out but the task manager.
    app.log.warn("second shutdown signal — exiting immediately");
    process.exit(code || 1);
  }
  shuttingDown = true;
  app.log.info(`shutting down (${reason})`);
  // Unref'd so this timer alone can't keep the process alive; forces exit if a hung
  // SSE turn stalls app.close() indefinitely.
  const forced = setTimeout(() => {
    app.log.error("shutdown deadline exceeded — forcing exit");
    process.exit(1);
  }, FORCED_EXIT_MS);
  forced.unref();
  terminateAllClaudeSessions({ shuttingDown: true });
  // Bounded well under FORCED_EXIT_MS so a hung speech job can't itself exhaust the forced-exit
  // deadline before app.close()/db.close() below even get a chance to run.
  try {
    await abortAllAndDrain(Math.max(0, FORCED_EXIT_MS - 1_000));
  } catch (err) {
    app.log.error({ err }, "error draining in-flight speech jobs");
  }
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
  }
  // Closes the DB so the WAL checkpoints cleanly instead of growing unbounded.
  try {
    db.close();
  } catch (err) {
    app.log.error({ err }, "error closing the database");
  }
  try {
    releaseSingleWriterLock(DB_PATH);
  } catch (err) {
    app.log.error({ err }, "error releasing the single-writer lock");
  }
  clearTimeout(forced);
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void shutdown(signal); });
}

// Without these handlers, a crash skips shutdown(): the orphaned `claude` child and the
// next --resume could both mutate the same on-disk session concurrently.
process.on("uncaughtException", (err) => {
  // Logged under `err`, never with request bodies attached.
  app.log.fatal({ err }, "uncaught exception");
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  app.log.fatal({ err: reason }, "unhandled rejection");
  void shutdown("unhandledRejection", 1);
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(
      `oral-test backend listening on ${HOST}:${PORT} (loopback only)`,
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
