'use strict';

/*
 * COMSATS Connect: communication boundary demo
 *
 * Logs in several users, opens a Socket.IO connection for each, and runs
 * thirteen scenarios that show who can talk to whom and where messages go.
 *
 * Usage: start the server (npm start), then run: npm run demo
 */

const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = 'Comsats@123';
const LONER_ID = 'FA22-BCS-999';

/* ------------------------------------------------------------------ */
/* Output helpers                                                      */
/* ------------------------------------------------------------------ */

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const cyan = (t) => paint('36', t);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);

const log = (line) => console.log(line === undefined ? '' : line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed += 1;
    log('   ' + green('PASS') + '  ' + label);
  } else {
    failed += 1;
    log('   ' + red('FAIL') + '  ' + label);
  }
}

function section(number, title) {
  log();
  log(bold(cyan('[' + number + '] ' + title)));
}

function info(text) {
  log('   ' + dim(text));
}

/* ------------------------------------------------------------------ */
/* Cast of characters                                                  */
/* ------------------------------------------------------------------ */

const CAST = {
  admin: 'admin.it',
  ahmed: 'dr.ahmed',
  muaaz: 'FA23-BCS-050',
  ayesha: 'FA22-BCS-012',
  hamza: 'FA22-BCS-078',
  fatima: 'FA22-BEE-031',
};

const G = {
  course: 'CSC334 Parallel and Distributed Computing',
  dept: 'CS Department Announcements',
  exam: 'Exam Cell Notices',
  acm: 'ACM Student Chapter',
  fyp: 'Venturify FYP Team',
};

const actors = {};
const groupIds = {};

/* ------------------------------------------------------------------ */
/* HTTP and socket helpers                                             */
/* ------------------------------------------------------------------ */

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  return { status: res.status, data };
}

const errorCode = (response) =>
  (response.data && response.data.error && response.data.error.code) || null;

async function login(key, loginId) {
  const r = await api('POST', '/api/auth/login', null, { loginId, password: PASSWORD });
  if (r.status !== 200) {
    throw new Error(
      'Login failed for ' + loginId + ' (HTTP ' + r.status + '). Did you run "npm run seed -- --force"?'
    );
  }
  actors[key] = { key, loginId, token: r.data.token, user: r.data.user, socket: null };
  return actors[key];
}

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.inbox = [];
    socket.onAny((event, payload) => socket.inbox.push({ event, payload }));
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

