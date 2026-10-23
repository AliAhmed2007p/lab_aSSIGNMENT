'use strict';

/*
 * HTTP surface of the SSO platform.
 *
 *   /.well-known/openid-configuration   discovery document
 *   /sso/jwks.json                      public keys used to verify tokens
 *   /sso/authorize                      OAuth 2.0 / OIDC authorization endpoint
 *   /sso/login                          the central sign-in page
 *   /sso/token                          token endpoint (code + refresh grants)
 *   /sso/userinfo                       user claims for an access token
 *   /sso/revoke                         refresh-token revocation
 *   /sso/end-session                    single sign-out
 *   /sso/social/<provider>/...          Google and Facebook sign-in
 *   /sso/api/...                        JSON API used by the sign-in pages
 */

const express = require('express');
const path = require('path');
const db = require('../store/db');
const { AppError } = db;
const tenants = require('../services/tenantService');
const users = require('../services/userService');
const clientApps = require('../services/clientAppService');
const mfa = require('../services/mfaService');
const sso = require('../services/ssoService');
const social = require('../services/socialService');
const audit = require('../services/auditService');
const passwords = require('../security/passwords');
const tokens = require('../security/tokens');
const cookies = require('../security/cookies');
const { randomToken, hashToken } = tokens;
const { asyncHandler } = require('../middleware/errorHandler');
const { SSO, SERVER, DEPARTMENTS } = require('../config/policies');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const RESET_TTL_MINUTES = 30;
const SOCIAL_STATE_COOKIE = 'connect_sso_social_state';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function sendPage(res, file) {
  res.sendFile(path.join(PUBLIC_DIR, file));
}

// Cookie-authenticated write endpoints only accept same-origin calls.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, tests)
  const allowed = [SERVER.PUBLIC_BASE_URL, SERVER.PUBLIC_BASE_URL.replace(/^https:/, 'http:')];
  if (!allowed.includes(String(origin).replace(/\/+$/, ''))) {
    throw new AppError(403, 'Cross-origin request refused.', 'BAD_ORIGIN');
  }
  return true;
}

function requireSession(req, res, next) {
  const session = sso.currentSession(req);
  if (!session) {
    return next(new AppError(401, 'Sign in first.', 'NO_SESSION'));
  }
  req.ssoSession = session;
  req.user = session.user;
  req.tenant = tenants.requireTenant(session.user.tenantId);
  next();
}

// Who is calling the token endpoint? (client_secret_post or client_secret_basic)
function clientCredentials(req) {
  const body = req.body || {};
  const header = req.headers.authorization || '';
  const basic = header.match(/^Basic\s+(.+)$/i);

  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    return {
      clientId: index >= 0 ? decoded.slice(0, index) : decoded,
      clientSecret: index >= 0 ? decoded.slice(index + 1) : null,
      method: 'client_secret_basic',
    };
  }
  return {
    clientId: body.client_id || null,
    clientSecret: body.client_secret || null,
    method: body.client_secret ? 'client_secret_post' : 'none',
  };
}

function assertClient(app, credentials) {
  if (app.kind === 'public') return true; // public clients rely on PKCE
  if (!clientApps.verifySecret(app, credentials.clientSecret)) {
    throw new AppError(401, 'Invalid client credentials.', 'INVALID_CLIENT');
  }
  return true;
}

// Errors on the OAuth endpoints use the error format clients expect.
function oauthErrorResponse(err, res) {
  const status = err instanceof AppError ? err.status : 500;
  const mapping = {
    INVALID_GRANT: 'invalid_grant',
    INVALID_CLIENT: 'invalid_client',
    UNKNOWN_CLIENT: 'invalid_client',
    INVALID_PKCE: 'invalid_grant',
    UNSUPPORTED_GRANT: 'unsupported_grant_type',
    UNSUPPORTED_RESPONSE_TYPE: 'unsupported_response_type',
    BAD_REDIRECT_URI: 'invalid_request',
    APP_DISABLED: 'unauthorized_client',
    TENANT_SUSPENDED: 'unauthorized_client',
  };
  const code = mapping[err.code] || (status >= 500 ? 'server_error' : 'invalid_request');
  res.status(code === 'invalid_client' ? 401 : 400).json({
    error: code,
    error_description: err.message,
  });
}

