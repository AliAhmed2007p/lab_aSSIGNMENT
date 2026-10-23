'use strict';

/*
 * Administration API.
 *
 * A platform administrator (role admin) manages every tenant; a tenant
 * administrator (role tenant_admin) only ever sees and changes their own
 * organization. Every tenant-sensitive call goes through tenantScope() /
 * assertTenantAccess() so a tenant administrator can never reach another
 * tenant's users, applications, policies or audit log.
 */

const express = require('express');
const path = require('path');
const db = require('../store/db');
const { AppError } = db;
const tenants = require('../services/tenantService');
const users = require('../services/userService');
const clientApps = require('../services/clientAppService');
const audit = require('../services/auditService');
const mfa = require('../services/mfaService');
const social = require('../services/socialService');
const { authenticate, requireAdmin, isPlatformAdmin, tenantScope } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { randomToken, hashToken } = require('../security/tokens');
const {
  ALL_ROLES,
  DEPARTMENTS,
  TOKEN_LIMITS,
  PASSWORD_POLICY_LIMITS,
  SOCIAL_PROVIDERS,
  isSocialConfigured,
  socialRedirectUri,
  SERVER,
} = require('../config/policies');

const router = express.Router();
const RESET_TTL_MINUTES = 30;

router.use(authenticate, requireAdmin);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function assertTenantAccess(req, tenantId) {
  if (isPlatformAdmin(req.user)) return tenantId;
  if (!tenantId || tenantId !== req.user.tenantId) {
    throw new AppError(403, 'You can only manage your own organization.', 'TENANT_FORBIDDEN');
  }
  return tenantId;
}

function scopedTenants(req) {
  if (isPlatformAdmin(req.user)) return tenants.listTenants({ tenantId: req.query.tenantId });
  return tenants.listTenants({ tenantId: req.user.tenantId });
}

function presentUser(user) {
  const tenant = tenants.getTenant(user.tenantId);
  return Object.assign({}, user, { tenantName: tenant ? tenant.name : null });
}

/* ------------------------------------------------------------------ */
/* Overview and metadata                                               */
/* ------------------------------------------------------------------ */

router.get('/me', (req, res) => {
  res.json({
    user: presentUser(req.user),
    tenant: tenants.present(tenants.requireTenant(req.user.tenantId)),
    isPlatformAdmin: isPlatformAdmin(req.user),
  });
});

router.get('/meta', (req, res) => {
  res.json({
    roles: ALL_ROLES,
    departments: DEPARTMENTS,
    tokenLimits: TOKEN_LIMITS,
    passwordPolicyLimits: PASSWORD_POLICY_LIMITS,
    socialProviders: SOCIAL_PROVIDERS.map((provider) => ({
      provider,
      configured: isSocialConfigured(provider),
      redirectUri: socialRedirectUri(provider),
    })),
    publicBaseUrl: SERVER.PUBLIC_BASE_URL,
    scopes: require('../config/policies').SSO.SCOPES,
  });
});

// Dashboard cards: how much is going on, and how much of it is failing.
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const scope = tenantScope(req.user, req.query.tenantId);
    const tenantId = scope || undefined;

    const allUsers = users.listUsers({ tenantId, includeInactive: true });
    const apps = clientApps.listApps({ tenantId });
    const tenantList = tenants.listTenants({ tenantId });

    const activeSessions = db
      .collection('sessions')
      .filter((s) => !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now())
      .filter((s) => !tenantId || s.tenantId === tenantId).length;

    const refreshTokens = db
      .collection('refreshTokens')
      .filter((t) => !t.revokedAt && new Date(t.expiresAt).getTime() > Date.now())
      .filter((t) => !tenantId || t.tenantId === tenantId).length;

    const summary = audit.summary({ tenantId });

    res.json({
      tenants: tenantList.length,
      users: allUsers.length,
      activeUsers: allUsers.filter((u) => u.active).length,
      administrators: allUsers.filter((u) => ['admin', 'tenant_admin'].includes(u.role)).length,
      mfaEnrolled: allUsers.filter((u) => u.mfa && u.mfa.enabled).length,
      lockedAccounts: allUsers.filter((u) => u.lockedUntil && new Date(u.lockedUntil) > new Date()).length,
      applications: apps.length,
      activeSessions,
      refreshTokens,
      eventsLast24h: summary.total,
      failedLast24h: summary.failures,
      failedLogins: summary.failedLogins,
      failureTypes: summary.failureTypes,
    });
  })
);

