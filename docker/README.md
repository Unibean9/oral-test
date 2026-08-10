# Docker / CI-CD / Dokploy deploy

## Pipeline

```
Push to main → GitHub Actions (docker-publish.yml)
  publish: build image → push to DockerHub (latest + commit SHA)
```

No test/typecheck/scan gate runs before publish — `npm run typecheck` and
`npm test` must be run locally (or in a PR check you add) before merging to
`main`. Deploy is manual: the workflow stops after `publish`, it never calls
the Dokploy API.

`docker-compose.yml` at the repo root builds all three images from source:
`seed` (one-shot, populates the `chapters`/`source_chunks` data the backend
needs to run real oral sessions — see the Dockerfile's `seed` stage),
`backend`, and `tts-sidecar`. `backend` waits for `seed` to exit 0 before
starting. It's used for local dev and is also what a from-source deploy
(e.g. building directly on the target host) would use.

## GitHub Actions secrets (repo → Settings → Secrets and variables → Actions)

| Secret            | Used for                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DOCKER_USERNAME` | DockerHub username — image push and image name (`${DOCKER_USERNAME}/oral-test-backend`, `${DOCKER_USERNAME}/oral-test-tts-sidecar`) |
| `DOCKER_PASSWORD` | DockerHub **access token**, not the account password                                                                                |

## `claude` CLI on the deploy host (one-time setup)

The image does **not** bundle the `claude` CLI that `src/claude-cli/spawn.ts`
shells out to. Bind-mount it in from a system-wide install on the host
instead, at the same absolute path on both sides so
`/usr/local/bin/claude`'s symlink into
`.../lib/node_modules/@anthropic-ai/claude-code` still resolves inside the
container without rewriting:

```bash
# On the host, once, as root (or via sudo):
npm install -g @anthropic-ai/claude-code
which claude              # confirm: /usr/local/bin/claude
npm root -g                # confirm: /usr/local/lib/node_modules
```

Uncomment the `CLAUDE_CLI_BIN` / `CLAUDE_CLI_LIB` / `.claude` volume lines in
`docker-compose.yml` and point them at your own local paths if they differ
from the defaults commented there.

**Auth is a Claude Pro plan login, not an API key.** Run `claude login` once
(interactively — it opens a browser-auth flow) so the session lands at
`~/.claude/` and `~/.claude.json`, then bind-mount those read-write (not
read-only) since the CLI refreshes its session tokens in these files
periodically — a read-only mount would let auth silently expire on the first
refresh.

If the CLI is ever upgraded on the host (`npm update -g
@anthropic-ai/claude-code`), no image rebuild is needed — the container
picks it up on its next restart since the mount is live, not a copy.
Re-running `claude login` needs no container change either, for the same
reason.

## Deploying

1. Wait for the `docker-publish` workflow to finish on the commit you want to ship — confirm both `oral-test-backend` and `oral-test-tts-sidecar` pushed successfully. (Note: `docker-publish.yml` only builds the `backend`/`tts-sidecar` targets, not `seed` — a from-source deploy via `docker compose up --build` runs `seed` as part of the compose stack; a deploy that only pulls the two published images still needs `seed` run once against the same data volume, e.g. `docker compose run --rm seed`.)
2. On the deploy host, either pull the published images and run them, or `docker compose up --build` from this repo's `docker-compose.yml` to build from source directly (this also runs `seed`).
3. Watch the app's `/health` endpoint until it responds `200`.

## Known limitations to resolve before this is internet-facing

This backend and the tts-sidecar were both written with an explicit
"loopback-only, no auth layer" invariant (`src/app.ts`, `tts-sidecar/README.md`).
Two changes were made to make containerization possible, but they do **not**
by themselves make the app safe to expose publicly:

1. **`HOST` is now env-configurable** (`src/app.ts`) so the container can bind `0.0.0.0` and be reached inside the Docker network. Container isolation (no published port for `tts-sidecar`, only the mapped backend port) is what currently keeps this scoped — not application-level auth.
2. **The backend's own Origin/Host guard** (`src/app.ts`'s `onRequest` hook) only allowlists loopback `Host` headers (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`). A request arriving through a reverse proxy carries the real domain as its `Host` header, so **every external request will currently be rejected with `403 forbidden_host`** until that allowlist is extended to include the deployed domain (`ORAL_TEST_ALLOWED_HOSTS`). This is an application-code/config change, decide and make it explicitly rather than loosening a security guard as a side effect of a deploy script.

## Local dev

```
docker compose up --build
```

Builds `seed`, `backend`, and `tts-sidecar` from source and runs them together (`backend` waits for `seed` to finish) with a stubbed `TTS_SIDECAR_URL` wiring already in place. `claude`-spawning routes won't work in this compose unless you uncomment the bind-mount lines in `docker-compose.yml` and point them at your own local `claude login` session (same read-write requirement as above).
