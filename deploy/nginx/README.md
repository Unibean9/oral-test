# NetBird Nginx API edge

This host-level Nginx virtual host binds only `100.75.51.122:443` and proxies to the backend's
loopback-only Docker publication at `127.0.0.1:3001`. The `api.oraltest.site` A record must point
to the NetBird address, so clients outside the NetBird network cannot route to the API.

The certificate paths intentionally reference a private CA-signed leaf certificate. Install only
the public root CA certificate on authorized demo clients; never export the CA private key.

The Vercel frontend origins must be explicitly listed in `BRAINSTORM_ALLOWED_ORIGINS`, and the
backend must run with `NODE_ENV=production` so its HttpOnly cookie is also Secure.
