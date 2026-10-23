'use strict';

const db = require('../store/db');
const { AppError } = db;
const perm = require('./permissionService');
const users = require('./userService');
const { POST_POLICIES, LIMITS } = require('../config/policies');

const { GROUP_ROLES } = perm;
const MAX_DESCRIPTION_LENGTH = 300;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function requireGroup(groupId) {
  const group = db.collection('groups').find((g) => g.id === groupId);
  if (!group) {
    throw new AppError(404, 'Group not found.', 'GROUP_NOT_FOUND');
  }
  return group;
}

function memberCount(groupId) {
  return db.collection('memberships').filter((m) => m.groupId === groupId).length;
}

function presentGroup(group) {
  return Object.assign({}, group, { memberCount: memberCount(group.id) });
}

function cleanGroupName(name) {
  if (typeof name !== 'string') {
    throw new AppError(400, 'Group name is required.', 'BAD_GROUP_NAME');
  }
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > LIMITS.MAX_GROUP_NAME_LENGTH) {
    throw new AppError(
      400,
      'Group name must be between 2 and ' + LIMITS.MAX_GROUP_NAME_LENGTH + ' characters.',
      'BAD_GROUP_NAME'
    );
  }
  return clean;
}

function cleanDescription(description) {
  if (description === undefined || description === null) return '';
  if (typeof description !== 'string') {
    throw new AppError(400, 'Description must be text.', 'BAD_DESCRIPTION');
  }
  const clean = description.trim();
  if (clean.length > MAX_DESCRIPTION_LENGTH) {
    throw new AppError(
      400,
      'Description can be at most ' + MAX_DESCRIPTION_LENGTH + ' characters.',
      'BAD_DESCRIPTION'
    );
  }
  return clean;
}

// Group names are unique inside a tenant, not across the whole platform:
// two organizations may both have a "BCS-7A" class group.
function assertNameFree(name, ignoreGroupId, tenantId) {
  const lower = name.toLowerCase();
  const taken = db
    .collection('groups')
    .some(
      (g) =>
        g.id !== ignoreGroupId &&
        g.tenantId === tenantId &&
        g.name.toLowerCase() === lower
    );
  if (taken) {
    throw new AppError(409, 'A group with this name already exists.', 'GROUP_EXISTS');
  }
}

function addMembership(groupId, userId, groupRole) {
  const membership = {
    groupId,
    userId,
    groupRole,
    muted: false,
    joinedAt: new Date().toISOString(),
  };
  db.collection('memberships').push(membership);
  return membership;
}

/* ------------------------------------------------------------------ */
/* Group CRUD                                                          */
/* ------------------------------------------------------------------ */

function createGroup(actor, input) {
  const data = input || {};
  const name = cleanGroupName(data.name);
  const description = cleanDescription(data.description);
  const postPolicy = data.postPolicy || POST_POLICIES.EVERYONE;

  perm.assertAllowed(perm.checkCreateGroup(actor, data.type, postPolicy));
  assertNameFree(name, null, actor.tenantId);

  // Validate every initial member before changing anything
  const rawIds = Array.isArray(data.memberIds) ? data.memberIds : [];
  const memberIds = Array.from(new Set(rawIds)).filter((id) => id !== actor.id);

  if (memberIds.length + 1 > LIMITS.MAX_GROUP_MEMBERS) {
    throw new AppError(
      400,
      'A group can have at most ' + LIMITS.MAX_GROUP_MEMBERS + ' members.',
      'GROUP_FULL'
    );
  }
  memberIds.forEach((id) => {
    const member = users.requireUser(id);
    if (!member.active) {
      throw new AppError(400, member.name + ' has a deactivated account.', 'USER_INACTIVE');
    }
    if (member.tenantId !== actor.tenantId) {
      throw new AppError(403, member.name + ' belongs to another organization.', 'CROSS_TENANT');
    }
  });

  const now = new Date().toISOString();
  const group = {
    id: db.newId('grp'),
    tenantId: actor.tenantId,
    name,
    type: data.type,
    postPolicy,
    description,
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  };

  db.collection('groups').push(group);
  addMembership(group.id, actor.id, GROUP_ROLES.OWNER);
  memberIds.forEach((id) => addMembership(group.id, id, GROUP_ROLES.MEMBER));
  db.save();

  return presentGroup(group);
}

