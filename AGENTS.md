# COMSATS Connect — working notes for automated agents

## What the app is

A single Node.js process: Express REST API + Socket.IO, serving the static
client from `public/` on the same origin. There is **no database server** —
data is a JSON file at `server/data/db.json` (gitignored, created on first
write). No external services or credentials are required: the token-signing RSA
key pair is generated on first start into `server/data/keys.json` (gitignored),
and the Google/Facebook buttons stay disabled until their credentials exist.

The same process is also the OAuth 2.0 / OpenID Connect **identity provider**,
with two sample client applications (`/apps/chat/login`, `/apps/library/login`)
and the chat behind sample application 1.

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

- Every browser page is a plain static file, so a JavaScript syntax error kills
  the page silently — no server-side error, the form and the provider buttons
  just never appear (`public/js/sso-login.js` had one). `node --check
  public/js/*.js` catches it before the browser does.
- `nodemon` is started with `--ignore server/data`: the batched JSON writes
  would otherwise restart the server on every message.
- `server/data/db.json` lives in the bind mount, so seeded demo data and any
  records created in the preview survive restarts — and are never committed.
- The three bundled applications get their callback URLs re-pointed at the
  current `PUBLIC_BASE_URL` on every start (`server/services/clientAppSync.js`),
  so a rotated preview host does not break their sign-in with `BAD_REDIRECT_URI`.
- Documentation screenshots live in `docs/screenshots/` and are referenced by
  `README.md` and `docs/SSO-SETUP.md`. They are captured from the running app
  with headless Chromium on the compose network, e.g.
  `docker run --rm --entrypoint node --network comsats-connect_default
  -v /tmp/sc:/tmp/sc -e NODE_PATH=/usr/src/app/node_modules
  -e SHOT_BASE=http://web:3000 zenika/alpine-chrome:with-puppeteer
  /tmp/sc/login-shot.js`. Keep a one-off capture script in `/tmp`, never in the
  repo; a capture that signs in writes sessions and audit rows into the store,
  so re-seed afterwards.
- The app is same-origin only: no CORS or host/origin allowlist configuration
  is needed behind the preview proxy.
