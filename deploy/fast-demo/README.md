# Fast NetBird demo

Typed-answer HTTP demo only. It binds Caddy to the VPS NetBird address and publishes no
frontend, backend, TTS, or SQLite port. Do not use this lane on a public interface.
TTS has outbound-only Docker egress for the first Hugging Face model download, but no host
listener; its API remains reachable only from the backend's private network.

## One-time VPS setup

1. Copy `.env.example` to `.env`, generate a strong JWT secret, and set mode `0600`.
2. Put the two source PDFs in `SOURCE_PDF_DIR`; keep them outside Git.
3. Install Claude Code globally, run `claude login` as the runtime account, and set the five
   runtime UID/GID/CLI/config paths in `.env` from `id`, `command -v claude`, and `npm root -g`.
4. Ensure `oraltest.site` resolves to `100.75.51.122` on the authorized NetBird client (a
   temporary client-only hosts entry is acceptable while public DNS propagates).

## Safe start/redeploy

The lock cleanup is safe only after the prior backend is gone. Never overlap deploys.

```sh
cd /opt/oral-er/oral-test
docker compose --env-file deploy/fast-demo/.env -f deploy/fast-demo/compose.yaml down
test -z "$(docker ps -q --filter label=com.docker.compose.project=oral-fast-demo)"
docker compose --env-file deploy/fast-demo/.env -f deploy/fast-demo/compose.yaml config
docker compose --env-file deploy/fast-demo/.env -f deploy/fast-demo/compose.yaml up -d --build
docker compose --env-file deploy/fast-demo/.env -f deploy/fast-demo/compose.yaml ps -a
```

`data-init` only aligns the named SQLite volume with the configured runtime UID/GID. The seed
must then log `5 demo chapters/378 chunks`. Verify auth without a paid model request:

```sh
docker compose --env-file deploy/fast-demo/.env -f deploy/fast-demo/compose.yaml logs seed lock-cleanup
docker compose --env-file deploy/fast-demo/.env -f deploy/fast-demo/compose.yaml exec backend claude auth status
curl -fsS http://oraltest.site:8080/api/health
```

Never run `docker compose down -v`. Creating an oral session invokes Claude and requires the
operator's explicit approval immediately beforehand.
