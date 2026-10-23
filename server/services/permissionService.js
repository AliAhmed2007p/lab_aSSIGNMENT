'use strict';

const db = require('../store/db');
const { AppError } = db;
const {
  GROUP_TYPES,
  POST_POLICIES,
  POST_POLICY_ALLOWED_ROLES,
  GROUP_CREATION_RULES,
  DM_RULES,
  LIMITS,
} = require('../config/policies');

/* ------------------------------------------------------------------ */
/* Role of a user INSIDE a group (different from the global role)      */
/* ------------------------------------------------------------------ */

const GROUP_ROLES = Object.freeze({
  OWNER: 'owner',
  MEMBER: 'member',
});

/* ------------------------------------------------------------------ */
/* Result helpers                                                      */
/* ------------------------------------------------------------------ */

const ALLOW = Object.freeze({ allowed: true });

function deny(code, reason, status) {
  return { allowed: false, code, reason, status: status || 403 };
}

// Turns a failed check into an AppError. Passes silently when allowed.
function assertAllowed(result) {
  if (!result.allowed) {
    throw new AppError(result.status || 403, result.reason, result.code);
  }
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/* ------------------------------------------------------------------ */
/* Membership lookups                                                  */
/* ------------------------------------------------------------------ */

function getMembership(groupId, userId) {
  return (
    db
      .collection('memberships')
      .find((m) => m.groupId === groupId && m.userId === userId) || null
  );
}

function isMember(groupId, userId) {
  return getMembership(groupId, userId) !== null;
}

function sharesGroup(userIdA, userIdB) {
  // Only open groups count. Sharing a read-only notice group (like Exam Cell Notices) does not make two students contacts.
  const openGroupIds = new Set(db.collection('groups').filter((g) => g.postPolicy === POST_POLICIES.EVERYONE).map((g) => g.id));
  const memberships = db.collection('memberships');
  const groupsOfA = new Set(
    memberships.filter((m) => m.userId === userIdA && openGroupIds.has(m.groupId)).map((m) => m.groupId)
  );
  return memberships.some(
    (m) => m.userId === userIdB && groupsOfA.has(m.groupId)
  );
}

function hasMessagedBefore(fromId, toId) {
  return db
    .collection('directMessages')
    .some((m) => m.fromId === fromId && m.toId === toId);
}

/* ------------------------------------------------------------------ */
/* Group creation and management                                       */
/* ------------------------------------------------------------------ */

function checkCreateGroup(user, type, postPolicy) {
  if (!user || !user.active) {
    return deny('INACTIVE', 'Your account is not active.');
  }
  if (!Object.values(GROUP_TYPES).includes(type)) {
    return deny('BAD_GROUP_TYPE', 'Unknown group type "' + type + '".', 400);
  }
  if (!Object.values(POST_POLICIES).includes(postPolicy)) {
    return deny('BAD_POST_POLICY', 'Unknown posting policy "' + postPolicy + '".', 400);
  }

  const rule = GROUP_CREATION_RULES[user.role];
  if (!rule || !rule.types.includes(type)) {
    const allowedTypes = rule ? rule.types.join(', ') : 'none';
    return deny(
      'GROUP_TYPE_FORBIDDEN',
      capitalize(user.role) + ' accounts cannot create "' + type +
        '" groups. Allowed types: ' + allowedTypes + '.'
    );
  }
  if (!rule.policies.includes(postPolicy)) {
    return deny(
      'POST_POLICY_FORBIDDEN',
      capitalize(user.role) + ' accounts cannot use the "' + postPolicy +
        '" posting policy. Allowed: ' + rule.policies.join(', ') + '.'
    );
  }
  return ALLOW;
}

// Used when an existing group's posting policy is changed
function checkSetPolicy(user, postPolicy) {
  if (!Object.values(POST_POLICIES).includes(postPolicy)) {
    return deny('BAD_POST_POLICY', 'Unknown posting policy "' + postPolicy + '".', 400);
  }
  const rule = user ? GROUP_CREATION_RULES[user.role] : null;
  if (!rule || !rule.policies.includes(postPolicy)) {
    return deny(
      'POST_POLICY_FORBIDDEN',
      'You are not allowed to use the "' + postPolicy + '" posting policy.'
    );
  }
  return ALLOW;
}

// Admins manage every group. Anyone else only manages groups they own.
function checkManageGroup(user, group) {
  if (!user || !user.active) {
    return deny('INACTIVE', 'Your account is not active.');
  }
  if (user.role === 'admin') return ALLOW;
  // A tenant administrator manages the groups of their own organization only.
  if (user.role === 'tenant_admin') {
    return group.tenantId === user.tenantId
      ? ALLOW
      : deny('CROSS_TENANT', 'That group belongs to another organization.');
  }
  const membership = getMembership(group.id, user.id);
  if (membership && membership.groupRole === GROUP_ROLES.OWNER) return ALLOW;
  return deny('NOT_GROUP_OWNER', 'Only the group owner or an admin can do that.');
}

/* ------------------------------------------------------------------ */
/* Reading and posting inside a group                                  */
/* ------------------------------------------------------------------ */

// Joining the socket room, reading history and receiving messages
// all require membership. Admins get no exception here.
function checkReadGroup(user, group) {
  if (!user || !user.active) {
    return deny('INACTIVE', 'Your account is not active.');
  }
  if (group.tenantId && user.tenantId && group.tenantId !== user.tenantId) {
    return deny('NOT_MEMBER', 'You are not a member of this group.', 404);
  }
  if (!isMember(group.id, user.id)) {
    return deny('NOT_MEMBER', 'You are not a member of this group.');
  }
  return ALLOW;
}

function checkPostToGroup(user, group) {
  if (!user || !user.active) {
    return deny('INACTIVE', 'Your account is not active.');
  }
  if (group.tenantId && user.tenantId && group.tenantId !== user.tenantId) {
    return deny('NOT_MEMBER', 'You are not a member of this group.', 404);
  }

  const membership = getMembership(group.id, user.id);
  if (!membership) {
    return deny('NOT_MEMBER', 'You are not a member of this group.');
  }
  if (membership.muted) {
    return deny('MUTED', 'You have been muted in this group. You can read but not post.');
  }

  const allowedRoles = POST_POLICY_ALLOWED_ROLES[group.postPolicy] || [];
  if (!allowedRoles.includes(user.role)) {
    if (group.postPolicy === POST_POLICIES.ADMIN_ONLY) {
      return deny('POLICY_ADMIN_ONLY', 'Only admins can post in this group.');
    }
    if (group.postPolicy === POST_POLICIES.FACULTY_ONLY) {
      return deny('POLICY_FACULTY_ONLY', 'Only faculty and admins can post in this group.');
    }
    return deny('POLICY_FORBIDDEN', 'Your role cannot post in this group.');
  }
  return ALLOW;
}

/* ------------------------------------------------------------------ */
/* Direct messages                                                     */
/* ------------------------------------------------------------------ */

function checkDirectMessage(sender, recipient) {
  if (!sender || !sender.active) {
    return deny('INACTIVE', 'Your account is not active.');
  }
  if (!recipient || !recipient.active) {
    return deny('RECIPIENT_UNAVAILABLE', 'That user is not available.', 404);
  }
  if (sender.id === recipient.id) {
    return deny('SELF_DM', 'You cannot send a direct message to yourself.', 400);
  }

  const rule = DM_RULES[sender.role];
  if (rule === 'anyone') return ALLOW;

  if (rule === 'shared_group_or_replied') {
    if (sharesGroup(sender.id, recipient.id)) return ALLOW;
    if (hasMessagedBefore(recipient.id, sender.id)) return ALLOW;
    return deny(
      'DM_NOT_ALLOWED',
      'Students can only message people who share a group with them, or who have messaged them first.'
    );
  }

  return deny('DM_NOT_ALLOWED', 'You are not allowed to send direct messages.');
}

/* ------------------------------------------------------------------ */
/* Message content                                                     */
/* ------------------------------------------------------------------ */

function validateMessageText(text) {
  if (typeof text !== 'string') {
    throw new AppError(400, 'Message text must be a string.', 'BAD_MESSAGE');
  }
  const clean = text.trim();
  if (!clean) {
    throw new AppError(400, 'Message cannot be empty.', 'EMPTY_MESSAGE');
  }
  if (clean.length > LIMITS.MESSAGE_MAX_LENGTH) {
    throw new AppError(
      400,
      'Message is too long. The limit is ' + LIMITS.MESSAGE_MAX_LENGTH + ' characters.',
      'MESSAGE_TOO_LONG'
    );
  }
  return clean;
}

module.exports = {
  GROUP_ROLES,
  assertAllowed,
  getMembership,
  isMember,
  sharesGroup,
  hasMessagedBefore,
  checkCreateGroup,
  checkSetPolicy,
  checkManageGroup,
  checkReadGroup,
  checkPostToGroup,
  checkDirectMessage,
  validateMessageText,
};