// Creates the SSO session, and either returns the tokens of the first-party
// API or sends the application back to its redirect URI with a fresh code.
function finishLogin(req, res, ctx) {
  const amr = ctx.amr || ['pwd'];
  const { session } = sso.createSession({ user: ctx.user, tenant: ctx.tenant, req, res, amr });

  if (!ctx.app || !ctx.request) {
    const tokens = sso.issueTokens({
      app: sso.FIRST_PARTY_APP,
      tenant: ctx.tenant,
      user: ctx.user,
      scope: ctx.scope || ['openid', 'profile', 'email', 'offline_access'],
      sessionId: session.id,
      authTime: Math.floor(Date.now() / 1000),
      amr,
      req,
    });
    return {
      status: 'ok',
      redirectTo: null,
      token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      user: ctx.user,
    };
  }

  const code = sso.issueAuthCode({
    app: ctx.app,
    tenant: ctx.tenant,
    user: ctx.user,
    request: ctx.request,
    sessionId: session.id,
    authTime: Math.floor(Date.now() / 1000),
    amr,
  });

  const params = { code };
  if (ctx.request.state) params.state = ctx.request.state;
  return { status: 'ok', redirectTo: sso.buildRedirect(ctx.request.redirectUri, params) };
}

// Shared by the password step, the registration step and the social callback.
function continueOrChallenge(req, res, ctx) {
  const { user, tenant, app, request } = ctx;
  const status = mfa.statusOf(user);

  if (mfa.isEnabled(user)) {
    return {
      status: 'mfa_required',
      ticket: sso.signLoginTicket({
        purpose: 'login:mfa',
        user,
        tenant,
        request: request ? sso.serializeRequest(request) : null,
      }),
      methods: ['totp', 'recovery_codes'],
      account: user.loginId,
    };
  }

  if (mfa.isEnrollmentRequired(tenant, user)) {
    return {
      status: 'mfa_enroll_required',
      ticket: sso.signLoginTicket({
        purpose: 'login:enroll',
        user,
        tenant,
        request: request ? sso.serializeRequest(request) : null,
      }),
      reason: tenant.name + ' requires two-factor authentication for every account.',
      account: user.loginId,
    };
  }

  const result = finishLogin(req, res, ctx);
  return Object.assign({ mfa: status }, result);
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

function discoveryDocument() {
  const base = SERVER.PUBLIC_BASE_URL;
  return {
    issuer: SSO.ISSUER,
    authorization_endpoint: base + '/sso/authorize',
    token_endpoint: base + '/sso/token',
    userinfo_endpoint: base + '/sso/userinfo',
    jwks_uri: base + '/sso/jwks.json',
    revocation_endpoint: base + '/sso/revoke',
    end_session_endpoint: base + '/sso/end-session',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: SSO.SCOPES,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [
      'sub',
      'name',
      'preferred_username',
      'email',
      'email_verified',
      'roles',
      'tenant',
      'auth_time',
      'amr',
    ],
  };
}

router.get('/.well-known/openid-configuration', (req, res) => {
  res.json(discoveryDocument());
});

router.get('/sso/.well-known/openid-configuration', (req, res) => {
  res.json(discoveryDocument());
});

router.get('/sso/jwks.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json(tokens.jwks());
});

/* ------------------------------------------------------------------ */
/* Authorization endpoint                                              */
/* ------------------------------------------------------------------ */

