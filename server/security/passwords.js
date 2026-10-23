'use strict';

/*
 * Password policy and hashing.
 *
 * Passwords are stored with bcrypt (salted, adaptive cost). Plaintext or
 * reversible encryption is never used. The strength rules below come from the
 * tenant's own security policy, so each organization can be stricter.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { AUTH, LIMITS } = require('../config/policies');
const { AppError } = require('../store/db');

const RULES = [
  { key: 'requireLower', test: /[a-z]/, label: 'a lowercase letter' },
  { key: 'requireUpper', test: /[A-Z]/, label: 'an uppercase letter' },
  { key: 'requireNumber', test: /\d/, label: 'a digit' },
  { key: 'requireSymbol', test: /[^A-Za-z0-9]/, label: 'a symbol' },
];

function describePolicy(policy) {
  const parts = ['at least ' + policy.minLength + ' characters'];
  RULES.forEach((rule) => {
    if (policy[rule.key]) parts.push(rule.label);
  });
  return parts.join(', ');
}

// Throws an AppError when the password does not satisfy the tenant policy.
function assertStrongPassword(password, policy) {
  if (typeof password !== 'string' || !password) {
    throw new AppError(400, 'Password is required.', 'WEAK_PASSWORD');
  }

  const problems = [];
  if (password.length < (policy.minLength || LIMITS.MIN_PASSWORD_LENGTH)) {
    problems.push('at least ' + (policy.minLength || LIMITS.MIN_PASSWORD_LENGTH) + ' characters');
  }
  RULES.forEach((rule) => {
    if (policy[rule.key] && !rule.test.test(password)) problems.push(rule.label);
  });

  if (problems.length) {
    throw new AppError(
      400,
      'Password must contain ' + problems.join(', ') + '.',
      'WEAK_PASSWORD'
    );
  }
  return true;
}

// A rough strength score for the account page, so users see why a field is red.
function strength(password, policy) {
  if (typeof password !== 'string' || !password) return { ok: false, missing: ['a password'] };
  const missing = [];
  if (password.length < policy.minLength) missing.push('at least ' + policy.minLength + ' characters');
  RULES.forEach((rule) => {
    if (policy[rule.key] && !rule.test.test(password)) missing.push(rule.label);
  });
  return { ok: missing.length === 0, missing };
}

async function hashPassword(password) {
  return bcrypt.hash(password, AUTH.BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(typeof password === 'string' ? password : '', hash);
}

// Keeps login timing similar when the account does not exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', AUTH.BCRYPT_ROUNDS);

async function verifyPasswordOrDummy(password, hash) {
  return bcrypt.compare(typeof password === 'string' ? password : '', hash || DUMMY_HASH);
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

// Ten one-time codes, e.g. 4F7K-2M9Q. Only their bcrypt hashes are stored.
function generateRecoveryCodes(count) {
  const codes = [];
  for (let i = 0; i < (count || 10); i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4, 8));
  }
  return codes;
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

module.exports = {
  assertStrongPassword,
  describePolicy,
  strength,
  hashPassword,
  verifyPassword,
  verifyPasswordOrDummy,
  generateRecoveryCodes,
  normalizeRecoveryCode,
};
