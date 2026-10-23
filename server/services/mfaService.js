'use strict';

/*
 * Multi-factor authentication with a TOTP authenticator application
 * (Google Authenticator, Authy, ...) plus single-use recovery codes.
 *
 * Enrollment is a two-step handshake: the secret is generated first and only
 * becomes active after the user proves they can produce a valid code. Until
 * then nothing about the account has changed.
 */

const db = require('../store/db');
const { AppError } = db;
const totp = require('../security/totp');
const passwords = require('../security/passwords');

function factorOf(user) {
  if (!user.mfa) {
    user.mfa = {
      enabled: false,
      secret: null,
      pendingSecret: null,
      pendingIssuedAt: null,
      recoveryCodes: [],
      enrolledAt: null,
      lastUsedAt: null,
    };
  }
  if (!Array.isArray(user.mfa.recoveryCodes)) user.mfa.recoveryCodes = [];
  return user.mfa;
}

function statusOf(user) {
  const factor = factorOf(user);
  return {
    enabled: Boolean(factor.enabled),
    enrolledAt: factor.enrolledAt || null,
    lastUsedAt: factor.lastUsedAt || null,
    recoveryCodesLeft: factor.recoveryCodes.filter((code) => !code.usedAt).length,
  };
}

// Works on both the stored record and the sanitized view a client receives:
// only "enabled" decides whether a challenge is needed, the secret itself is
// read from the stored record when a code is verified.
function isEnabled(user) {
  return Boolean(user && user.mfa && user.mfa.enabled);
}

/* ------------------------------------------------------------------ */
/* Enrollment                                                          */
/* ------------------------------------------------------------------ */

function startEnrollment(user, tenant) {
  const factor = factorOf(user);
  const secret = totp.generateSecret();

  factor.pendingSecret = secret;
  factor.pendingIssuedAt = new Date().toISOString();
  db.save();

  return {
    secret,
    otpauthUri: totp.otpauthUri({
      secret,
      issuer: 'COMSATS SSO',
      account: user.loginId,
    }),
    issuer: 'COMSATS SSO',
    account: user.loginId,
    tenant: tenant ? tenant.name : null,
    digits: totp.DIGITS,
    period: totp.PERIOD_SECONDS,
  };
}

async function confirmEnrollment(user, code) {
  const factor = factorOf(user);

  if (!factor.pendingSecret) {
    throw new AppError(400, 'Start the enrollment first.', 'MFA_NOT_STARTED');
  }
  if (!totp.verifyCode(factor.pendingSecret, code)) {
    throw new AppError(400, 'That code is not valid. Check the code in your authenticator app.', 'MFA_CODE_INVALID');
  }

  const recoveryCodes = passwords.generateRecoveryCodes(10);
  factor.enabled = true;
  factor.secret = factor.pendingSecret;
  factor.pendingSecret = null;
  factor.pendingIssuedAt = null;
  factor.enrolledAt = new Date().toISOString();
  factor.recoveryCodes = await Promise.all(
    recoveryCodes.map(async (plain) => ({
      hash: await passwords.hashPassword(passwords.normalizeRecoveryCode(plain)),
      usedAt: null,
    }))
  );

  db.save();
  // The plaintext codes are shown to the user once and never stored.
  return { recoveryCodes, status: statusOf(user) };
}

async function regenerateRecoveryCodes(user) {
  const factor = factorOf(user);
  if (!factor.enabled) {
    throw new AppError(400, 'Two-factor authentication is not enabled.', 'MFA_NOT_ENABLED');
  }

  const recoveryCodes = passwords.generateRecoveryCodes(10);
  factor.recoveryCodes = await Promise.all(
    recoveryCodes.map(async (plain) => ({
      hash: await passwords.hashPassword(passwords.normalizeRecoveryCode(plain)),
      usedAt: null,
    }))
  );
  db.save();
  return { recoveryCodes, status: statusOf(user) };
}

function disable(user) {
  const factor = factorOf(user);
  factor.enabled = false;
  factor.secret = null;
  factor.pendingSecret = null;
  factor.pendingIssuedAt = null;
  factor.recoveryCodes = [];
  factor.enrolledAt = null;
  db.save();
  return statusOf(user);
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

function verifyCode(user, code) {
  const factor = factorOf(user);
  if (!factor.enabled || !factor.secret) {
    throw new AppError(400, 'Two-factor authentication is not enabled for this account.', 'MFA_NOT_ENABLED');
  }
  if (!totp.verifyCode(factor.secret, code)) return false;

  factor.lastUsedAt = new Date().toISOString();
  db.save();
  return true;
}

// Recovery codes are single use: the matching hash is marked as used.
async function verifyRecoveryCode(user, code) {
  const factor = factorOf(user);
  const normalized = passwords.normalizeRecoveryCode(code);

  if (!normalized) return false;

  for (let i = 0; i < factor.recoveryCodes.length; i += 1) {
    const entry = factor.recoveryCodes[i];
    if (entry.usedAt) continue;
    // eslint-disable-next-line no-await-in-loop
    const matches = await passwords.verifyPassword(normalized, entry.hash);
    if (matches) {
      entry.usedAt = new Date().toISOString();
      factor.lastUsedAt = entry.usedAt;
      db.save();
      return true;
    }
  }
  return false;
}

// A tenant can require the second factor even for people who never set it up.
function isEnrollmentRequired(tenant, user) {
  return Boolean(tenant && tenant.settings && tenant.settings.mfaRequired) && !isEnabled(user);
}

function requiredFor(tenant, user) {
  if (isEnabled(user)) return true;
  return Boolean(tenant && tenant.settings && tenant.settings.mfaRequired);
}

module.exports = {
  statusOf,
  isEnabled,
  isEnrollmentRequired,
  requiredFor,
  startEnrollment,
  confirmEnrollment,
  regenerateRecoveryCodes,
  disable,
  verifyCode,
  verifyRecoveryCode,
};