router.get(
  '/sso/authorize',
  asyncHandler(async (req, res) => {
    const request = sso.normalizeAuthorize(req.query);
    const params = sso.authorizeParams(request).toString();

    const session = sso.currentSession(req);
    const sameTenant = session && session.user.tenantId === request.tenant.id;

    if (sameTenant && request.prompt !== 'login') {
      audit.record({
        type: 'sso.session_reused',
        tenantId: request.tenant.id,
        tenantName: request.tenant.name,
        actorUserId: session.user.id,
        actorLoginId: session.user.loginId,
        clientId: request.app.clientId,
        req,
        detail: 'existing SSO session signed the user in without a password prompt',
      });

      const code = sso.issueAuthCode({
        app: request.app,
        tenant: request.tenant,
        user: session.user,
        request,
        sessionId: session.sessionId,
        amr: session.amr,
      });
      const redirectParams = { code };
      if (request.state) redirectParams.state = request.state;
      return res.redirect(sso.buildRedirect(request.redirectUri, redirectParams));
    }

    const reason = session && !sameTenant ? '&switch=1' : '';
    res.redirect('/sso/login?' + params + reason);
  })
);

router.get('/sso/login', (req, res) => sendPage(res, 'sso-login.html'));
router.get('/sso/account', (req, res) => sendPage(res, 'sso-account.html'));
router.get('/sso/reset', (req, res) => sendPage(res, 'sso-reset.html'));

// Everything the sign-in page needs to render: who the application is, which
// organization it belongs to, the tenant's policies and any existing session.
router.get(
  '/sso/api/login-context',
  asyncHandler(async (req, res) => {
    const request = sso.normalizeAuthorize(req.query);
    const settings = tenants.settingsOf(request.tenant);
    const session = sso.currentSession(req);

    res.json({
      app: {
        name: request.app.name,
        clientId: request.app.clientId,
        description: request.app.description,
        scopes: request.scope,
      },
      tenant: tenants.present(request.tenant),
      allowSelfRegistration: settings.allowSelfRegistration,
      mfaRequired: settings.mfaRequired,
      passwordPolicy: settings.passwordPolicy,
      departments: DEPARTMENTS,
      social: social.availability(request.tenant),
      session:
        session && session.user.tenantId === request.tenant.id
          ? { user: session.user, tenant: session.tenant }
          : null,
    });
  })
);

/* ------------------------------------------------------------------ */
/* Sign-in, registration and the MFA steps                             */
/* ------------------------------------------------------------------ */

router.post(
  '/sso/api/login',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const request = sso.normalizeAuthorize(body);
    tenants.assertActive(request.tenant);

    const user = await users.authenticate(body.loginId, body.password, {
      tenantId: request.tenant.id,
      tenant: request.tenant,
    });

    audit.record({
      type: 'login.password',
      tenantId: request.tenant.id,
      tenantName: request.tenant.name,
      actorUserId: user.id,
      actorLoginId: user.loginId,
      actorName: user.name,
      clientId: request.app.clientId,
      req,
      detail: 'password accepted',
    });

    res.json(continueOrChallenge(req, res, {
      // The stored record, so the MFA steps have access to the factor.
      user: users.rawUser(user.id),
      tenant: request.tenant,
      app: request.app,
      request,
    }));
  })
);

router.post(
  '/sso/api/register',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const request = sso.normalizeAuthorize(body);
    tenants.assertActive(request.tenant);

    const settings = tenants.settingsOf(request.tenant);
    if (!settings.allowSelfRegistration) {
      throw new AppError(
        403,
        request.tenant.name + ' does not allow self-registration. Ask an administrator for an account.',
        'REGISTRATION_DISABLED'
      );
    }

    const user = await users.createUser({
      tenantId: request.tenant.id,
      loginId: body.loginId,
      name: body.name,
      role: 'student',
      department: body.department,
      email: body.email,
      password: body.password,
    });

    audit.record({
      type: 'user.registered',
      tenantId: request.tenant.id,
      tenantName: request.tenant.name,
      actorUserId: user.id,
      actorLoginId: user.loginId,
      actorName: user.name,
      clientId: request.app.clientId,
      req,
      detail: 'self-registration accepted',
    });

    res.status(201).json(continueOrChallenge(req, res, {
      user: users.rawUser(user.id),
      tenant: request.tenant,
      app: request.app,
      request,
    }));
  })
);

