'use strict';

/*
 * Social sign-in (Google and Facebook).
 *
 * The provider is configured per tenant AND needs credentials in .env. When a
 * provider is not configured the buttons are disabled and the tenant switch is
 * ignored, so the platform keeps working without any external account.
 *
 * Account linking is deliberate:
 *   - an existing link always wins, one social identity drives one account
 *   - otherwise a *verified* e-mail address may match an account of the same
 *     tenant, and the identity is linked to it
 *   - otherwise, and only when the tenant allows self-registration, a new
 *     account is created; the login ID is a placeholder (external: true)
 *   - anything else is refused, never silently merged into somebody's account
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const db = require('../store/db');
const { AppError } = db;
const users = require('./userService');
const tenants = require('./tenantService');
const sso = require('./ssoService');
const { SOCIAL, SOCIAL_PROVIDERS, SSO, isSocialConfigured, socialRedirectUri } = require('../config/policies');

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

function availability(tenant) {
  const settings = tenants.settingsOf(tenant);
  return SOCIAL_PROVIDERS.map((provider) => ({
    provider,
    label: provider === 'google' ? 'Google' : 'Facebook',
    configured: isSocialConfigured(provider),
    enabledByTenant: Boolean(settings.socialProviders[provider]),
    available: isSocialConfigured(provider) && Boolean(settings.socialProviders[provider]),
  }));
}

function assertUsable(provider, tenant) {
  if (!SOCIAL_PROVIDERS.includes(provider)) {
    throw new AppError(404, 'Unknown social provider.', 'UNKNOWN_PROVIDER');
  }
  if (!isSocialConfigured(provider)) {
    throw new AppError(
      503,
      (provider === 'google' ? 'Google' : 'Facebook') +
        ' sign-in is not configured on this server. Add the credentials to .env.',
      'PROVIDER_NOT_CONFIGURED'
    );
  }
  const settings = tenants.settingsOf(tenant);
  if (!settings.socialProviders[provider]) {
    throw new AppError(403, tenant.name + ' has not enabled this sign-in provider.', 'PROVIDER_DISABLED');
  }
}

/* ------------------------------------------------------------------ */
/* State (CSRF protection for the callback)                             */
/* ------------------------------------------------------------------ */

// The pending authorization request travels in a short-lived signed cookie,
// so the callback can continue where the browser left off.
function signState(input) {
  return sso.signStateTicket({
    purpose: 'social:' + input.provider,
    tenantId: input.tenant ? input.tenant.id : null,
    subject: input.user ? input.user.id : 'state',
    // The pending authorization request is carried through the round trip,
    // so the callback can hand control back to the right application.
    request: input.request
      ? Object.assign({}, input.request, { mode: input.mode || 'login' })
      : { mode: input.mode || 'login' },
  });
}

function verifyState(ticket, provider) {
  return sso.verifyStateTicket(ticket, 'social:' + provider);
}

/* ------------------------------------------------------------------ */
/* Provider calls                                                      */
/* ------------------------------------------------------------------ */

function providerConfig(provider) {
  return SOCIAL[provider];
}

function authorizeUrl(provider, state) {
  const config = providerConfig(provider);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: socialRedirectUri(provider),
    response_type: 'code',
    scope: config.scope,
    state,
  });

  if (provider === 'google') {
    params.set('access_type', 'online');
    params.set('prompt', 'select_account');
  }
  return config.authorizeUrl + '?' + params.toString();
}

function httpJson(url, options) {
  const opts = Object.assign({ method: 'GET' }, options);
  const isHttps = String(url).startsWith('https:');
  const target = new URL(url);
  const body = opts.body;

  const requestOptions = {
    method: opts.method,
    hostname: target.hostname,
    path: target.pathname + target.search,
    headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}),
  };
  if (body) requestOptions.headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    const lib = isHttps ? https : http;
    const request = lib.request(requestOptions, (response) => {
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
        if (response.statusCode >= 400) {
          const message = (parsed && (parsed.error_description || parsed.error || parsed.message)) || raw;
          return reject(new Error('Provider request failed (' + response.statusCode + '): ' + message));
        }
        resolve(parsed || {});
      });
    });

    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('The identity provider did not answer.')));
    if (body) request.write(body);
    request.end();
  });
}

