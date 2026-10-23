'use strict';

/*
 * Request authentication and authorization.
 *
 * Access tokens are RS256-signed by the SSO service. The role is always read
 * from the database, never trusted from the token, so deactivating or demoting
 * somebody takes effect on their next request.
 */

const { AppError } = require('../store/db');
const sso = require('../services/ssoService');

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Rejects a request that does not carry a valid access token.
function authenticate(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) throw new AppError(401, 'Authentication required.', 'NO_TOKEN');

    const claims = sso.verifyAccessToken(token);
    req.user = claims.user;
    req.tenant = claims.tenant;
    req.token = claims.payload;
    req.clientApp = claims.app;
    next();
  } catch (err) {
    next(err);
  }
}

// Same check, for the Socket.IO handshake (kept under the old name).
function userFromToken(token) {
  if (!token) throw new AppError(401, 'Authentication required.', 'NO_TOKEN');
  return sso.verifyAccessToken(token).user;
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(
        new AppError(403, 'This action requires one of these roles: ' + roles.join(', ') + '.', 'ROLE_FORBIDDEN')
      );
    }
    next();
  };
}

// Platform administrators manage every tenant; tenant administrators only
// their own. Used by the administration endpoints.
function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'tenant_admin'].includes(req.user.role)) {
    return next(new AppError(403, 'This action requires an administrator account.', 'ROLE_FORBIDDEN'));
  }
  next();
}

function isPlatformAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

// Which tenant may the caller read or change?
//   platform admin  - the requested tenant, or all tenants when none is given
//   tenant admin    - always their own tenant, never another one
function tenantScope(user, requestedTenantId) {
  if (isPlatformAdmin(user)) return requestedTenantId || null;
  if (user.role === 'tenant_admin') return user.tenantId;
  throw new AppError(403, 'This action requires an administrator account.', 'ROLE_FORBIDDEN');
}

// Optional OAuth scope check for calls made with a client-application token.
function requireScope(scope) {
  return (req, res, next) => {
    const granted = String((req.token && req.token.scope) || '').split(/\s+/);
    if (!granted.includes(scope)) {
      return next(new AppError(403, 'This application needs the "' + scope + '" scope.', 'SCOPE_FORBIDDEN'));
    }
    next();
  };
}

module.exports = {
  extractBearerToken,
  authenticate,
  userFromToken,
  requireRole,
  requireAdmin,
  isPlatformAdmin,
  tenantScope,
  requireScope,
};
