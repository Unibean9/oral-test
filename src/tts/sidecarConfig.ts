import { seam } from '../testSeam.js';

/**
 * Injectable seam for the sidecar base URL, per src/testSeam.ts's convention (same pattern as
 * `runRawFreshSession` in claude-cli/spawn.ts). A plain `const` resolved once at import time
 * cannot be repointed at a per-test stub instance/port within one process — `setForTests()` can.
 */
export const getSidecarBaseUrl = seam((): string => process.env.TTS_SIDECAR_URL ?? 'http://127.0.0.1:8765');
