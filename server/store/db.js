'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER, LIMITS } = require('../config/policies');

/* ------------------------------------------------------------------ */
/* Shared error type (used by every service, handled in Phase 2)       */
/* ------------------------------------------------------------------ */

class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code || 'ERROR';
  }
}

/* ------------------------------------------------------------------ */
/* JSON file store                                                     */
/* ------------------------------------------------------------------ */

function emptyData() {
  return {
    // Identity provider (SSO) data
    tenants: [],
    clientApps: [],
    authCodes: [],
    refreshTokens: [],
    sessions: [],
    auditLogs: [],
    passwordResets: [],
    // Sessions of the sample client applications, and their demo data
    appSessions: [],
    libraryLoans: [],
    // Chat application data
    users: [],
    groups: [],
    memberships: [],
    messages: [],
    directMessages: [],
  };
}

let data = null;
let saveTimer = null;

function flush() {
  if (!data) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  fs.mkdirSync(path.dirname(SERVER.DB_FILE), { recursive: true });
  const tmpFile = SERVER.DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, SERVER.DB_FILE);
}

function load() {
  if (data) return data;

  fs.mkdirSync(path.dirname(SERVER.DB_FILE), { recursive: true });

  if (fs.existsSync(SERVER.DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SERVER.DB_FILE, 'utf8'));
      data = Object.assign(emptyData(), parsed);
    } catch (err) {
      const backup = SERVER.DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(SERVER.DB_FILE, backup);
      console.error(
        '[db] db.json could not be parsed. A backup was saved to ' +
          backup +
          ' and a fresh database was created.'
      );
      data = emptyData();
      flush();
    }
  } else {
    data = emptyData();
    flush();
  }

  return data;
}

// Writes are batched: many messages in a burst cause one disk write.
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 200);
  if (saveTimer.unref) saveTimer.unref();
}

function collection(name) {
  const store = load();
  if (!Array.isArray(store[name])) {
    throw new Error('Unknown collection: ' + name);
  }
  return store[name];
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function reset() {
  data = emptyData();
  flush();
}

// Returns the newest `limit` items (oldest first). `before` is an ISO
// timestamp used for paging backwards. Items must be in chronological order.
function latest(items, options) {
  const opts = options || {};
  let limit = parseInt(opts.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = LIMITS.HISTORY_LIMIT;
  limit = Math.min(limit, 200);

  let list = items;
  if (opts.before) {
    list = list.filter((item) => item.createdAt < opts.before);
  }
  return list.slice(-limit);
}

/* ------------------------------------------------------------------ */
/* Make sure pending writes reach the disk when the process stops      */
/* ------------------------------------------------------------------ */

process.on('exit', flush);

process.on('SIGINT', () => {
  flush();
  process.exit(0);
});

process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});

// nodemon restarts the app with SIGUSR2
process.once('SIGUSR2', () => {
  flush();
  process.kill(process.pid, 'SIGUSR2');
});

module.exports = {
  AppError,
  collection,
  save,
  flush,
  reset,
  newId,
  latest,
};