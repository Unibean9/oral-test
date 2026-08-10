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
| `ANTHROPIC_API_KEY` | yes | Auth for the `claude` CLI the backend spawns (`src/claude-cli/spawn.ts`) — out of scope for the 2 CI secrets requested; set here only |
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

Builds both images from source and runs them together with a stubbed `TTS_SIDECAR_URL` wiring already in place. Set `ANTHROPIC_API_KEY` in your shell (or an `--env-file`) before running if you need the `claude`-spawning routes to work.
