'use strict';

require('dotenv').config();

const path = require('path');

/* ------------------------------------------------------------------ */
/* Roles, group types, posting policies                                */
/* ------------------------------------------------------------------ */

// Platform-wide (global) roles.
//   admin        - platform administrator, manages every tenant
//   tenant_admin - administrator of one organization (tenant)
//   faculty      - teaching staff inside a tenant
//   student      - student inside a tenant
const ROLES = Object.freeze({
  ADMIN: 'admin',
  TENANT_ADMIN: 'tenant_admin',
  FACULTY: 'faculty',
  STUDENT: 'student',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

const GROUP_TYPES = Object.freeze({
  CLASS: 'class', // e.g. BCS-7A
  COURSE: 'course', // e.g. CSC334 Parallel and Distributed Computing
  DEPARTMENT: 'department', // e.g. Department of Computer Science
  SOCIETY: 'society', // e.g. ACM Student Chapter
  FYP: 'fyp', // final year project team
  OFFICE: 'office', // e.g. Exam Cell, Admissions Office
});

const POST_POLICIES = Object.freeze({
  EVERYONE: 'everyone', // every unmuted member can post
  FACULTY_ONLY: 'faculty_only', // members can read; only faculty/admin members can post
  ADMIN_ONLY: 'admin_only', // members can read; only admin members can post
});

// Which user roles may post under each policy
const POST_POLICY_ALLOWED_ROLES = Object.freeze({
  everyone: ['admin', 'tenant_admin', 'faculty', 'student'],
  faculty_only: ['admin', 'tenant_admin', 'faculty'],
  admin_only: ['admin', 'tenant_admin'],
});

/* ------------------------------------------------------------------ */
/* Who may create which kind of group                                  */
/* ------------------------------------------------------------------ */

const GROUP_CREATION_RULES = Object.freeze({
  admin: {
    types: Object.values(GROUP_TYPES),
    policies: Object.values(POST_POLICIES),
  },
  tenant_admin: {
    types: Object.values(GROUP_TYPES),
    policies: Object.values(POST_POLICIES),
  },
  faculty: {
    types: [GROUP_TYPES.COURSE, GROUP_TYPES.FYP],
    policies: [POST_POLICIES.EVERYONE, POST_POLICIES.FACULTY_ONLY],
  },
  student: {
    types: [GROUP_TYPES.SOCIETY, GROUP_TYPES.FYP],
    policies: [POST_POLICIES.EVERYONE],
  },
});

/* ------------------------------------------------------------------ */
/* Direct message boundaries (rule applies to the SENDER's role)       */
/* ------------------------------------------------------------------ */

const DM_RULES = Object.freeze({
  admin: 'anyone',
  tenant_admin: 'anyone',
  faculty: 'anyone',
  // students may DM someone only if they share a group with them,
  // or if that person has already messaged them first
  student: 'shared_group_or_replied',
});

/* ------------------------------------------------------------------ */
/* COMSATS departments and login ID formats                            */
/* ------------------------------------------------------------------ */

const DEPARTMENTS = Object.freeze([
  'Computer Science',
  'Electrical and Computer Engineering',
  'Management Sciences',
  'Mathematics',
  'Physics',
  'Chemistry',
  'Bioscience',
  'Humanities',
  'Pharmacy',
  'Civil Engineering',
  'Meteorology',
  'Administration',
]);

// Students log in with their registration number, e.g. FA22-BCS-045
// Faculty, tenant admins and platform admins use a username, e.g. dr.ahmed
const LOGIN_ID_PATTERNS = Object.freeze({
  student: /^(FA|SP)\d{2}-[A-Z]{3}-\d{3}$/,
  faculty: /^[a-z0-9._-]{3,30}$/i,
  tenant_admin: /^[a-z0-9._-]{3,30}$/i,
  admin: /^[a-z0-9._-]{3,30}$/i,
});

/* ------------------------------------------------------------------ */
/* Socket.IO event names (shared by server and demo client)            */
/* ------------------------------------------------------------------ */

const EVENTS = Object.freeze({
  // client -> server (with acknowledgement callback)
  GROUP_MESSAGE: 'group:message',
  DIRECT_MESSAGE: 'direct:message',
  GROUP_HISTORY: 'group:history',
  DIRECT_HISTORY: 'direct:history',
  MY_GROUPS: 'groups:list',
  TYPING: 'typing',
  // server -> client (pushed)
  PRESENCE: 'presence:update',
  GROUP_ADDED: 'group:added',
  GROUP_REMOVED: 'group:removed',
  GROUP_UPDATED: 'group:updated',
});

/* ------------------------------------------------------------------ */
/* Numeric limits (overridable through .env)                           */
/* ------------------------------------------------------------------ */

function toInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const LIMITS = Object.freeze({
  MESSAGE_MAX_LENGTH: toInt(process.env.MESSAGE_MAX_LENGTH, 2000),
  RATE_LIMIT_MESSAGES: toInt(process.env.RATE_LIMIT_MESSAGES, 10),
  RATE_LIMIT_WINDOW_MS: toInt(process.env.RATE_LIMIT_WINDOW_MS, 10000),
  HISTORY_LIMIT: toInt(process.env.HISTORY_LIMIT, 50),
  MIN_PASSWORD_LENGTH: 8,
  MAX_GROUP_NAME_LENGTH: 60,
  MAX_GROUP_MEMBERS: 500,
});

/* ------------------------------------------------------------------ */
/* Server and auth settings                                            */
/* ------------------------------------------------------------------ */

function stripSlash(url) {
  return String(url).replace(/\/+$/, '');
}

const PORT = toInt(process.env.PORT, 3000);

// Absolute address the browser uses to reach this server. Needed to build
// OAuth 2.0 / OIDC redirect URIs, the issuer claim and social-login callbacks.
const PUBLIC_BASE_URL = stripSlash(process.env.PUBLIC_BASE_URL || 'http://localhost:' + PORT);

const SERVER = Object.freeze({
  PORT,
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || '*',
  DB_FILE: path.join(__dirname, '..', 'data', 'db.json'),
  KEYS_FILE: path.join(__dirname, '..', 'data', 'keys.json'),
  PUBLIC_BASE_URL,
  // Behind the sandbox preview proxy the request is not the client. Only the
  // platform's preview environment is trusted this way; local runs are not.
  TRUST_PROXY: process.env.BASE44_PREVIEW_MODE === '1',
  IS_PREVIEW: process.env.BASE44_PREVIEW_MODE === '1',
});

const AUTH = Object.freeze({
  BCRYPT_ROUNDS: 10,
});

/* ------------------------------------------------------------------ */
/* Single sign-on (OAuth 2.0 / OpenID Connect provider) settings        */
/* ------------------------------------------------------------------ */

const SSO = Object.freeze({
  // Issuer identifier used in the iss claim and the discovery document.
  ISSUER: stripSlash(process.env.SSO_ISSUER || PUBLIC_BASE_URL),
  AUTH_CODE_TTL_SECONDS: 120,
  // Short-lived signed tickets used between the password step and the MFA step.
  TICKET_TTL_MINUTES: 10,
  ID_TOKEN_TTL_SECONDS: 900,
  LOGIN_TICKET_AUDIENCE: 'sso:login-ticket',
  SCOPES: ['openid', 'profile', 'email', 'offline_access', 'chat:read', 'chat:write', 'library:read', 'library:write'],
});

// Tenant settings that administrators are allowed to change. Values are
// clamped to the ranges below ("within safe platform limits").
const TOKEN_LIMITS = Object.freeze({
  accessTtlSeconds: { min: 60, max: 3600, fallback: 900 },
  refreshTtlDays: { min: 1, max: 90, fallback: 30 },
  sessionTtlHours: { min: 1, max: 72, fallback: 12 },
  idTokenTtlSeconds: { min: 60, max: 3600, fallback: 900 },
});

const PASSWORD_POLICY_LIMITS = Object.freeze({
  minLength: { min: 8, max: 64, fallback: 10 },
  maxFailedLogins: { min: 3, max: 20, fallback: 5 },
  lockoutMinutes: { min: 1, max: 120, fallback: 15 },
});

const SOCIAL_PROVIDERS = Object.freeze(['google', 'facebook']);

const DEFAULT_TENANT_SETTINGS = Object.freeze({
  // Require every member of the tenant to use a second factor
  mfaRequired: false,
  // Let people create their own account from the sign-in page
  allowSelfRegistration: true,
  // Which social providers this tenant accepts (also needs .env credentials)
  socialProviders: { google: false, facebook: false },
  tokens: {
    accessTtlSeconds: 900,
    refreshTtlDays: 30,
    sessionTtlHours: 12,
    idTokenTtlSeconds: 900,
  },
  passwordPolicy: {
    minLength: 10,
    requireUpper: true,
    requireLower: true,
    requireNumber: true,
    requireSymbol: false,
  },
  maxFailedLogins: 5,
  lockoutMinutes: 15,
});

// Credentials for the social providers. They are optional: when a provider is
// not configured the buttons are disabled and the tenant switch has no effect.
const SOCIAL = Object.freeze({
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    scope: 'openid email profile',
  },
  facebook: {
    clientId: process.env.FACEBOOK_APP_ID || '',
    clientSecret: process.env.FACEBOOK_APP_SECRET || '',
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    userInfoUrl: 'https://graph.facebook.com/me?fields=id,name,email',
    scope: 'email public_profile',
  },
});

function isSocialConfigured(provider) {
  const config = SOCIAL[provider];
  return Boolean(config && config.clientId && config.clientSecret);
}

function socialRedirectUri(provider) {
  return PUBLIC_BASE_URL + '/sso/social/' + provider + '/callback';
}

module.exports = {
  ROLES,
  ALL_ROLES,
  GROUP_TYPES,
  POST_POLICIES,
  POST_POLICY_ALLOWED_ROLES,
  GROUP_CREATION_RULES,
  DM_RULES,
  DEPARTMENTS,
  LOGIN_ID_PATTERNS,
  EVENTS,
  LIMITS,
  SERVER,
  AUTH,
  SSO,
  TOKEN_LIMITS,
  PASSWORD_POLICY_LIMITS,
  SOCIAL_PROVIDERS,
  DEFAULT_TENANT_SETTINGS,
  SOCIAL,
  isSocialConfigured,
  socialRedirectUri,
};
