'use strict';

/*
 * Sample client application 2: COMSATS Library portal.
 *
 * A second, independent client of the SSO platform. It uses the same
 * authorization code + PKCE flow, but keeps the tokens on the server and
 * protects its own API with the scopes it was granted (library:read,
 * library:write) and with the role of the signed-in user.
 *
 * Open the chat first, then this application: no credentials are asked for a
 * second time while the SSO session is alive.
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

const CLIENT_ID = process.env.LIBRARY_CLIENT_ID || 'comsats-library-portal';
const CLIENT_SECRET = process.env.LIBRARY_CLIENT_SECRET || 'dev-library-client-secret';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'library:read', 'library:write'];
const FLOW_COOKIE = 'connect_library_flow';
const SESSION_COOKIE = 'connect_library_session';
const RENEW_DAYS = 14;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function redirectUri() {
  return SERVER.PUBLIC_BASE_URL + '/apps/library/callback';
}

function appOrThrow() {
  const app = clientApps.getByClientId(CLIENT_ID);
  if (!app) {
    throw new AppError(
      500,
      'The library application is not registered. Run "npm run seed" to register the sample applications.',
      'APP_NOT_REGISTERED'
    );
  }
  return app;
}

function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    maxAge: maxAgeSeconds,
    sameSite: SERVER.IS_PREVIEW ? 'None' : 'Lax',
    secure: SERVER.IS_PREVIEW ? true : Boolean(SERVER.PUBLIC_BASE_URL.startsWith('https')),
  };
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

// Refreshes the access token when it is about to expire.
async function freshToken(session) {
  if (new Date(session.accessExpiresAt).getTime() - Date.now() > 60 * 1000) {
    return session.accessToken;
  }
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
  return session.accessToken;
}

function requireSession(req, res, next) {
  try {
    const session = readAppSession(req);
    if (!session) {
      return next(new AppError(401, 'Sign in to the library portal first.', 'NO_SESSION'));
    }
    req.appSession = session;
    req.user = users.requireUser(session.userId);
    req.tenant = tenants.requireTenant(session.tenantId);
    req.scopes = String(session.scope || '').split(/\s+/);
    next();
  } catch (err) {
    next(err);
  }
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!req.scopes.includes(scope)) {
      return next(
        new AppError(403, 'This application was not granted the "' + scope + '" permission in this session.', 'SCOPE_FORBIDDEN')
      );
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Loans (demo data, tenant scoped)                                    */
/* ------------------------------------------------------------------ */

function loansOf(tenantId) {
  return db.collection('libraryLoans').filter((loan) => loan.tenantId === tenantId);
}

function isOverdue(loan) {
  return !loan.returnedAt && new Date(loan.dueAt).getTime() < Date.now();
}

function presentLoan(loan) {
  const borrower = users.getUserById(loan.userId);
  const overdue = isOverdue(loan);
  return {
    id: loan.id,
    title: loan.title,
    author: loan.author,
    dueAt: loan.dueAt,
    renewals: loan.renewals || 0,
    returned: Boolean(loan.returnedAt),
    overdue,
    student: borrower ? borrower.name : 'Unknown',
    loginId: borrower ? borrower.loginId : null,
    isMine: false,
  };
}

function listLoans(user, tenant) {
  const all = loansOf(tenant.id);
  const mine = all.filter((loan) => loan.userId === user.id);

  if (user.role === 'student') {
    // Students only ever see their own loans; this is both the privacy rule
    // and what the library policy says.
    return mine.map((loan) => Object.assign(presentLoan(loan), { isMine: true }));
  }
  return all
    .map((loan) => Object.assign(presentLoan(loan), { isMine: loan.userId === user.id }))
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
}

function requireLoan(user, tenant, loanId) {
  const loan = loansOf(tenant.id).find((entry) => entry.id === loanId);
  if (!loan) throw new AppError(404, 'Loan not found.', 'LOAN_NOT_FOUND');
  if (user.role === 'student' && loan.userId !== user.id) {
    throw new AppError(403, 'Students can only manage their own loans.', 'LOAN_FORBIDDEN');
  }
  return loan;
}

/* ------------------------------------------------------------------ */
/* OAuth flow                                                          */
/* ------------------------------------------------------------------ */