// Second factor: a TOTP code, or one of the single-use recovery codes.
router.post(
  '/sso/api/login/mfa',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const ticket = sso.verifyLoginTicket(body.ticket, 'login:mfa');
    const request = ticket.request ? sso.deserializeRequest(ticket.request) : null;
    tenants.assertActive(ticket.tenant);

    let amr = ['pwd', 'totp'];
    let ok = false;

    if (body.mode === 'recovery') {
      ok = await mfa.verifyRecoveryCode(ticket.user, body.recoveryCode || body.code);
      amr = ['pwd', 'recovery_code'];
    } else {
      ok = mfa.verifyCode(ticket.user, body.code);
    }

    if (!ok) {
      audit.record({
        type: body.mode === 'recovery' ? 'mfa.recovery.failed' : 'mfa.challenge.failed',
        outcome: 'failure',
        tenantId: ticket.tenant.id,
        tenantName: ticket.tenant.name,
        actorUserId: ticket.user.id,
        actorLoginId: ticket.user.loginId,
        clientId: request ? request.app.clientId : null,
        req,
        detail: 'second factor rejected',
      });
      throw new AppError(401, 'That code is not valid. Try the current code, or use a recovery code.', 'MFA_CODE_INVALID');
    }

    audit.record({
      type: body.mode === 'recovery' ? 'mfa.recovery.used' : 'mfa.challenge',
      tenantId: ticket.tenant.id,
      tenantName: ticket.tenant.name,
      actorUserId: ticket.user.id,
      actorLoginId: ticket.user.loginId,
      clientId: request ? request.app.clientId : null,
      req,
      detail: body.mode === 'recovery' ? 'recovery code consumed' : 'TOTP accepted',
    });

    res.json(finishLogin(req, res, {
      user: ticket.user,
      tenant: ticket.tenant,
      app: request ? request.app : null,
      request,
      amr,
    }));
  })
);

// Enrollment is required by the tenant's policy for users without a factor.
router.post(
  '/sso/api/login/enroll/start',
  asyncHandler(async (req, res) => {
    const ticket = sso.verifyLoginTicket((req.body || {}).ticket, 'login:enroll');
    res.json(mfa.startEnrollment(ticket.user, ticket.tenant));
  })
);

router.post(
  '/sso/api/login/enroll/confirm',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const ticket = sso.verifyLoginTicket(body.ticket, 'login:enroll');
    const result = await mfa.confirmEnrollment(ticket.user, body.code);
    const request = ticket.request ? sso.deserializeRequest(ticket.request) : null;

    audit.record({
      type: 'mfa.enrolled',
      tenantId: ticket.tenant.id,
      tenantName: ticket.tenant.name,
      actorUserId: ticket.user.id,
      actorLoginId: ticket.user.loginId,
      clientId: request ? request.app.clientId : null,
      req,
      detail: 'TOTP enrollment completed',
    });

    res.json(Object.assign(
      { recoveryCodes: result.recoveryCodes, mfa: result.status },
      finishLogin(req, res, {
        user: ticket.user,
        tenant: ticket.tenant,
        app: request ? request.app : null,
        request,
        amr: ['pwd', 'totp'],
      })
    ));
  })
);

/* ------------------------------------------------------------------ */
/* Session state for the pages                                         */
/* ------------------------------------------------------------------ */

router.get('/sso/api/session', (req, res) => {
  res.json({ session: sso.currentSession(req) });
});

router.post(
  '/sso/api/logout',
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const session = sso.currentSession(req);
    const had = sso.destroySession(req, res, 'logout');
    res.json({ status: 'ok', signedOut: had, was: session ? session.user.loginId : null });
  })
);

