'use strict';

/*
 * Sample client application 1: COMSATS Connect chat.
 *
 * The chat pages (/chat.html) are a browser application that calls the REST and
 * Socket.IO API with a bearer token. Instead of asking for a password itself,
 * it sends the user to the SSO authorization endpoint and exchanges the code it
 * gets back for tokens (authorization code + PKCE, confidential client).
 *
 * Sign in here, then open the Library portal: the second application is
 * authorized without asking for credentials again.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../store/db');
const { AppError } = db;
const clientApps = require('../services/clientAppService');
const sso = require('../services/ssoService');
const tenants = require('../services/tenantService');
const users = require('../services/userService');
const audit = require('../services/auditService');
const oauth = require('./oauthClient');
const tokens = require('../security/tokens');
const cookies = require('../security/cookies');
const { asyncHandler } = require('../middleware/errorHandler');
const { SERVER } = require('../config/policies');

const router = express.Router();

const CLIENT_ID = process.env.CHAT_CLIENT_ID || 'comsats-connect-chat';
const CLIENT_SECRET = process.env.CHAT_CLIENT_SECRET || 'dev-chat-client-secret';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'chat:read', 'chat:write'];
const FLOW_COOKIE = 'connect_chat_flow';
const SESSION_COOKIE = 'connect_chat_session';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function redirectUri() {
  return SERVER.PUBLIC_BASE_URL + '/apps/chat/callback';
}

function appOrThrow() {
  const app = clientApps.getByClientId(CLIENT_ID);
  if (!app) {
    throw new AppError(
      500,
      'The chat application is not registered. Run "npm run seed" to register the sample applications.',
      'APP_NOT_REGISTERED'
    );
  }
  return app;
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    maxAge: maxAgeSeconds,
    sameSite: SERVER.IS_PREVIEW ? 'None' : 'Lax',
    secure: SERVER.IS_PREVIEW ? true : Boolean(SERVER.PUBLIC_BASE_URL.startsWith('https')),
  };
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function readAppSession(req) {
  const jar = cookies.parse(req);
  const raw = jar[SESSION_COOKIE];
  if (!raw) return null;

  const session = db
    .collection('appSessions')
    .find((s) => s.tokenHash === tokens.hashToken(raw) && s.clientId === CLIENT_ID);
  if (!session || session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

// Hands the browser its tokens (the chat pages keep them in sessionStorage,
// like any single-page application) and sends it to the chat.
function bootstrapPage(res, token, expiresIn, user, target) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Signing in - COMSATS Connect</title>' +
      '<link rel="stylesheet" href="/css/styles.css"></head>' +
      '<body class="login-page"><main class="login-panel"><h2>Signing you in...</h2>' +
      '<p class="sub">The chat is opening.</p></main>' +
      '<script>' +
      'sessionStorage.setItem("connect.token", ' + jsonForScript(token) + ');' +
      'sessionStorage.setItem("connect.expiresIn", ' + jsonForScript(expiresIn) + ');' +
      'sessionStorage.setItem("connect.user", ' + jsonForScript(JSON.stringify(user)) + ');' +
      'location.replace(' + jsonForScript(target || '/chat.html') + ');' +
      '</script></body></html>'
  );
}

/* ------------------------------------------------------------------ */
/* OAuth flow                                                          */
/* ------------------------------------------------------------------ */

// Step 1: send the browser to the SSO authorization endpoint
router.get(
  '/login',
  asyncHandler(async (req, res) => {
    const app = appOrThrow();
    const tenant = tenants.requireTenant(app.tenantId);
    tenants.assertActive(tenant);

    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(16).toString('hex');

    const ticket = sso.signStateTicket({
      purpose: 'app:chat:flow',
      tenantId: tenant.id,
      subject: 'chat-flow',
      request: { state, verifier },
    });
    cookies.set(res, FLOW_COOKIE, ticket, cookieOptions(600));

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: redirectUri(),
      scope: SCOPES.join(' '),
      state,
      nonce: crypto.randomBytes(12).toString('hex'),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    audit.record({
      type: 'app.login_started',
      tenantId: tenant.id,
      tenantName: tenant.name,
      clientId: app.clientId,
      req,
      detail: 'chat application sent the user to the authorization endpoint',
    });

    res.redirect('/sso/authorize?' + params.toString());
  })
);

