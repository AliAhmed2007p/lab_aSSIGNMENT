'use strict';

const { Server } = require('socket.io');
const { AppError } = require('../store/db');
const users = require('../services/userService');
const groups = require('../services/groupService');
const perm = require('../services/permissionService');
const { userFromToken } = require('../middleware/auth');
const { createRateLimiter } = require('./rateLimiter');
const { EVENTS, LIMITS } = require('../config/policies');

const userRoom = (userId) => 'user:' + userId;
const groupRoom = (groupId) => 'group:' + groupId;

/* ------------------------------------------------------------------ */
/* Payload helpers                                                     */
/* ------------------------------------------------------------------ */

function asObject(payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError(400, 'Payload must be an object.', 'BAD_PAYLOAD');
  }
  return payload;
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, '"' + field + '" is required.', 'BAD_PAYLOAD');
  }
  return value;
}

function errorReply(err) {
  if (err instanceof AppError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  console.error('[socket error]', err);
  return {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' },
  };
}

/* ------------------------------------------------------------------ */
/* Attach Socket.IO to the HTTP server                                 */
/* ------------------------------------------------------------------ */

function attachSockets(httpServer, corsOrigin) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 100 * 1024, // reject oversized payloads
  });

  // userId -> number of open sockets (one user may have several tabs)
  const onlineCounts = new Map();
  const isOnline = (userId) => (onlineCounts.get(userId) || 0) > 0;

  /* ---------------- Handshake authentication ---------------- */

  io.use((socket, next) => {
    try {
      const authToken = socket.handshake.auth && socket.handshake.auth.token;
      const header = socket.handshake.headers.authorization || '';
      const match = header.match(/^Bearer\s+(.+)$/i);
      const token = authToken || (match ? match[1].trim() : null);

      socket.data.user = userFromToken(token);
      next();
    } catch (err) {
      const rejection = new Error(err.message);
      rejection.data = { code: err.code || 'AUTH_ERROR' };
      next(rejection);
    }
  });

  /* ---------------- Presence ---------------- */

  // Presence is only shared with people who share a group with the user
  function broadcastPresence(user, online) {
    const rooms = groups.listGroupsForUser(user.id).map((g) => groupRoom(g.id));
    if (rooms.length === 0) return;

    rooms
      .reduce((operator, room) => operator.to(room), io)
      .emit(EVENTS.PRESENCE, { userId: user.id, name: user.name, online });
  }

  /* ---------------- Per-event wrapper ---------------- */

  // Re-reads the user on every event, so deactivation takes effect at once
  function currentUser(socket) {
    const user = users.getUserById(socket.data.user.id);
    if (!user || !user.active) {
      socket.disconnect(true);
      throw new AppError(403, 'This account has been deactivated.', 'ACCOUNT_DISABLED');
    }
    socket.data.user = user;
    return user;
  }

  // Registers one event with: acknowledgement handling, user refresh,
  // optional rate limiting, and uniform error replies.
  function register(socket, event, limiterName, handler) {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};

      try {
        const user = currentUser(socket);

        if (limiterName) {
          const verdict = socket.data[limiterName].consume();
          if (!verdict.allowed) {
            const seconds = Math.ceil(verdict.retryAfterMs / 1000);
            return reply({
              ok: false,
              error: {
                code: 'RATE_LIMITED',
                message: 'You are sending too fast. Try again in ' + seconds + ' second(s).',
                retryAfterMs: verdict.retryAfterMs,
              },
            });
          }
        }

        const result = handler(user, asObject(payload)) || {};
        reply(Object.assign({ ok: true }, result));
      } catch (err) {
        reply(errorReply(err));
      }
    });
  }

  /* ---------------- Connection ---------------- */

  io.on('connection', (socket) => {
    const user = socket.data.user;

    // Personal room plus one room per group the user belongs to.
    // This is the delivery boundary: no membership, no room, no events.
    socket.join(userRoom(user.id));
    groups.listGroupsForUser(user.id).forEach((g) => socket.join(groupRoom(g.id)));

    socket.data.messageLimiter = createRateLimiter({
      max: LIMITS.RATE_LIMIT_MESSAGES,
      windowMs: LIMITS.RATE_LIMIT_WINDOW_MS,
    });
    socket.data.typingLimiter = createRateLimiter({
      max: LIMITS.RATE_LIMIT_MESSAGES * 5,
      windowMs: LIMITS.RATE_LIMIT_WINDOW_MS,
    });

    const alreadyOnline = isOnline(user.id);
    onlineCounts.set(user.id, (onlineCounts.get(user.id) || 0) + 1);
    if (!alreadyOnline) broadcastPresence(user, true);

    console.log('[socket] connected: ' + user.loginId + ' (' + user.role + ')');

    /* ----- group:message ----- */
    register(socket, EVENTS.GROUP_MESSAGE, 'messageLimiter', (u, p) => {
      const message = groups.postMessage(u, requireString(p.groupId, 'groupId'), p.text);
      io.to(groupRoom(message.groupId)).emit(EVENTS.GROUP_MESSAGE, message);
      return { message };
    });

    /* ----- direct:message ----- */
    register(socket, EVENTS.DIRECT_MESSAGE, 'messageLimiter', (u, p) => {
      const message = users.sendDirectMessage(u, requireString(p.toUserId, 'toUserId'), p.text);
      io.to(userRoom(message.toId))
        .to(userRoom(message.fromId))
        .emit(EVENTS.DIRECT_MESSAGE, message);
      return { message };
    });

    /* ----- group:history ----- */
    register(socket, EVENTS.GROUP_HISTORY, null, (u, p) => {
      const messages = groups.getGroupHistory(u, requireString(p.groupId, 'groupId'), {
        limit: p.limit,
        before: p.before,
      });
      return { messages };
    });

    /* ----- direct:history ----- */
    register(socket, EVENTS.DIRECT_HISTORY, null, (u, p) => {
      const messages = users.getDirectHistory(u.id, requireString(p.withUserId, 'withUserId'), {
        limit: p.limit,
        before: p.before,
      });
      return { messages };
    });

    /* ----- groups:list ----- */
    register(socket, EVENTS.MY_GROUPS, null, (u) => {
      const list = groups.listGroupsForUser(u.id).map((g) =>
        Object.assign({}, g, {
          onlineMemberIds: groups.getMemberIds(g.id).filter(isOnline),
        })
      );
      return { groups: list };
    });

    /* ----- typing (silent on failure, no message budget used) ----- */
    register(socket, EVENTS.TYPING, 'typingLimiter', (u, p) => {
      const isTyping = Boolean(p.isTyping);

      if (p.groupId) {
        const group = groups.listGroupsForUser(u.id).find((g) => g.id === p.groupId);
        // Only show typing from people who are actually able to post
        if (group && perm.checkPostToGroup(u, group).allowed) {
          socket.to(groupRoom(group.id)).emit(EVENTS.TYPING, {
            groupId: group.id,
            userId: u.id,
            name: u.name,
            isTyping,
          });
        }
      } else if (p.toUserId) {
        const recipient = users.getUserById(p.toUserId);
        if (recipient && perm.checkDirectMessage(u, recipient).allowed) {
          socket.to(userRoom(recipient.id)).emit(EVENTS.TYPING, {
            fromUserId: u.id,
            name: u.name,
            isTyping,
          });
        }
      }
      return {};
    });

    /* ----- disconnect ----- */
    socket.on('disconnect', () => {
      const remaining = (onlineCounts.get(user.id) || 1) - 1;
      if (remaining <= 0) {
        onlineCounts.delete(user.id);
        broadcastPresence(user, false);
      } else {
        onlineCounts.set(user.id, remaining);
      }
      console.log('[socket] disconnected: ' + user.loginId);
    });
  });

  return io;
}

module.exports = { attachSockets };