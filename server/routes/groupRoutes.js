'use strict';

const express = require('express');
const groups = require('../services/groupService');
const { authenticate, requireRole, isPlatformAdmin } = require('../middleware/auth');
const { EVENTS } = require('../config/policies');

const router = express.Router();

router.use(authenticate);

/* ------------------------------------------------------------------ */
/* Real-time helper                                                    */
/* If Socket.IO is attached (Phase 3) these push live updates and keep */
/* socket rooms in sync with membership. Otherwise they do nothing.    */
/* ------------------------------------------------------------------ */

const userRoom = (userId) => 'user:' + userId;
const groupRoom = (groupId) => 'group:' + groupId;

function realtime(req) {
  const io = req.app.get('io');

  return {
    joinUsers(userIds, groupId) {
      if (!io) return;
      userIds.forEach((id) => io.in(userRoom(id)).socketsJoin(groupRoom(groupId)));
    },
    leaveUsers(userIds, groupId) {
      if (!io) return;
      userIds.forEach((id) => io.in(userRoom(id)).socketsLeave(groupRoom(groupId)));
    },
    toUser(userId, event, payload) {
      if (!io) return;
      io.to(userRoom(userId)).emit(event, payload);
    },
    toGroup(groupId, event, payload) {
      if (!io) return;
      io.to(groupRoom(groupId)).emit(event, payload);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

// GET /api/groups   groups the current user belongs to
router.get('/', (req, res) => {
  res.json({ groups: groups.listGroupsForUser(req.user.id) });
});

// GET /api/groups/all   every group an administrator may see.
// Tenant administrators see their own organization only; a platform
// administrator sees everything, or one tenant with ?tenantId=.
router.get('/all', requireRole('admin', 'tenant_admin'), (req, res) => {
  const tenantId = isPlatformAdmin(req.user) ? req.query.tenantId || null : req.user.tenantId;
  res.json({ groups: groups.listAllGroups(tenantId) });
});

/* ------------------------------------------------------------------ */
/* Group CRUD                                                          */
/* ------------------------------------------------------------------ */

// POST /api/groups   { name, type, postPolicy?, description?, memberIds? }
router.post('/', (req, res) => {
  const rt = realtime(req);
  const group = groups.createGroup(req.user, req.body || {});
  const memberIds = groups.getMemberIds(group.id);

  rt.joinUsers(memberIds, group.id);
  memberIds.forEach((id) => rt.toUser(id, EVENTS.GROUP_ADDED, { group }));

  res.status(201).json({ group });
});

// GET /api/groups/:id   details and member list
router.get('/:id', (req, res) => {
  res.json({ group: groups.getGroupDetails(req.user, req.params.id) });
});

// PATCH /api/groups/:id   { name?, description?, postPolicy? }
router.patch('/:id', (req, res) => {
  const rt = realtime(req);
  const group = groups.updateGroup(req.user, req.params.id, req.body || {});

  rt.toGroup(group.id, EVENTS.GROUP_UPDATED, { group });
  res.json({ group });
});

// DELETE /api/groups/:id
router.delete('/:id', (req, res) => {
  const rt = realtime(req);
  const { group, memberIds } = groups.deleteGroup(req.user, req.params.id);

  memberIds.forEach((id) => rt.toUser(id, EVENTS.GROUP_REMOVED, { groupId: group.id }));
  rt.leaveUsers(memberIds, group.id);

  res.json({ deleted: true, groupId: group.id });
});

/* ------------------------------------------------------------------ */
/* Membership                                                          */
/* ------------------------------------------------------------------ */

// POST /api/groups/:id/members   { userId }
router.post('/:id/members', (req, res) => {
  const rt = realtime(req);
  const body = req.body || {};
  const result = groups.addMember(req.user, req.params.id, body.userId);

  rt.joinUsers([result.user.id], result.group.id);
  rt.toUser(result.user.id, EVENTS.GROUP_ADDED, { group: result.group });
  rt.toGroup(result.group.id, EVENTS.GROUP_UPDATED, { group: result.group });

  res.status(201).json({ group: result.group, user: result.user });
});

// DELETE /api/groups/:id/members/:userId   (also used by a member to leave)
router.delete('/:id/members/:userId', (req, res) => {
  const rt = realtime(req);
  const result = groups.removeMember(req.user, req.params.id, req.params.userId);

  rt.toUser(result.userId, EVENTS.GROUP_REMOVED, { groupId: result.group.id });
  rt.leaveUsers([result.userId], result.group.id);
  rt.toGroup(result.group.id, EVENTS.GROUP_UPDATED, { group: result.group });

  res.json({ removed: true, groupId: result.group.id, userId: result.userId });
});

// PATCH /api/groups/:id/members/:userId   { muted: true|false }
router.patch('/:id/members/:userId', (req, res) => {
  const rt = realtime(req);
  const body = req.body || {};
  const result = groups.setMuted(req.user, req.params.id, req.params.userId, body.muted);

  rt.toUser(result.userId, EVENTS.GROUP_UPDATED, {
    groupId: result.group.id,
    muted: result.muted,
  });

  res.json({ groupId: result.group.id, userId: result.userId, muted: result.muted });
});

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

// GET /api/groups/:id/messages?limit=&before=   (members only)
router.get('/:id/messages', (req, res) => {
  const messages = groups.getGroupHistory(req.user, req.params.id, {
    limit: req.query.limit,
    before: req.query.before,
  });
  res.json({ messages });
});

module.exports = router;