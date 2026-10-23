'use strict';

/* Shared helpers for every page: session, REST calls, socket requests, DOM helpers. */
(function () {
  const TOKEN_KEY = 'connect.token';
  const USER_KEY = 'connect.user';

  /* ---------- Session (per browser tab, so you can test several users at once) ---------- */

  const session = {
    token() {
      return sessionStorage.getItem(TOKEN_KEY);
    },
    user() {
      try {
        return JSON.parse(sessionStorage.getItem(USER_KEY));
      } catch (err) {
        return null;
      }
    },
    save(token, user) {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    },
  };

  /* ---------- Sign-in through the single sign-on platform ----------
     The chat is an OAuth client of the SSO platform: /apps/chat/login starts
     the authorization code flow, and this endpoint hands the browser a
     short-lived access token (refreshing it server-side when necessary). */

  let bootstrap = null;

  function signIn() {
    location.replace('/apps/chat/login');
  }

  async function ensureSession() {
    if (session.token()) return session.user();

    if (!bootstrap) {
      bootstrap = fetch('/apps/chat/api/session', { headers: { Accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (data && data.token) session.save(data.token, data.user);
          return data ? data.user : null;
        })
        .catch(() => null);
    }
    return bootstrap;
  }

  async function requireLogin() {
    const user = await ensureSession();
    if (!user) {
      signIn();
      return false;
    }
    return true;
  }

  // Asks the chat backend for a fresh access token, using the session cookie.
  async function refreshSession() {
    bootstrap = null;
    try {
      const response = await fetch('/apps/chat/api/session', { headers: { Accept: 'application/json' } });
      if (!response.ok) return false;
      const data = await response.json();
      session.save(data.token, data.user);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function logout() {
    try {
      await fetch('/apps/chat/logout', { method: 'POST', headers: { Accept: 'application/json' } });
    } catch (err) {
      // Signing out locally still works when the server cannot be reached.
    }
    session.clear();
    // Single sign-out: the platform session ends as well.
    location.assign('/sso/end-session');
  }

  function expireSession() {
    session.clear();
    signIn();
  }

  /* ---------- REST ---------- */

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  async function send(path, opts) {
    const headers = { Accept: 'application/json' };
    const token = session.token();

    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check that it is running.');
    }

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    return { response, data, token };
  }

  async function api(path, options) {
    const opts = options || {};
    let attempt = await send(path, opts);

    // An expired access token is refreshed once through the chat backend, so a
    // session keeps working without sending the user back to the sign-in page.
    if (attempt.response.status === 401 && opts.skipAuthRedirect !== true) {
      if (await refreshSession()) {
        attempt = await send(path, opts);
      }
    }

    if (!attempt.response.ok) {
      const info = (attempt.data && attempt.data.error) || {};
      const error = new ApiError(
        attempt.response.status,
        info.code || 'ERROR',
        info.message || 'Request failed (' + attempt.response.status + ').'
      );
      if (attempt.response.status === 401 && opts.skipAuthRedirect !== true) {
        expireSession();
      }
      throw error;
    }
    return attempt.data;
  }

  /* ---------- Socket.IO ---------- */

  // The io() function comes from /socket.io/socket.io.js, loaded by the chat page.
  function connectSocket() {
    return io({ auth: { token: session.token() } });
  }

  // Sends an event and waits for the server's acknowledgement.
  // Resolves with the reply, or rejects with an ApiError carrying the server's reason.
  function request(socket, event, payload) {
    return new Promise((resolve, reject) => {
      socket.timeout(8000).emit(event, payload || {}, (err, reply) => {
        if (err) {
          return reject(new ApiError(0, 'TIMEOUT', 'The server did not respond. Try again.'));
        }
        if (!reply || !reply.ok) {
          const info = (reply && reply.error) || {};
          return reject(new ApiError(0, info.code || 'ERROR', info.message || 'Request failed.'));
        }
        resolve(reply);
      });
    });
  }

  /* ---------- DOM helpers (text goes in with textContent, never innerHTML) ---------- */

  function el(tag, attrs) {
    const node = document.createElement(tag);
    const attributes = attrs || {};

    Object.keys(attributes).forEach((key) => {
      const value = attributes[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.indexOf('on') === 0 && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? '' : value);
    });

    Array.prototype.slice.call(arguments, 2).flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function toast(message, kind) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
      document.body.append(box);
    }
    const item = el('div', {
      class: 'toast' + (kind ? ' toast-' + kind : ''),
      role: kind === 'error' ? 'alert' : 'status',
      text: message,
    });
    box.append(item);
    setTimeout(() => item.remove(), kind === 'error' ? 6000 : 3500);
  }

  /* ---------- Labels and small formatters ---------- */

  const TYPE_LABELS = {
    class: 'Class',
    course: 'Course',
    department: 'Department',
    society: 'Society',
    fyp: 'FYP team',
    office: 'Office',
  };

  // Order and names of the sections in the group list
  const TYPE_SECTIONS = [
    ['class', 'Classes'],
    ['course', 'Courses'],
    ['department', 'Departments'],
    ['office', 'Offices'],
    ['society', 'Societies'],
    ['fyp', 'FYP teams'],
  ];

  const POLICY_LABELS = {
    everyone: 'Everyone can post',
    faculty_only: 'Faculty and admins post',
    admin_only: 'Admins post',
  };

  const POLICY_ROLES = {
    everyone: ['admin', 'faculty', 'student'],
    faculty_only: ['admin', 'faculty'],
    admin_only: ['admin'],
  };

  // UI hint only. The server enforces the real rule on every message.
  function postState(user, group) {
    if (group.muted) {
      return { allowed: false, reason: 'You have been muted in this group. You can read but not post.' };
    }
    const roles = POLICY_ROLES[group.postPolicy] || [];
    if (!roles.includes(user.role)) {
      return {
        allowed: false,
        reason:
          group.postPolicy === 'admin_only'
            ? 'Read-only. Only admins can post in this group.'
            : 'Read-only. Only faculty and admins can post in this group.',
      };
    }
    return { allowed: true, reason: '' };
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === new Date().toDateString()) return time;
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join('');
  }

  window.Connect = {
    session,
    requireLogin,
    ensureSession,
    refreshSession,
    signIn,
    logout,
    ApiError,
    api,
    connectSocket,
    request,
    el,
    toast,
    TYPE_LABELS,
    TYPE_SECTIONS,
    POLICY_LABELS,
    postState,
    formatTime,
    initials,
  };
})();
