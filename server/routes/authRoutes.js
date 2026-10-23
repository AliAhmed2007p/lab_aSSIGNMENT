'use strict';

/*
 * First-party authentication API.
 *
 * The browser flow goes through the SSO pages (/sso/login), but this API stays
 * available for scripts, the automated demo and any client that already has a
 * login ID and password. It issues the same RS256 access tokens, and it
 * respects the tenant's MFA policy exactly like the SSO flow does.
 */

const express = require('express');
const tenants = require('../services/tenantService');
const users = require('../services/userService');
const mfa = require('../services/mfaService');
const sso = require('../services/ssoService');
const audit = require('../services/auditService');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../store/db');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Brute-force protection: 5 failed logins per minute per IP + login ID */
/* ------------------------------------------------------------------ */

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60 * 1000;
const failures = new Map();

function failureKey(req, loginId) {
  return req.ip + '|' + String(loginId || '').trim().toLowerCase();
}

function assertNotLocked(key) {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() > entry.resetAt) {
    failures.delete(key);
    return;
  }
  if (entry.count >= MAX_FAILURES) {
    throw new AppError(
      429,
      'Too many failed login attempts. Please wait a minute and try again.',
      'TOO_MANY_ATTEMPTS'
    );
  }
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// POST /api/auth/login   { loginId, password }
// Answers with an access token, or with a ticket when a second factor is
// needed (the same tickets the SSO pages use).
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const key = failureKey(req, body.loginId);
    assertNotLocked(key);

    let user;
    try {
      user = await users.authenticate(body.loginId, body.password);
    } catch (err) {
      if (err.code === 'INVALID_CREDENTIALS') recordFailure(key);
      audit.record({
        type: 'login.password',
        outcome: 'failure',
        req,
        detail: err.code,
      });
      throw err;
    }

    failures.delete(key);
    const tenant = tenants.requireTenant(user.tenantId);

    const signIn = async (activeUser, amr) => {
      const { session } = sso.createSession({ user: activeUser, tenant, req, res, amr });
      const granted = sso.issueTokens({
        app: sso.FIRST_PARTY_APP,
        tenant,
        user: activeUser,
        scope: ['openid', 'profile', 'email', 'offline_access'],
        sessionId: session.id,
        amr,
        req,
      });

      audit.record({
        type: 'login.password',
        tenantId: tenant.id,
        tenantName: tenant.name,
        actorUserId: activeUser.id,
        actorLoginId: activeUser.loginId,
        actorName: activeUser.name,
        req,
        detail: 'password accepted (' + amr.join(',') + ')',
      });

      return {
        token: granted.access_token,
        expiresIn: granted.expires_in,
        refreshToken: granted.refresh_token,
        tokenType: 'Bearer',
        user: activeUser,
      };
    };

    // The stored record is what the second-factor steps operate on.
    const record = users.rawUser(user.id);

    if (mfa.isEnabled(record)) {
      return res.status(401).json({
        error: {
          code: 'MFA_REQUIRED',
          message: 'Two-factor authentication is enabled for this account. Send the code to /sso/api/login/mfa.',
          ticket: sso.signLoginTicket({ purpose: 'login:mfa', user, tenant, request: null }),
          methods: ['totp', 'recovery_codes'],
        },
      });
    }

    if (mfa.isEnrollmentRequired(tenant, record)) {
      return res.status(401).json({
        error: {
          code: 'MFA_ENROLL_REQUIRED',
          message: tenant.name + ' requires two-factor authentication. Enroll through /sso/login first.',
          ticket: sso.signLoginTicket({ purpose: 'login:enroll', user, tenant, request: null }),
        },
      });
    }

    res.json(await signIn(user, ['pwd']));
  })
);

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({
    user: req.user,
    tenant: tenants.present(req.tenant),
    tokenAudience: req.token.aud,
    scope: req.token.scope,
  });
});

// POST /api/auth/logout   ends the session this token belongs to
router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const sessionId = req.token.sid;
    const raw = require('../store/db').collection('sessions').find((s) => s.id === sessionId);

    if (raw && !raw.revokedAt) {
      sso.revokeSessionById(req.user.id, sessionId, 'logout');
    } else {
      sso.revokeAllForUser(req.user.id, 'logout');
    }

    sso.destroySession(req, res, 'logout');
    audit.record({
      type: 'session.revoked',
      tenantId: req.tenant.id,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: 'logout',
    });

    res.json({ status: 'ok' });
  })
);

// GET /api/auth/sessions   the sessions of the signed-in account
router.get('/sessions', authenticate, (req, res) => {
  res.json({ sessions: sso.listSessions(req.user.id) });
});

// POST /api/auth/password   { currentPassword, newPassword }
router.post(
  '/password',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    await users.changePassword(req.user.id, body.currentPassword, body.newPassword);
    const revoked = sso.revokeAllForUser(req.user.id, 'password_changed');

    audit.record({
      type: 'password.changed',
      tenantId: req.tenant.id,
      tenantName: req.tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: revoked.sessions + ' session(s) revoked',
    });

    res.json({ status: 'ok', signInAgain: true, sessionsRevoked: revoked.sessions });
  })
);

module.exports = router;
