'use strict';

/*
 * The single sign-on service: the OpenID Connect / OAuth 2.0 authorization
 * server, the SSO session that makes "sign in once, use every application"
 * work, and the access/refresh token machinery.
 *
 * Flow (authorization code + PKCE, which is what the sample applications use):
 *
 *   1. the application sends the browser to /sso/authorize
 *   2. this service validates the client and its redirect URI
 *   3. the user signs in once (password + MFA when required) and gets an
 *      HttpOnly session cookie for the SSO platform
 *   4. a short-lived authorization code is returned to the application
 *   5. the application exchanges the code (with its secret and the PKCE
 *      verifier) for an access token, an ID token and a refresh token
 *   6. any other application that starts the same flow while the session
 *      cookie is still valid skips step 3 entirely - that is the SSO part
 */

const db = require('../store/db');
const { AppError } = db;
const tenants = require('./tenantService');
const users = require('./userService');
const clientApps = require('./clientAppService');
const audit = require('./auditService');
const { SSO, SERVER } = require('../config/policies');
const {
  signJwt,
  verifyJwt,
  randomToken,
  hashToken,
  verifyPkceChallenge,
} = require('../security/tokens');
const cookies = require('../security/cookies');

const SESSION_COOKIE = 'connect_sso_session';
const FIRST_PARTY_AUDIENCE = 'first-party';
const SESSION_REFRESH_INTERVAL_MS = 60 * 1000;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  return proto ? String(proto).split(',')[0].trim() === 'https' : false;
}

// Cookie attributes for the SSO session. Inside the sandbox preview the pages
// are embedded in a frame on another site, so the cookie has to be sent there
// too ("SameSite=None"); a normal deployment uses "Lax".
function sessionCookieOptions(req, maxAgeSeconds) {
  return {
    httpOnly: true,
    maxAge: maxAgeSeconds,
    sameSite: SERVER.IS_PREVIEW ? 'None' : 'Lax',
    secure: SERVER.IS_PREVIEW ? true : isSecureRequest(req),
  };
}

/* ------------------------------------------------------------------ */
/* Authorization requests                                              */
/* ------------------------------------------------------------------ */