function updateGroup(actor, groupId, changes) {
  const group = requireGroup(groupId);
  perm.assertAllowed(perm.checkManageGroup(actor, group));
  const c = changes || {};

  // Validate everything first so a failure changes nothing
  let newName = group.name;
  if (c.name !== undefined) {
    newName = cleanGroupName(c.name);
    assertNameFree(newName, group.id, group.tenantId);
  }
  const newDescription =
    c.description !== undefined ? cleanDescription(c.description) : group.description;
  if (c.postPolicy !== undefined) {
    perm.assertAllowed(perm.checkSetPolicy(actor, c.postPolicy));
  }

  group.name = newName;
  group.description = newDescription;
  if (c.postPolicy !== undefined) group.postPolicy = c.postPolicy;
  group.updatedAt = new Date().toISOString();
  db.save();

  return presentGroup(group);
}

// Returns the removed group and who was in it, so the caller can notify them
function deleteGroup(actor, groupId) {
  const group = requireGroup(groupId);
  perm.assertAllowed(perm.checkManageGroup(actor, group));

  const memberIds = getMemberIds(groupId);

  const store = {
    groups: db.collection('groups'),
    memberships: db.collection('memberships'),
    messages: db.collection('messages'),
  };

  // Arrays are shared references, so edit them in place
  const keep = (list, predicate) => {
    const kept = list.filter(predicate);
    list.length = 0;
    kept.forEach((item) => list.push(item));
  };

  keep(store.groups, (g) => g.id !== groupId);
  keep(store.memberships, (m) => m.groupId !== groupId);
  keep(store.messages, (m) => m.groupId !== groupId);
  db.save();

  return { group, memberIds };
}

/* ------------------------------------------------------------------ */
/* Listing and details                                                 */
/* ------------------------------------------------------------------ */

