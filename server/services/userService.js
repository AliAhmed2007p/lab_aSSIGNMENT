'use strict';

/*
 * Users of a tenant: creation, sign-in checks, lockout, profile updates and
 * the direct-message helpers the chat application uses.
 *
 * Everything here is tenant-aware: a user always belongs to exactly one
 * organization, login IDs are unique across the platform, and e-mail addresses
 * only have to be unique inside a tenant. Passwords are stored as bcrypt
 * hashes (see security/passwords.js).
 */

const db = require('../store/db');
const { AppError } = db;
const passwords = require('../security/passwords');
const tenants = require('./tenantService');
const {
  ALL_ROLES,
  DEPARTMENTS,
  LOGIN_ID_PATTERNS,
  LIMITS,
} = require('../config/policies');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// Never send the password hash or the TOTP secret to a client.
function sanitize(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  const factor = safe.mfa || {};
  safe.mfa = {
    enabled: Boolean(factor.enabled),
    enrolledAt: factor.enrolledAt || null,
    recoveryCodesLeft: Array.isArray(factor.recoveryCodes)
      ? factor.recoveryCodes.filter((code) => !code.usedAt).length
      : 0,
  };
  safe.socialLinks = (safe.socialLinks || []).map((link) => ({
    provider: link.provider,
    linkedAt: link.linkedAt,
  }));
  return safe;
}

function cleanName(name) {
  if (typeof name !== 'string') {
    throw new AppError(400, 'Name is required.', 'BAD_NAME');
  }
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80) {
    throw new AppError(400, 'Name must be between 2 and 80 characters.', 'BAD_NAME');
  }
  return clean;
}

function cleanEmail(email) {
  if (email === undefined || email === null || email === '') return null;
  const clean = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean) || clean.length > 120) {
    throw new AppError(400, 'That e-mail address is not valid.', 'BAD_EMAIL');
  }
  return clean;
}

function validateDepartment(department) {
  if (department === undefined || department === null || department === '') return 'Administration';
  if (!DEPARTMENTS.includes(department)) {
    throw new AppError(400, 'Department must be one of: ' + DEPARTMENTS.join(', ') + '.', 'BAD_DEPARTMENT');
  }
  return department;
}

function normalizeLoginId(loginId, role, external) {
  if (typeof loginId !== 'string') {
    throw new AppError(400, 'Login ID is required.', 'BAD_LOGIN_ID');
  }
  const trimmed = loginId.trim();

  // Accounts provisioned by a social provider get a placeholder login ID
  // derived from the e-mail address, so the university's pattern for
  // registration numbers does not apply to them.
  if (external) {
    const safe = trimmed.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (safe.length < 3 || safe.length > 30) {
      throw new AppError(400, 'Could not derive a login ID for this account.', 'BAD_LOGIN_ID');
    }
    return safe;
  }

  const normalized = role === 'student' ? trimmed.toUpperCase() : trimmed.toLowerCase();
  const pattern = LOGIN_ID_PATTERNS[role] || LOGIN_ID_PATTERNS.faculty;

  if (!pattern.test(normalized)) {
    const hint =
      role === 'student'
        ? 'Students use a registration number like FA22-BCS-045.'
        : 'Staff use a username of 3-30 letters, digits, dots, dashes or underscores.';
    throw new AppError(400, 'Invalid login ID. ' + hint, 'BAD_LOGIN_ID');
  }
  return normalized;
}

function assertRole(role) {
  if (!ALL_ROLES.includes(role)) {
    throw new AppError(400, 'Role must be one of: ' + ALL_ROLES.join(', ') + '.', 'BAD_ROLE');
  }
  return role;
}

function rawById(id) {
  return db.collection('users').find((u) => u.id === id) || null;
}

function findRawByLoginId(loginId) {
  if (typeof loginId !== 'string') return null;
  const target = loginId.trim().toLowerCase();
  return db.collection('users').find((u) => u.loginId.toLowerCase() === target) || null;
}

function findRawByEmail(tenantId, email) {
  if (!email) return null;
  const target = String(email).toLowerCase();
  return (
    db
      .collection('users')
      .find((u) => u.tenantId === tenantId && (u.email || '').toLowerCase() === target) || null
  );
}