/* ------------------------------------------------------------------ */
/* Password recovery                                                   */
/* ------------------------------------------------------------------ */

// No mail provider is configured for this project, so the reset link is
// recorded for the administrators of the tenant and printed to the server
// console. The same link flow works with an e-mail provider later on.
router.post(
  '/sso/api/password/forgot',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const user = users.getUserByLoginId(body.loginId);
    const generic = {
      status: 'ok',
      message: 'If that account exists, a password reset has been requested for it.',
      delivery: 'administrator',
    };

    if (!user) {
      audit.record({
        type: 'password.reset.requested',
        outcome: 'failure',
        req,
        detail: 'unknown login ID ' + String(body.loginId || '').slice(0, 40),
      });
      return res.json(generic);
    }

    const token = randomToken(32);
    const createdAt = new Date().toISOString();
    const entry = {
      id: db.newId('rst'),
      tenantId: user.tenantId,
      userId: user.id,
      loginId: user.loginId,
      tokenHash: hashToken(token),
      createdAt,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000).toISOString(),
      usedAt: null,
      generatedBy: 'user',
      requestedIp: req.ip || null,
    };

    // Only the newest request can be used.
    db.collection('passwordResets')
      .filter((reset) => reset.userId === user.id && !reset.usedAt)
      .forEach((reset) => {
        reset.usedAt = createdAt;
        reset.superseded = true;
      });
    db.collection('passwordResets').push(entry);
    db.save();

    const link = SERVER.PUBLIC_BASE_URL + '/sso/reset?token=' + token;
    console.log('[password-reset] ' + user.loginId + ' requested a reset: ' + link);

    audit.record({
      type: 'password.reset.requested',
      tenantId: user.tenantId,
      actorUserId: user.id,
      actorLoginId: user.loginId,
      req,
      detail: 'link valid for ' + RESET_TTL_MINUTES + ' minutes; an administrator can re-generate it',
    });

    res.json(generic);
  })
);

router.post(
  '/sso/api/password/reset',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const entry = db
      .collection('passwordResets')
      .find((reset) => reset.tokenHash === hashToken(body.token || ''));

    if (!entry || entry.usedAt || new Date(entry.expiresAt).getTime() < Date.now()) {
      throw new AppError(400, 'This reset link is invalid or has expired. Request a new one.', 'INVALID_RESET_TOKEN');
    }

    const user = users.requireUser(entry.userId);
    const tenant = tenants.requireTenant(user.tenantId);

    await users.setPassword(user.id, body.password);
    entry.usedAt = new Date().toISOString();
    db.save();

    // Changing a password ends every existing session and token.
    const revoked = sso.revokeAllForUser(user.id, 'password_reset');

    audit.record({
      type: 'password.reset.completed',
      tenantId: tenant.id,
      tenantName: tenant.name,
      actorUserId: user.id,
      actorLoginId: user.loginId,
      req,
      detail: revoked.sessions + ' session(s) and ' + revoked.refreshTokens + ' refresh token(s) revoked',
    });

    res.json({ status: 'ok', loginId: user.loginId, sessionsRevoked: revoked.sessions });
  })
);

/* ------------------------------------------------------------------ */
/* Account self-service (requires the SSO session cookie)              */
/* ------------------------------------------------------------------ */

router.get(
  '/sso/api/account',
  requireSession,
  asyncHandler(async (req, res) => {
    const raw = db.collection('users').find((u) => u.id === req.user.id);
    res.json({
      user: req.user,
      tenant: tenants.present(req.tenant),
      sessionId: req.ssoSession.sessionId,
      mfa: mfa.statusOf(raw),
      sessions: sso.listSessions(req.user.id),
      social: social.availability(req.tenant),
      passwordPolicy: tenants.settingsOf(req.tenant).passwordPolicy,
      roles: [req.user.role],
    });
  })
);