/* ------------------------------------------------------------------ */
/* Tenants                                                             */
/* ------------------------------------------------------------------ */

router.get('/tenants', (req, res) => {
  res.json({ tenants: scopedTenants(req) });
});

router.post(
  '/tenants',
  asyncHandler(async (req, res) => {
    if (!isPlatformAdmin(req.user)) {
      throw new AppError(403, 'Only a platform administrator can create organizations.', 'ROLE_FORBIDDEN');
    }
    const tenant = tenants.createTenant(req.body || {});
    audit.record({
      type: 'tenant.created',
      tenantId: tenant.id,
      tenantName: tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
    });
    res.status(201).json({ tenant });
  })
);

router.patch(
  '/tenants/:id',
  asyncHandler(async (req, res) => {
    const id = assertTenantAccess(req, req.params.id);
    const tenant = tenants.updateTenant(id, req.body || {});
    audit.record({
      type: 'tenant.updated',
      tenantId: tenant.id,
      tenantName: tenant.name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: Object.keys(req.body || {}).join(', '),
    });
    res.json({ tenant });
  })
);

/* ------------------------------------------------------------------ */
/* Client applications                                                 */
/* ------------------------------------------------------------------ */

function appTenantId(req, requested) {
  if (isPlatformAdmin(req.user)) return requested || req.user.tenantId;
  return assertTenantAccess(req, req.user.tenantId);
}

router.get(
  '/apps',
  asyncHandler(async (req, res) => {
    const tenantId = isPlatformAdmin(req.user) ? req.query.tenantId : req.user.tenantId;
    const apps = clientApps.listApps({ tenantId }).map((app) => {
      const tenant = tenants.getTenant(app.tenantId);
      return Object.assign({}, app, { tenantName: tenant ? tenant.name : null });
    });
    res.json({ apps });
  })
);

router.post(
  '/apps',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const tenantId = appTenantId(req, body.tenantId);
    const created = clientApps.createApp(Object.assign({}, body, { tenantId }));

    audit.record({
      type: 'app.created',
      tenantId,
      tenantName: tenants.getTenant(tenantId).name,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: created.app.name + ' (' + created.app.clientId + ')',
    });

    res.status(201).json(created);
  })
);

router.patch(
  '/apps/:id',
  asyncHandler(async (req, res) => {
    const app = clientApps.requireApp(req.params.id);
    assertTenantAccess(req, app.tenantId);
    const updated = clientApps.updateApp(app.id, req.body || {});

    audit.record({
      type: 'app.updated',
      tenantId: app.tenantId,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: updated.name + ': ' + Object.keys(req.body || {}).join(', '),
    });
    res.json({ app: updated });
  })
);

router.post(
  '/apps/:id/secret',
  asyncHandler(async (req, res) => {
    const app = clientApps.requireApp(req.params.id);
    assertTenantAccess(req, app.tenantId);
    const rotated = clientApps.rotateSecret(app.id);

    audit.record({
      type: 'app.secret_rotated',
      tenantId: app.tenantId,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: app.name,
    });
    res.json(rotated);
  })
);

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const tenantId = isPlatformAdmin(req.user) ? req.query.tenantId : req.user.tenantId;
    const list = users
      .listUsers({
        tenantId,
        role: req.query.role,
        department: req.query.department,
        search: req.query.search,
        includeInactive: req.query.includeInactive === 'true',
      })
      .map(presentUser);
    res.json({ users: list });
  })
);

