'use strict';

/*
 * Signing keys, JSON Web Tokens, opaque tokens and PKCE helpers.
 *
 * The SSO provider signs access tokens and ID tokens with RS256 using an RSA
 * key pair that is generated on first start and kept in server/data/keys.json
 * (gitignored). The public half is published as a JWKS document, exactly like
 * a real OpenID provider, so client applications can verify the tokens.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { SERVER, SSO } = require('../config/policies');
const { AppError } = require('../store/db');

let keys = null;

function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  return {
    kid: crypto.randomBytes(8).toString('hex'),
    privateKey,
    publicKey,
    createdAt: new Date().toISOString(),
    algorithm: 'RS256',
  };
}

function loadKeys() {
  if (keys) return keys;

  const file = SERVER.KEYS_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (process.env.SSO_PRIVATE_KEY_PEM) {
    const privateKey = process.env.SSO_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
    keys = {
      kid: process.env.SSO_KEY_ID || 'env-key',
      privateKey,
      publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
      algorithm: 'RS256',
      createdAt: new Date().toISOString(),
    };
    return keys;
  }

  if (fs.existsSync(file)) {
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'));
      return keys;
    } catch (err) {
      console.error('[keys] key file could not be parsed, generating a new key pair.');
    }
  }

  keys = generateKeyPair();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log('[keys] generated a new RS256 signing key pair in ' + file);
  return keys;
}

/* ------------------------------------------------------------------ */
/* JSON Web Tokens                                                     */
/* ------------------------------------------------------------------ */

function signJwt(payload, options) {
  const opts = options || {};
  const key = loadKeys();

  return jwt.sign(payload, key.privateKey, {
    algorithm: 'RS256',
    keyid: key.kid,
    issuer: opts.issuer || SSO.ISSUER,
    audience: opts.audience,
    expiresIn: opts.expiresIn,
    subject: opts.subject,
  });
}

// Verifies signature, issuer, audience and expiry, then checks the token type.
function verifyJwt(token, options) {
  const opts = options || {};
  const key = loadKeys();

  let payload;
  try {
    payload = jwt.verify(token, key.publicKey, {
      algorithms: ['RS256'],
      issuer: opts.issuer || SSO.ISSUER,
      audience: opts.audience,
    });
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw new AppError(
      401,
      expired ? 'Your session has expired. Please sign in again.' : 'Invalid or unverifiable token.',
      expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'
    );
  }

  // "token_use" separates access tokens, ID tokens and the short-lived
  // tickets used between the sign-in steps.
  if (opts.tokenUse && payload.token_use !== opts.tokenUse) {
    throw new AppError(401, 'Unexpected token type.', 'INVALID_TOKEN');
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* Published key set (JWKS)                                            */
/* ------------------------------------------------------------------ */

function jwks() {
  const key = loadKeys();
  const publicKey = crypto.createPublicKey(key.publicKey);
  const jwk = publicKey.export({ format: 'jwk' });

  return {
    keys: [
      {
        kty: jwk.kty,
        use: 'sig',
        alg: 'RS256',
        kid: key.kid,
        n: jwk.n,
        e: jwk.e,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Opaque tokens (authorization codes, refresh tokens, sessions)        */
/* ------------------------------------------------------------------ */

// Only the hash of a token is stored, so a database dump cannot be replayed.
function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('base64url');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/* ------------------------------------------------------------------ */
/* PKCE (RFC 7636)                                                     */
/* ------------------------------------------------------------------ */

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function verifyPkceChallenge(verifier, challenge, method) {
  if (!challenge) return true; // client did not use PKCE

  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) {
    throw new AppError(400, 'code_verifier must be 43-128 characters.', 'INVALID_PKCE');
  }

  const computed =
    (method || 'S256') === 'S256'
      ? base64url(crypto.createHash('sha256').update(verifier).digest())
      : verifier;

  if (!safeEqual(computed, challenge)) {
    throw new AppError(400, 'The PKCE code_verifier does not match code_challenge.', 'INVALID_PKCE');
  }
  return true;
}

module.exports = {
  loadKeys,
  signJwt,
  verifyJwt,
  jwks,
  randomToken,
  hashToken,
  safeEqual,
  verifyPkceChallenge,
  base64url,
};