router.post(
  '/sso/api/account/password',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const body = req.body || {};
    const updated = await users.changePassword(req.user.id, body.currentPassword, body.newPassword);
    const revoked = sso.revokeAllForUser(req.user.id, 'password_changed');

    audit.record({
      type: 'password.changed',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: revoked.sessions + ' other session(s) revoked',
    });

    // The session that made the change is replaced with a fresh one.
    sso.destroySession(req, res, 'password_changed');
    res.json({ status: 'ok', user: updated, signInAgain: true });
  })
);

router.post(
  '/sso/api/account/mfa/start',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const raw = db.collection('users').find((u) => u.id === req.user.id);
    res.json(mfa.startEnrollment(raw, req.tenant));
  })
);

router.post(
  '/sso/api/account/mfa/confirm',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const raw = db.collection('users').find((u) => u.id === req.user.id);
    const result = await mfa.confirmEnrollment(raw, (req.body || {}).code);
    audit.record({
      type: 'mfa.enrolled',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: 'enrolled from the account page',
    });
    res.json({ status: 'ok', recoveryCodes: result.recoveryCodes, mfa: result.status });
  })
);

router.post(
  '/sso/api/account/mfa/recovery-codes',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const raw = db.collection('users').find((u) => u.id === req.user.id);
    const result = await mfa.regenerateRecoveryCodes(raw);
    audit.record({
      type: 'mfa.recovery_codes.regenerated',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
    });
    res.json({ status: 'ok', recoveryCodes: result.recoveryCodes, mfa: result.status });
  })
);

router.post(
  '/sso/api/account/mfa/disable',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const raw = db.collection('users').find((u) => u.id === req.user.id);
    const settings = tenants.settingsOf(req.tenant);

    if (settings.mfaRequired) {
      throw new AppError(
        403,
        req.tenant.name + ' requires two-factor authentication, so it cannot be turned off for your account.',
        'MFA_REQUIRED_BY_TENANT'
      );
    }

    const password = (req.body || {}).password;
    const ok = await passwords.verifyPassword(password, raw.passwordHash);
    if (!ok) throw new AppError(401, 'Enter your password to turn off two-factor authentication.', 'INVALID_CREDENTIALS');

    const status = mfa.disable(raw);
    audit.record({
      type: 'mfa.disabled',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
    });
    res.json({ status: 'ok', mfa: status });
  })
);

router.post(
  '/sso/api/account/sessions/:id/revoke',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const sessions = sso.revokeSessionById(req.user.id, req.params.id, 'revoked_by_user');
    audit.record({
      type: 'session.revoked',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: 'revoked by the user: ' + req.params.id,
    });
    res.json({ status: 'ok', sessions });
  })
);

router.post(
  '/sso/api/account/social/:provider/unlink',
  requireSession,
  asyncHandler(async (req, res) => {
    assertSameOrigin(req);
    const provider = req.params.provider;
    const updated = users.unlinkSocial(req.user.id, provider);
    audit.record({
      type: 'social.unlinked',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: provider,
    });
    res.json({ status: 'ok', user: updated });
  })
);

/* ------------------------------------------------------------------ */
/* Social sign-in                                                      */
/* ------------------------------------------------------------------ */

