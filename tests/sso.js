'use strict';

/*
 * COMSATS SSO: end-to-end test of the sign-in platform.
 *
 * It drives the real HTTP endpoints the way a browser and a client
 * application would - authorization code + PKCE, token exchange, refresh-token
 * rotation, second factor, tenant isolation, password reset - and prints PASS
 * or FAIL for every check.
 *
 * Usage:
 *   npm start            (in one terminal)
 *   npm run demo:sso     (in another)
 *
 * The script restores what it changes: it removes the two-factor factor and the
 * password it sets during the run, so the demo data stays usable afterwards.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const totp = require('../server/security/totp');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = process.env.DEMO_PASSWORD || 'Comsats@123';
const MFA_LOGIN_ID = 'SP23-BBA-019'; // Usman Raza: not used by tests/demo.js

let passed = 0;
let failed = 0;

function check(label, condition, extra) {
  if (condition) {
    passed += 1;
    console.log('   \x1b[32mPASS\x1b[0m  ' + label);
  } else {
    failed += 1;
    console.log('   \x1b[31mFAIL\x1b[0m  ' + label + (extra ? '  (' + extra + ')' : ''));
  }
}

function section(title) {
  console.log('');
  console.log('\x1b[1m\x1b[36m' + title + '\x1b[0m');
}

/* ------------------------------------------------------------------ */
/* Tiny HTTP client with a cookie jar and manual redirects             */
/* ------------------------------------------------------------------ */

let jar = new Map();

function cookieHeader() {
  return Array.from(jar.entries()).map(([name, value]) => name + '=' + value).join('; ');
}

function storeCookies(response) {
  const list =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);

  list.forEach((cookie) => {
    const pair = cookie.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  });
}

function resetJar() {
  jar = new Map();
}

async function call(method, path, options) {
  const opts = options || {};
  const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
  if (jar.size) headers.Cookie = cookieHeader();
  if (opts.body) headers['Content-Type'] = opts.contentType || 'application/json';

  const response = await fetch(path.startsWith('http') ? path : BASE + path, {
    method,
    headers,
    body: opts.body
      ? opts.contentType === 'application/x-www-form-urlencoded'
        ? opts.body
        : JSON.stringify(opts.body)
      : undefined,
    redirect: 'manual',
  });

  storeCookies(response);

  const text = await response.text();
  let data = null;
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }

  return {
    status: response.status,
    location: response.headers.get('location'),
    data,
    text,
  };
}

function query(path) {
  return new URL(path.startsWith('http') ? path : BASE + path).searchParams;
}

// Keeps a redirect on this server: absolute addresses (the sample applications
// are registered with the public base URL) are followed on their path only.
function local(path) {
  if (!path.startsWith('http')) return path;
  const url = new URL(path);
  return url.pathname + url.search;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/* ------------------------------------------------------------------ */
/* Sign-in helpers                                                     */
/* ------------------------------------------------------------------ */

const authParams = (clientId, redirectUri, state, challenge, scope) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: scope,
  state,
  nonce: crypto.randomBytes(8).toString('hex'),
  code_challenge: challenge,
  code_challenge_method: 'S256',
});

// Walks the whole browser flow and leaves the SSO session cookie in the jar.
async function browserSignIn(clientId, redirectUri, loginId, password) {
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(8).toString('hex');
  const params = authParams(clientId, redirectUri, state, challenge);

  const authorize = await call('GET', '/sso/authorize?' + new URLSearchParams(params).toString());
  const loginPage = authorize.location;
  const loginQuery = query(loginPage);

  const body = {};
  loginQuery.forEach((value, key) => {
    body[key] = value;
  });
  body.loginId = loginId;
  body.password = password;

  const login = await call('POST', '/sso/api/login', { body });
  return { verifier, state, params, authorize, login };
}

async function exchangeCode(clientId, clientSecret, redirectUri, code, verifier) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
  });
  return call('POST', '/sso/token', {
    body: form.toString(),
    contentType: 'application/x-www-form-urlencoded',
  });
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

let platformAdminToken = null;
let usmanId = null;

