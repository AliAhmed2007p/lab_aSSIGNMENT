'use strict';

/*
 * Demo data for the whole platform:
 *
 *   1. two organizations (tenants), one of them enforcing two-factor auth
 *   2. users of both tenants (administrators, faculty, students)
 *   3. the chat groups and messages of the original COMSATS Connect project
 *   4. three registered client applications, including the two sample apps
 *   5. library loans for the second sample application
 *
 * Every demo account uses the password "Comsats@123".
 * Re-run with --force to wipe everything and start again.
 */

const db = require('./store/db');
const tenantsService = require('./services/tenantService');
const users = require('./services/userService');
const groups = require('./services/groupService');
const clientApps = require('./services/clientAppService');
const { SERVER } = require('./config/policies');

const DEFAULT_PASSWORD = 'Comsats@123';
const day = 86400 * 1000;

async function main() {
  const force = process.argv.includes('--force');

  if (db.collection('users').length > 0 && !force) {
    console.log('The database already contains users, so nothing was changed.');
    console.log('To wipe it and load the demo data again, run:');
    console.log('  npm run seed -- --force');
    return;
  }

  if (force) {
    db.reset();
    console.log('Existing data wiped.');
  }

  /* ---------------- 1. Tenants ---------------- */

  const islamabad = tenantsService.createTenant({
    name: 'COMSATS University Islamabad',
    slug: 'comsats-islamabad',
  });
  tenantsService.updateTenant(islamabad.id, {
    settings: {
      mfaRequired: false,
      allowSelfRegistration: true,
      // Both providers are enabled here; they start working as soon as the
      // credentials are added to .env.
      socialProviders: { google: true, facebook: true },
      tokens: { accessTtlSeconds: 900, refreshTtlDays: 30, sessionTtlHours: 12 },
      passwordPolicy: { minLength: 10, requireUpper: true, requireLower: true, requireNumber: true, requireSymbol: false },
      maxFailedLogins: 5,
      lockoutMinutes: 15,
    },
  });

  const lahore = tenantsService.createTenant({
    name: 'COMSATS University Lahore',
    slug: 'comsats-lahore',
  });
  tenantsService.updateTenant(lahore.id, {
    settings: {
      // This organization insists on a second factor: signing in with one of
      // its accounts demonstrates the enrollment step.
      mfaRequired: true,
      allowSelfRegistration: false,
      socialProviders: { google: false, facebook: false },
      tokens: { accessTtlSeconds: 600, refreshTtlDays: 14, sessionTtlHours: 8 },
    },
  });

  /* ---------------- 2. Users ---------------- */

  const make = (tenantId) => (loginId, name, role, department, email) =>
    users.createUser({
      tenantId,
      loginId,
      name,
      role,
      department,
      email,
      password: DEFAULT_PASSWORD,
    });

  const islamabadUser = make(islamabad.id);
  const lahoreUser = make(lahore.id);

  // Platform administrator: manages every organization
  const itAdmin = await islamabadUser('admin.it', 'IT Administrator', 'admin', 'Administration', 'it.admin@comsats.example.edu');
  // Organization administrator: manages the Islamabad tenant only
  const examCell = await islamabadUser('exam.cell', 'Exam Cell Office', 'tenant_admin', 'Administration', 'exam.cell@comsats.example.edu');

  const drAhmed = await islamabadUser('dr.ahmed', 'Dr. Ahmed Raza', 'faculty', 'Computer Science', 'ahmed.raza@comsats.example.edu');
  const drSana = await islamabadUser('dr.sana', 'Dr. Sana Malik', 'faculty', 'Computer Science', 'sana.malik@comsats.example.edu');
  const drBilal = await islamabadUser('dr.bilal', 'Dr. Bilal Hussain', 'faculty', 'Management Sciences', 'bilal.hussain@comsats.example.edu');

  const muaaz = await islamabadUser('FA23-BCS-050', 'Muaaz Tasawar', 'student', 'Computer Science', 'fa23-bcs-050@comsats.example.edu');
  const abbas = await islamabadUser('FA23-BCS-001', 'Abbas Raza', 'student', 'Computer Science', null);
  const amna = await islamabadUser('FA23-BCS-016', 'Amna Bibi', 'student', 'Computer Science', null);
  const ayesha = await islamabadUser('FA22-BCS-012', 'Ayesha Khan', 'student', 'Computer Science', 'fa22-bcs-012@comsats.example.edu');
  const hamza = await islamabadUser('FA22-BCS-078', 'Hamza Ali', 'student', 'Computer Science', 'fa22-bcs-078@comsats.example.edu');
  const fatima = await islamabadUser('FA22-BEE-031', 'Fatima Noor', 'student', 'Electrical and Computer Engineering', null);
  const usman = await islamabadUser('SP23-BBA-019', 'Usman Raza', 'student', 'Management Sciences', null);

  // Lahore: the same platform, a completely separate set of people and data
  const lhrAdmin = await lahoreUser('admin.lhr', 'Lahore IT Office', 'tenant_admin', 'Administration', 'it@lahore.example.edu');
  const drKamran = await lahoreUser('dr.kamran', 'Dr. Kamran Aslam', 'faculty', 'Computer Science', 'kamran.aslam@lahore.example.edu');
  const aliHassan = await lahoreUser('FA23-BCS-101', 'Ali Hassan', 'student', 'Computer Science', 'fa23-bcs-101@lahore.example.edu');
  const saraIqbal = await lahoreUser('FA23-BCS-102', 'Sara Iqbal', 'student', 'Computer Science', null);

  /* ---------------- 3. Groups and messages ---------------- */

  const bcs7a = groups.createGroup(itAdmin, {
    name: 'BCS-7A',
    type: 'class',
    postPolicy: 'everyone',
    description: 'Class group for BCS Semester 7, Section A.',
    memberIds: [drAhmed.id, drSana.id, muaaz.id, ayesha.id, hamza.id],
  });

  const pdc = groups.createGroup(drAhmed, {
    name: 'CSC334 Parallel and Distributed Computing',
    type: 'course',
    postPolicy: 'everyone',
    description: 'Course discussion for PDC. Lab assignments are posted here.',
    memberIds: [muaaz.id, ayesha.id, hamza.id],
  });

  const csAnnouncements = groups.createGroup(itAdmin, {
    name: 'CS Department Announcements',
    type: 'department',
    postPolicy: 'faculty_only',
    description: 'Official department announcements. Students can read only.',
    memberIds: [drAhmed.id, drSana.id, muaaz.id, ayesha.id, hamza.id],
  });

  const examNotices = groups.createGroup(examCell, {
    name: 'Exam Cell Notices',
    type: 'office',
    postPolicy: 'admin_only',
    description: 'Datesheets and exam notices. Only the Exam Cell can post.',
    memberIds: [
      itAdmin.id, drAhmed.id, drSana.id, drBilal.id,
      muaaz.id, abbas.id, amna.id, ayesha.id, hamza.id, fatima.id, usman.id,
    ],
  });

  // Created by a student, which exercises the student creation rules
  const acm = groups.createGroup(muaaz, {
    name: 'ACM Student Chapter',
    type: 'society',
    postPolicy: 'everyone',
    description: 'COMSATS ACM student society.',
    memberIds: [ayesha.id, hamza.id, fatima.id],
  });

  const venturify = groups.createGroup(muaaz, {
    name: 'Venturify FYP Team',
    type: 'fyp',
    postPolicy: 'everyone',
    description: 'Final year project team. Supervisor: Dr. Sana Malik.',
    memberIds: [abbas.id, amna.id, ayesha.id, drSana.id],
  });

  // Hamza can read the ACM group but not post, which demonstrates muting
  groups.setMuted(muaaz, acm.id, hamza.id, true);

  groups.postMessage(examCell, examNotices.id, 'Mid-term datesheet will be uploaded on the portal by Friday.');
  groups.postMessage(drAhmed, csAnnouncements.id, 'The department seminar on cloud computing is on Monday at 11:00 AM.');
  groups.postMessage(drAhmed, pdc.id, 'Lab Assignment 1 (Socket.IO) has been posted. Please read the brief carefully.');
  groups.postMessage(ayesha, pdc.id, 'Sir, is the demo required in the lab or can we show it online?');
  groups.postMessage(muaaz, venturify.id, 'Sprint planning meeting tomorrow after the 2 PM class.');
  groups.postMessage(abbas, venturify.id, 'I will prepare the database design for the next meeting.');
  groups.postMessage(amna, venturify.id, 'I will work on the user interface mockups.');
  groups.postMessage(drSana, bcs7a.id, 'Please submit your FYP proposals by next week.');

  // A separate group in the second tenant: invisible to Islamabad users
  const lhrClass = groups.createGroup(lhrAdmin, {
    name: 'BCS-9A',
    type: 'class',
    postPolicy: 'everyone',
    description: 'Class group of the Lahore campus.',
    memberIds: [drKamran.id, aliHassan.id, saraIqbal.id],
  });
  groups.postMessage(drKamran, lhrClass.id, 'Welcome back. The SSO platform is shared, the class data is ours alone.');

  /* ---------------- 4. Registered client applications ---------------- */

  const base = SERVER.PUBLIC_BASE_URL;
  const local = 'http://localhost:' + SERVER.PORT;

  const chatApp = clientApps.createApp({
    tenantId: islamabad.id,
    clientId: process.env.CHAT_CLIENT_ID || 'comsats-connect-chat',
    clientSecret: process.env.CHAT_CLIENT_SECRET || 'dev-chat-client-secret',
    name: 'COMSATS Connect (chat)',
    description: 'Messaging for classes, courses, departments and offices.',
    redirectUris: [local + '/apps/chat/callback', base + '/apps/chat/callback'],
    postLogoutRedirectUris: [local + '/index.html', base + '/index.html'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'chat:read', 'chat:write'],
  });

  const libraryApp = clientApps.createApp({
    tenantId: islamabad.id,
    clientId: process.env.LIBRARY_CLIENT_ID || 'comsats-library-portal',
    clientSecret: process.env.LIBRARY_CLIENT_SECRET || 'dev-library-client-secret',
    name: 'COMSATS Library portal',
    description: 'Borrowed items, due dates and renewals for the campus library.',
    redirectUris: [local + '/apps/library/callback', base + '/apps/library/callback'],
    postLogoutRedirectUris: [local + '/index.html', base + '/index.html'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'library:read', 'library:write'],
  });

  // Registered but not bundled: shows how a third application is added, and
  // that applications belong to exactly one organization.
  clientApps.createApp({
    tenantId: lahore.id,
    clientId: process.env.LAHORE_CLIENT_ID || 'comsats-lahore-portal',
    clientSecret: process.env.LAHORE_CLIENT_SECRET || 'dev-lahore-client-secret',
    name: 'COMSATS Lahore campus portal',
    description: 'Campus portal of the Lahore organization.',
    redirectUris: [local + '/apps/lahore/callback', base + '/apps/lahore/callback'],
    scopes: ['openid', 'profile', 'email'],
  });

  /* ---------------- 5. Library loans ---------------- */

  const loan = (tenantId, user, title, author, daysUntilDue, renewals) => {
    db.collection('libraryLoans').push({
      id: db.newId('loan'),
      tenantId,
      userId: user.id,
      title,
      author,
      dueAt: new Date(Date.now() + daysUntilDue * day).toISOString(),
      renewals: renewals || 0,
      returnedAt: null,
    });
  };

  loan(islamabad.id, muaaz, 'Computer Networking: A Top-Down Approach', 'Kurose & Ross', 5, 0);
  loan(islamabad.id, muaaz, 'Designing Data-Intensive Applications', 'Martin Kleppmann', -3, 1); // overdue
  loan(islamabad.id, ayesha, 'Introduction to Algorithms', 'Cormen et al.', 12, 0);
  loan(islamabad.id, hamza, 'Clean Code', 'Robert C. Martin', 2, 2);
  loan(lahore.id, aliHassan, 'Operating System Concepts', 'Silberschatz et al.', 7, 0);

  db.flush();

  /* ---------------- Summary ---------------- */

  console.log('');
  console.log('Seed complete.');
  console.log('  Database file : ' + SERVER.DB_FILE);
  console.log('  Organizations : ' + tenantsService.listTenants().length);
  console.log('  Users         : ' + users.listUsers({ includeInactive: true }).length);
  console.log('  Groups        : ' + groups.listAllGroups().length);
  console.log('  Applications  : ' + clientApps.listApps().length);
  console.log('  Password for every demo account: ' + DEFAULT_PASSWORD);
  console.log('');
  console.log('Demo logins:');
  users.listUsers().forEach((u) => {
    const tenant = tenantsService.getTenant(u.tenantId);
    console.log('  ' + u.loginId.padEnd(14) + u.role.padEnd(13) + (tenant ? tenant.name : ''));
  });
  console.log('');
  console.log('Registered applications:');
  console.log('  ' + chatApp.app.name.padEnd(30) + chatApp.app.clientId);
  console.log('  ' + libraryApp.app.name.padEnd(30) + libraryApp.app.clientId);
  console.log('');
  console.log('Open http://localhost:' + SERVER.PORT + ' and sign in through the SSO page.');
  console.log('COMSATS Lahore requires two-factor authentication: use admin.lhr to see');
  console.log('the enrollment step, or enable it for Islamabad in the admin console.');
  console.log('');
}

main().catch((err) => {
  console.error('Seeding failed:', err.message);
  console.error(err);
  process.exit(1);
});
