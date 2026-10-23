'use strict';

/*
 * Time-based one-time passwords (RFC 6238) for the authenticator-app second
 * factor. Implemented on top of node:crypto so the project keeps only its
 * existing dependencies.
 */

const crypto = require('crypto');

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32

/* ------------------------------------------------------------------ */
/* Base32                                                              */
/* ------------------------------------------------------------------ */

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(encoded) {
  const clean = String(encoded).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < clean.length; i += 1) {
    const index = ALPHABET.indexOf(clean[i]);
    if (index === -1) throw new Error('Invalid base32 character: ' + clean[i]);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/* ------------------------------------------------------------------ */
/* Secrets and codes                                                   */
/* ------------------------------------------------------------------ */

// 160 bits of randomness, as recommended by RFC 4226 for HMAC-SHA1.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeForCounter(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentCounter(at) {
  const seconds = Math.floor((at ? at.getTime() : Date.now()) / 1000);
  return Math.floor(seconds / PERIOD_SECONDS);
}

function generateCode(secret, at) {
  return codeForCounter(secret, currentCounter(at));
}

// Accepts the previous and next time step too, to allow for clock drift.
function verifyCode(secret, token, window) {
  const steps = window === undefined ? 1 : window;
  const candidate = String(token || '').replace(/\D/g, '');
  if (candidate.length !== DIGITS) return false;

  const counter = currentCounter();
  for (let offset = -steps; offset <= steps; offset += 1) {
    if (codeForCounter(secret, counter + offset) === candidate) return true;
  }
  return false;
}

// Value for the QR code / manual entry in Google Authenticator, Authy, ...
function otpauthUri(options) {
  const label = encodeURIComponent(options.account) + ':' + encodeURIComponent(options.issuer);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return 'otpauth://totp/' + label + '?' + params.toString();
}

module.exports = {
  DIGITS,
  PERIOD_SECONDS,
  generateSecret,
  generateCode,
  verifyCode,
  otpauthUri,
  base32Encode,
  base32Decode,
};