router.get(
  '/sso/social/:provider/start',
  asyncHandler(async (req, res) => {
    const provider = req.params.provider;
    const mode = req.query.mode === 'link' ? 'link' : 'login';

    const session = sso.currentSession(req);
    let tenant;
    let request = null;

    if (mode === 'link') {
      if (!session) throw new AppError(401, 'Sign in first.', 'NO_SESSION');
      tenant = tenants.requireTenant(session.user.tenantId);
    } else {
      request = sso.normalizeAuthorize(req.query);
      tenant = request.tenant;
    }

    social.assertUsable(provider, tenant);

    const state = randomToken(16);
    const ticket = social.signState({
      provider,
      tenant,
      user: session ? session.user : null,
      mode,
      request: request ? sso.serializeRequest(request) : null,
    });

    cookies.set(res, SOCIAL_STATE_COOKIE, ticket + '.' + state, {
      httpOnly: true,
      maxAge: SSO.TICKET_TTL_MINUTES * 60,
      sameSite: SERVER.IS_PREVIEW ? 'None' : 'Lax',
      secure: SERVER.IS_PREVIEW ? true : Boolean(req.secure),
    });

    const url = social.authorizeUrl(provider, state);
    audit.record({
      type: 'social.started',
      tenantId: tenant.id,
      tenantName: tenant.name,
      actorUserId: session ? session.user.id : null,
      actorLoginId: session ? session.user.loginId : null,
      clientId: request ? request.app.clientId : null,
      req,
      detail: provider + ' (' + mode + ')',
    });

    res.redirect(url);
  })
);

router.get(
  '/sso/social/:provider/callback',
  asyncHandler(async (req, res) => {
    const provider = req.params.provider;
    const jar = cookies.parse(req);
    const rawCookie = jar[SOCIAL_STATE_COOKIE];
    cookies.clear(res, SOCIAL_STATE_COOKIE, { sameSite: 'Lax' });

    if (!rawCookie) throw new AppError(400, 'The sign-in attempt expired. Please try again.', 'INVALID_TICKET');

    const [ticket, state] = rawCookie.split('.');
    const stored = social.verifyState(ticket, provider);

    if (req.query.error) {
      audit.record({
        type: 'social.failed',
        outcome: 'failure',
        tenantId: stored.tid,
        req,
        detail: provider + ': ' + String(req.query.error_description || req.query.error).slice(0, 120),
      });
      return res.redirect('/index.html?social_error=' + encodeURIComponent(String(req.query.error)));
    }

    if (!req.query.code || req.query.state !== state) {
      throw new AppError(400, 'The provider callback could not be validated (state mismatch).', 'INVALID_STATE');
    }

    const tenant = tenants.requireTenant(stored.tid);
    social.assertUsable(provider, tenant);

    const tokens = await social.exchangeCode(provider, req.query.code);
    const profile = await social.fetchProfile(provider, tokens);

    if (stored.request && stored.request.mode === 'link') {
      const session = sso.currentSession(req);
      if (!session) throw new AppError(401, 'Your session ended before the provider answered. Sign in again.', 'NO_SESSION');
      users.linkSocial(session.user.id, provider, profile.providerUserId, profile.email);
      audit.record({
        type: 'social.linked',
        tenantId: tenant.id,
        tenantName: tenant.name,
        actorUserId: session.user.id,
        actorLoginId: session.user.loginId,
        req,
        detail: provider,
      });
      return res.redirect('/sso/account?linked=' + provider);
    }

    const resolution = await social.resolveUser(provider, profile, tenant);

    audit.record({
      type: 'social.login',
      tenantId: tenant.id,
      tenantName: tenant.name,
      actorUserId: resolution.user.id,
      actorLoginId: resolution.user.loginId,
      req,
      detail: provider + ' (' + resolution.linked + ')',
    });

    const request = stored.request ? sso.deserializeRequest(stored.request) : null;
    const result = finishLogin(req, res, {
      user: resolution.user,
      tenant,
      app: request ? request.app : null,
      request,
      amr: ['social:' + provider],
    });

    res.redirect(result.redirectTo || '/sso/account');
  })
);

/* ------------------------------------------------------------------ */
/* Token endpoint, userinfo, revocation, single sign-out               */
/* ------------------------------------------------------------------ */