function findBySocial(provider, providerUserId) {
  const link = db
    .collection('users')
    .find((u) =>
      (u.socialLinks || []).some(
        (l) => l.provider === provider && l.providerUserId === String(providerUserId)
      )
    );
  return link ? sanitize(link) : null;
}

function rawBySocial(provider, providerUserId) {
  return (
    db
      .collection('users')
      .find((u) =>
        (u.socialLinks || []).some(
          (l) => l.provider === provider && l.providerUserId === String(providerUserId)
        )
      ) || null
  );
}

/* ------------------------------------------------------------------ */
/* Creating users                                                      */
/* ------------------------------------------------------------------ */

async function createUser(input) {
  const data = input || {};

  if (!data.tenantId) {
    throw new AppError(400, 'A user must belong to an organization.', 'BAD_TENANT');
  }
  const tenant = tenants.requireTenant(data.tenantId);
  const role = assertRole(data.role);
  const name = cleanName(data.name);
  const loginId = normalizeLoginId(data.loginId, role, Boolean(data.external));
  const department = validateDepartment(data.department);
  const email = cleanEmail(data.email);
  const settings = tenants.settingsOf(tenant);

  passwords.assertStrongPassword(data.password, settings.passwordPolicy);

  if (findRawByLoginId(loginId)) {
    throw new AppError(409, 'A user with this login ID already exists.', 'USER_EXISTS');
  }
  if (email && findRawByEmail(tenant.id, email)) {
    throw new AppError(409, 'A user with this e-mail address already exists in this organization.', 'EMAIL_EXISTS');
  }

  const passwordHash = await passwords.hashPassword(data.password);
  const now = new Date().toISOString();

  const user = {
    id: db.newId('usr'),
    tenantId: tenant.id,
    loginId,
    name,
    role,
    department,
    email,
    passwordHash,
    active: true,
    mfa: {
      enabled: false,
      secret: null,
      pendingSecret: null,
      pendingIssuedAt: null,
      recoveryCodes: [],
      enrolledAt: null,
      lastUsedAt: null,
    },
    socialLinks: [],
    failedLogins: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    passwordChangedAt: now,
  };

  db.collection('users').push(user);
  db.save();
  return sanitize(user);
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                             */
/* ------------------------------------------------------------------ */

// Failed attempts are counted per account and lock the account for the
// duration configured by the tenant.
async function authenticate(loginId, password, options) {
  const opts = options || {};
  const user = findRawByLoginId(loginId);
  const tenant = user ? tenants.getTenant(user.tenantId) : opts.tenant || null;

  if (user && user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    const seconds = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
    throw new AppError(
      423,
      'This account is locked after too many failed attempts. Try again in ' + seconds + ' seconds.',
      'ACCOUNT_LOCKED'
    );
  }

  const policy = tenant ? tenants.settingsOf(tenant) : null;
  const matches = await passwords.verifyPasswordOrDummy(password, user ? user.passwordHash : null);

  if (!user || !matches) {
    if (user) {
      user.failedLogins = (user.failedLogins || 0) + 1;
      const max = policy ? policy.maxFailedLogins : 5;
      if (user.failedLogins >= max) {
        const minutes = policy ? policy.lockoutMinutes : 15;
        user.lockedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        user.failedLogins = 0;
        db.save();
        throw new AppError(
          423,
          'Too many failed attempts. This account is locked for ' + minutes + ' minutes.',
          'ACCOUNT_LOCKED'
        );
      }
      db.save();
    }
    throw new AppError(401, 'Invalid login ID or password.', 'INVALID_CREDENTIALS');
  }

  if (opts.tenantId && user.tenantId !== opts.tenantId) {
    // Deliberately vague: it must not reveal that the account exists elsewhere.
    throw new AppError(
      401,
      'These credentials do not match an account in ' + (opts.tenant ? opts.tenant.name : 'this organization') + '.',
      'INVALID_CREDENTIALS'
    );
  }

  if (!user.active) {
    throw new AppError(403, 'This account has been deactivated.', 'ACCOUNT_DISABLED');
  }
  tenants.assertActive(tenant || tenants.requireTenant(user.tenantId));

  user.failedLogins = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date().toISOString();
  db.save();
  return sanitize(user);
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

function getUserById(id) {
  return sanitize(rawById(id));
}

// Internal use only (tokens, second factor): the stored record with the
// password hash and the TOTP secret. Never send this to a client.
function rawUser(id) {
  return rawById(id);
}

function requireUser(id) {
  const user = getUserById(id);
  if (!user) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
  return user;
}

function getUserByLoginId(loginId) {
  return sanitize(findRawByLoginId(loginId));
}

function listUsers(filters) {
  const f = filters || {};
  let users = db.collection('users');

  if (f.tenantId) users = users.filter((u) => u.tenantId === f.tenantId);
  if (f.role) users = users.filter((u) => u.role === f.role);
  if (f.department) users = users.filter((u) => u.department === f.department);
  if (f.mfaEnabled !== undefined) {
    users = users.filter((u) => Boolean(u.mfa && u.mfa.enabled) === Boolean(f.mfaEnabled));
  }
  if (!f.includeInactive) users = users.filter((u) => u.active);
  if (f.search) {
    const term = String(f.search).toLowerCase();
    users = users.filter(
      (u) =>
        u.name.toLowerCase().includes(term) ||
        u.loginId.toLowerCase().includes(term) ||
        (u.email || '').toLowerCase().includes(term)
    );
  }

  return users.map(sanitize).sort((a, b) => a.name.localeCompare(b.name));
}

async function updateUser(id, changes) {
  const user = rawById(id);
  if (!user) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');

  const c = changes || {};
  const tenant = tenants.requireTenant(user.tenantId);
  const policy = tenants.settingsOf(tenant);

  if (c.name !== undefined) user.name = cleanName(c.name);

  if (c.department !== undefined) user.department = validateDepartment(c.department);

  if (c.email !== undefined) {
    const email = cleanEmail(c.email);
    const taken = email ? findRawByEmail(user.tenantId, email) : null;
    if (taken && taken.id !== user.id) {
      throw new AppError(409, 'That e-mail address is already used in this organization.', 'EMAIL_EXISTS');
    }
    user.email = email;
  }

  if (c.role !== undefined) {
    assertRole(c.role);
    user.role = c.role;
  }

  if (c.active !== undefined) {
    if (typeof c.active !== 'boolean') {
      throw new AppError(400, '"active" must be true or false.', 'BAD_ACTIVE');
    }
    if (c.active === false && (user.role === 'admin' || user.role === 'tenant_admin')) {
      const otherAdmins = db
        .collection('users')
        .filter(
          (u) => u.role === user.role && u.active && u.id !== user.id && u.tenantId === user.tenantId
        );
      if (otherAdmins.length === 0) {
        throw new AppError(400, 'You cannot deactivate the last active administrator.', 'LAST_ADMIN');
      }
    }
    if (c.active === false) revokeAccess(user.id);
  }

  if (c.password !== undefined) {
    await setPassword(user.id, c.password);
  }

  user.updatedAt = new Date().toISOString();
  db.save();
  return sanitize(user);
}

// Replaces the password hash. Callers revoke the user's sessions afterwards.
async function setPassword(userId, password) {
  const user = rawById(userId);
  if (!user) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');

  const policy = tenants.settingsOf(tenants.requireTenant(user.tenantId));
  passwords.assertStrongPassword(password, policy);

  user.passwordHash = await passwords.hashPassword(password);
  user.passwordChangedAt = new Date().toISOString();
  db.save();
  return sanitize(user);
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = rawById(userId);
  if (!user) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');

  const ok = await passwords.verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    throw new AppError(401, 'Your current password is not correct.', 'INVALID_CREDENTIALS');
  }
  return setPassword(userId, newPassword);
}

// Marks an account as no longer usable: sessions and tokens are dropped too.
function revokeAccess(userId) {
  const sessions = db.collection('sessions').filter((s) => s.userId === userId && !s.revokedAt);
  sessions.forEach((session) => {
    session.revokedAt = new Date().toISOString();
    session.revokedReason = 'account_deactivated';
  });

  const tokens = db.collection('refreshTokens').filter((t) => t.userId === userId && !t.revokedAt);
  tokens.forEach((token) => {
    token.revokedAt = new Date().toISOString();
    token.revokedReason = 'account_deactivated';
  });

  db.save();
  return { sessions: sessions.length, refreshTokens: tokens.length };
}

/* ------------------------------------------------------------------ */
/* Social identities                                                   */
/* ------------------------------------------------------------------ */

function linkSocial(userId, provider, providerUserId, email) {
  const user = rawById(userId);
  if (!user) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');

  const existing = rawBySocial(provider, providerUserId);
  if (existing && existing.id !== user.id) {
    // Prevents hijacking: one social identity can only drive one account.
    throw new AppError(409, 'This ' + provider + ' account is already linked to another user.', 'SOCIAL_ALREADY_LINKED');
  }

  if (!user.socialLinks) user.socialLinks = [];
  if (!user.socialLinks.some((l) => l.provider === provider)) {
    user.socialLinks.push({
      provider,
      providerUserId: String(providerUserId),
      email: email || null,
      linkedAt: new Date().toISOString(),
    });
    db.save();
  }
  return sanitize(user);
}

function unlinkSocial(userId, provider) {
  const user = rawById(userId);
  if (!user) throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');

  user.socialLinks = (user.socialLinks || []).filter((l) => l.provider !== provider);
  db.save();
  return sanitize(user);
}

/* ------------------------------------------------------------------ */
/* Direct messages (persistence lives with users, rules in permissions) */
/* ------------------------------------------------------------------ */

function sendDirectMessage(sender, recipientId, text) {
  const recipient = requireUser(recipientId);
  const perm = require('./permissionService');
  if (sender.tenantId !== recipient.tenantId) {
    throw new AppError(404, 'That user is not available.', 'RECIPIENT_UNAVAILABLE');
  }
  perm.assertAllowed(perm.checkDirectMessage(sender, recipient));
  const clean = perm.validateMessageText(text);

  const message = {
    id: db.newId('dm'),
    fromId: sender.id,
    toId: recipient.id,
    senderName: sender.name,
    text: clean,
    createdAt: new Date().toISOString(),
  };

  db.collection('directMessages').push(message);
  db.save();
  return message;
}

function getDirectHistory(userId, otherUserId, options) {
  const other = requireUser(otherUserId);
  const me = requireUser(userId);
  if (me.tenantId !== other.tenantId) {
    throw new AppError(404, 'User not found.', 'USER_NOT_FOUND');
  }

  const conversation = db
    .collection('directMessages')
    .filter(
      (m) =>
        (m.fromId === userId && m.toId === otherUserId) ||
        (m.fromId === otherUserId && m.toId === userId)
    );
  return db.latest(conversation, options);
}

// One entry per person the user has talked to, newest conversation first
function listConversations(userId) {
  const lastByPartner = new Map();

  db.collection('directMessages').forEach((m) => {
    if (m.fromId !== userId && m.toId !== userId) return;
    const partnerId = m.fromId === userId ? m.toId : m.fromId;
    lastByPartner.set(partnerId, m);
  });

  return Array.from(lastByPartner.entries())
    .map(([partnerId, lastMessage]) => ({
      partner: getUserById(partnerId),
      lastMessage,
    }))
    .filter((entry) => entry.partner)
    .sort((a, b) => (a.lastMessage.createdAt < b.lastMessage.createdAt ? 1 : -1));
}

module.exports = {
  LIMITS,
  sanitize,
  createUser,
  authenticate,
  getUserById,
  rawUser,
  getUserByLoginId,
  findBySocial,
  rawBySocial,
  findRawByEmail,
  requireUser,
  listUsers,
  updateUser,
  setPassword,
  changePassword,
  revokeAccess,
  linkSocial,
  unlinkSocial,
  sendDirectMessage,
  getDirectHistory,
  listConversations,
};