router.get(
  '/login',
  asyncHandler(async (req, res) => {
    const app = appOrThrow();
    const tenant = tenants.requireTenant(app.tenantId);
    tenants.assertActive(tenant);

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    cookies.set(
      res,
      FLOW_COOKIE,
      sso.signStateTicket({
        purpose: 'app:library:flow',
        tenantId: tenant.id,
        subject: 'library-flow',
        request: { state, verifier },
      }),
      cookieOptions(600)
    );

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

    res.redirect('/sso/authorize?' + params.toString());
  })
);

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

    const stored = sso.verifyStateTicket(flow, 'app:library:flow');
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

    const claims = tokens.verifyJwt(granted.id_token, { audience: app.clientId, tokenUse: 'id' });

    const raw = crypto.randomBytes(24).toString('base64url');
    db.collection('appSessions').push({
      id: db.newId('aps'),
      tokenHash: tokens.hashToken(raw),
      clientId: app.clientId,
      appId: app.id,
      userId: claims.sub,
      tenantId: claims.tid,
      scope: granted.scope,
      accessToken: granted.access_token,
      accessExpiresAt: new Date(Date.now() + granted.expires_in * 1000).toISOString(),
      refreshToken: granted.refresh_token,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      revokedAt: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });
    db.save();

    cookies.set(res, SESSION_COOKIE, raw, cookieOptions(30 * 86400));

    audit.record({
      type: 'app.login_completed',
      tenantId: claims.tid,
      actorUserId: claims.sub,
      clientId: app.clientId,
      req,
      detail: 'library portal exchanged the authorization code',
    });

    res.redirect('/apps/library/');
  })
);

// The portal is rendered from the server, so the browser never sees a token.
router.get(
  '/api/session',
  requireSession,
  asyncHandler(async (req, res) => {
    const accessToken = await freshToken(req.appSession);
    // Claims come from the provider's userinfo endpoint, like any OIDC client.
    const profile = await oauth.userinfo(accessToken);

    res.json({
      signedIn: true,
      profile,
      user: req.user,
      tenant: tenants.present(req.tenant),
      scopes: req.scopes,
      role: req.user.role,
      canManageAll: req.user.role !== 'student',
    });
  })
);

router.get(
  '/api/loans',
  requireSession,
  requireScope('library:read'),
  asyncHandler(async (req, res) => {
    const loans = listLoans(req.user, req.tenant);
    res.json({
      loans,
      summary: {
        visible: loans.length,
        overdue: loans.filter((loan) => loan.overdue).length,
        mine: loans.filter((loan) => loan.isMine).length,
      },
    });
  })
);

router.post(
  '/api/loans/:id/renew',
  requireSession,
  requireScope('library:write'),
  asyncHandler(async (req, res) => {
    const loan = requireLoan(req.user, req.tenant, req.params.id);

    if (loan.returnedAt) {
      throw new AppError(400, 'That book has already been returned.', 'LOAN_RETURNED');
    }
    if (isOverdue(loan)) {
      throw new AppError(400, 'Overdue items must be returned to the desk before they can be renewed.', 'LOAN_OVERDUE');
    }

    const limit = req.user.role === 'student' ? 2 : 3;
    if ((loan.renewals || 0) >= limit) {
      throw new AppError(400, 'This loan has reached its renewal limit.', 'RENEWAL_LIMIT');
    }

    loan.renewals = (loan.renewals || 0) + 1;
    loan.dueAt = new Date(Date.now() + RENEW_DAYS * 86400 * 1000).toISOString();
    db.save();

    audit.record({
      type: 'library.loan_renewed',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      clientId: CLIENT_ID,
      req,
      detail: loan.title + ' (by ' + req.user.role + ')',
    });

    res.json({ status: 'ok', loan: presentLoan(loan) });
  })
);

router.post(
  '/logout',
  requireSession,
  asyncHandler(async (req, res) => {
    await oauth.revoke({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: req.appSession.refreshToken,
    });
    req.appSession.revokedAt = new Date().toISOString();
    db.save();
    cookies.clear(res, SESSION_COOKIE, cookieOptions(0));
    res.json({ status: 'ok' });
  })
);

module.exports = { router, CLIENT_ID, SCOPES, redirectUri };