function requestedScopes(raw, app) {
  const wanted = String(raw || '')
    .split(/[\s+]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const allowed = wanted.filter((scope) => app.scopes.includes(scope));
  if (allowed.length === 0) return app.scopes.slice(0, 2);
  return Array.from(new Set(allowed));
}

// Validates every parameter of /sso/authorize. Throws (never redirects) so the
// caller can decide whether the error may be sent back to the client.
function normalizeAuthorize(query) {
  const params = query || {};
  const app = clientApps.requireUsableApp(params.client_id);
  const tenant = tenants.requireTenant(app.tenantId);
  tenants.assertActive(tenant);

  if (params.response_type && params.response_type !== 'code') {
    throw new AppError(400, 'Only response_type=code is supported.', 'UNSUPPORTED_RESPONSE_TYPE');
  }

  let redirectUri = params.redirect_uri;
  if (!redirectUri) {
    if (app.redirectUris.length !== 1) {
      throw new AppError(400, 'redirect_uri is required for this client.', 'BAD_REDIRECT_URI');
    }
    redirectUri = app.redirectUris[0];
  }
  redirectUri = clientApps.assertRedirectUri(app, redirectUri);

  if (params.code_challenge && params.code_challenge_method && params.code_challenge_method !== 'S256') {
    throw new AppError(400, 'Only code_challenge_method=S256 is supported.', 'INVALID_PKCE');
  }

  return {
    app,
    tenant,
    redirectUri,
    scope: requestedScopes(params.scope, app),
    state: params.state || null,
    nonce: params.nonce || null,
    prompt: params.prompt || null,
    codeChallenge: params.code_challenge || null,
    codeChallengeMethod: params.code_challenge ? 'S256' : null,
  };
}

// The authorize parameters as a query string, used to hand the request over to
// the sign-in page and back again without keeping server-side state.
function authorizeParams(request) {
  const params = new URLSearchParams();
  params.set('client_id', request.app.clientId);
  params.set('redirect_uri', request.redirectUri);
  params.set('response_type', 'code');
  params.set('scope', request.scope.join(' '));
  if (request.state) params.set('state', request.state);
  if (request.nonce) params.set('nonce', request.nonce);
  if (request.codeChallenge) {
    params.set('code_challenge', request.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return params;
}

// The pending request travels as plain parameters (inside a signed ticket or
// the query string of the sign-in page), never as server-side state.
function serializeRequest(request) {
  return {
    clientId: request.app.clientId,
    redirectUri: request.redirectUri,
    scope: request.scope,
    state: request.state,
    nonce: request.nonce,
    prompt: request.prompt,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
  };
}

function deserializeRequest(stored) {
  const data = stored || {};
  return normalizeAuthorize({
    client_id: data.clientId,
    redirect_uri: data.redirectUri,
    scope: (data.scope || []).join(' '),
    state: data.state,
    nonce: data.nonce,
    prompt: data.prompt,
    code_challenge: data.codeChallenge,
    code_challenge_method: data.codeChallengeMethod,
  });
}

function buildRedirect(redirectUri, params) {
  const url = new URL(redirectUri);
  Object.keys(params).forEach((key) => {
    if (params[key] !== null && params[key] !== undefined) url.searchParams.set(key, params[key]);
  });
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Authorization codes                                                 */
/* ------------------------------------------------------------------ */

function issueAuthCode(input) {
  const code = randomToken(32);
  const createdAt = nowIso();

  db.collection('authCodes').push({
    id: db.newId('code'),
    codeHash: hashToken(code),
    appId: input.app.id,
    clientId: input.app.clientId,
    tenantId: input.tenant.id,
    userId: input.user.id,
    sessionId: input.sessionId || null,
    redirectUri: input.request.redirectUri,
    scope: input.request.scope,
    nonce: input.request.nonce,
    codeChallenge: input.request.codeChallenge,
    codeChallengeMethod: input.request.codeChallengeMethod,
    authTime: input.authTime || Math.floor(Date.now() / 1000),
    amr: input.amr || ['pwd'],
    createdAt,
    expiresAt: addSeconds(createdAt, SSO.AUTH_CODE_TTL_SECONDS),
    usedAt: null,
  });
  db.save();

  return code;
}

// Authorization codes are single use. A second use of the same code means the
// code leaked, so every token that was issued from it is revoked.
function redeemAuthCode(input) {
  const data = input || {};
  const entry = db
    .collection('authCodes')
    .find((code) => code.codeHash === hashToken(data.code || ''));

  if (!entry) {
    throw new AppError(400, 'Unknown or already used authorization code.', 'INVALID_GRANT');
  }

  if (entry.usedAt) {
    revokeForUserAndClient(entry.userId, entry.clientId, 'authorization_code_reuse');
    audit.record({
      type: 'auth_code.reuse_detected',
      outcome: 'failure',
      tenantId: entry.tenantId,
      actorUserId: entry.userId,
      clientId: entry.clientId,
      req: data.req,
      detail: 'authorization code was presented twice',
    });
    throw new AppError(400, 'This authorization code has already been used.', 'INVALID_GRANT');
  }

  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    throw new AppError(400, 'The authorization code has expired.', 'INVALID_GRANT');
  }

  const app = clientApps.requireApp(entry.appId);
  if (app.clientId !== data.clientId) {
    throw new AppError(400, 'The authorization code was issued to another client.', 'INVALID_GRANT');
  }
  if (clientApps.assertRedirectUri(app, data.redirectUri) !== entry.redirectUri) {
    throw new AppError(400, 'redirect_uri does not match the authorization request.', 'INVALID_GRANT');
  }

  verifyPkceChallenge(data.codeVerifier, entry.codeChallenge, entry.codeChallengeMethod);

  entry.usedAt = nowIso();
  db.save();

  const tenant = tenants.requireTenant(entry.tenantId);
  const user = users.requireUser(entry.userId);

  return {
    app,
    tenant,
    user,
    sessionId: entry.sessionId,
    scope: entry.scope,
    nonce: entry.nonce,
    authTime: entry.authTime,
    amr: entry.amr,
  };
}

/* ------------------------------------------------------------------ */
/* SSO session (the cookie that makes single sign-on possible)          */
/* ------------------------------------------------------------------ */

function createSession(input) {
  const token = randomToken(32);
  const createdAt = nowIso();
  const settings = tenants.settingsOf(input.tenant);
  const maxAgeSeconds = settings.tokens.sessionTtlHours * 3600;

  const session = {
    id: db.newId('ses'),
    tokenHash: hashToken(token),
    userId: input.user.id,
    tenantId: input.tenant.id,
    amr: input.amr || ['pwd'],
    createdAt,
    expiresAt: addSeconds(createdAt, maxAgeSeconds),
    lastSeenAt: createdAt,
    revokedAt: null,
    revokedReason: null,
    ip: input.ip || null,
    userAgent: input.userAgent || null,
  };

  db.collection('sessions').push(session);
  db.save();

  if (input.res) {
    cookies.set(input.res, SESSION_COOKIE, token, sessionCookieOptions(input.req || {}, maxAgeSeconds));
  }
  logAudit('session.created', input, { sessionId: session.id });

  return { session, token, maxAgeSeconds };
}

function logAudit(type, input, detail) {
  audit.record({
    type,
    tenantId: input.tenant ? input.tenant.id : null,
    tenantName: input.tenant ? input.tenant.name : null,
    actorUserId: input.user ? input.user.id : null,
    actorLoginId: input.user ? input.user.loginId : null,
    actorName: input.user ? input.user.name : null,
    clientId: input.clientId || null,
    req: input.req,
    detail: detail || null,
  });
}

// Reads the session cookie and returns { session, user, tenant } or null.
function readSession(req) {
  const jar = cookies.parse(req);
  const token = jar[SESSION_COOKIE];
  if (!token) return null;

  const session = db
    .collection('sessions')
    .find((s) => s.tokenHash === hashToken(token));
  if (!session) return null;

  if (session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;

  const user = users.getUserById(session.userId);
  const tenant = tenants.getTenant(session.tenantId);
  if (!user || !user.active || !tenant || tenant.status !== 'active') return null;

  if (Date.now() - new Date(session.lastSeenAt).getTime() > SESSION_REFRESH_INTERVAL_MS) {
    session.lastSeenAt = nowIso();
    db.save();
  }

  return { session, user, tenant };
}

// Used by the sign-in page: who is already signed in?
function currentSession(req) {
  const found = readSession(req);
  if (!found) return null;
  return {
    user: found.user,
    tenant: tenants.present(found.tenant),
    sessionId: found.session.id,
    amr: found.session.amr,
    createdAt: found.session.createdAt,
    expiresAt: found.session.expiresAt,
  };
}

function revokeSession(session, reason) {
  session.revokedAt = nowIso();
  session.revokedReason = reason || 'logout';
  db.collection('refreshTokens')
    .filter((token) => token.sessionId === session.id && !token.revokedAt)
    .forEach((token) => {
      token.revokedAt = session.revokedAt;
      token.revokedReason = reason || 'logout';
    });
  db.save();
}

function destroySession(req, res, reason) {
  const found = readSession(req);
  if (found) {
    revokeSession(found.session, reason || 'logout');
    audit.record({
      type: 'session.revoked',
      tenantId: found.tenant.id,
      tenantName: found.tenant.name,
      actorUserId: found.user.id,
      actorLoginId: found.user.loginId,
      req,
      detail: reason || 'logout',
    });
  }
  if (res) cookies.clear(res, SESSION_COOKIE, sessionCookieOptions(req, 0));
  return Boolean(found);
}

function listSessions(userId) {
  const now = Date.now();
  return db
    .collection('sessions')
    .filter((s) => s.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      revokedReason: s.revokedReason,
      amr: s.amr,
      ip: s.ip,
      userAgent: s.userAgent,
      active: !s.revokedAt && new Date(s.expiresAt).getTime() > now,
    }));
}

function revokeSessionById(userId, sessionId, reason) {
  const session = db.collection('sessions').find((s) => s.id === sessionId && s.userId === userId);
  if (!session) throw new AppError(404, 'Session not found.', 'SESSION_NOT_FOUND');
  revokeSession(session, reason || 'revoked_by_user');
  return listSessions(userId);
}

function revokeAllForUser(userId, reason) {
  let sessions = 0;
  db.collection('sessions')
    .filter((s) => s.userId === userId && !s.revokedAt)
    .forEach((s) => {
      revokeSession(s, reason || 'revoked');
      sessions += 1;
    });

  let tokens = 0;
  db.collection('refreshTokens')
    .filter((t) => t.userId === userId && !t.revokedAt)
    .forEach((t) => {
      t.revokedAt = nowIso();
      t.revokedReason = reason || 'revoked';
      tokens += 1;
    });

  db.save();
  return { sessions, refreshTokens: tokens };
}

/* ------------------------------------------------------------------ */
/* Refresh tokens (rotating, with reuse detection)                      */
/* ------------------------------------------------------------------ */

function createRefreshToken(input) {
  const token = randomToken(48);
  const createdAt = nowIso();
  const settings = tenants.settingsOf(input.tenant);

  const entry = {
    id: db.newId('rt'),
    tokenHash: hashToken(token),
    family: input.family || db.newId('fam'),
    appId: input.app.id,
    clientId: input.app.clientId,
    tenantId: input.tenant.id,
    userId: input.user.id,
    sessionId: input.sessionId || null,
    scope: input.scope,
    createdAt,
    expiresAt: addSeconds(createdAt, settings.tokens.refreshTtlDays * 86400),
    rotatedAt: null,
    replacedById: null,
    revokedAt: null,
    revokedReason: null,
    ip: input.ip || null,
    userAgent: input.userAgent || null,
  };

  db.collection('refreshTokens').push(entry);
  db.save();
  return { token, entry };
}

// Presenting an already rotated refresh token means it was stolen or replayed:
// the whole family is revoked.
function revokeFamily(family, reason) {
  db.collection('refreshTokens')
    .filter((token) => token.family === family && !token.revokedAt)
    .forEach((token) => {
      token.revokedAt = nowIso();
      token.revokedReason = reason;
    });
  db.save();
}

function revokeForUserAndClient(userId, clientId, reason) {
  db.collection('refreshTokens')
    .filter((v) => v.userId === userId && v.clientId === clientId && !v.revokedAt)
    .forEach((token) => {
      token.revokedAt = nowIso();
      token.revokedReason = reason;
    });
  db.save();
}

function rotateRefreshToken(input) {
  const data = input || {};
  const entry = db
    .collection('refreshTokens')
    .find((token) => token.tokenHash === hashToken(data.token || ''));

  if (!entry) {
    throw new AppError(400, 'Unknown refresh token.', 'INVALID_GRANT');
  }

  if (entry.revokedAt || entry.rotatedAt) {
    revokeFamily(entry.family, 'refresh_token_reuse');
    audit.record({
      type: 'token.reuse_detected',
      outcome: 'failure',
      tenantId: entry.tenantId,
      actorUserId: entry.userId,
      clientId: entry.clientId,
      req: data.req,
      detail: 'refresh token was replayed; the whole token family was revoked',
    });
    throw new AppError(400, 'This refresh token has already been used. Sign in again.', 'INVALID_GRANT');
  }

  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    throw new AppError(400, 'The refresh token has expired. Sign in again.', 'INVALID_GRANT');
  }

  const app = clientApps.requireApp(entry.appId);
  if (app.clientId !== data.clientId) {
    throw new AppError(400, 'The refresh token belongs to another client.', 'INVALID_GRANT');
  }

  const tenant = tenants.requireTenant(entry.tenantId);
  tenants.assertActive(tenant);
  const user = users.requireUser(entry.userId);
  if (!user.active) {
    throw new AppError(403, 'This account has been deactivated.', 'ACCOUNT_DISABLED');
  }

  const rotated = createRefreshToken({
    app,
    tenant,
    user,
    scope: entry.scope,
    sessionId: entry.sessionId,
    family: entry.family,
    ip: data.ip,
    userAgent: data.userAgent,
  });

  entry.rotatedAt = nowIso();
  entry.replacedById = rotated.entry.id;
  db.save();

  return {
    app,
    tenant,
    user,
    scope: entry.scope,
    sessionId: entry.sessionId,
    refreshToken: rotated.token,
  };
}

function revokeRefreshToken(input) {
  const data = input || {};
  const entry = db
    .collection('refreshTokens')
    .find((token) => token.tokenHash === hashToken(data.token || ''));

  if (!entry) return false;
  if (entry.clientId !== data.clientId) return false;

  entry.revokedAt = nowIso();
  entry.revokedReason = data.reason || 'revoked_by_client';
  db.save();

  audit.record({
    type: 'token.revoked',
    tenantId: entry.tenantId,
    actorUserId: entry.userId,
    clientId: entry.clientId,
    req: data.req,
    detail: entry.revokedReason,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Access tokens and ID tokens                                         */
/* ------------------------------------------------------------------ */

function issueTokens(input) {
  const { app, tenant, user, scope } = input;
  const settings = tenants.settingsOf(tenant);
  const accessTtl = settings.tokens.accessTtlSeconds;
  const idTtl = settings.tokens.idTokenTtlSeconds;
  const sessionId = input.sessionId || null;

  const accessToken = signJwt(
    {
      token_use: 'access',
      tid: tenant.id,
      sid: sessionId,
      roles: [user.role],
      scope: scope.join(' '),
      name: user.name,
      email: user.email || undefined,
    },
    { audience: app.clientId, expiresIn: accessTtl, subject: user.id }
  );

  // When refreshing, the rotated token has already been created by the caller.
  const refreshToken = input.existingRefreshToken || createRefreshToken(input).token;

  const result = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope: scope.join(' '),
  };

  if (scope.includes('openid')) {
    result.id_token = signJwt(
      {
        token_use: 'id',
        tid: tenant.id,
        sid: sessionId,
        name: user.name,
        preferred_username: user.loginId,
        email: user.email || undefined,
        roles: [user.role],
        nonce: input.nonce || undefined,
        auth_time: input.authTime || Math.floor(Date.now() / 1000),
        amr: input.amr || ['pwd'],
      },
      { audience: app.clientId, expiresIn: idTtl, subject: user.id }
    );
  }

  audit.record({
    type: 'token.issued',
    tenantId: tenant.id,
    tenantName: tenant.name,
    actorUserId: user.id,
    actorLoginId: user.loginId,
    clientId: app.clientId,
    req: input.req,
    detail: 'access token ' + accessTtl + 's, scope ' + scope.join(' '),
  });

  return result;
}

// Verifies an access token: signature, issuer, expiry, audience, token type,
// then re-checks the account and the tenant against the database.
function verifyAccessToken(token) {
  const payload = verifyJwt(token, { tokenUse: 'access' });

  const audience = payload.aud;
  const isFirstParty = audience === FIRST_PARTY_AUDIENCE;
  const app = isFirstParty ? null : clientApps.getByClientId(audience);
  if (!isFirstParty && (!app || app.status !== 'active')) {
    throw new AppError(401, 'This token was issued to an unknown application.', 'INVALID_TOKEN');
  }

  const user = users.requireUser(payload.sub);
  if (!user.active) {
    throw new AppError(403, 'This account has been deactivated.', 'ACCOUNT_DISABLED');
  }

  const tenant = tenants.getTenant(payload.tid);
  tenants.assertActive(tenant);

  return { payload, user, tenant, app };
}

function userInfoFor(claims) {
  const { user, tenant } = claims;
  return {
    sub: user.id,
    name: user.name,
    preferred_username: user.loginId,
    email: user.email || null,
    email_verified: Boolean(user.email),
    roles: [user.role],
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
  };
}

/* ------------------------------------------------------------------ */
/* Signed tickets between the sign-in steps                             */
/* ------------------------------------------------------------------ */

// Short-lived, single-purpose tokens: they carry the pending authorization
// request from the password step to the MFA step, or to the enrollment step.
function signLoginTicket(input) {
  return signJwt(
    {
      token_use: 'ticket',
      purpose: input.purpose,
      tid: input.tenant.id,
      request: input.request,
    },
    {
      audience: SSO.LOGIN_TICKET_AUDIENCE,
      expiresIn: SSO.TICKET_TTL_MINUTES * 60,
      subject: input.user.id,
    }
  );
}

// Stateless state value for the social-login round trip. It carries the
// pending authorization request and never identifies an account by itself.
function signStateTicket(input) {
  return signJwt(
    {
      token_use: 'ticket',
      purpose: input.purpose,
      tid: input.tenantId || null,
      request: input.request || null,
    },
    {
      audience: SSO.LOGIN_TICKET_AUDIENCE,
      expiresIn: SSO.TICKET_TTL_MINUTES * 60,
      subject: input.subject || 'state',
    }
  );
}

function verifyStateTicket(ticket, purpose) {
  const payload = verifyJwt(ticket, { audience: SSO.LOGIN_TICKET_AUDIENCE, tokenUse: 'ticket' });
  if (payload.purpose !== purpose) {
    throw new AppError(400, 'This sign-in attempt has expired. Start again.', 'INVALID_TICKET');
  }
  return payload;
}

function verifyLoginTicket(ticket, purpose) {
  const payload = verifyJwt(ticket, { audience: SSO.LOGIN_TICKET_AUDIENCE, tokenUse: 'ticket' });
  if (payload.purpose !== purpose) {
    throw new AppError(400, 'This sign-in step has expired. Start again.', 'INVALID_TICKET');
  }
  // The stored record: the next step needs the TOTP secret, which the
  // sanitized view never carries.
  const user = users.rawUser(payload.sub);
  if (!user) throw new AppError(401, 'This account no longer exists.', 'INVALID_TOKEN');
  const tenant = tenants.requireTenant(payload.tid);
  return { payload, user, tenant, request: payload.request };
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

function purgeExpired() {
  const now = Date.now();
  const stores = {
    authCodes: (entry) => new Date(entry.expiresAt).getTime() < now - 3600 * 1000,
    sessions: (entry) =>
      new Date(entry.expiresAt).getTime() < now - 7 * 86400 * 1000 ||
      (entry.revokedAt && new Date(entry.revokedAt).getTime() < now - 7 * 86400 * 1000),
    refreshTokens: (entry) =>
      new Date(entry.expiresAt).getTime() < now ||
      (entry.revokedAt && new Date(entry.revokedAt).getTime() < now - 7 * 86400 * 1000),
    passwordResets: (entry) =>
      new Date(entry.expiresAt).getTime() < now - 86400 * 1000 ||
      (entry.usedAt && new Date(entry.usedAt).getTime() < now - 86400 * 1000),
  };

  Object.keys(stores).forEach((name) => {
    const list = db.collection(name);
    const kept = list.filter((entry) => !stores[name](entry));
    if (kept.length !== list.length) {
      list.length = 0;
      kept.forEach((entry) => list.push(entry));
    }
  });
  db.save();
}

// Pseudo client used by the first-party REST API (/api/auth/login): it lets
// scripts and the demo suite obtain an access token without a browser.
const FIRST_PARTY_APP = Object.freeze({
  id: 'first-party',
  clientId: FIRST_PARTY_AUDIENCE,
  name: 'COMSATS Connect (first-party API)',
  scopes: SSO.SCOPES,
  kind: 'confidential',
  status: 'active',
});

module.exports = {
  SESSION_COOKIE,
  FIRST_PARTY_AUDIENCE,
  sessionCookieOptions,
  normalizeAuthorize,
  authorizeParams,
  serializeRequest,
  deserializeRequest,
  buildRedirect,
  issueAuthCode,
  redeemAuthCode,
  issueTokens,
  createSession,
  readSession,
  currentSession,
  destroySession,
  revokeSessionById,
  revokeAllForUser,
  listSessions,
  rotateRefreshToken,
  revokeRefreshToken,
  verifyAccessToken,
  userInfoFor,
  signLoginTicket,
  verifyLoginTicket,
  signStateTicket,
  verifyStateTicket,
  purgeExpired,
  FIRST_PARTY_APP,
};
