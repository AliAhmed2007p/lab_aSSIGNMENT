'use strict';

/*
 * Tiny OpenID Connect client used by the two bundled sample applications.
 *
 * It speaks to this server's own token, userinfo and revocation endpoints over
 * loopback, exactly the way an external application would talk to the SSO
 * platform over the network - only without leaving the machine.
 */

const http = require('http');
const { SERVER } = require('../config/policies');

function endpoint(path) {
  return 'http://127.0.0.1:' + SERVER.PORT + path;
}

function call(path, options) {
  const opts = options || {};
  const body = opts.body || null;
  const target = new URL(endpoint(path));

  const requestOptions = {
    method: opts.method || 'POST',
    hostname: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}),
  };
  if (body) requestOptions.headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const request = http.request(requestOptions, (response) => {
      let raw = '';
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (err) {
          parsed = null;
        }
        resolve({ status: response.statusCode, body: parsed, raw });
      });
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('The single sign-on server did not answer.')));
    if (body) request.write(body);
    request.end();
  });
}

function form(fields) {
  const params = new URLSearchParams();
  Object.keys(fields).forEach((key) => {
    if (fields[key] !== undefined && fields[key] !== null) params.set(key, fields[key]);
  });
  return params.toString();
}

/* ------------------------------------------------------------------ */
/* Token endpoint                                                      */
/* ------------------------------------------------------------------ */

async function authorizationCodeGrant(input) {
  const response = await call('/sso/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code_verifier: input.codeVerifier,
    }),
  });

  if (response.status !== 200) {
    const description = (response.body && response.body.error_description) || 'token request failed';
    throw new Error(description);
  }
  return response.body;
}

async function refreshGrant(input) {
  const response = await call('/sso/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  });

  if (response.status !== 200) {
    const description = (response.body && response.body.error_description) || 'refresh request failed';
    throw new Error(description);
  }
  return response.body;
}

async function revoke(input) {
  return call('/sso/revoke', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  });
}

async function userinfo(accessToken) {
  const response = await call('/sso/userinfo', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (response.status !== 200) {
    const description = (response.body && response.body.error_description) || 'userinfo request failed';
    throw new Error(description);
  }
  return response.body;
}

module.exports = { authorizationCodeGrant, refreshGrant, revoke, userinfo, endpoint };
