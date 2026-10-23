'use strict';

/*
 * Tenants (organizations) and their security policies.
 *
 * Every user, group, client application and audit entry carries a tenant id.
 * Administrators of a tenant can change the settings below, but the values are
 * clamped to the platform's safe ranges (TOKEN_LIMITS / PASSWORD_POLICY_LIMITS),
 * so a tenant can never configure (for example) a 10-year access token.
 */

const db = require('../store/db');
const { AppError } = db;
const {
  DEFAULT_TENANT_SETTINGS,
  TOKEN_LIMITS,
  PASSWORD_POLICY_LIMITS,
  SOCIAL_PROVIDERS,
} = require('../config/policies');

const STATUSES = ['active', 'suspended'];

function clamp(value, range, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new AppError(400, name + ' must be a number.', 'BAD_SETTING');
  }
  return Math.min(range.max, Math.max(range.min, Math.round(number)));
}

function cleanName(name) {
  if (typeof name !== 'string') throw new AppError(400, 'Tenant name is required.', 'BAD_TENANT');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80) {
    throw new AppError(400, 'Tenant name must be between 2 and 80 characters.', 'BAD_TENANT');
  }
  return clean;
}

function cleanSlug(slug) {
  const clean = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (clean.length < 2 || clean.length > 40) {
    throw new AppError(400, 'Tenant slug must be 2-40 characters (a-z, 0-9, dashes).', 'BAD_TENANT');
  }
  return clean;
}

function slugFromName(name) {
  return cleanSlug(name);
}

