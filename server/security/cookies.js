'use strict';

/*
 * Minimal cookie helpers. The SSO session and the sample applications keep
 * their session identifiers in HttpOnly cookies, so a script injected into a
 * page cannot read or replay them.
 */

function parse(req) {
  const header = req.headers.cookie;
  if (!header) return {};

  const jar = {};
  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) return;
    try {
      jar[name] = decodeURIComponent(value);
    } catch (err) {
      jar[name] = value;
    }
  });
  return jar;
}

function serialize(name, value, options) {
  const opts = options || {};
  const parts = [name + '=' + encodeURIComponent(value)];

  parts.push('Path=' + (opts.path || '/'));
  if (opts.maxAge !== undefined) parts.push('Max-Age=' + Math.floor(opts.maxAge));
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  // Lax keeps the cookie on top-level navigations (the OAuth redirects) while
  // still blocking it on cross-site subrequests. "none" is only needed when the
  // pages are embedded in a third-party frame.
  parts.push('SameSite=' + (opts.sameSite || 'Lax'));

  return parts.join('; ');
}

function set(res, name, value, options) {
  const previous = res.getHeader('Set-Cookie');
  const cookie = serialize(name, value, options);
  res.setHeader('Set-Cookie', previous ? [].concat(previous, cookie) : cookie);
}

function clear(res, name, options) {
  set(res, name, '', Object.assign({}, options, { maxAge: 0 }));
}

module.exports = { parse, serialize, set, clear };
