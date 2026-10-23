'use strict';

/*
 * Registered client applications (the "relying parties" of the SSO platform).
 *
 * Each application belongs to exactly one tenant, has its own client id and
 * secret, and may only use the redirect URIs an administrator registered for
 * it. The secret is stored as a SHA-256 hash and shown once, when it is
 * created or rotated.
 */

const crypto = require('crypto');
const db = require('../store/db');
const { AppError } = db;
const { SSO } = require('../config/policies');
const { randomToken, hashToken, safeEqual } = require('../security/tokens');

function generateClientId() {
  return 'app_' + crypto.randomBytes(9).toString('hex');
}

function generateClientSecret() {
  return 'cs_' + randomToken(32);
}

function cleanRedirectUri(uri) {
  let parsed;
  try {
    parsed = new URL(String(uri).trim());
  } catch (err) {
    throw new AppError(400, 'Redirect URI must be an absolute URL: ' + uri, 'BAD_REDIRECT_URI');
  }
  if (parsed.hash) {
    throw new AppError(400, 'Redirect URIs cannot contain a fragment: ' + uri, 'BAD_REDIRECT_URI');
  }
  return parsed.toString();
}

function cleanRedirectUris(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new AppError(400, 'At least one redirect URI is required.', 'BAD_REDIRECT_URI');
  }
  return Array.from(new Set(list.map(cleanRedirectUri)));
}

function cleanScopes(scopes) {
  const requested = Array.isArray(scopes) ? scopes : SSO.SCOPES;
  const clean = requested
    .map((scope) => String(scope).trim())
    .filter((scope) => SSO.SCOPES.includes(scope));
  return clean.length ? Array.from(new Set(clean)) : ['openid', 'profile'];
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

function getApp(id) {
  return db.collection('clientApps').find((a) => a.id === id) || null;
}

function requireApp(id) {
  const app = getApp(id);
  if (!app) throw new AppError(404, 'Application not found.', 'APP_NOT_FOUND');
  return app;
}

function getByClientId(clientId) {
  return db.collection('clientApps').find((a) => a.clientId === clientId) || null;
}

// Public view of an application: never exposes the secret hash.
function present(app) {
  if (!app) return null;
  const { clientSecretHash, ...safe } = app;
  return Object.assign({}, safe, { hasSecret: Boolean(clientSecretHash) });
}

function listApps(filters) {
  const f = filters || {};
  let apps = db.collection('clientApps');
  if (f.tenantId) apps = apps.filter((a) => a.tenantId === f.tenantId);
  return apps.map(present).sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Registration and management                                         */
/* ------------------------------------------------------------------ */

function createApp(input) {
  const data = input || {};
  const name = String(data.name || '').trim();
  if (name.length < 2 || name.length > 60) {
    throw new AppError(400, 'Application name must be between 2 and 60 characters.', 'BAD_APP');
  }
  if (!data.tenantId) {
    throw new AppError(400, 'An application must belong to a tenant.', 'BAD_APP');
  }

  // Seeded applications get a readable client id and a secret from .env, so
  // the bundled sample applications can authenticate without manual setup.
  let clientId = generateClientId();
  if (data.clientId) {
    clientId = String(data.clientId).trim();
    if (!/^[a-z0-9._-]{3,60}$/i.test(clientId)) {
      throw new AppError(400, 'client_id may only contain letters, digits, dot, dash and underscore.', 'BAD_APP');
    }
    if (getByClientId(clientId)) {
      throw new AppError(409, 'This client_id is already registered.', 'APP_EXISTS');
    }
  }

  const secret = data.clientSecret ? String(data.clientSecret) : generateClientSecret();
  const now = new Date().toISOString();

  const app = {
    id: db.newId('app'),
    tenantId: data.tenantId,
    name,
    description: String(data.description || '').slice(0, 300),
    clientId,
    clientSecretHash: hashToken(secret),
    kind: data.kind === 'public' ? 'public' : 'confidential',
    redirectUris: cleanRedirectUris(data.redirectUris),
    postLogoutRedirectUris: data.postLogoutRedirectUris
      ? cleanRedirectUris(data.postLogoutRedirectUris)
      : [],
    scopes: cleanScopes(data.scopes),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };

  db.collection('clientApps').push(app);
  db.save();

  // The plaintext secret is returned exactly once.
  return { app: present(app), clientSecret: secret };
}

function updateApp(id, changes) {
  const app = requireApp(id);
  const c = changes || {};

  if (c.name !== undefined) {
    const name = String(c.name).trim();
    if (name.length < 2 || name.length > 60) {
      throw new AppError(400, 'Application name must be between 2 and 60 characters.', 'BAD_APP');
    }
    app.name = name;
  }
  if (c.description !== undefined) app.description = String(c.description).slice(0, 300);
  if (c.redirectUris !== undefined) app.redirectUris = cleanRedirectUris(c.redirectUris);
  if (c.postLogoutRedirectUris !== undefined) {
    app.postLogoutRedirectUris = Array.isArray(c.postLogoutRedirectUris)
      ? cleanRedirectUris(c.postLogoutRedirectUris)
      : [];
  }
  if (c.scopes !== undefined) app.scopes = cleanScopes(c.scopes);
  if (c.status !== undefined) {
    if (!['active', 'disabled'].includes(c.status)) {
      throw new AppError(400, 'Status must be active or disabled.', 'BAD_APP');
    }
    app.status = c.status;
  }

  app.updatedAt = new Date().toISOString();
  db.save();
  return present(app);
}

// Rotating invalidates the old secret immediately.
function rotateSecret(id) {
  const app = requireApp(id);
  const secret = generateClientSecret();
  app.clientSecretHash = hashToken(secret);
  app.updatedAt = new Date().toISOString();
  db.save();
  return { app: present(app), clientSecret: secret };
}

// Returns the application, or throws when it is unknown, disabled or belongs
// to a suspended tenant. Used by every OAuth endpoint.
function requireUsableApp(clientId) {
  const app = getByClientId(clientId);
  if (!app) {
    throw new AppError(400, 'Unknown client_id: ' + clientId, 'UNKNOWN_CLIENT');
  }
  if (app.status !== 'active') {
    throw new AppError(403, 'This application has been disabled.', 'APP_DISABLED');
  }
  return app;
}

// Redirect URIs must match exactly, otherwise the endpoint becomes an
// open redirect that can leak authorization codes.
function assertRedirectUri(app, redirectUri) {
  if (!redirectUri) throw new AppError(400, 'redirect_uri is required.', 'BAD_REDIRECT_URI');
  let normalized;
  try {
    normalized = new URL(redirectUri).toString();
  } catch (err) {
    throw new AppError(400, 'redirect_uri must be an absolute URL.', 'BAD_REDIRECT_URI');
  }
  if (!app.redirectUris.includes(normalized)) {
    throw new AppError(
      400,
      'The redirect_uri is not registered for this application: ' + normalized,
      'BAD_REDIRECT_URI'
    );
  }
  return normalized;
}

function verifySecret(app, secret) {
  if (!app || !app.clientSecretHash) return false;
  if (typeof secret !== 'string' || !secret) return false;
  return safeEqual(hashToken(secret), app.clientSecretHash);
}

function markUsed(app) {
  app.lastUsedAt = new Date().toISOString();
  db.save();
}

module.exports = {
  generateClientId,
  getApp,
  requireApp,
  getByClientId,
  requireUsableApp,
  present,
  listApps,
  createApp,
  updateApp,
  rotateSecret,
  assertRedirectUri,
  verifySecret,
  markUsed,
};