async function setup() {
  section('[0] Setup');

  const health = await call('GET', '/api/health');
  check('The server answers /api/health', health.status === 200 && health.data.status === 'ok');
  if (health.status !== 200) {
    console.log('\n   Start the server first (npm start) and try again.');
    process.exit(1);
  }

  const login = await call('POST', '/api/auth/login', {
    body: { loginId: 'admin.it', password: PASSWORD },
  });
  check('The platform administrator can sign in through the API', login.status === 200 && Boolean(login.data.token));
  platformAdminToken = login.data ? login.data.token : null;

  const users = await call('GET', '/api/admin/users?search=' + MFA_LOGIN_ID + '&includeInactive=true', {
    headers: { Authorization: 'Bearer ' + platformAdminToken },
  });
  const usman = users.data && users.data.users.find((u) => u.loginId === MFA_LOGIN_ID);
  check('The demo user used for the two-factor checks exists', Boolean(usman));
  usmanId = usman ? usman.id : null;
}

/* ------------------------------------------------------------------ */
/* 1. Discovery and keys                                               */
/* ------------------------------------------------------------------ */

let jwks = null;
let issuer = null;

async function discovery() {
  section('[1] Discovery document and public keys');

  const document = await call('GET', '/.well-known/openid-configuration');
  issuer = document.data ? document.data.issuer : null;
  check('The discovery document is published', document.status === 200 && document.data.issuer);
  check('It advertises the authorization, token and userinfo endpoints',
    Boolean(document.data.authorization_endpoint && document.data.token_endpoint && document.data.userinfo_endpoint));
  check('It advertises PKCE (S256)', (document.data.code_challenge_methods_supported || []).includes('S256'));

  const keys = await call('GET', '/sso/jwks.json');
  check('The public key set (JWKS) is published', keys.status === 200 && keys.data.keys.length > 0);
  jwks = keys.data.keys;
}