router.post(
  '/users',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const tenantId = appTenantId(req, body.tenantId);

    if (!isPlatformAdmin(req.user) && ['admin'].includes(body.role)) {
      throw new AppError(403, 'Only a platform administrator can create platform administrators.', 'ROLE_FORBIDDEN');
    }

    const user = await users.createUser(Object.assign({}, body, { tenantId }));
    audit.record({
      type: 'user.created',
      tenantId,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: user.loginId + ' (' + user.role + ')',
    });
    res.status(201).json({ user: presentUser(user) });
  })
);

router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const target = users.getUserById(req.params.id);
    if (!target) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
    assertTenantAccess(req, target.tenantId);

    const body = req.body || {};
    if (!isPlatformAdmin(req.user) && body.role === 'admin') {
      throw new AppError(403, 'Only a platform administrator can grant that role.', 'ROLE_FORBIDDEN');
    }

    const user = await users.updateUser(target.id, body);
    audit.record({
      type: 'user.updated',
      tenantId: user.tenantId,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: user.loginId + ': ' + Object.keys(body).join(', '),
    });

    const io = req.app.get('io');
    if (io && user.active === false) io.in('user:' + user.id).disconnectSockets(true);

    res.json({ user: presentUser(user) });
  })
);

// Administrators can hand out a fresh reset link when the user cannot receive
// e-mail. Any earlier link stops working.
router.post(
  '/users/:id/reset-link',
  asyncHandler(async (req, res) => {
    const target = users.getUserById(req.params.id);
    if (!target) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
    assertTenantAccess(req, target.tenantId);

    const token = randomToken(32);
    const createdAt = new Date().toISOString();
    const request = {
      id: db.newId('rst'),
      tenantId: target.tenantId,
      userId: target.id,
      loginId: target.loginId,
      tokenHash: hashToken(token),
      createdAt,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000).toISOString(),
      usedAt: null,
      generatedBy: 'admin:' + req.user.loginId,
      requestedIp: null,
    };

    db.collection('passwordResets')
      .filter((reset) => reset.userId === target.id && !reset.usedAt)
      .forEach((reset) => {
        reset.usedAt = createdAt;
        reset.superseded = true;
      });
    db.collection('passwordResets').push(request);
    db.save();

    audit.record({
      type: 'password.reset.link_created',
      tenantId: target.tenantId,
      actorUserId: req.user.id,
      actorLoginId: req.user.loginId,
      req,
      detail: 'for ' + target.loginId,
    });

    res.json({
      status: 'ok',
      loginId: target.loginId,
      expiresAt: request.expiresAt,
      link: SERVER.PUBLIC_BASE_URL + '/sso/reset?token=' + token,
    });
  })
);

router.get(
  '/password-resets',
  asyncHandler(async (req, res) => {
    const tenantId = isPlatformAdmin(req.user) ? req.query.tenantId : req.user.tenantId;
    const now = Date.now();

    const requests = db
      .collection('passwordResets')
      .filter((reset) => !tenantId || reset.tenantId === tenantId)
      .slice(-50)
      .reverse()
      .map((reset) => ({
        id: reset.id,
        loginId: reset.loginId,
        createdAt: reset.createdAt,
        expiresAt: reset.expiresAt,
        generatedBy: reset.generatedBy,
        pending: !reset.usedAt && new Date(reset.expiresAt).getTime() > now,
        used: Boolean(reset.usedAt) && !reset.superseded,
      }));

    res.json({ requests });
  })
);

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

router.get('/audit', (req, res) => {
  const tenantId = isPlatformAdmin(req.user) ? req.query.tenantId : req.user.tenantId;
  res.json({
    events: audit.list({
      tenantId,
      type: req.query.type,
      outcome: req.query.outcome,
      limit: req.query.limit,
    }),
    summary: audit.summary({ tenantId }),
  });
});

module.exports = router;
