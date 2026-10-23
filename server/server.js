'use strict';

/*
 * COMSATS Connect server: the SSO platform plus the sample applications.
 *
 *   /sso/...          single sign-on (OAuth 2.0 / OpenID Connect provider)
 *   /api/auth/...     first-party login API (same tokens as the SSO flow)
 *   /api/admin/...    administration of tenants, applications, policies, audit
 *   /api/users|groups|...  the chat application API
 *   /apps/chat/...    sample application 1: COMSATS Connect chat
 *   /apps/library/... sample application 2: COMSATS Library portal
 *   /public           the pages themselves
 */

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');

const {
  SERVER,
  ROLES,
  GROUP_TYPES,
  POST_POLICIES,
  GROUP_CREATION_RULES,
  DEPARTMENTS,
  LIMITS,
  SSO,
  SOCIAL_PROVIDERS,
  isSocialConfigured,
  socialRedirectUri,
} = require('./config/policies');

const authRoutes = require('./routes/authRoutes');
const ssoRoutes = require('./routes/ssoRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const groupRoutes = require('./routes/groupRoutes');
const chatApp = require('./apps/chatApp');
const libraryApp = require('./apps/libraryApp');
const { attachSockets } = require('./sockets');
const ssoService = require('./services/ssoService');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
const server = http.createServer(app);

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */

const corsOrigin =
  SERVER.CLIENT_ORIGIN === '*'
    ? true
    : SERVER.CLIENT_ORIGIN.split(',').map((origin) => origin.trim());

// Behind the preview proxy the app is reachable over https even though the
// request that reaches us is plain http, and req.ip must come from the proxy
// header. Only the preview environment is trusted this way.
if (SERVER.TRUST_PROXY) app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ */
/* Socket.IO (routes reach it through app.get('io'))                   */
/* ------------------------------------------------------------------ */

const io = attachSockets(server, corsOrigin);
app.set('io', io);

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Public description of the platform, handy for clients and for the demo
app.get('/api/meta', (req, res) => {
  res.json({
    roles: Object.values(ROLES),
    groupTypes: Object.values(GROUP_TYPES),
    postPolicies: Object.values(POST_POLICIES),
    groupCreationRules: GROUP_CREATION_RULES,
    departments: DEPARTMENTS,
    messageMaxLength: LIMITS.MESSAGE_MAX_LENGTH,
    sso: {
      issuer: SSO.ISSUER,
      authorizationEndpoint: SERVER.PUBLIC_BASE_URL + '/sso/authorize',
      tokenEndpoint: SERVER.PUBLIC_BASE_URL + '/sso/token',
      userinfoEndpoint: SERVER.PUBLIC_BASE_URL + '/sso/userinfo',
      discoveryEndpoint: SERVER.PUBLIC_BASE_URL + '/.well-known/openid-configuration',
      jwksUri: SERVER.PUBLIC_BASE_URL + '/sso/jwks.json',
      scopes: SSO.SCOPES,
    },
    socialProviders: SOCIAL_PROVIDERS.map((provider) => ({
      provider,
      configured: isSocialConfigured(provider),
      redirectUri: socialRedirectUri(provider),
    })),
  });
});

app.use('/', ssoRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/groups', groupRoutes);
app.use('/apps/chat', chatApp.router);
app.use('/apps/library', libraryApp.router);

app.use(notFound);
app.use(errorHandler);

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function start() {
  // Expired codes, sessions and tokens are cleaned up on every boot.
  ssoService.purgeExpired();

  server.listen(SERVER.PORT, () => {
    console.log('COMSATS Connect API running on http://localhost:' + SERVER.PORT);
    console.log('SSO issuer: ' + SSO.ISSUER);
    console.log('Socket.IO is ready for connections.');
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, server, io, start };