// Merges the tenant's stored settings over the platform defaults.
function settingsOf(tenant) {
  const stored = tenant.settings || {};
  return {
    mfaRequired: Boolean(stored.mfaRequired),
    allowSelfRegistration:
      stored.allowSelfRegistration === undefined
        ? DEFAULT_TENANT_SETTINGS.allowSelfRegistration
        : Boolean(stored.allowSelfRegistration),
    socialProviders: Object.assign(
      {},
      DEFAULT_TENANT_SETTINGS.socialProviders,
      stored.socialProviders || {}
    ),
    tokens: Object.assign({}, DEFAULT_TENANT_SETTINGS.tokens, stored.tokens || {}),
    passwordPolicy: Object.assign(
      {},
      DEFAULT_TENANT_SETTINGS.passwordPolicy,
      stored.passwordPolicy || {}
    ),
    maxFailedLogins: stored.maxFailedLogins || DEFAULT_TENANT_SETTINGS.maxFailedLogins,
    lockoutMinutes: stored.lockoutMinutes || DEFAULT_TENANT_SETTINGS.lockoutMinutes,
  };
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

function getTenant(id) {
  return db.collection('tenants').find((t) => t.id === id) || null;
}

function getTenantBySlug(slug) {
  const clean = String(slug || '').toLowerCase();
  return db.collection('tenants').find((t) => t.slug === clean) || null;
}

function requireTenant(id) {
  const tenant = getTenant(id);
  if (!tenant) throw new AppError(404, 'Organization not found.', 'TENANT_NOT_FOUND');
  return tenant;
}

function listTenants(options) {
  const opts = options || {};
  let tenants = db.collection('tenants');
  if (opts.tenantId) tenants = tenants.filter((t) => t.id === opts.tenantId);
  return tenants
    .map(present)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function present(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt,
    settings: settingsOf(tenant),
  };
}

function assertActive(tenant) {
  if (!tenant) throw new AppError(404, 'Organization not found.', 'TENANT_NOT_FOUND');
  if (tenant.status !== 'active') {
    throw new AppError(
      403,
      tenant.name + ' is currently suspended. Contact the platform administrator.',
      'TENANT_SUSPENDED'
    );
  }
  return tenant;
}

/* ------------------------------------------------------------------ */
/* Creating and updating                                               */
/* ------------------------------------------------------------------ */

function createTenant(input) {
  const data = input || {};
  const name = cleanName(data.name);
  const slug = data.slug ? cleanSlug(data.slug) : slugFromName(name);

  if (db.collection('tenants').some((t) => t.slug === slug)) {
    throw new AppError(409, 'A tenant with this slug already exists.', 'TENANT_EXISTS');
  }

  const now = new Date().toISOString();
  const tenant = {
    id: db.newId('tnt'),
    name,
    slug,
    status: 'active',
    settings: Object.assign({}, DEFAULT_TENANT_SETTINGS),
    createdAt: now,
    updatedAt: now,
  };

  db.collection('tenants').push(tenant);
  db.save();
  return present(tenant);
}

function applySettings(tenant, patch) {
  const current = settingsOf(tenant);
  const next = Object.assign({}, current);

  if (patch.mfaRequired !== undefined) next.mfaRequired = Boolean(patch.mfaRequired);
  if (patch.allowSelfRegistration !== undefined) {
    next.allowSelfRegistration = Boolean(patch.allowSelfRegistration);
  }

  if (patch.socialProviders) {
    SOCIAL_PROVIDERS.forEach((provider) => {
      if (patch.socialProviders[provider] !== undefined) {
        next.socialProviders[provider] = Boolean(patch.socialProviders[provider]);
      }
    });
  }

  if (patch.tokens) {
    const tokens = patch.tokens;
    if (tokens.accessTtlSeconds !== undefined) {
      next.tokens.accessTtlSeconds = clamp(tokens.accessTtlSeconds, TOKEN_LIMITS.accessTtlSeconds, 'Access token lifetime');
    }
    if (tokens.refreshTtlDays !== undefined) {
      next.tokens.refreshTtlDays = clamp(tokens.refreshTtlDays, TOKEN_LIMITS.refreshTtlDays, 'Refresh token lifetime');
    }
    if (tokens.sessionTtlHours !== undefined) {
      next.tokens.sessionTtlHours = clamp(tokens.sessionTtlHours, TOKEN_LIMITS.sessionTtlHours, 'Session lifetime');
    }
    if (tokens.idTokenTtlSeconds !== undefined) {
      next.tokens.idTokenTtlSeconds = clamp(tokens.idTokenTtlSeconds, TOKEN_LIMITS.idTokenTtlSeconds, 'ID token lifetime');
    }
  }

  if (patch.passwordPolicy) {
    const policy = patch.passwordPolicy;
    if (policy.minLength !== undefined) {
      next.passwordPolicy.minLength = clamp(policy.minLength, PASSWORD_POLICY_LIMITS.minLength, 'Minimum password length');
    }
    ['requireUpper', 'requireLower', 'requireNumber', 'requireSymbol'].forEach((key) => {
      if (policy[key] !== undefined) next.passwordPolicy[key] = Boolean(policy[key]);
    });
  }

  if (patch.maxFailedLogins !== undefined) {
    next.maxFailedLogins = clamp(patch.maxFailedLogins, PASSWORD_POLICY_LIMITS.maxFailedLogins, 'Maximum failed sign-ins');
  }
  if (patch.lockoutMinutes !== undefined) {
    next.lockoutMinutes = clamp(patch.lockoutMinutes, PASSWORD_POLICY_LIMITS.lockoutMinutes, 'Lockout duration');
  }

  tenant.settings = next;
}

function updateTenant(id, changes) {
  const tenant = requireTenant(id);
  const c = changes || {};

  if (c.name !== undefined) tenant.name = cleanName(c.name);

  if (c.status !== undefined) {
    if (!STATUSES.includes(c.status)) {
      throw new AppError(400, 'Status must be active or suspended.', 'BAD_TENANT');
    }
    if (c.status === 'suspended') {
      const admins = db
        .collection('users')
        .filter((u) => u.tenantId === tenant.id && u.role === 'tenant_admin' && u.active);
      if (admins.length === 0) {
        // Not fatal: the platform administrator can still restore the tenant.
        console.warn('[tenant] suspending ' + tenant.name + ' without an active tenant administrator.');
      }
    }
    tenant.status = c.status;
  }

  if (c.settings) applySettings(tenant, c.settings);

  tenant.updatedAt = new Date().toISOString();
  db.save();
  return present(tenant);
}

module.exports = {
  STATUSES,
  settingsOf,
  present,
  getTenant,
  getTenantBySlug,
  requireTenant,
  assertActive,
  listTenants,
  createTenant,
  updateTenant,
};