// Resolves true if the server refuses the connection
function connectionRefused(token) {
  return new Promise((resolve) => {
    const socket = io(BASE, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 4000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.close();
      resolve(false);
    });
    socket.on('connect_error', () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: { code: 'TIMEOUT', message: 'No reply from server' } }),
      5000
    );
    socket.emit(event, payload, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

function connectedActors() {
  return Object.values(actors).filter((a) => a.socket && a.socket.connected);
}

function snapshot() {
  const marks = {};
  Object.values(actors).forEach((a) => {
    if (a.socket) marks[a.key] = a.socket.inbox.length;
  });
  return marks;
}

function inboxLength(key) {
  return actors[key].socket.inbox.length;
}

function sawEvent(key, fromIndex, event, predicate) {
  return actors[key].socket.inbox
    .slice(fromIndex)
    .some((e) => e.event === event && (!predicate || predicate(e.payload)));
}

// Which actors received a given event whose text contains `textPart`
function receivers(marks, event, textPart) {
  const got = new Set();
  connectedActors().forEach((a) => {
    const received = a.socket.inbox
      .slice(marks[a.key] || 0)
      .some(
        (e) =>
          e.event === event &&
          e.payload &&
          typeof e.payload.text === 'string' &&
          e.payload.text.includes(textPart)
      );
    if (received) got.add(a.key);
  });
  return got;
}

function printDelivery(got) {
  connectedActors().forEach((a) => {
    const tag = got.has(a.key) ? green('received    ') : dim('not received');
    log('      ' + a.loginId.padEnd(14) + ' ' + tag + '  ' + dim(a.user.role));
  });
}

function report(actor, action, response) {
  if (response.ok) {
    log('   ' + green('SENT   ') + ' ' + actor.user.name + ' ' + action);
  } else {
    log(
      '   ' + red('BLOCKED') + ' ' + actor.user.name + ' ' + action +
        '  ->  ' + yellow(response.error.code) + ': ' + response.error.message
    );
  }
}

async function postGroup(key, groupName, text) {
  const actor = actors[key];
  const response = await emitAck(actor.socket, 'group:message', {
    groupId: groupIds[groupName],
    text,
  });
  report(actor, 'posts in "' + groupName + '"', response);
  return response;
}

async function sendDirect(fromKey, toKey, text) {
  const actor = actors[fromKey];
  const target = actors[toKey];
  const response = await emitAck(actor.socket, 'direct:message', {
    toUserId: target.user.id,
    text,
  });
  report(actor, 'messages ' + target.user.name + ' directly', response);
  return response;
}

const blockedWith = (response, code) =>
  Boolean(response && !response.ok && response.error && response.error.code === code);

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

async function ensureLoner() {
  const found = await api(
    'GET',
    '/api/users?search=' + LONER_ID + '&includeInactive=true',
    actors.admin.token
  );
  const existing = found.data.users.find((u) => u.loginId === LONER_ID);

  if (!existing) {
    const created = await api('POST', '/api/users', actors.admin.token, {
      loginId: LONER_ID,
      name: 'Loner Student',
      role: 'student',
      department: 'Computer Science',
      password: PASSWORD,
    });
    if (created.status !== 201) {
      throw new Error('Could not create the demo student: ' + errorCode(created));
    }
  } else if (!existing.active) {
    await api('PATCH', '/api/users/' + existing.id, actors.admin.token, { active: true });
  }

  await login('loner', LONER_ID);
}

async function setup() {
  section('0', 'Setup: preparing a known starting state');

  for (const key of Object.keys(CAST)) {
    await login(key, CAST[key]);
  }

  const all = await api('GET', '/api/groups/all', actors.admin.token);
  all.data.groups.forEach((g) => {
    groupIds[g.name] = g.id;
  });

  Object.values(G).forEach((name) => {
    if (!groupIds[name]) {
      throw new Error('Group "' + name + '" is missing. Run "npm run seed -- --force" and restart the server.');
    }
  });

  // Fatima must start outside the FYP team
  const fyp = await api('GET', '/api/groups/' + groupIds[G.fyp], actors.admin.token);
  if (fyp.data.group.members.some((m) => m.userId === actors.fatima.user.id)) {
    await api(
      'DELETE',
      '/api/groups/' + groupIds[G.fyp] + '/members/' + actors.fatima.user.id,
      actors.muaaz.token
    );
    info('Removed Fatima from the FYP team left over from an earlier run.');
  }

  // Hamza must start muted in the ACM society
  await api(
    'PATCH',
    '/api/groups/' + groupIds[G.acm] + '/members/' + actors.hamza.user.id,
    actors.muaaz.token,
    { muted: true }
  );

  await ensureLoner();
  info('Ready. Logged in ' + Object.keys(actors).length + ' users. Groups found: ' + Object.keys(groupIds).length + '.');
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

async function scenarioAuth() {
  section('1', 'Authentication: only valid tokens can open a socket');

  check('Socket with no token is refused', await connectionRefused(null));
  check('Socket with a forged token is refused', await connectionRefused('not-a-real-token'));

  for (const key of Object.keys(CAST)) {
    actors[key].socket = await openSocket(actors[key].token);
  }
  check('Six users with valid tokens are connected', connectedActors().length === 6);
}

async function scenarioListing() {
  section('2', 'Each user sees only their own groups');

  for (const key of Object.keys(CAST)) {
    const actor = actors[key];
    const reply = await emitAck(actor.socket, 'groups:list', {});
    const names = reply.groups.map((g) => g.name);
    log('   ' + actor.user.name.padEnd(18) + dim('(' + actor.user.role + ')') + ' ' + names.length + ' groups');
    if (key === 'fatima') {
      check('Fatima is not listed in the Venturify FYP Team', !names.includes(G.fyp));
    }
  }
}

async function scenarioEveryone() {
  section('3', 'Course group (policy: everyone), delivery stays inside the group');

  const marks = snapshot();
  const res = await postGroup('ayesha', G.course, 'Sir, can we have the lab demo online? [demo 3]');
  await sleep(300);
  const got = receivers(marks, 'group:message', '[demo 3]');
  printDelivery(got);

  check('Message was accepted', res.ok === true);
  check('Group members (Muaaz, Hamza, Dr. Ahmed) received it', ['muaaz', 'hamza', 'ahmed'].every((k) => got.has(k)));
  check('Non-members (Fatima, admin) did NOT receive it', !got.has('fatima') && !got.has('admin'));
}

async function scenarioFacultyOnly() {
  section('4', 'Department announcements (policy: faculty_only)');

  const blocked = await postGroup('ayesha', G.dept, 'Can I post here? [demo 4a]');
  check('Student is blocked with POLICY_FACULTY_ONLY', blockedWith(blocked, 'POLICY_FACULTY_ONLY'));

  const marks = snapshot();
  const sent = await postGroup('ahmed', G.dept, 'Seminar on Monday at 11 AM. [demo 4b]');
  await sleep(300);
  const got = receivers(marks, 'group:message', '[demo 4b]');
  printDelivery(got);

  check('Faculty announcement was accepted', sent.ok === true);
  check('Students (Muaaz, Ayesha, Hamza) can read it', ['muaaz', 'ayesha', 'hamza'].every((k) => got.has(k)));
  check('Fatima (not in this group) did NOT receive it', !got.has('fatima'));
}

async function scenarioAdminOnly() {
  section('5', 'Exam Cell notices (policy: admin_only)');

  const facultyTry = await postGroup('ahmed', G.exam, 'Fake notice from faculty [demo 5a]');
  check('Faculty is blocked with POLICY_ADMIN_ONLY', blockedWith(facultyTry, 'POLICY_ADMIN_ONLY'));

  const studentTry = await postGroup('muaaz', G.exam, 'Fake notice from student [demo 5b]');
  check('Student is blocked with POLICY_ADMIN_ONLY', blockedWith(studentTry, 'POLICY_ADMIN_ONLY'));

  const marks = snapshot();
  const sent = await postGroup('admin', G.exam, 'Mid-term datesheet is now on the portal. [demo 5c]');
  await sleep(300);
  const got = receivers(marks, 'group:message', '[demo 5c]');
  printDelivery(got);

  check('Admin notice was accepted', sent.ok === true);
  check('All members received the official notice', ['muaaz', 'ayesha', 'hamza', 'fatima', 'ahmed'].every((k) => got.has(k)));
}

async function scenarioMuting() {
  section('6', 'Muting: a muted member can read but not post');

  const hamza = actors.hamza;
  const blocked = await postGroup('hamza', G.acm, 'Hello everyone [demo 6a]');
  check('Muted student is blocked with MUTED', blockedWith(blocked, 'MUTED'));

  const history = await emitAck(hamza.socket, 'group:history', { groupId: groupIds[G.acm] });
  check('Muted student can still read the group history', history.ok === true);

  const url = '/api/groups/' + groupIds[G.acm] + '/members/' + hamza.user.id;
  const mark = inboxLength('hamza');

  info('Owner (Muaaz) unmutes Hamza over REST...');
  await api('PATCH', url, actors.muaaz.token, { muted: false });
  await sleep(300);
  check('Hamza was told live about the change', sawEvent('hamza', mark, 'group:updated', (p) => p.muted === false));

  const marks = snapshot();
  const sent = await postGroup('hamza', G.acm, 'Thanks for unmuting me [demo 6b]');
  await sleep(300);
  const got = receivers(marks, 'group:message', '[demo 6b]');
  check('After unmuting, Hamza can post and members receive it', sent.ok === true && got.has('muaaz') && got.has('fatima'));

  info('Owner re-mutes Hamza to restore the starting state...');
  await api('PATCH', url, actors.muaaz.token, { muted: true });
  await sleep(200);
}

async function scenarioMembership() {
  section('7', 'Membership boundary: outsiders get nothing, changes apply live');

  const fatima = actors.fatima;
  const fypId = groupIds[G.fyp];

  const readTry = await emitAck(fatima.socket, 'group:history', { groupId: fypId });
  report(fatima, 'reads history of "' + G.fyp + '"', readTry.ok ? readTry : readTry);
  check('Non-member cannot read history (NOT_MEMBER)', blockedWith(readTry, 'NOT_MEMBER'));

  const postTry = await postGroup('fatima', G.fyp, 'Let me in [demo 7a]');
  check('Non-member cannot post (NOT_MEMBER)', blockedWith(postTry, 'NOT_MEMBER'));

  let marks = snapshot();
  await postGroup('muaaz', G.fyp, 'Sprint notes for the team [demo 7b]');
  await sleep(300);
  let got = receivers(marks, 'group:message', '[demo 7b]');
  printDelivery(got);
  check('Fatima did NOT receive the team message', !got.has('fatima') && got.has('ayesha'));

  info('Owner (Muaaz) adds Fatima to the team over REST...');
  const fatimaMark = inboxLength('fatima');
  await api('POST', '/api/groups/' + fypId + '/members', actors.muaaz.token, { userId: fatima.user.id });
  await sleep(300);
  check('Fatima received group:added live, with no reconnect', sawEvent('fatima', fatimaMark, 'group:added', (p) => p.group.id === fypId));

  marks = snapshot();
  await postGroup('muaaz', G.fyp, 'Welcome to the team, Fatima [demo 7c]');
  await sleep(300);
  got = receivers(marks, 'group:message', '[demo 7c]');
  check('Fatima now receives the group messages', got.has('fatima'));

  info('Owner removes Fatima again...');
  const removeMark = inboxLength('fatima');
  await api('DELETE', '/api/groups/' + fypId + '/members/' + fatima.user.id, actors.muaaz.token);
  await sleep(300);
  check('Fatima received group:removed live', sawEvent('fatima', removeMark, 'group:removed', (p) => p.groupId === fypId));

  marks = snapshot();
  await postGroup('muaaz', G.fyp, 'Private discussion after removal [demo 7d]');
  await sleep(300);
  got = receivers(marks, 'group:message', '[demo 7d]');
  check('Removed member no longer receives anything', !got.has('fatima'));

  const afterRead = await emitAck(fatima.socket, 'group:history', { groupId: fypId });
  check('Removed member can no longer read history (NOT_MEMBER)', blockedWith(afterRead, 'NOT_MEMBER'));
}

async function scenarioCreationRules() {
  section('8', 'Who may create which groups (REST)');

  const suffix = Date.now().toString(36);

  let r = await api('POST', '/api/groups', actors.muaaz.token, { name: 'Demo Class ' + suffix, type: 'class' });
  log('   Student creates a class group      -> HTTP ' + r.status + ' ' + yellow(String(errorCode(r))));
  check('Student cannot create a class group (GROUP_TYPE_FORBIDDEN)', r.status === 403 && errorCode(r) === 'GROUP_TYPE_FORBIDDEN');

  r = await api('POST', '/api/groups', actors.muaaz.token, {
    name: 'Demo Society ' + suffix, type: 'society', postPolicy: 'faculty_only',
  });
  log('   Student creates faculty_only group -> HTTP ' + r.status + ' ' + yellow(String(errorCode(r))));
  check('Student cannot use faculty_only policy (POST_POLICY_FORBIDDEN)', r.status === 403 && errorCode(r) === 'POST_POLICY_FORBIDDEN');

  r = await api('POST', '/api/groups', actors.ahmed.token, { name: 'Demo Society ' + suffix, type: 'society' });
  log('   Faculty creates a society          -> HTTP ' + r.status + ' ' + yellow(String(errorCode(r))));
  check('Faculty cannot create a society (GROUP_TYPE_FORBIDDEN)', r.status === 403 && errorCode(r) === 'GROUP_TYPE_FORBIDDEN');

  const mark = inboxLength('ayesha');
  r = await api('POST', '/api/groups', actors.ahmed.token, {
    name: 'Demo Course ' + suffix, type: 'course', memberIds: [actors.ayesha.user.id],
  });
  log('   Faculty creates a course group     -> HTTP ' + r.status);
  check('Faculty can create a course group', r.status === 201);
  if (r.status === 201) {
    const courseId = r.data.group.id;
    await sleep(300);
    check('Added member (Ayesha) was notified live', sawEvent('ayesha', mark, 'group:added', (p) => p.group.id === courseId));

    const removeMark = inboxLength('ayesha');
    await api('DELETE', '/api/groups/' + courseId, actors.ahmed.token);
    await sleep(300);
    check('Deleting the group notified its members', sawEvent('ayesha', removeMark, 'group:removed', (p) => p.groupId === courseId));
  }

  r = await api('POST', '/api/groups', actors.muaaz.token, { name: 'Demo Society ' + suffix, type: 'society' });
  log('   Student creates a society          -> HTTP ' + r.status);
  check('Student can create a society with open posting', r.status === 201);
  if (r.status === 201) {
    await api('DELETE', '/api/groups/' + r.data.group.id, actors.muaaz.token);
  }
}

async function scenarioDirectMessages() {
  section('9', 'Direct messages: students are limited, faculty are not');

  actors.loner.socket = await openSocket(actors.loner.token);

  let marks = snapshot();
  let res = await sendDirect('muaaz', 'ayesha', 'Did you finish the lab? [demo 9a]');
  await sleep(300);
  let got = receivers(marks, 'direct:message', '[demo 9a]');
  check('Student can DM a classmate (shared group), and it arrives live', res.ok === true && got.has('ayesha'));

  res = await sendDirect('muaaz', 'loner', 'Hi stranger [demo 9b]');
  check('Student cannot DM a student with no shared group (DM_NOT_ALLOWED)', blockedWith(res, 'DM_NOT_ALLOWED'));

  marks = snapshot();
  res = await sendDirect('ahmed', 'loner', 'Please see me in my office. [demo 9c]');
  await sleep(300);
  got = receivers(marks, 'direct:message', '[demo 9c]');
  check('Faculty can DM any student', res.ok === true && got.has('loner'));

  res = await sendDirect('loner', 'ahmed', 'Yes sir, I will come. [demo 9d]');
  check('The student can reply because faculty messaged first', res.ok === true);

  res = await sendDirect('loner', 'muaaz', 'Hello Muaaz [demo 9e]');
  check('But the student still cannot DM Muaaz (DM_NOT_ALLOWED)', blockedWith(res, 'DM_NOT_ALLOWED'));

  const history = await emitAck(actors.ahmed.socket, 'direct:history', { withUserId: actors.loner.user.id });
  check('Conversation history is saved and readable', history.ok === true && history.messages.length >= 2);
}

async function scenarioValidation() {
  section('10', 'Message validation');

  const meta = await api('GET', '/api/meta');
  const max = meta.data.messageMaxLength;

  const empty = await postGroup('ayesha', G.course, '   ');
  check('Empty message is rejected (EMPTY_MESSAGE)', blockedWith(empty, 'EMPTY_MESSAGE'));

  const long = await postGroup('ayesha', G.course, 'x'.repeat(max + 1));
  check('Message over ' + max + ' characters is rejected (MESSAGE_TOO_LONG)', blockedWith(long, 'MESSAGE_TOO_LONG'));
}

async function scenarioRateLimit() {
  section('11', 'Rate limiting (a fresh socket, so earlier messages do not count)');

  const socket = await openSocket(actors.muaaz.token);
  const burst = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      emitAck(socket, 'group:message', {
        groupId: groupIds[G.acm],
        text: 'burst ' + i + ' [rate-limit test]',
      })
    )
  );
  socket.close();

  const accepted = burst.filter((r) => r.ok).length;
  const limited = burst.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED').length;
  log('   15 rapid messages: ' + green(accepted + ' accepted') + ', ' + red(limited + ' blocked (RATE_LIMITED)'));
  check('The rate limiter blocked part of the burst', limited > 0);
}