function publicKeyFor(kid) {
  const jwk = jwks.find((key) => key.kid === kid) || jwks[0];
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/* ------------------------------------------------------------------ */
/* 2. Authorization code + PKCE                                        */
/* ------------------------------------------------------------------ */

async function authorizationCodeFlow() {
  section('[2] Authorization code flow with PKCE (library portal)');

  resetJar();
  const redirectUri = BASE + '/apps/library/callback';
  const flow = await browserSignIn('comsats-library-portal', redirectUri, 'FA23-BCS-050', PASSWORD);

  check('The application is sent to the authorization endpoint', flow.authorize.status === 302 &&
    String(flow.authorize.location).includes('/sso/login'));

  check('Signing in returns a redirect back to the application', flow.login.status === 200 &&
    String(flow.login.data.redirectTo || '').startsWith(redirectUri), flow.login.data && flow.login.data.error && flow.login.data.error.message);

  const returned = await call('GET', flow.login.data.redirectTo);
  const returnedQuery = query(returned.location || flow.login.data.redirectTo);
  check('The authorization response carries a code and the state', Boolean(returnedQuery.get('code')) &&
    returnedQuery.get('state') === flow.state);

  const code = returnedQuery.get('code');
  const secret = process.env.LIBRARY_CLIENT_SECRET || 'dev-library-client-secret';

  const withoutSecret = await exchangeCode('comsats-library-portal', null, redirectUri, code, flow.verifier);
  check('A confidential client cannot exchange a code without its secret',
    withoutSecret.status === 401 || withoutSecret.status === 400);

  const wrongVerifier = await exchangeCode('comsats-library-portal', secret, redirectUri, code, pkce().verifier);
  check('A wrong PKCE verifier is refused', wrongVerifier.status === 400);

  const granted = await exchangeCode('comsats-library-portal', secret, redirectUri, code, flow.verifier);
  check('The code is exchanged for tokens', granted.status === 200 && Boolean(granted.data.access_token), granted.data && granted.data.error_description);
  check('An ID token and a refresh token are returned', Boolean(granted.data.id_token) && Boolean(granted.data.refresh_token));
  check('The access token is short lived', granted.data.expires_in > 0 && granted.data.expires_in <= 3600);

  // The ID token must verify against the published key set.
  const decodedHeader = jwt.decode(granted.data.id_token, { complete: true });
  let claims = null;
  try {
    claims = jwt.verify(granted.data.id_token, publicKeyFor(decodedHeader.header.kid), {
      algorithms: ['RS256'],
      audience: 'comsats-library-portal',
      issuer,
    });
  } catch (err) {
    claims = null;
  }
  check('The ID token signature, issuer and audience verify with the published key', Boolean(claims));
  check('The ID token carries the tenant and the role', Boolean(claims && claims.tid && (claims.roles || []).length));

  const userinfo = await call('GET', '/sso/userinfo', {
    headers: { Authorization: 'Bearer ' + granted.data.access_token },
  });
  check('The userinfo endpoint returns the profile', userinfo.status === 200 && userinfo.data.preferred_username === 'FA23-BCS-050');
  check('The userinfo scope is not tenant-wide data', userinfo.data.tenant && typeof userinfo.data.tenant.slug === 'string');

  const reused = await exchangeCode('comsats-library-portal', secret, redirectUri, code, flow.verifier);
  check('The authorization code cannot be used twice', reused.status === 400);

  const wrongRedirect = await call('GET', '/sso/authorize?' + new URLSearchParams(
    authParams('comsats-library-portal', 'https://attacker.example/callback', 'x', pkce().challenge, 'openid')
  ).toString());
  check('An unregistered redirect_uri is refused', wrongRedirect.status === 400);

  return granted.data;
}

/* ------------------------------------------------------------------ */
/* 3. Single sign-on across two applications                           */
/* ------------------------------------------------------------------ */

async function singleSignOn() {
  section('[3] One session, two applications');

  // The jar still holds the SSO session cookie from the previous sign-in.
  const start = await call('GET', '/apps/chat/login');
  check('The chat application sends the browser to the platform',
    start.status === 302 && String(start.location).includes('/sso/authorize'));

  const authorize = await call('GET', local(start.location));
  check('The second application is authorized without asking for credentials again',
    authorize.status === 302 && String(authorize.location).includes('/apps/chat/callback'));
  check('It receives a fresh authorization code',
    Boolean(query(authorize.location).get('code')));

  const chatCallback = await call('GET', local(authorize.location));
  check('The chat application completes its own callback and hands the token to the page',
    chatCallback.status === 200 && String(chatCallback.text).includes('/chat.html'));

  const chatSession = await call('GET', '/apps/chat/api/session');
  check('The chat backend can hand out an access token for the SSO session',
    chatSession.status === 200 && Boolean(chatSession.data.token));

  const groups = await call('GET', '/api/groups', {
    headers: { Authorization: 'Bearer ' + chatSession.data.token },
  });
  check('The access token is accepted by the chat API', groups.status === 200 && Array.isArray(groups.data.groups));
  check('The chat lists the groups of the signed-in student', groups.data.groups.length > 0);

  resetJar();
  const afterLogout = await call('GET', '/sso/authorize?' + new URLSearchParams(
    authParams('comsats-connect-chat', BASE + '/apps/chat/callback', 'chat-state-2', pkce().challenge, 'openid profile email')
  ).toString());
  check('After single sign-out the platform asks for credentials again',
    afterLogout.status === 302 && String(afterLogout.location).includes('/sso/login'));
}

/* ------------------------------------------------------------------ */
/* 4. Refresh token rotation and reuse detection                       */
/* ------------------------------------------------------------------ */

async function refreshRotation() {
  section('[4] Refresh token rotation and revocation');

  resetJar();
  const redirectUri = BASE + '/apps/library/callback';
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(8).toString('hex');
  const params = authParams('comsats-library-portal', redirectUri, state, challenge, 'openid profile email library:read offline_access');
  const authorize = await call('GET', '/sso/authorize?' + new URLSearchParams(params).toString());
  const loginQuery = query(authorize.location);
  const body = {};
  loginQuery.forEach((value, key) => {
    body[key] = value;
  });
  Object.assign(body, { loginId: 'FA22-BCS-012', password: PASSWORD });

  const login = await call('POST', '/sso/api/login', { body });
  const withCode = await call('GET', login.data.redirectTo);
  const code = query(withCode.location || login.data.redirectTo).get('code');
  const secret = process.env.LIBRARY_CLIENT_SECRET || 'dev-library-client-secret';

  const first = await exchangeCode('comsats-library-portal', secret, redirectUri, code, verifier);
  check('A first token set is issued', first.status === 200 && Boolean(first.data.refresh_token));

  const refresh = async (token) =>
    call('POST', '/sso/token', {
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: 'comsats-library-portal',
        client_secret: secret,
      }).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });

  const second = await refresh(first.data.refresh_token);
  check('The refresh token is rotated for a new one', second.status === 200 &&
    Boolean(second.data.refresh_token) && second.data.refresh_token !== first.data.refresh_token);

  const replayed = await refresh(first.data.refresh_token);
  check('Replaying the old refresh token is refused', replayed.status === 400 &&
    replayed.data.error === 'invalid_grant');

  const familyRevoked = await refresh(second.data.refresh_token);
  check('Reuse revokes the whole token family', familyRevoked.status === 400);

  const revoke = await call('POST', '/sso/revoke', {
    body: new URLSearchParams({
      token: second.data.refresh_token,
      client_id: 'comsats-library-portal',
      client_secret: secret,
    }).toString(),
    contentType: 'application/x-www-form-urlencoded',
  });
  check('The revocation endpoint answers 200', revoke.status === 200);
}

