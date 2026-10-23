'use strict';

/*
 * Keep the bundled sample applications reachable.
 *
 * The address a deployment is served from (`PUBLIC_BASE_URL`) is not fixed: in
 * the hosted/preview environment it changes whenever the environment is
 * recreated. The three sample applications register their callback there, so
 * after such a change the redirect URI they send no longer matches the one
 * stored for them, and the authorization endpoint refuses the request with
 * `BAD_REDIRECT_URI` (redirect URIs are compared exactly).
 *
 * This points those three applications back at the current `PUBLIC_BASE_URL`.
 * Only the callback path of a bundled application is touched: localhost
 * entries (handy for local development, where the base is localhost anyway)
 * and any other redirect URI an administrator registered are left alone.
 */

const { SERVER } = require('../config/policies');
const clientApps = require('./clientAppService');

const BUNDLED_APPS = [
  { clientId: process.env.CHAT_CLIENT_ID || 'comsats-connect-chat', path: '/apps/chat/callback' },
  { clientId: process.env.LIBRARY_CLIENT_ID || 'comsats-library-portal', path: '/apps/library/callback' },
  { clientId: process.env.LAHORE_CLIENT_ID || 'comsats-lahore-portal', path: '/apps/lahore/callback' },
];

function parts(uri) {
  try {
    return new URL(uri);
  } catch (err) {
    return null;
  }
}

function isLoopback(uri) {
  const url = parts(uri);
  return Boolean(url) && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

// The callback for this application, served from somewhere else.
function isStaleCallback(uri, path) {
  const url = parts(uri);
  return Boolean(url) && !isLoopback(uri) && url.pathname === path;
}

function redirectsFor(current, baseUri, path) {
  const kept = current.filter((uri) => !isStaleCallback(uri, path));
  const next = kept.includes(baseUri) ? kept : kept.concat([baseUri]);
  const unchanged = next.length === current.length && next.every((uri, i) => uri === current[i]);
  return unchanged ? null : next;
}

// Returns the client ids whose redirect URIs were updated.
function syncBundledAppRedirects() {
  const updated = [];

  BUNDLED_APPS.forEach(({ clientId, path }) => {
    const app = clientApps.getByClientId(clientId);
    if (!app) return;

    const next = redirectsFor(app.redirectUris || [], SERVER.PUBLIC_BASE_URL + path, path);
    if (!next) return;

    clientApps.updateApp(app.id, { redirectUris: next });
    updated.push(clientId);
  });

  return updated;
}

module.exports = { syncBundledAppRedirects };