router.post(
  '/sso/token',
  asyncHandler(async (req, res) => {
    try {
      const credentials = clientCredentials(req);
      const body = req.body || {};

      if (!credentials.clientId) {
        throw new AppError(400, 'client_id is required.', 'INVALID_CLIENT');
      }
      const app = clientApps.requireUsableApp(credentials.clientId);
      const tenant = tenants.requireTenant(app.tenantId);
      tenants.assertActive(tenant);
      assertClient(app, credentials);
      clientApps.markUsed(app);

      if (body.grant_type === 'authorization_code') {
        const grant = sso.redeemAuthCode({
          code: body.code,
          clientId: credentials.clientId,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
          req,
        });

        const tokens = sso.issueTokens({
          app: grant.app,
          tenant: grant.tenant,
          user: grant.user,
          scope: grant.scope,
          sessionId: grant.sessionId,
          nonce: grant.nonce,
          authTime: grant.authTime,
          amr: grant.amr,
          req,
        });

        audit.record({
          type: 'token.issued',
          tenantId: grant.tenant.id,
          tenantName: grant.tenant.name,
          actorUserId: grant.user.id,
          actorLoginId: grant.user.loginId,
          clientId: app.clientId,
          req,
          detail: 'authorization code exchanged',
        });

        return res.json(tokens);
      }

      if (body.grant_type === 'refresh_token') {
        const rotated = sso.rotateRefreshToken({
          token: body.refresh_token,
          clientId: credentials.clientId,
          req,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        const tokens = sso.issueTokens({
          app: rotated.app,
          tenant: rotated.tenant,
          user: rotated.user,
          scope: rotated.scope,
          sessionId: rotated.sessionId,
          existingRefreshToken: rotated.refreshToken,
          amr: ['refresh_token'],
          req,
        });

        audit.record({
          type: 'token.refreshed',
          tenantId: rotated.tenant.id,
          tenantName: rotated.tenant.name,
          actorUserId: rotated.user.id,
          actorLoginId: rotated.user.loginId,
          clientId: credentials.clientId,
          req,
          detail: 'refresh token rotated',
        });

        return res.json(tokens);
      }

      throw new AppError(400, 'Unsupported grant_type: ' + String(body.grant_type), 'UNSUPPORTED_GRANT');
    } catch (err) {
      return oauthErrorResponse(err, res);
    }
  })
);

router.post(
  '/sso/revoke',
  asyncHandler(async (req, res) => {
    const credentials = clientCredentials(req);
    if (credentials.clientId) {
      const app = clientApps.requireUsableApp(credentials.clientId);
      // Public clients may revoke their own tokens without a secret.
      assertClient(app, credentials);
      sso.revokeRefreshToken({
        token: (req.body || {}).token,
        clientId: app.clientId,
        reason: 'revoked_by_client',
        req,
      });
    }
    // RFC 7009: the response is always 200, even for unknown tokens.
    res.json({ status: 'ok' });
  })
);

function userinfoHandler(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : (req.body || {}).access_token;
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({ error: 'invalid_token', error_description: 'An access token is required.' });
    }

    const claims = sso.verifyAccessToken(token);
    res.json(sso.userInfoFor(claims));
  } catch (err) {
    if (err instanceof AppError && err.status === 401) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({ error: 'invalid_token', error_description: err.message });
    }
    return next(err);
  }
}

router.get('/sso/userinfo', userinfoHandler);
router.post('/sso/userinfo', userinfoHandler);

router.get(
  '/sso/end-session',
  asyncHandler(async (req, res) => {
    const session = sso.currentSession(req);
    sso.destroySession(req, res, 'single_sign_out');

    const clientId = req.query.client_id;
    let target = null;

    if (clientId) {
      const app = clientApps.getByClientId(clientId);
      const requested = req.query.post_logout_redirect_uri;
      if (app && requested && app.postLogoutRedirectUris.includes(requested)) {
        target = requested;
      }
    }

    if (!target) return res.redirect('/index.html?signed_out=1');

    const url = new URL(target);
    if (req.query.state) url.searchParams.set('state', req.query.state);
    res.redirect(url.toString());
  })
);

module.exports = router;