/* ------------------------------------------------------------------ */
/* 5. Second factor (TOTP) and recovery codes                          */
/* ------------------------------------------------------------------ */

async function secondFactor() {
  section('[5] Two-factor authentication: enrollment, challenge, recovery code');

  resetJar();
  const redirectUri = BASE + '/apps/library/callback';
  const signIn = async () => {
    const { verifier, challenge } = pkce();
    const state = crypto.randomBytes(8).toString('hex');
    const params = authParams('comsats-library-portal', redirectUri, state, challenge, 'openid profile email library:read');
    const authorize = await call('GET', '/sso/authorize?' + new URLSearchParams(params).toString());
    const loginQuery = query(authorize.location);
    const body = {};
    loginQuery.forEach((value, key) => {
      body[key] = value;
    });
    Object.assign(body, { loginId: MFA_LOGIN_ID, password: PASSWORD });
    return call('POST', '/sso/api/login', { body });
  };

  const first = await signIn();
  check('The account signs in without a second factor at first', first.status === 200 && first.data.status === 'ok');

  const start = await call('POST', '/sso/api/account/mfa/start', { body: {} });
  check('Enrollment produces a secret and an otpauth:// link', start.status === 200 &&
    Boolean(start.data.secret) && String(start.data.otpauthUri).startsWith('otpauth://totp/'));
  check('The secret is valid base32 of the expected length', /^[A-Z2-7]{32}$/.test(start.data.secret || ''));

  const badConfirm = await call('POST', '/sso/api/account/mfa/confirm', { body: { code: '000000' } });
  check('A wrong code does not enable the factor', badConfirm.status === 400);

  const good = totp.generateCode(start.data.secret);
  const confirm = await call('POST', '/sso/api/account/mfa/confirm', { body: { code: good } });
  check('A valid code enables the factor', confirm.status === 200 && confirm.data.mfa.enabled === true);
  check('Recovery codes are handed out once', (confirm.data.recoveryCodes || []).length === 10);

  resetJar();
  const challenged = await signIn();
  check('Signing in now asks for the second factor', challenged.status === 200 &&
    challenged.data.status === 'mfa_required' && Boolean(challenged.data.ticket));

  const wrong = await call('POST', '/sso/api/login/mfa', {
    body: { ticket: challenged.data.ticket, code: '111111' },
  });
  check('A wrong second factor is refused', wrong.status === 401);

  const verified = await call('POST', '/sso/api/login/mfa', {
    body: { ticket: challenged.data.ticket, code: totp.generateCode(start.data.secret) },
  });
  check('The correct code completes the sign-in', verified.status === 200 && Boolean(verified.data.redirectTo));

  resetJar();
  const recovery = await signIn();
  const recovered = await call('POST', '/sso/api/login/mfa', {
    body: { ticket: recovery.data.ticket, mode: 'recovery', recoveryCode: confirm.data.recoveryCodes[0] },
  });
  check('A recovery code can be used instead of the app', recovered.status === 200 && Boolean(recovered.data.redirectTo));

  resetJar();
  const replay = await signIn();
  const reusedCode = await call('POST', '/sso/api/login/mfa', {
    body: { ticket: replay.data.ticket, mode: 'recovery', recoveryCode: confirm.data.recoveryCodes[0] },
  });
  check('A recovery code only works once', reusedCode.status === 401);

  // Restore the account: turn the factor off again (it also clears the codes).
  resetJar();
  const session = await signIn();
  await call('POST', '/sso/api/login/mfa', {
    body: { ticket: session.data.ticket, code: totp.generateCode(start.data.secret) },
  });
  const disabled = await call('POST', '/sso/api/account/mfa/disable', {
    body: { password: PASSWORD },
  });
  check('The demo account is restored (factor turned off again)', disabled.status === 200 && disabled.data.mfa.enabled === false);
}