// Step 2: the SSO platform sent the user back with a code
router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const app = appOrThrow();
    const jar = cookies.parse(req);
    const flow = jar[FLOW_COOKIE];
    cookies.clear(res, FLOW_COOKIE, cookieOptions(0));

    if (req.query.error) {
      throw new AppError(401, 'Sign-in was refused: ' + req.query.error, 'AUTHORIZATION_DENIED');
    }
    if (!flow) throw new AppError(400, 'The sign-in attempt expired. Please start again.', 'INVALID_STATE');

    const stored = sso.verifyStateTicket(flow, 'app:chat:flow');
    if (!stored.request || req.query.state !== stored.request.state) {
      throw new AppError(400, 'The authorization response could not be validated.', 'INVALID_STATE');
    }

    const granted = await oauth.authorizationCodeGrant({
      clientId: app.clientId,
      clientSecret: CLIENT_SECRET,
      code: req.query.code,
      redirectUri: redirectUri(),
      codeVerifier: stored.request.verifier,
    });

    // Verify the ID token ourselves: signature, issuer, audience, expiry.
    const claims = tokens.verifyJwt(granted.id_token, { audience: app.clientId, tokenUse: 'id' });

    const now = Date.now();
    const session = {
      id: db.newId('aps'),
      tokenHash: tokens.hashToken(crypto.randomBytes(24).toString('base64url')),
      clientId: app.clientId,
      appId: app.id,
      userId: claims.sub,
      tenantId: claims.tid,
      scope: granted.scope,
      accessToken: granted.access_token,
      accessExpiresAt: new Date(now + granted.expires_in * 1000).toISOString(),
      refreshToken: granted.refresh_token,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30 * 86400 * 1000).toISOString(),
      revokedAt: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    };

    // The cookie carries an opaque value; the tokens stay on the server.
    const raw = crypto.randomBytes(24).toString('base64url');
    session.tokenHash = tokens.hashToken(raw);
    db.collection('appSessions').push(session);
    db.save();

    cookies.set(res, SESSION_COOKIE, raw, cookieOptions(30 * 86400));

    const user = users.getUserById(claims.sub);
    audit.record({
      type: 'app.login_completed',
      tenantId: session.tenantId,
      actorUserId: session.userId,
      actorLoginId: user ? user.loginId : null,
      clientId: app.clientId,
      req,
      detail: 'chat application exchanged the authorization code',
    });

    bootstrapPage(res, granted.access_token, granted.expires_in, user, req.query.returnTo);
  })
);

// The single-page app asks for a token here; expired tokens are refreshed
// server-side, so the browser never holds a long-lived credential.
router.get(
  '/api/session',
  asyncHandler(async (req, res) => {
    const session = readAppSession(req);
    if (!session) {
      return res.status(401).json({ error: { code: 'NO_SESSION', message: 'Not signed in.' } });
    }

    const user = users.getUserById(session.userId);
    if (!user || !user.active) {
      session.revokedAt = new Date().toISOString();
      db.save();
      return res.status(403).json({ error: { code: 'ACCOUNT_DISABLED', message: 'This account is not active.' } });
    }

    // Refresh a little before it expires.
    if (new Date(session.accessExpiresAt).getTime() - Date.now() < 60 * 1000) {
      const refreshed = await oauth.refreshGrant({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: session.refreshToken,
      });
      session.accessToken = refreshed.access_token;
      session.refreshToken = refreshed.refresh_token;
      session.scope = refreshed.scope;
      session.accessExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      db.save();
    }

    res.json({
      token: session.accessToken,
      expiresIn: Math.max(1, Math.round((new Date(session.accessExpiresAt).getTime() - Date.now()) / 1000)),
      user,
      scope: session.scope,
    });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const session = readAppSession(req);
    if (session) {
      await oauth.revoke({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: session.refreshToken,
      });
      session.revokedAt = new Date().toISOString();
      db.save();

      audit.record({
        type: 'app.logout',
        tenantId: session.tenantId,
        actorUserId: session.userId,
        clientId: CLIENT_ID,
        req,
        detail: 'chat application session ended and refresh token revoked',
      });
    }
    cookies.clear(res, SESSION_COOKIE, cookieOptions(0));
    res.json({ status: 'ok' });
  })
);

module.exports = { router, CLIENT_ID, SCOPES, redirectUri };
