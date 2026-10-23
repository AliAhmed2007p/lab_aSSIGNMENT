'use strict';

/*
 * Security audit log.
 *
 * Every authentication event (successful sign-in, failed password, MFA
 * challenge, token refresh, reuse of a rotated refresh token, policy change,
 * ...) is appended here. The dashboard reads it back to show "authentication
 * events and security audit logs" and to monitor failed sign-ins.
 */

const db = require('../store/db');

const MAX_ENTRIES = 5000;

function record(event) {
  const data = event || {};
  const req = data.req;

  const entry = {
    id: db.newId('evt'),
    at: new Date().toISOString(),
    type: data.type,
    outcome: data.outcome === 'failure' ? 'failure' : 'success',
    tenantId: data.tenantId || null,
    tenantName: data.tenantName || null,
    actorUserId: data.actorUserId || null,
    actorLoginId: data.actorLoginId || null,
    actorName: data.actorName || null,
    clientId: data.clientId || null,
    ip: data.ip || (req ? clientIp(req) : null),
    userAgent: data.userAgent || (req ? String(req.headers['user-agent'] || '').slice(0, 160) : null),
    detail: data.detail || null,
  };

  const logs = db.collection('auditLogs');
  logs.push(entry);

  // Keep the file bounded: drop the oldest entries once the cap is reached.
  if (logs.length > MAX_ENTRIES) logs.splice(0, logs.length - MAX_ENTRIES);
  db.save();

  const line = '[audit] ' + entry.type + ' ' + entry.outcome +
    (entry.actorLoginId ? ' loginId=' + entry.actorLoginId : '') +
    (entry.detail ? ' ' + (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)) : '');
  if (entry.outcome === 'failure') console.warn(line);
  else console.log(line);

  return entry;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || null;
}

function list(filters) {
  const f = filters || {};
  let entries = db.collection('auditLogs');

  if (f.tenantId) entries = entries.filter((e) => e.tenantId === f.tenantId);
  if (f.type) entries = entries.filter((e) => e.type === f.type);
  if (f.outcome) entries = entries.filter((e) => e.outcome === f.outcome);
  if (f.actorUserId) entries = entries.filter((e) => e.actorUserId === f.actorUserId);

  const limit = Math.min(500, Math.max(1, parseInt(f.limit, 10) || 100));
  return entries.slice(-limit).reverse();
}

// Counts used by the "failed sign-ins and suspicious activity" panel.
function summary(filters) {
  const f = filters || {};
  let entries = db.collection('auditLogs');
  if (f.tenantId) entries = entries.filter((e) => e.tenantId === f.tenantId);

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => new Date(e.at).getTime() >= since);

  const failedByAccount = new Map();
  const failuresByType = new Map();

  recent
    .filter((e) => e.outcome === 'failure')
    .forEach((e) => {
      const key = e.actorLoginId || '(unknown account)';
      const current = failedByAccount.get(key) || { loginId: key, count: 0, lastAt: e.at };
      current.count += 1;
      current.lastAt = e.at;
      failedByAccount.set(key, current);

      failuresByType.set(e.type, (failuresByType.get(e.type) || 0) + 1);
    });

  return {
    windowHours: 24,
    total: recent.length,
    successes: recent.filter((e) => e.outcome === 'success').length,
    failures: recent.filter((e) => e.outcome === 'failure').length,
    failedLogins: Array.from(failedByAccount.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    failureTypes: Array.from(failuresByType.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
  };
}

module.exports = { record, list, summary, MAX_ENTRIES };