async function scenarioPresence() {
  section('12', 'Presence: online and offline updates reach group-mates');

  const usman = await api('POST', '/api/auth/login', null, { loginId: 'SP23-BBA-019', password: PASSWORD });
  const usmanId = usman.data.user.id;

  const mark = inboxLength('admin');
  const socket = await openSocket(usman.data.token);
  await sleep(300);
  check(
    'Admin (shares Exam Cell Notices with Usman) saw him come online',
    sawEvent('admin', mark, 'presence:update', (p) => p.userId === usmanId && p.online === true)
  );

  const mark2 = inboxLength('admin');
  socket.close();
  await sleep(400);
  check(
    'Admin saw him go offline',
    sawEvent('admin', mark2, 'presence:update', (p) => p.userId === usmanId && p.online === false)
  );
}

async function scenarioDeactivation() {
  section('13', 'Deactivation: access ends immediately');

  const loner = actors.loner;
  check('Loner is connected before deactivation', loner.socket.connected === true);

  info('Admin deactivates the account...');
  await api('PATCH', '/api/users/' + loner.user.id, actors.admin.token, { active: false });
  await sleep(500);
  check('The live socket was disconnected by the server', loner.socket.connected === false);

  const retry = await api('POST', '/api/auth/login', null, { loginId: LONER_ID, password: PASSWORD });
  check('Logging in again is refused (ACCOUNT_DISABLED)', retry.status === 403 && errorCode(retry) === 'ACCOUNT_DISABLED');

  await api('PATCH', '/api/users/' + loner.user.id, actors.admin.token, { active: true });
  info('Account reactivated to restore the starting state.');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  log(bold('COMSATS Connect: communication boundary demo'));
  log(dim('Server: ' + BASE));

  const health = await api('GET', '/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    log();
    log(red('Cannot reach the server at ' + BASE + '.'));
    log('Start it in another window with "npm start" and try again.');
    process.exit(1);
  }

  await setup();
  await scenarioAuth();
  await scenarioListing();
  await scenarioEveryone();
  await scenarioFacultyOnly();
  await scenarioAdminOnly();
  await scenarioMuting();
  await scenarioMembership();
  await scenarioCreationRules();
  await scenarioDirectMessages();
  await scenarioValidation();
  await scenarioRateLimit();
  await scenarioPresence();
  await scenarioDeactivation();

  Object.values(actors).forEach((a) => {
    if (a.socket) a.socket.close();
  });

  log();
  log(bold('Summary: ') + green(passed + ' passed') + ', ' + (failed ? red(failed + ' failed') : dim('0 failed')));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  log();
  log(red('Demo stopped: ' + err.message));
  process.exit(1);
});