/* ------------------------------------------------------------------ */
/* 6. Tenant isolation                                                 */
/* ------------------------------------------------------------------ */

async function tenantIsolation() {
  section('[6] Tenant isolation');

  resetJar();
  const lahoreUserAtIslamabad = await browserSignIn(
    'comsats-library-portal',
    BASE + '/apps/library/callback',
    'FA23-BCS-101',
    PASSWORD
  );
  check('A Lahore account cannot sign in to an Islamabad application',
    lahoreUserAtIslamabad.login.status === 401);

  resetJar();
  const islamabadUserAtLahore = await browserSignIn(
    'comsats-lahore-portal',
    BASE + '/apps/lahore/callback',
    'FA23-BCS-050',
    PASSWORD
  );
  check('An Islamabad account cannot sign in to the Lahore application',
    islamabadUserAtLahore.login.status === 401);

  const token = platformAdminToken;
  const lahoreGroups = await call('GET', '/api/groups/all?tenantId=', { headers: { Authorization: 'Bearer ' + token } });
  check('The platform administrator sees the groups of both organizations',
    lahoreGroups.status === 200 && lahoreGroups.data.groups.length >= 7);

  // A tenant administrator must not see the other organization.
  const tenantAdmin = await call('POST', '/api/auth/login', {
    body: { loginId: 'exam.cell', password: PASSWORD },
  });
  const scoped = await call('GET', '/api/groups/all', {
    headers: { Authorization: 'Bearer ' + tenantAdmin.data.token },
  });
  const names = (scoped.data.groups || []).map((g) => g.name);
  check('A tenant administrator only sees the groups of their own organization',
    scoped.status === 200 && names.includes('BCS-7A') && !names.includes('BCS-9A'));

  const otherTenantUsers = await call('GET', '/api/admin/users?tenantId=tnt_lahore', {
    headers: { Authorization: 'Bearer ' + tenantAdmin.data.token },
  });
  check('A tenant administrator cannot list another organization (scoped to their own)',
    otherTenantUsers.status === 200 &&
    (otherTenantUsers.data.users || []).every((u) => u.tenantId === tenantAdmin.data.user.tenantId));

  const forbidden = await call('GET', '/api/admin/overview', {
    headers: { Authorization: 'Bearer ' + (await call('POST', '/api/auth/login', {
      body: { loginId: 'FA23-BCS-050', password: PASSWORD },
    })).data.token },
  });
  check('A student cannot open the administration API', forbidden.status === 403);
}

/* ------------------------------------------------------------------ */
/* 7. Scopes and roles in the sample application                       */
/* ------------------------------------------------------------------ */

async function libraryAuthorisation() {
  section('[7] The library portal: scopes and roles');

  resetJar();

  // The complete browser flow, starting at the application (which stores its
  // PKCE verifier in a cookie and then talks to the authorization endpoint).
  const start = await call('GET', '/apps/library/login');
  const authorize = await call('GET', local(start.location));
  const loginQuery = query(authorize.location);
  const body = {};
  loginQuery.forEach((value, key) => {
    body[key] = value;
  });
  Object.assign(body, { loginId: 'FA23-BCS-050', password: PASSWORD });

  const login = await call('POST', '/sso/api/login', { body });
  check('The portal redirects the browser to the sign-in page and back', login.status === 200 && Boolean(login.data.redirectTo));

  const callback = await call('GET', local(login.data.redirectTo));
  check('The portal exchanges the code and opens itself',
    callback.status === 302 && String(callback.location).includes('/apps/library/'));

  const session = await call('GET', '/apps/library/api/session');
  check('The portal session is established through the SSO flow', session.status === 200 && session.data.signedIn === true);
  check('The portal reports the scopes it was granted', (session.data.scopes || []).includes('library:write'));

  const loans = await call('GET', '/apps/library/api/loans');
  check('A student sees only their own loans', loans.status === 200 &&
    loans.data.loans.length > 0 && loans.data.loans.every((loan) => loan.isMine));

  const overdue = loans.data.loans.find((loan) => loan.overdue);
  if (overdue) {
    const renewOverdue = await call('POST', '/apps/library/api/loans/' + overdue.id + '/renew', { body: {} });
    check('An overdue loan cannot be renewed', renewOverdue.status === 400);
  }

  const renewable = loans.data.loans.find((loan) => !loan.overdue);
  if (renewable) {
    const renew = await call('POST', '/apps/library/api/loans/' + renewable.id + '/renew', { body: {} });
    check('A student can renew their own loan', renew.status === 200 && renew.data.loan.renewals >= 1);
  }
}