function listAllGroups(tenantId) {
  return db
    .collection('groups')
    .filter((group) => !tenantId || group.tenantId === tenantId)
    .map(presentGroup)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listGroupsForUser(userId) {
  const myMemberships = db
    .collection('memberships')
    .filter((m) => m.userId === userId);

  return myMemberships
    .map((m) => {
      const group = db.collection('groups').find((g) => g.id === m.groupId);
      if (!group) return null;
      return Object.assign(presentGroup(group), {
        myGroupRole: m.groupRole,
        muted: m.muted,
      });
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getMemberIds(groupId) {
  return db
    .collection('memberships')
    .filter((m) => m.groupId === groupId)
    .map((m) => m.userId);
}

function listMembers(groupId) {
  requireGroup(groupId);
  return db
    .collection('memberships')
    .filter((m) => m.groupId === groupId)
    .map((m) => {
      const user = users.getUserById(m.userId);
      return {
        userId: m.userId,
        loginId: user ? user.loginId : null,
        name: user ? user.name : 'Unknown user',
        role: user ? user.role : null,
        department: user ? user.department : null,
        groupRole: m.groupRole,
        muted: m.muted,
        joinedAt: m.joinedAt,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Admins may inspect any group's roster for management.
// Everyone else must be a member.
function getGroupDetails(actor, groupId) {
  const group = requireGroup(groupId);
  if (actor.role !== 'admin') {
    perm.assertAllowed(perm.checkReadGroup(actor, group));
  }
  return Object.assign(presentGroup(group), { members: listMembers(groupId) });
}

/* ------------------------------------------------------------------ */
/* Membership management                                               */
/* ------------------------------------------------------------------ */

function addMember(actor, groupId, userId) {
  const group = requireGroup(groupId);
  perm.assertAllowed(perm.checkManageGroup(actor, group));

  const user = users.requireUser(userId);
  if (!user.active) {
    throw new AppError(400, user.name + ' has a deactivated account.', 'USER_INACTIVE');
  }
  // Tenant isolation: membership never crosses an organization boundary.
  if (user.tenantId !== group.tenantId) {
    throw new AppError(403, user.name + ' belongs to another organization.', 'CROSS_TENANT');
  }
  if (perm.isMember(groupId, userId)) {
    throw new AppError(409, user.name + ' is already a member.', 'ALREADY_MEMBER');
  }
  if (memberCount(groupId) >= LIMITS.MAX_GROUP_MEMBERS) {
    throw new AppError(
      400,
      'A group can have at most ' + LIMITS.MAX_GROUP_MEMBERS + ' members.',
      'GROUP_FULL'
    );
  }

  const membership = addMembership(groupId, userId, GROUP_ROLES.MEMBER);
  db.save();
  return { group: presentGroup(group), membership, user };
}

function removeMember(actor, groupId, userId) {
  const group = requireGroup(groupId);
  const membership = perm.getMembership(groupId, userId);
  if (!membership) {
    throw new AppError(404, 'That user is not a member of this group.', 'NOT_MEMBER');
  }
  if (membership.groupRole === GROUP_ROLES.OWNER) {
    throw new AppError(
      400,
      'The group owner cannot be removed. Delete the group instead.',
      'OWNER_PROTECTED'
    );
  }

  // Members may always leave on their own. Removing others needs management rights.
  if (actor.id !== userId) {
    perm.assertAllowed(perm.checkManageGroup(actor, group));
  }

  const memberships = db.collection('memberships');
  const index = memberships.indexOf(membership);
  memberships.splice(index, 1);
  db.save();

  return { group: presentGroup(group), userId };
}

function setMuted(actor, groupId, userId, muted) {
  const group = requireGroup(groupId);
  perm.assertAllowed(perm.checkManageGroup(actor, group));

  if (typeof muted !== 'boolean') {
    throw new AppError(400, '"muted" must be true or false.', 'BAD_MUTED');
  }

  const membership = perm.getMembership(groupId, userId);
  if (!membership) {
    throw new AppError(404, 'That user is not a member of this group.', 'NOT_MEMBER');
  }
  if (membership.groupRole === GROUP_ROLES.OWNER) {
    throw new AppError(400, 'The group owner cannot be muted.', 'OWNER_PROTECTED');
  }
  const target = users.requireUser(userId);
  if (target.role === 'admin') {
    throw new AppError(403, 'Admins cannot be muted.', 'ADMIN_PROTECTED');
  }

  membership.muted = muted;
  db.save();
  return { group: presentGroup(group), userId, muted };
}

/* ------------------------------------------------------------------ */
/* Group messages                                                      */
/* ------------------------------------------------------------------ */

// The single entry point for posting. Both REST and Socket.IO call this,
// so the boundary rules cannot be bypassed.
function postMessage(sender, groupId, text) {
  const group = requireGroup(groupId);
  perm.assertAllowed(perm.checkPostToGroup(sender, group));
  const clean = perm.validateMessageText(text);

  const message = {
    id: db.newId('msg'),
    groupId,
    senderId: sender.id,
    senderName: sender.name,
    senderRole: sender.role,
    text: clean,
    createdAt: new Date().toISOString(),
  };

  db.collection('messages').push(message);
  db.save();
  return message;
}

function getGroupHistory(user, groupId, options) {
  const group = requireGroup(groupId);
  perm.assertAllowed(perm.checkReadGroup(user, group));

  const groupMessages = db
    .collection('messages')
    .filter((m) => m.groupId === groupId);
  return db.latest(groupMessages, options);
}

module.exports = {
  createGroup,
  updateGroup,
  deleteGroup,
  listAllGroups,
  listGroupsForUser,
  getMemberIds,
  listMembers,
  getGroupDetails,
  addMember,
  removeMember,
  setMuted,
  postMessage,
  getGroupHistory,
};