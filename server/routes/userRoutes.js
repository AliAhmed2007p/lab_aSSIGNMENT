'use strict';

/*
 * People directory for the chat application.
 *
 * Everybody can look people up (it is needed to add group members and to start
 * a direct message), but only inside the caller's own organization. A platform
 * administrator may pass ?tenantId= to look into a specific tenant.
 */

const express = require('express');
const users = require('../services/userService');
const { authenticate, requireRole, isPlatformAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../store/db');

const router = express.Router();

router.use(authenticate);

function visibleTenantId(req) {
  if (isPlatformAdmin(req.user)) return req.query.tenantId || null;
  return req.user.tenantId;
}

// GET /api/users?role=&department=&search=&includeInactive=true
router.get('/', (req, res) => {
  const canSeeInactive = ['admin', 'tenant_admin'].includes(req.user.role);

  res.json({
    users: users.listUsers({
      tenantId: visibleTenantId(req),
      role: req.query.role,
      department: req.query.department,
      search: req.query.search,
      includeInactive: canSeeInactive && req.query.includeInactive === 'true',
    }),
  });
});

// GET /api/users/me/conversations   (must be declared before "/:id")
router.get('/me/conversations', (req, res) => {
  res.json({ conversations: users.listConversations(req.user.id) });
});

// GET /api/users/:id
router.get('/:id', (req, res) => {
  const user = users.requireUser(req.params.id);
  if (user.tenantId !== req.user.tenantId && !isPlatformAdmin(req.user)) {
    throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
  }
  res.json({ user });
});

// GET /api/users/:id/messages?limit=&before=
// Your own direct-message history with that user. Nobody can read
// other people's conversations because the caller is always one side.
router.get('/:id/messages', (req, res) => {
  const messages = users.getDirectHistory(req.user.id, req.params.id, {
    limit: req.query.limit,
    before: req.query.before,
  });
  res.json({ messages });
});

// POST /api/users   (administrators)
router.post(
  '/',
  requireRole('admin', 'tenant_admin'),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const tenantId = isPlatformAdmin(req.user)
      ? body.tenantId || req.user.tenantId
      : req.user.tenantId;

    if (!isPlatformAdmin(req.user) && body.role === 'admin') {
      throw new AppError(403, 'Only a platform administrator can create platform administrators.', 'ROLE_FORBIDDEN');
    }

    const user = await users.createUser(Object.assign({}, body, { tenantId }));
    res.status(201).json({ user });
  })
);

// PATCH /api/users/:id   { name?, department?, active?, password?, role?, email? }
router.patch(
  '/:id',
  requireRole('admin', 'tenant_admin'),
  asyncHandler(async (req, res) => {
    const target = users.getUserById(req.params.id);
    if (!target) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
    if (target.tenantId !== req.user.tenantId && !isPlatformAdmin(req.user)) {
      throw new AppError(403, 'You can only manage users of your own organization.', 'TENANT_FORBIDDEN');
    }

    const body = req.body || {};
    if (!isPlatformAdmin(req.user) && body.role === 'admin') {
      throw new AppError(403, 'Only a platform administrator can grant that role.', 'ROLE_FORBIDDEN');
    }

    const user = await users.updateUser(req.params.id, body);

    // A deactivated user is kicked off immediately
    const io = req.app.get('io');
    if (io && user.active === false) {
      io.in('user:' + user.id).disconnectSockets(true);
    }

    res.json({ user });
  })
);

module.exports = router;
