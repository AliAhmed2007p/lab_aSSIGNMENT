# COMSATS Connect — working notes for automated agents

## What the app is

A single Node.js process: Express REST API + Socket.IO, serving the static
client from `public/` on the same origin. There is **no database server** —
data is a JSON file at `server/data/db.json` (gitignored, created on first
write). No external services or credentials are required; the only secret is
`JWT_SECRET` for signing session tokens.

## Running it here (sandbox)

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

Three services:

- `install` (one-shot) — `npm ci` into the shared `node_modules` volume, only
  when the volume is empty.
- `seed` (one-shot) — loads demo users/groups/messages; it is idempotent and
  does nothing when the store already has users.
- `web` — `npm run dev` (nodemon) on host port 3000, source bind-mounted.

After changing `package.json`/`package-lock.json`:

```bash
docker compose -f docker-compose.base44.yml run --rm install \
  sh -ec "npm ci --no-audit --no-fund"
docker compose -f docker-compose.base44.yml restart web
```

Server code changes are picked up by nodemon automatically; the browser does
not reload itself, so refresh the preview after a restart.

## Verification

```bash
curl -s localhost:3000/api/health          # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/     # 200 (login page)
```

End-to-end boundary demo (needs the server up; logs in six users over
Socket.IO and prints PASS/FAIL for 13 scenarios):

```bash
docker compose -f docker-compose.base44.yml exec web npm run demo
```

Single sign-on platform suite (discovery, PKCE, token exchange, refresh-token
rotation, MFA, tenant isolation, password reset, audit log; prints PASS/FAIL
for ~75 checks):

```bash
docker compose -f docker-compose.base44.yml exec web npm run demo:sso
```

Demo accounts all use password `Comsats@123`
(e.g. `admin.it`, `dr.ahmed`, `FA23-BCS-050`, `FA22-BEE-031`, `SP23-BBA-019`).
`npm run demo:sso` restores everything it changes except one library renewal:
after a few runs the demo loan is at its renewal limit and the suite checks the
limit instead of the successful renewal. Re-seed to get the renewal path back.
Reset the data with `docker compose -f docker-compose.base44.yml exec web npm run seed -- --force`
followed by `docker compose -f docker-compose.base44.yml restart web`
(the server caches the store in memory).

## Gotchas

- `nodemon` is started with `--ignore server/data`: the batched JSON writes
  would otherwise restart the server on every message.
- `server/data/db.json` lives in the bind mount, so seeded demo data and any
  records created in the preview survive restarts — and are never committed.
- `JWT_SECRET` is delivered by the platform at `/run/base44/app.env`; when it
  is missing the app prints a warning and uses a built-in development secret.
- The app is same-origin only: no CORS or host/origin allowlist configuration
  is needed behind the preview proxy.