async function exchangeCode(provider, code) {
  const config = providerConfig(provider);
  const params = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: socialRedirectUri(provider),
    grant_type: 'authorization_code',
  });

  const result = await httpJson(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!result.access_token) {
    throw new AppError(502, 'The provider did not return an access token.', 'PROVIDER_ERROR');
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* ID token verification (Google, OIDC)                                */
/* ------------------------------------------------------------------ */

let googleKeys = { fetchedAt: 0, keys: [] };

async function googleSigningKeys() {
  if (Date.now() - googleKeys.fetchedAt < 6 * 60 * 60 * 1000 && googleKeys.keys.length) {
    return googleKeys.keys;
  }
  const discovery = await httpJson(SOCIAL.google.discoveryUrl);
  const jwks = await httpJson(discovery.jwks_uri);
  googleKeys = { fetchedAt: Date.now(), keys: jwks.keys || [] };
  return googleKeys.keys;
}

// Verifies signature, issuer, audience and expiry of the ID token Google
// returns, using Google's published keys (no extra dependency).
async function verifyGoogleIdToken(idToken) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new AppError(502, 'Google returned an unreadable ID token.', 'PROVIDER_ERROR');
  }

  const keys = await googleSigningKeys();
  const jwk = keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) throw new AppError(502, 'Google signing key not found.', 'PROVIDER_ERROR');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    audience: SOCIAL.google.clientId,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  });
}

async function fetchProfile(provider, tokens) {
  const config = providerConfig(provider);

  if (provider === 'google' && tokens.id_token) {
    const claims = await verifyGoogleIdToken(tokens.id_token);
    return {
      providerUserId: claims.sub,
      email: claims.email ? String(claims.email).toLowerCase() : null,
      emailVerified: Boolean(claims.email_verified),
      name: claims.name || (claims.email ? claims.email.split('@')[0] : 'Google user'),
    };
  }

  const profile = await httpJson(config.userInfoUrl, {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
  });

  return {
    providerUserId: profile.sub || profile.id,
    email: profile.email ? String(profile.email).toLowerCase() : null,
    // Facebook only returns an address when it is verified
    emailVerified: provider === 'facebook' ? Boolean(profile.email) : Boolean(profile.email_verified),
    name: profile.name || 'Social user',
  };
}

/* ------------------------------------------------------------------ */
/* Account resolution                                                  */
/* ------------------------------------------------------------------ */

async function resolveUser(provider, profile, tenant) {
  if (!profile.providerUserId) {
    throw new AppError(502, 'The provider did not return an account id.', 'PROVIDER_ERROR');
  }

  const linked = users.rawBySocial(provider, profile.providerUserId);
  if (linked) {
    if (linked.tenantId !== tenant.id) {
      throw new AppError(
        403,
        'This ' + provider + ' account belongs to a user of another organization.',
        'WRONG_TENANT'
      );
    }
    if (!linked.active) {
      throw new AppError(403, 'This account has been deactivated.', 'ACCOUNT_DISABLED');
    }
    return { user: users.sanitize(linked), linked: 'existing', created: false };
  }

  if (profile.email && profile.emailVerified) {
    const match = users.findRawByEmail(tenant.id, profile.email);
    if (match) {
      if (!match.active) {
        throw new AppError(403, 'This account has been deactivated.', 'ACCOUNT_DISABLED');
      }
      const updated = users.linkSocial(match.id, provider, profile.providerUserId, profile.email);
      return { user: updated, linked: 'email', created: false };
    }
  }

  const settings = tenants.settingsOf(tenant);
  if (!settings.allowSelfRegistration) {
    throw new AppError(
      403,
      'No account in ' + tenant.name + ' is linked to this ' + provider +
        ' account. Sign in with your university credentials and link it from Account settings.',
      'SOCIAL_ACCOUNT_NOT_LINKED'
    );
  }

  const localPart = profile.email ? profile.email.split('@')[0] : provider + '.' + profile.providerUserId;
  const user = await users.createUser({
    tenantId: tenant.id,
    loginId: localPart,
    name: profile.name,
    role: 'student',
    department: 'Computer Science',
    email: profile.email || null,
    password: crypto.randomBytes(24).toString('base64url') + 'aA1',
    external: true,
  });

  users.linkSocial(user.id, provider, profile.providerUserId, profile.email);
  return { user: users.getUserById(user.id), linked: 'created', created: true };
}

// Linking from the account page (the user is already signed in).
function linkToExistingUser(user, provider, profile) {
  if (!profile.providerUserId) {
    throw new AppError(502, 'The provider did not return an account id.', 'PROVIDER_ERROR');
  }
  return users.linkSocial(user.id, provider, profile.providerUserId, profile.email);
}

module.exports = {
  SSO_SCOPE: SSO.SCOPES,
  availability,
  assertUsable,
  signState,
  verifyState,
  authorizeUrl,
  exchangeCode,
  fetchProfile,
  resolveUser,
  linkToExistingUser,
};