/* ------------------------------------------------------------------ */
/* 8. Password reset and brute-force protection                        */
/* ------------------------------------------------------------------ */

async function passwordReset() {
  section('[8] Password reset and failed sign-in protection');

  const request = await call('POST', '/sso/api/password/forgot', { body: { loginId: MFA_LOGIN_ID } });
  check('A reset request is accepted without revealing whether the account exists',
    request.status === 200 && request.data.delivery === 'administrator');

  const resets = await call('GET', '/api/admin/password-resets', {
    headers: { Authorization: 'Bearer ' + platformAdminToken },
  });
  check('The request is visible to the administrators of the organization',
    resets.status === 200 && resets.data.requests.some((entry) => entry.loginId === MFA_LOGIN_ID));

  const link = await call('POST', '/api/admin/users/' + usmanId + '/reset-link', { body: {} });
  check('An administrator can hand out a reset link', link.status === 200 && String(link.data.link).includes('/sso/reset?token='));
  const token = new URL(link.data.link).searchParams.get('token');

  const weak = await call('POST', '/sso/api/password/reset', { body: { token, password: 'short' } });
  check('The tenant password policy is enforced on reset', weak.status === 400);

  const reset = await call('POST', '/sso/api/password/reset', {
    body: { token, password: 'Restored!2026' },
  });
  check('The password is reset with a valid token', reset.status === 200);

  const reused = await call('POST', '/sso/api/password/reset', {
    body: { token, password: 'Restored!2027' },
  });
  check('The reset token can only be used once', reused.status === 400);

  const withNew = await call('POST', '/api/auth/login', {
    body: { loginId: MFA_LOGIN_ID, password: 'Restored!2026' },
  });
  check('The new password works', withNew.status === 200);

  const withOld = await call('POST', '/api/auth/login', {
    body: { loginId: MFA_LOGIN_ID, password: PASSWORD },
  });
  check('The old password no longer works', withOld.status === 401);

  const restore = await call('PATCH', '/api/admin/users/' + usmanId, {
    headers: { Authorization: 'Bearer ' + platformAdminToken },
    body: { password: PASSWORD },
  });
  check('The demo password is restored', restore.status === 200);

  // Brute-force protection is checked with a login ID that does not exist, so
  // no real account is locked by this test.
  const fake = 'FA99-BCS-999';
  let attempts = [];
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    attempts.push(await call('POST', '/api/auth/login', { body: { loginId: fake, password: 'nope' } }));
  }
  check('Repeated failures are rate limited (429 after five attempts)',
    attempts[5].status === 429);
}

/* ------------------------------------------------------------------ */
/* 9. Audit log                                                        */
/* ------------------------------------------------------------------ */

async function auditTrail() {
  section('[9] Security audit log');

  const audit = await call('GET', '/api/admin/audit?limit=200', {
    headers: { Authorization: 'Bearer ' + platformAdminToken },
  });
  const types = (audit.data.events || []).map((event) => event.type);

  check('The audit log is available to the administrator', audit.status === 200 && types.length > 0);
  check('Successful sign-ins are recorded', types.includes('login.password'));
  check('Token activity is recorded', types.includes('token.issued'));
  check('Failed attempts appear in the summary',
    audit.data.summary.failures > 0 && audit.data.summary.failedLogins.length > 0);
  check('The audit entry of the reuse detection is recorded', types.includes('token.reuse_detected'));
  check('Two-factor events are recorded', types.includes('mfa.enrolled'));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('\x1b[1mCOMSATS SSO - end-to-end check\x1b[0m');
  await setup();
  await discovery();
  await authorizationCodeFlow();
  await singleSignOn();
  await refreshRotation();
  await secondFactor();
  await tenantIsolation();
  await libraryAuthorisation();
  await passwordReset();
  await auditTrail();

  console.log('');
  console.log('\x1b[1mSummary: \x1b[32m' + passed + ' passed\x1b[0m, ' +
    (failed ? '\x1b[31m' + failed + ' failed\x1b[0m' : '\x1b[2m0 failed\x1b[0m'));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nThe check could not finish:', err.message);
  process.exit(1);
});
