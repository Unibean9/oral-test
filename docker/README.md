# Docker / CI-CD / Dokploy deploy

## Pipeline

```
Push to main → GitHub Actions
  validate: secret scan (gitleaks) → typecheck → test → SCA (Trivy fs) → SAST (Semgrep)
  publish:  build image → container scan (Trivy) → push to DockerHub (latest + commit SHA)
```

**Deploy is manual.** The workflow stops after `publish` — it never calls the
Dokploy API. `docker/docker-compose.prod.yml` is the only deploy artifact
Dokploy needs; it never builds from source.

## GitHub Actions secrets (repo → Settings → Secrets and variables → Actions)

| Secret | Used for |
|---|---|
| `DOCKER_USER` | DockerHub username — image push and image name (`${DOCKER_USER}/oral-test-backend`, `${DOCKER_USER}/oral-test-tts-sidecar`) |
| `DOCKER_PASSWORD` | DockerHub **access token**, not the account password |

Nothing else lives in GitHub Secrets for this pipeline — no Dokploy API token
is needed since deploy is manual.

## `claude` CLI on the VPS (one-time setup)

The image does **not** bundle the `claude` CLI that `src/claude-cli/spawn.ts`
shells out to. Instead, `docker-compose.prod.yml` bind-mounts it in from a
system-wide install on the VPS host itself, at the same absolute path on both
sides so `/usr/local/bin/claude`'s symlink into
`.../lib/node_modules/@anthropic-ai/claude-code` still resolves inside the
container without rewriting:

```bash
# On the VPS, once, as root (or via sudo):
npm install -g @anthropic-ai/claude-code
which claude              # confirm: /usr/local/bin/claude
npm root -g                # confirm: /usr/local/lib/node_modules
```

If either path differs from `/usr/local/bin/claude` /
`/usr/local/lib/node_modules/@anthropic-ai/claude-code` on your VPS (e.g. npm's
prefix was reconfigured, or it's nvm-managed instead of system-wide), set
`CLAUDE_CLI_BIN` and `CLAUDE_CLI_LIB` as Dokploy app env vars to override the
defaults in `docker-compose.prod.yml` — don't edit the compose file itself for
a host-specific path.

**Auth is a Claude Pro plan login, not an API key.** Run `claude login` as
`root` on the VPS once (interactively, over SSH — it opens a browser-auth
flow) so the session lands at `/root/.claude/` and `/root/.claude.json`. The
backend container then:

- runs as `user: "0:0"` (root) instead of the Dockerfile's non-root `app`
  user, and
- bind-mounts `/root/.claude` and `/root/.claude.json` **read-write** (not
  read-only, unlike the binary mounts above) — the CLI refreshes its session
  tokens in these files periodically, and a read-only mount would let auth
  silently expire the first time that refresh is attempted.

This trades away the container's non-root isolation to reuse the host's login
session. The alternative — create a dedicated non-root VPS user, log in as
that user, and set the container's UID/GID to match it via `user:` — keeps
the container non-root but adds a one-time VPS setup step; switch to it later
if the root-container tradeoff stops being acceptable.

If the CLI is ever upgraded on the VPS (`npm update -g @anthropic-ai/claude-code`),
no image rebuild or redeploy is needed — the container picks it up on its next
restart since the mount is live, not a copy. Re-running `claude login` (e.g.
after a session is revoked) needs no container change either, for the same
reason.

## Deploying (manual, every time)

1. Wait for the `docker-publish` workflow to finish on the commit you want to ship — confirm both `oral-test-backend` and `oral-test-tts-sidecar` pushed successfully.
2. In the Dokploy dashboard, open this app's Compose service.
3. Set the `IMAGE_TAG` environment variable to the commit SHA you want to run (or leave it unset / `latest` for "whatever `main` last built" — not recommended for anything you'd need to roll back from).
4. Set/confirm the other env vars this compose file reads (see table below).
5. Click **Deploy**. Dokploy pulls the image (`pull_policy: always`) and recreates the containers.
6. Watch the app's `/health` endpoint (or Dokploy's own log tail) until it responds `200`.

## Dokploy app environment variables

Set these directly in the Dokploy app (never in GitHub Secrets — they're not read by CI):

| Variable | Required | Notes |
|---|---|---|
| `DOCKER_USER` | yes | Same DockerHub username as the CI secret — `docker-compose.prod.yml` interpolates `${DOCKER_USER}/oral-test-*` as the image name |
| `IMAGE_TAG` | yes | Commit SHA to deploy. This is the rollback lever — see below |
| `BACKEND_PORT` | no (default `3001`) | Host-side port Dokploy/Traefik routes to |
| `BRAINSTORM_ALLOWED_ORIGINS` | yes | Comma-separated exact origins the backend's CORS guard accepts |
| `CLAUDE_CLI_BIN` | no (default `/usr/local/bin/claude`) | Only set if the VPS's `which claude` differs from the default — see "`claude` CLI on the VPS" above |
| `CLAUDE_CLI_LIB` | no (default `/usr/local/lib/node_modules/@anthropic-ai/claude-code`) | Only set if the VPS's `npm root -g` differs from the default |
| `BACKEND_MEMORY_LIMIT` | no (default `512m`) | |
| `SIDECAR_MEMORY_LIMIT` | no (default `2g`) | The TTS model is the memory-heavy part of this stack |

Domain/SSL for the backend is configured in Dokploy's own **Domains** tab, not in the compose file.

## Rollback

1. In Dokploy, set `IMAGE_TAG` back to the previous known-good commit SHA (check GitHub Actions run history or the DockerHub tags list for what's available).
2. Click **Deploy** again — same button, same API, only the tag it resolves to changed.

Never roll back by leaving `IMAGE_TAG` on `latest` — by the time you need to roll back, `latest` already points past the bad build.

## Known limitations to resolve before this is internet-facing

This backend and the tts-sidecar were both written with an explicit
"loopback-only, no auth layer" invariant (`src/app.ts`, `tts-sidecar/README.md`).
Two changes were made to make containerization possible, but they do **not**
by themselves make the app safe to expose publicly:

1. **`HOST` is now env-configurable** (`src/app.ts`) so the container can bind `0.0.0.0` and be reached inside the Docker network. Container isolation (no published port for `tts-sidecar`, only the mapped `BACKEND_PORT` for `backend`) is what currently keeps this scoped — not application-level auth.
2. **The backend's own Origin/Host guard** (`src/app.ts`'s `onRequest` hook) only allowlists loopback `Host` headers (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`). A request arriving through Dokploy's reverse proxy carries the real domain as its `Host` header, so **every external request will currently be rejected with `403 forbidden_host`** until that allowlist is extended to include the deployed domain. This is an application-code change, intentionally left out of this CI/CD scaffold — decide and make it explicitly rather than loosening a security guard as a side effect of a deploy script.

## Local dev

```
docker compose -f docker/docker-compose.dev.yml up --build
```

Builds both images from source and runs them together with a stubbed `TTS_SIDECAR_URL` wiring already in place. `claude`-spawning routes won't work in this dev compose unless you uncomment the bind-mount lines in `docker-compose.dev.yml` and point them at your own local `claude login` session (same read-write requirement as prod — see above).
