# COMSATS Connect

> A Socket.IO communication system for COMSATS University Islamabad, with users, groups, a browser chat client, an admin console and server-enforced communication boundaries.

**Course:** Advanced Web Technologies (Semester 7) | **Assignment:** Lab Assignment 1, CLO-5 (Socket.IO)
**Author:** Muaaz Tasawar | **Repository:** https://github.com/MuaazTasawar/comsats-connect

---

## Table of Contents

1. [Overview](#1-overview)
2. [Features](#2-features)
3. [Screenshots](#3-screenshots)
4. [Single sign-on platform](#4-single-sign-on-platform)
5. [Tech Stack](#5-tech-stack)
6. [How This Meets the Assignment](#6-how-this-meets-the-assignment)
7. [Roles and Communication Rules](#7-roles-and-communication-rules)
8. [Architecture](#8-architecture)
9. [Web Interface](#9-web-interface)
10. [Project Structure](#10-project-structure)
11. [Getting Started](#11-getting-started)
12. [Environment Variables](#12-environment-variables)
13. [Demo Accounts and Seed Data](#13-demo-accounts-and-seed-data)
14. [Demo Walkthrough in the Browser](#14-demo-walkthrough-in-the-browser)
15. [Running the Automated Demo](#15-running-the-automated-demo)
16. [REST API Reference](#16-rest-api-reference)
17. [Socket.IO Reference](#17-socketio-reference)
18. [Manual Testing Guide](#18-manual-testing-guide)
19. [Error Codes](#19-error-codes)
20. [Data Storage](#20-data-storage)
21. [Security Notes](#21-security-notes)
22. [Troubleshooting](#22-troubleshooting)
23. [Phase Build History](#23-phase-build-history)
24. [Limitations and Future Work](#24-limitations-and-future-work)
25. [Contributing](#25-contributing)
26. [License](#26-license)

---

## 1. Overview

COMSATS Connect is a university communication platform. Administrators, faculty and students are registered as users, organised into groups (classes, courses, departments, societies, FYP teams and offices), and talk to each other in real time over Socket.IO.

The central idea is the **communication boundary**: the server decides who may read and post in each group and who may send direct messages. The rules model how communication works at COMSATS. For example, the Exam Cell can post official notices that students can read but not reply to, a faculty-only announcement group is read-only for students, and a society president can mute a disruptive member.

All rules live in one place (`permissionService.js`) and are checked on the server for every message. A client cannot bypass them by editing front-end code or by forging a group ID.

The project has two parts that share the same rules:

- **Backend:** an Express REST API for administration plus a Socket.IO engine for real-time messaging.
- **Frontend:** a browser client with no build step. A chat page for everyone, and an admin console for administrators to add users and manage groups. The chat page shows the boundaries as they apply to you, for example a locked message bar in read-only groups.

There is also an automated demo script (`tests/demo.js`) that connects several users at once and prints exactly which messages are delivered and which are blocked.

---

## 2. Features

**Communication boundaries (enforced on the server)**

- **Membership boundary:** only members can join a group's Socket.IO room, read its history or receive its messages. Non-members never receive its events, not even admins.
- **Posting policies:** each group is `everyone`, `faculty_only` or `admin_only`.
- **Muting:** a group owner or admin can mute a member, who can still read but not post.
- **Group creation rules:** admins can create any group, faculty can create course and FYP groups, students can create society and FYP groups (open posting only).
- **Direct messages:** admins and faculty can message anyone. Students can message only people who share an open group with them, or who have messaged them first.
- **Abuse control:** per-socket rate limiting, a message length cap, a request body size cap, and login attempt lockout.

**Users and groups**

- **User management:** admin-created accounts for three roles (admin, faculty, student) with COMSATS-style login IDs (for example `FA23-BCS-050`). Accounts can be deactivated, and a deactivated user is disconnected immediately.
- **Groups:** six group types (class, course, department, society, FYP, office) with owners, members, descriptions and renaming.
- **Live membership sync:** adding or removing a member updates the user's live socket rooms instantly, with no reconnect.

**Real-time messaging**

- **Presence:** online and offline updates are shared only with people who share a group with the user.
- **Typing indicators:** shown only for people who are actually allowed to post.
- **Message history:** paged history for groups and direct conversations.
- **Authentication:** one JWT works for both the REST API and the Socket.IO handshake.

**Browser interface**

- **Chat page:** groups sorted by type with lock icons on restricted groups, direct messages with online dots, unread counts (also in the browser tab title), day separators, "Load earlier messages", and a message box that turns into a locked bar when you cannot post.
- **Members panel and dialogs:** view members, mute, remove, add people, edit or leave a group, create a group, start a direct message.
- **Admin console:** add, search, filter, edit, reset the password of, deactivate and reactivate users, and create, edit, manage and delete any group.
- **Live updates everywhere:** a new group, a removal, a mute or a deactivation shows up in open browsers without a refresh.
- **Reconnect handling:** after a dropped connection the page reloads anything it missed.
- **Per-tab sessions:** every browser tab keeps its own login, so you can test several users side by side.
- **Responsive and accessible:** the sidebar becomes a drawer on small screens, keyboard focus is visible, controls have labels, and animations respect "reduce motion".

**Persistence**

- Data survives restarts using a human-readable JSON file, with no database install.

**Single sign-on**

The repository also carries a **multi-tenant single sign-on platform** (OAuth 2.0 and OpenID Connect) that both the chat application and a campus library portal sign their users in through. It owns the user directory, the organizations, the security policies and the audit log; see [Single sign-on platform](#4-single-sign-on-platform).

---

## 3. Screenshots

All screenshots are taken from the running application with the demo data from [Demo Accounts and Seed Data](#13-demo-accounts-and-seed-data). Screenshots 1 to 15 are the chat application (sample application 1) after signing in through the platform; the platform's own pages - the landing page, the central sign-in page, the account page, the admin console and the library portal - are in [Single sign-on platform](#4-single-sign-on-platform).

### Sign in

The chat application sends the browser to the platform's central sign-in page, which names the application, lists the scopes it is asking for and states the platform rules. Every demo account is one click, which fills in the form.

![Sign-in page](docs/screenshots/01-login.png)

### Chat as a student

Muaaz Tasawar (student) in the BCS-7A class group. Groups are sorted by type, and the lock icon marks the two groups where students cannot post: CS Department Announcements and Exam Cell Notices. The header shows the group type, the posting policy and the member count.

![Student chat in a class group](docs/screenshots/02-chat-class-group.png)

### Read-only group

In CS Department Announcements the posting policy is "Faculty and admins post". The student can read the notices, but the message box is replaced by a locked bar that explains why.

![Locked message bar in a faculty-only group](docs/screenshots/03-readonly-announcements-student.png)

### Chat as faculty

Dr. Ahmed Raza (faculty) in the CSC334 course group. Faculty post freely in groups that allow it and can start a direct message with anyone, such as the student in the Direct messages list.

![Faculty chat in a course group](docs/screenshots/04-course-chat-faculty.png)

### Members panel

The group owner sees every member with Mute and Remove buttons, and an "Add people" search to bring in more members.

![Members panel for a group owner](docs/screenshots/05-members-panel.png)

### Muting a member

After the owner presses Mute, the member shows a Muted tag and the button becomes Unmute. The muted student can still read the group, but their message box locks live.

![A muted member in the members panel](docs/screenshots/06-member-muted.png)

### Group creation is limited by role

A student opening "Create a group" is offered only Society and FYP team. The "Who can post" list contains only "Everyone can post". Faculty and admins see wider lists.

![Create a group dialog for a student](docs/screenshots/07-student-create-group.png)

### Direct message boundary

Muaaz and Usman Raza are both in the read-only Exam Cell Notices group, but they share no open group. A read-only notice board does not make two students contacts, so the server refuses the message and the page shows the reason. The earlier "Hi!" in the same chat was sent before this rule was tightened.

![Direct message blocked because no open group is shared](docs/screenshots/08-dm-blocked-no-open-group.png)

A student with no groups at all is blocked the same way.

![Direct message blocked for a student with no shared group](docs/screenshots/09-dm-blocked-stranger.png)

### Admin console: users

Admins see every account with role, department, status and last sign-in. They can add, edit, reset the password of, deactivate and reactivate users.

![Admin console, users tab](docs/screenshots/10-admin-users.png)

### A new user has no groups yet

A newly added student signs in and sees no groups, because membership is the boundary. An admin or a group owner has to add them.

![New student with no groups](docs/screenshots/11-new-user-no-groups.png)

### Admin console: managing a group

Admins can rename a group, edit its description, change who can post, and manage its members.

![Manage group dialog](docs/screenshots/12-admin-manage-group.png)

The member list shows the group owner, admins, and muted members, with Mute, Unmute and Remove buttons, plus a search to add people.

![Group members with a muted student](docs/screenshots/13-admin-members-muted.png)

### Deactivating a user

Deactivation asks for confirmation. The user is signed out right away and cannot sign in again until reactivated.

![Deactivate confirmation](docs/screenshots/14-admin-deactivate-confirm.png)

### Creating a group as an admin

Library Notices was created as an Office group with the "Admins post" policy. The dialog opens straight away so members can be added.

![A newly created office group](docs/screenshots/15-admin-create-group.png)

---

## 4. Single sign-on platform

The repository carries a second assignment as well: a **multi-tenant single sign-on platform** built on OAuth 2.0 and OpenID Connect. The chat system described above is sample application 1; a campus library portal is sample application 2. Both sign their users in through the platform, which owns the user directory, the organizations, the security policies, the token-signing keys and the audit log.

An application never sees a password. It sends the browser to the platform's authorization endpoint, receives an authorization code on its own callback, and exchanges that code (with PKCE) for an access token and an ID token. The platform keeps one session per browser, so the second application signs the user in without asking for credentials again — that is the single sign-on part.

```
browser ──▶ /apps/chat/login                 sample application 1 (chat)
            /apps/library/login              sample application 2 (library)
                 │
                 ▼
            /sso/authorize                   authorization endpoint
                 │ no session                 │ session exists
                 ▼                             │ (single sign-on: no credentials asked)
            /sso/login   (password, MFA, social)
                 │
                 ▼
            /sso/token  ⇄  /sso/userinfo, /sso/jwks.json
                 │ authorization code + tokens
                 ▼
            /apps/chat/callback, /apps/library/callback
```

### What the platform provides

| Capability | Where it lives |
|------------|----------------|
| OAuth 2.0 / OpenID Connect (authorization code + PKCE) | `/sso/authorize`, `/sso/token`, `server/services/ssoService.js` |
| Discovery document and JWKS, RS256 signatures | `/.well-known/openid-configuration`, `/sso/jwks.json`, `server/security/tokens.js` |
| Multi-tenancy with data isolation | `server/services/tenantService.js`; a tenant id on users, groups, applications, sessions and audit events |
| Organization administration | `public/admin.html`, `public/js/admin-sso.js`, `/api/admin/*` |
| TOTP second factor, recovery codes, policy per organization | `server/security/totp.js`, `server/services/mfaService.js` |
| Password hashing, strength policy, lockout, reset | `server/security/passwords.js`, `server/services/userService.js` |
| Access and refresh tokens, rotation, revocation, single sign-out | `server/services/ssoService.js` |
| Google and Facebook sign-in, switched on per organization | `server/services/socialService.js` |
| Audit log and failed sign-in monitoring | `server/services/auditService.js`, admin console → **Audit log** |

### Organizations (tenants)

Two organizations are seeded, and each one has its own security policy.

| Organization | Policy | Accounts |
|--------------|--------|----------|
| COMSATS University Islamabad | two-factor optional | `admin.it`, `exam.cell`, `dr.ahmed`, students |
| COMSATS University Lahore | two-factor required | `admin.lhr`, `dr.kamran`, `FA23-BCS-101`, `FA23-BCS-102` |

Every user, group, application, loan and audit event carries the organization it belongs to. A user of one organization never sees the data of the other: Lahore has its own class group, its own users and its own registered application, and the chat and admin APIs are scoped to the caller's organization.

### Roles

| Role | Scope |
|------|-------|
| `admin` | Platform administrator: every organization, user, application and policy |
| `tenant_admin` | Administers its own organization only |
| `faculty`, `student` | Ordinary users of the chat and of the library portal |

### Signing in

1. An application sends the browser to `/sso/authorize` with its client id, callback, scopes and a PKCE challenge.
2. With no platform session, the browser lands on `/sso/login`, which shows which application is asking and which scopes it wants.
3. The user signs in with their login ID and password. If the organization requires a second factor, a TOTP step follows; a user without a factor sees the enrollment step (secret, `otpauth://` link, recovery codes).
4. The platform redirects back to the application's callback with an authorization code, which the application exchanges at `/sso/token` for an access token, an ID token and a refresh token.
5. Opening the second application finds the existing session and issues a code without asking for credentials again.

Social sign-in (Google, Facebook) is offered on the sign-in page for the organizations where an administrator has switched the provider on; the buttons stay disabled until the matching client credentials are configured.

### Tokens, sessions and sign-out

- Access tokens are signed RS256 tokens with a 60–3600 second lifetime (configurable per organization); the ID token mirrors the OpenID Connect claims.
- Refresh tokens rotate on every use, and a replayed refresh token revokes the whole family.
- Changing or resetting a password revokes every session and refresh token for that user.
- **Sign out everywhere** on the account page ends the platform session, and both applications then ask for credentials again. `POST /sso/revoke` and `GET /sso/end-session` are the protocol endpoints behind it.
- Signing keys are a generated RSA-2048 pair in `server/data/keys.json` (gitignored); set `SSO_PRIVATE_KEY_PEM` to use your own.
- There is no mail provider: a password reset prints its single-use link to the server console and records the request, so an administrator can issue a fresh link (admin console → **Users → Reset link**) instead.

### Pages

| URL | Who | Purpose |
|-----|-----|---------|
| `/` | Everyone | Landing page: what the platform is, the two applications, the demo accounts and the platform endpoints |
| `/sso/login` | Everyone | The central sign-in page (password, second factor, enrollment, registration, password reset) |
| `/sso/account` | Signed-in users | Profile, two-step verification, password change, linked providers, active sessions |
| `/sso/reset` | Everyone with a reset link | Sets a new password |
| `/chat.html`, `/apps/chat/` | Chat users | Sample application 1, reached through single sign-on |
| `/apps/library/` | Library users | Sample application 2: borrowed items, due dates, renewals |
| `/admin.html` | Administrators | Users, groups, organizations, applications and the audit log |

The admin console has five tabs: **Users** and **Groups** manage the chat accounts and groups, **Organizations** edits each organization's policies (MFA, self-registration, password rules, token lifetime, social providers), **Applications** registers client applications and rotates their secrets, and **Audit log** lists authentication events with failed sign-in monitoring.

### Screenshots

The landing page, from which either application can be opened. It also lists the demo accounts and the platform endpoints.

![SSO platform landing page](docs/screenshots/sso-01-landing.png)

An application sends the browser to the central sign-in page, which names the application and lists the scopes it is asking for.

![Central sign-in page for the chat application](docs/screenshots/sso-02-signin.png)

The Lahore organization requires a second factor, so its users see the enrollment step: the shared secret, the `otpauth://` link for an authenticator app, and (after confirming a code) their recovery codes.

![Second-factor enrollment step](docs/screenshots/sso-03-mfa.png)

The account page: profile, two-step verification, password change, linked sign-in providers and every active session.

![The account page](docs/screenshots/sso-04-account.png)

The admin console **Users** tab, with the role, organization, status and last sign-in of every account.

![Admin console, users tab](docs/screenshots/sso-05-admin-users.png)

**Organizations** shows both tenants with their policy switches, including whether the second factor is required.

![Admin console, organizations tab](docs/screenshots/sso-06-admin-organizations.png)

**Applications** lists the registered client applications with their client id, redirect URIs, scopes and state.

![Admin console, applications tab](docs/screenshots/sso-07-admin-applications.png)

**Audit log** records every authentication event and flags repeated failures.

![Admin console, audit log tab](docs/screenshots/sso-08-admin-audit.png)

The library portal, sample application 2, after signing in through single sign-on. Students see only their own loans; staff see the whole campus and can renew an item on a student's behalf.

![Library portal](docs/screenshots/sso-09-library.png)

### The two sample applications

| Application | Kind | What it shows |
|-------------|------|---------------|
| COMSATS Connect (`/apps/chat/`) | Browser application with a protected REST and Socket.IO API | Single sign-on, scopes, refresh tokens, a protected API |
| Library portal (`/apps/library/`) | Server-rendered application | A second application reusing the same session, roles inside the application (student vs staff) and a resource API of its own |

Registering a third application is an admin-console operation: **Applications → Register application**, then send the browser to `/sso/authorize` and exchange the code at `/sso/token`, exactly as the two bundled applications do.

### Where to read more

- [Single sign-on setup](docs/SSO-SETUP.md) — running it, the demo walkthrough, Google and Facebook credentials, how each requirement maps to the code, registering a third application and the security notes.
- [REST API reference](#16-rest-api-reference) — the SSO and administration endpoints.
- The landing page at `/` links to the discovery document, the JWKS and the admin console.

---

## 5. Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Runtime | Node.js 18+ | Uses the built-in `fetch` in the demo |
| HTTP server | Express 5 | REST API, and serves the `public` folder |
| Real-time | Socket.IO 4 | Rooms, acknowledgements, handshake auth |
| Authentication | JSON Web Tokens (`jsonwebtoken`) | Shared by REST and sockets |
| Password hashing | `bcryptjs` | 10 salt rounds |
| Storage | JSON file (`server/data/db.json`) | Zero install, easy to inspect |
| Frontend | Plain HTML, CSS and JavaScript | No build step, no framework, no CDN. The Socket.IO client comes from the server at `/socket.io/socket.io.js` |
| Fonts | System fonts (Segoe UI) and Georgia | Works offline |
| Configuration | `dotenv` | Settings come from `.env` |
| Cross-origin | `cors` | Origins controlled by `CLIENT_ORIGIN` |
| Dev tools | `nodemon`, `socket.io-client` | Auto-restart and the demo client |

---

## 6. How This Meets the Assignment

| Assignment requirement | Where it is implemented |
|------------------------|-------------------------|
| Create a communication system using Socket.IO | `server/sockets/index.js` and `server/server.js` |
| Different users can be added | `POST /api/users` (admin), `userService.createUser`, the Admin console, `server/seed.js` |
| Their groups can be created | `POST /api/groups`, `groupService.createGroup`, the Create group dialogs in the chat page and the Admin console |
| Communication boundaries define who can communicate in which group | `server/services/permissionService.js` (membership, posting policy, muting, DM rules) |
| Realistic COMSATS requirements | Exam Cell notices, faculty announcements, class and course groups, societies, FYP teams, supervisor access, registration-number logins |
| A way to see it working | The browser chat client and admin console, plus `tests/demo.js` for an automated multi-user run |

---

## 7. Roles and Communication Rules

### Roles

| Role | Typical account | Login ID format |
|------|-----------------|-----------------|
| `admin` | IT office that manages the whole platform | Username, for example `admin.it` |
| `tenant_admin` | An office that administers its own organization only | Username, for example `exam.cell`, `admin.lhr` |
| `faculty` | Teachers and supervisors | Username, for example `dr.ahmed` |
| `student` | Registered students | Registration number, for example `FA23-BCS-050` |

### Group types

| Type | Example |
|------|---------|
| `class` | BCS-7A |
| `course` | CSC334 Parallel and Distributed Computing |
| `department` | CS Department Announcements |
| `society` | ACM Student Chapter |
| `fyp` | Venturify FYP Team |
| `office` | Exam Cell Notices |

### Posting policy (who may write in a group)

| Policy | Who can post | Typical use |
|--------|--------------|-------------|
| `everyone` | Every member who is not muted | Class and course discussion |
| `faculty_only` | Faculty and admin members | Department announcements |
| `admin_only` | Admin members | Official exam and office notices |

In every case the user must also be a **member** and must **not be muted**.

### Who can create which groups

| Role | Allowed types | Allowed posting policies |
|------|---------------|--------------------------|
| admin | All six types | everyone, faculty_only, admin_only |
| tenant_admin | All six types | everyone, faculty_only, admin_only |
| faculty | course, fyp | everyone, faculty_only |
| student | society, fyp | everyone |

The creator becomes the group's **owner**.

### Who can manage a group

Admins and the group owner can add members, remove members, mute and unmute members, rename the group, change its description and posting policy, and delete it. Ordinary members can only leave on their own.

Extra protections: the owner cannot be removed or muted (delete the group instead), admins cannot be muted, and the last active admin account cannot be deactivated.

### Membership boundary

- Only members can join a group room, read its history or receive its messages.
- This applies to admins too. An admin can inspect a group's roster over REST (and in the Admin console), but cannot read its messages unless they are a member.
- Removing a member immediately removes their live socket from the group room.

### Direct messages

| Sender role | Who they may message |
|-------------|----------------------|
| admin | Anyone |
| tenant_admin | Anyone |
| faculty | Anyone |
| student | Only people who share at least one **open group** (posting policy `everyone`) with them, or who have already messaged them first |

Sharing a read-only notice group, such as Exam Cell Notices or CS Department Announcements, does **not** make two students contacts. Without this rule every student would share the Exam Cell Notices group with every other student, and the direct message boundary would never block anyone.

You cannot message yourself or a deactivated account.

### Abuse control

| Control | Default |
|---------|---------|
| Message length cap | 2000 characters |
| Message rate limit | 10 messages per 10 seconds per socket |
| Typing events rate limit | 50 per 10 seconds per socket |
| Login lockout | 5 failed attempts per minute for the same IP and login ID |
| Request body size | 100 KB |
| Socket payload size | 100 KB |
| Group size | 500 members |

---

## 8. Architecture

```
          +-----------------------------------------------------------+
          |                          Clients                          |
          |  Browser (chat.html, admin.html)   demo script   Postman  |
          +-------------+-----------------------------+---------------+
                        | REST (JWT)                  | Socket.IO (JWT in handshake)
                        v                             v
  +-------------------------------------------------------------------------+
  |                         Express + Socket.IO                             |
  |                                                                         |
  |  public/ (static)   routes/*          sockets/index.js    middleware/*  |
  |  the web client     (REST API)        (real-time engine)  (auth, errors)|
  +----------------------------+-------------------------+------------------+
                               |                         |
                               v                         v
  +-------------------------------------------------------------------------+
  |                    Domain services (the rules)                          |
  |                                                                         |
  |       userService       groupService       permissionService            |
  +--------------------------------+----------------------------------------+
                                   |
                                   v
  +-------------------------------------------------------------------------+
  |            store/db.js  ->  server/data/db.json                         |
  +-------------------------------------------------------------------------+
```

### The single path rule

Both the REST routes and the Socket.IO handlers call the **same service functions**. For example, every group message goes through `groupService.postMessage`, which re-checks membership, mute status and posting policy against the database. There is no code path that posts a message without those checks. The browser only mirrors the rules to decide what to show (for example the locked bar), and the server makes the real decision on every message.

### Socket.IO rooms

| Room | Who is in it | Used for |
|------|--------------|----------|
| `user:<userId>` | Every socket of that user | Direct messages, personal notifications |
| `group:<groupId>` | Sockets of that group's members only | Group messages, typing, presence, updates |

On connection a socket is placed in its user room and in one room per group the user belongs to. Membership changes made over REST add or remove live sockets from rooms.

### Life of a group message

```
Client emits  group:message { groupId, text }
      |
      v
1. Handshake JWT already verified when the socket connected
2. User re-read from the database (is the account still active?)
3. Per-socket rate limiter
4. groupService.postMessage
      - group exists?
      - member of the group?
      - not muted?
      - role allowed by the posting policy?
      - text valid and within the length cap?
5. Message saved to the store
6. Server broadcasts group:message to room group:<groupId>
7. Sender's acknowledgement callback receives { ok: true, message }
```

If any check fails, the sender's acknowledgement receives `{ ok: false, error: { code, message } }` and nothing is broadcast. In the browser, the reason is shown above the message box.

---

## 9. Web Interface

The server serves the `public` folder, so the whole interface is available at **http://localhost:3000** with no build step.

### Pages

| URL | File | Who | Purpose |
|-----|------|-----|---------|
| `/` | `public/index.html` | Everyone | Landing page: what the platform is, the two sample applications, the demo accounts and the platform endpoints |
| `/sso/login` | `public/sso-login.html` | Everyone | The central sign-in page an application sends the browser to (password, second factor, enrollment, registration, password reset) |
| `/sso/account` | `public/sso-account.html` | Signed-in users | Profile, two-step verification, password change, linked providers and active sessions |
| `/sso/reset` | `public/sso-reset.html` | Everyone with a reset link | Sets a new password |
| `/chat.html`, `/apps/chat/` | `public/chat.html` | Signed-in users | Group and direct messaging, reached through single sign-on |
| `/apps/library/` | `public/apps/library/index.html` | Library users | Sample application 2: borrowed items, due dates and renewals |
| `/admin.html` | `public/admin.html` | Admins and organization admins only | Users, groups, organizations, applications and the audit log. Other roles are sent back to the chat page |

A direct link to a conversation works: `chat.html#g:<groupId>` opens a group and `chat.html#d:<userId>` opens a direct message. A visitor with no session is sent to `/apps/chat/login`, which starts the single sign-on flow.

### Chat page

| Area | What it does |
|------|--------------|
| Sidebar | Your name and role, connection status, groups sorted by type (Classes, Courses, Departments, Offices, Societies, FYP teams), direct messages with online dots, and unread counts |
| Lock icon | Marks groups whose posting policy is not "everyone" |
| Header | Group name, type, posting policy, member count and description, and a Members button |
| Message list | Messages grouped by sender and day, role badges for faculty and admins, and "Load earlier messages" for older history |
| Message box | Enter sends and Shift+Enter adds a new line. In a read-only group or when muted it becomes a locked bar with the reason |
| Typing line | Shows who is typing in the open chat |
| Members panel | Member list, mute, remove, add people, edit group, leave group and delete group, depending on your rights |
| Dialogs | Create a group, start a direct message, edit a group |
| Toasts | Live notices: you were added, removed, muted or unmuted |

### Admin console

| Tab | What it does |
|-----|--------------|
| Users | Search and filter by role, department and status, add a user, edit name and department, reset a password, issue a password-reset link, deactivate or reactivate an account |
| Groups | Search and filter by type and posting policy, create any group, and open Manage to edit settings, add, mute or remove members, and delete the group |
| Organizations | Edit each organization's security policy: two-factor requirement, self-registration, password rules, token lifetimes, social providers |
| Applications | Register client applications with their redirect URIs and scopes, and rotate a client secret |
| Audit log | Every authentication and administration event, with failed sign-in monitoring |

The last three tabs belong to the platform and are described in [Single sign-on platform](#4-single-sign-on-platform).

### How the frontend works

| File | Responsibility |
|------|----------------|
| `public/js/api.js` | Session storage, REST calls with the token, socket connection and acknowledgement helper, small DOM helpers, labels |
| `public/js/landing.js` | Landing page: the demo-account list |
| `public/js/sso-login.js` | The central sign-in page: password step, second factor, enrollment, registration, password reset, demo-account chips |
| `public/js/sso-account.js` | Account page: profile, password change, two-step verification, linked providers, sessions |
| `public/js/sso-reset.js` | The password-reset page |
| `public/js/chat.js` | Socket connection, group and conversation lists, messages, composer, typing, unread counts, reconnect sync |
| `public/js/chat-panels.js` | Members panel and the create group, new direct message and edit group dialogs |
| `public/js/admin.js` | Admin console tabs, user and group management |
| `public/js/admin-sso.js` | The organizations, applications and audit-log tabs |
| `public/js/library.js` | The library portal: loans and renewals |
| `public/css/styles.css` | Shared styles |
| `public/css/sso.css` | Landing, sign-in, account and reset pages |
| `public/css/chat.css` | Chat page layout |
| `public/css/admin.css` | Admin console layout |

Design notes:

- **Per-tab sessions:** the token is kept in `sessionStorage`, not `localStorage`, so each tab has its own login. Open one tab as a student and another as faculty to watch messages and blocks happen live. Closing the tab signs you out.
- **Server is the authority:** the browser reads `/api/meta` and the group data to decide what to show, but never to decide what is allowed. If a rule is bypassed in the browser, the server still refuses the message.
- **Safe rendering:** all message text and names are inserted with `textContent`, never `innerHTML`, so a message cannot inject markup.
- **Same-origin:** because the pages and the API come from the same server, no CORS setup is needed for the bundled client.

---

## 10. Project Structure

```
comsats-connect/
├── server/
│   ├── config/
│   │   └── policies.js            Roles, group types, rules, limits, SSO settings
│   ├── data/
│   │   └── .gitkeep               Keeps the folder in Git (db.json and keys.json are generated)
│   ├── security/
│   │   ├── passwords.js           Hashing, strength policy, recovery codes
│   │   ├── tokens.js              RS256 signing keys, JWTs, PKCE helpers
│   │   ├── cookies.js             Session cookie helpers
│   │   └── totp.js                TOTP second factor
│   ├── store/
│   │   └── db.js                  JSON file store, AppError, history paging
│   ├── services/
│   │   ├── userService.js         Users, login, passwords, password reset, direct messages
│   │   ├── groupService.js        Groups, membership, muting, group messages
│   │   ├── permissionService.js   Every communication rule lives here
│   │   ├── tenantService.js       Organizations and their security policies
│   │   ├── ssoService.js          Sessions, authorization codes, tokens, revocation
│   │   ├── mfaService.js          Second-factor enrollment and verification
│   │   ├── socialService.js       Google and Facebook sign-in
│   │   ├── clientAppService.js    Registered applications and their client secrets
│   │   ├── clientAppSync.js       Keeps the bundled applications' callbacks on PUBLIC_BASE_URL
│   │   └── auditService.js        Audit log and failed sign-in monitoring
│   ├── apps/
│   │   ├── oauthClient.js         Authorization-code + PKCE client used by both sample apps
│   │   ├── chatApp.js             Sample application 1: login, callback, session, logout
│   │   └── libraryApp.js          Sample application 2: login, callback, loans, renewals
│   ├── middleware/
│   │   ├── auth.js                Access-token verification, role and tenant guard
│   │   └── errorHandler.js        Uniform JSON errors, async wrapper, 404
│   ├── routes/
│   │   ├── authRoutes.js          First-party login and current user
│   │   ├── userRoutes.js          User listing, creation, updates, DM history
│   │   ├── groupRoutes.js         Groups, members, muting, history
│   │   ├── adminRoutes.js         Organizations, applications, users, audit (/api/admin)
│   │   └── ssoRoutes.js           The platform's own endpoints (/sso/*, /.well-known)
│   ├── sockets/
│   │   ├── rateLimiter.js         Sliding-window limiter, one per socket
│   │   └── index.js               Socket.IO server, rooms, events
│   ├── seed.js                    Loads the demo organizations, users, groups, applications and loans
│   └── server.js                  Express and Socket.IO entry point, serves public/
├── public/
│   ├── apps/
│   │   └── library/
│   │       └── index.html         Library portal (sample application 2)
│   ├── css/
│   │   ├── styles.css             Shared styles
│   │   ├── sso.css                Landing, sign-in, account and reset pages
│   │   ├── chat.css               Chat page layout
│   │   └── admin.css              Admin console layout
│   ├── js/
│   │   ├── api.js                 Session, REST, socket helpers, DOM helpers
│   │   ├── landing.js             Landing page logic
│   │   ├── sso-login.js           Central sign-in page logic
│   │   ├── sso-account.js         Account page logic
│   │   ├── sso-reset.js           Password-reset page logic
│   │   ├── chat.js                Chat page logic
│   │   ├── chat-panels.js         Members panel and chat dialogs
│   │   ├── admin.js               Admin console logic
│   │   ├── admin-sso.js           Organizations, applications and audit-log tabs
│   │   └── library.js             Library portal logic
│   ├── index.html                 Landing page
│   ├── sso-login.html             Central sign-in page
│   ├── sso-account.html           Account page
│   ├── sso-reset.html             Password-reset page
│   ├── chat.html                  Chat page
│   └── admin.html                 Admin console
├── docs/
│   ├── SSO-SETUP.md               Running the platform, credentials, requirement map
│   └── screenshots/               Images used in this README
├── tests/
│   ├── demo.js                    Multi-user boundary demonstration
│   └── sso.js                     End-to-end check of the single sign-on platform
├── .env.example                   Template for your .env
├── .gitignore
├── docker-compose.base44.yml      Base44 sandbox environment (see AGENTS.md)
├── package.json
├── AGENTS.md                      Working notes for automated agents
└── README.md
```

---

## 11. Getting Started

All commands below are for **Windows PowerShell**.

### Prerequisites

| Tool | Version | Check with |
|------|---------|------------|
| Node.js | 18 or newer | `node -v` |
| npm | Comes with Node | `npm -v` |
| Git | Any recent version | `git --version` |
| Browser | Any current Chrome, Edge or Firefox | |

If PowerShell says "running scripts is disabled" when you use `npm`, run this once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Step 1: Clone the repository

```powershell
git clone https://github.com/MuaazTasawar/comsats-connect.git
cd comsats-connect
```

### Step 2: Install dependencies

```powershell
npm install
```

You may see a few npm audit warnings from development packages. Do not run `npm audit fix --force`, because it can break the install. They do not affect this project.

### Step 3: Create your `.env` file

```powershell
Copy-Item .env.example .env
```

Nothing in the file has to be filled in to run the demo. The platform generates its RSA signing key pair on first start (`server/data/keys.json`, gitignored), and every demo account uses the shared demo password. Add Google or Facebook credentials only if you want social sign-in - without them those buttons stay disabled.

All variables are explained in [Environment Variables](#12-environment-variables).

### Step 4: Load the demo data

```powershell
npm run seed
```

You should see `Seed complete`, along with 2 organizations, 16 users, 7 groups, 3 registered applications and a list of demo logins. This creates `server/data/db.json`.

### Step 5: Start the server

```powershell
npm start
```

Expected output:

```
COMSATS Connect API running on http://localhost:3000
Socket.IO is ready for connections.
```

For development with automatic restart on file changes:

```powershell
npm run dev
```

Leave this window open. The server must be running for everything below.

### Step 6: Open the web app

Go to **http://localhost:3000** in your browser. The landing page describes the platform and offers both sample applications; **Sign in with SSO** on the COMSATS Connect card leads to the central sign-in page, where each demo account is one click. Student, faculty and admin accounts each see a different set of groups. Admin accounts also see an "Admin console" link under their name.

If port 3000 is busy, start the server on another port and open that address instead:

```powershell
$env:PORT = 3001
npm start
```

### Step 7: Check the API (optional)

In a **second** PowerShell window:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

You should get `status : ok`.

### Step 8: Run the automated demo (optional)

In the second window, from the project folder:

```powershell
npm run demo
```

See [Running the Automated Demo](#15-running-the-automated-demo).

### Command summary

| Command | What it does |
|---------|--------------|
| `npm start` | Starts the server |
| `npm run dev` | Starts the server with nodemon (auto-restart) |
| `npm run seed` | Loads demo data (does nothing if users already exist) |
| `npm run seed -- --force` | Wipes the database and loads demo data again |
| `npm run demo` | Runs the boundary demo (server must be running) |
| `npm test` | Same as `npm run demo` |
| `npm run demo:sso` | Runs the single sign-on suite (server must be running) |

---

## 12. Environment Variables

Set in `.env` (copied from `.env.example`). Nothing is required to run the project: the social sign-in providers stay disabled until their credentials are present.

**Server and chat limits**

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Address the browser uses to reach the server. It builds the OAuth redirect URIs and the issuer claim, so it must match what you open in the browser |
| `PORT` | `3000` | Port the server listens on |
| `CLIENT_ORIGIN` | `*` | Allowed browser origins for the chat API. Use `*` for any, or a comma-separated list such as `http://localhost:5173,https://app.example.com` |
| `MESSAGE_MAX_LENGTH` | `2000` | Maximum characters in one message |
| `RATE_LIMIT_MESSAGES` | `10` | Messages allowed per window, per socket |
| `RATE_LIMIT_WINDOW_MS` | `10000` | Length of the rate-limit window in milliseconds |
| `HISTORY_LIMIT` | `50` | Default number of messages returned for history (maximum 200) |

**Single sign-on platform**

| Variable | Default | Description |
|----------|---------|-------------|
| `SSO_ISSUER` | `PUBLIC_BASE_URL` | Issuer identifier used in the discovery document and the `iss` claim |
| `SSO_PRIVATE_KEY_PEM` | *(generated)* | Sign the tokens with your own RSA private key instead of the pair generated at `server/data/keys.json` |
| `SSO_KEY_ID` | `env-key` | Key id published in the JWKS when `SSO_PRIVATE_KEY_PEM` is set |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | *(empty)* | Google sign-in. The button stays disabled until both are set *and* the provider is switched on for the organization |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | *(empty)* | Facebook sign-in, same rule |
| `CHAT_CLIENT_ID`, `CHAT_CLIENT_SECRET` | `comsats-connect-chat`, `dev-chat-client-secret` | Client credentials of sample application 1 (the chat) |
| `LIBRARY_CLIENT_ID`, `LIBRARY_CLIENT_SECRET` | `comsats-library-portal`, `dev-library-client-secret` | Client credentials of sample application 2 (the library portal) |
| `LAHORE_CLIENT_ID`, `LAHORE_CLIENT_SECRET` | `comsats-lahore-portal`, `dev-lahore-client-secret` | Client credentials of the Lahore campus portal |

The automated scripts read three optional variables of their own: `BASE_URL` (default `http://localhost:3000`) when the server runs elsewhere, `DEMO_PASSWORD` (default `Comsats@123`), and `NO_COLOR=1` turns off coloured output.

```powershell
$env:BASE_URL = 'http://localhost:4000'; npm run demo
```

A hosted deployment does not read a `.env` file: the same variables are stored as app secrets and delivered to the running server at `/run/base44/app.env`, which the `web` service in `docker-compose.base44.yml` mounts as its last `env_file` so a value set in the dashboard always wins. Nothing is committed and the service is recreated when a credential changes.

---

## 13. Demo Accounts and Seed Data

**Every demo account uses the password `Comsats@123`.** These accounts are for demonstration only. Change or remove them before any real use.

### Users

| Login ID | Name | Role | Department |
|----------|------|------|------------|
| `admin.it` | IT Administrator | admin | Administration |
| `exam.cell` | Exam Cell Office | tenant_admin | Administration |
| `dr.ahmed` | Dr. Ahmed Raza | faculty | Computer Science |
| `dr.sana` | Dr. Sana Malik | faculty | Computer Science |
| `dr.bilal` | Dr. Bilal Hussain | faculty | Management Sciences |
| `FA23-BCS-001` | Abbas Raza | student | Computer Science |
| `FA23-BCS-016` | Amna Bibi | student | Computer Science |
| `FA23-BCS-050` | Muaaz Tasawar | student | Computer Science |
| `FA22-BCS-012` | Ayesha Khan | student | Computer Science |
| `FA22-BCS-078` | Hamza Ali | student | Computer Science |
| `FA22-BEE-031` | Fatima Noor | student | Electrical and Computer Engineering |
| `SP23-BBA-019` | Usman Raza | student | Management Sciences |

The central sign-in page offers five of these as one-click demo buttons: `admin.it`, `exam.cell`, `dr.ahmed`, `FA23-BCS-050` and `FA22-BEE-031`. The Lahore organization has four accounts of its own (`admin.lhr`, `dr.kamran`, `FA23-BCS-101`, `FA23-BCS-102`); see [Single sign-on platform](#4-single-sign-on-platform).

### Groups

| Group | Type | Posting policy | Owner | Members |
|-------|------|----------------|-------|---------|
| BCS-7A | class | everyone | admin.it | dr.ahmed, dr.sana, Muaaz, Ayesha, Hamza |
| CSC334 Parallel and Distributed Computing | course | everyone | dr.ahmed | Muaaz, Ayesha, Hamza |
| CS Department Announcements | department | faculty_only | admin.it | dr.ahmed, dr.sana, Muaaz, Ayesha, Hamza |
| Exam Cell Notices | office | admin_only | exam.cell | admin.it, all faculty, all students |
| ACM Student Chapter | society | everyone | Muaaz | Ayesha, Hamza (**muted**), Fatima |
| Venturify FYP Team | fyp | everyone | Muaaz | Abbas Raza, Amna Bibi, Ayesha, dr.sana |
| BCS-9A (Lahore campus) | class | everyone | admin.lhr | dr.kamran, Ali Hassan, Sara Iqbal |

A few starting messages are also loaded so history is not empty.

### Resetting to this state

```powershell
npm run seed -- --force
```

This wipes `db.json` completely and recreates the data above. If the server is running, stop it first and start it again afterwards, because it keeps the data in memory.

---

## 14. Demo Walkthrough in the Browser

Start from a fresh seed (`npm run seed -- --force`, then `npm start`). Open several tabs of **http://localhost:3000**. Each tab keeps its own login. The screenshot numbers refer to [Screenshots](#3-screenshots).

| Step | Do this | You should see |
|------|---------|----------------|
| 1 | Open the landing page, then **Sign in with SSO** on the COMSATS Connect card | The central sign-in page names the application and its scopes, with one-click demo accounts (screenshot 1) |
| 2 | Tab A: sign in as Muaaz. Tab B: sign in as `dr.ahmed` | Each person sees only their own groups, sorted by type (screenshots 2 and 4) |
| 3 | Tab B: post in the CSC334 group while Tab A has it open | The message appears in Tab A at once. While Tab B types, Tab A shows "Dr. Ahmed Raza is typing..." |
| 4 | Tab A: open CS Department Announcements | A locked bar: "Read-only. Only faculty and admins can post in this group." (screenshot 3) |
| 5 | Tab B: post in CS Department Announcements | Tab A receives it live (or shows an unread badge if another chat is open). Faculty can post here, students cannot |
| 6 | Tab B: open Exam Cell Notices | Even faculty are locked out. Only `exam.cell` or `admin.it` can post |
| 7 | Tab B: open CSC334, press Members, then Mute next to Muaaz | Tab A shows a toast and Muaaz's message box locks, while the history stays readable (screenshots 5 and 6) |
| 8 | Tab C: sign in as Fatima | She sees only Exam Cell Notices and the ACM Student Chapter. BCS-7A is invisible to her |
| 9 | Tab A: press + next to Direct messages and send Usman Raza a message | Blocked. Muaaz and Usman only share the read-only Exam Cell Notices (screenshot 8) |
| 10 | Tab B: send Usman a direct message. Then, in a new tab as Usman, reply to Muaaz | Faculty can message anyone, and Usman can reply to Muaaz because Muaaz messaged him first |
| 11 | Tab A: press + next to Groups | Only Society and FYP team, with the "Everyone can post" policy (screenshot 7) |
| 12 | Tab D: sign in as `admin.it`, open the Admin console, add a student, then open Groups, Manage BCS-7A and add them | The new user sees BCS-7A appear live, with a toast (screenshots 10 to 13) |
| 13 | In Manage, press Mute next to the new user | Their message box locks live |
| 14 | In the Users tab, press Deactivate next to the new user | Their tab is signed out immediately and they cannot sign in again (screenshot 14) |
| 15 | Create a group, for example Library Notices as an Office group with "Admins post" | The group appears in the table and the Manage dialog opens so members can be added (screenshot 15) |
| 16 | Sign in as `FA23-BCS-050` and open `/admin.html` | The page sends you back to the chat page. The server also refuses the admin API calls for non-admins |
| 17 | Run `npm run demo` | Thirteen scenarios print PASS or FAIL for every boundary |

---

## 15. Running the Automated Demo

`tests/demo.js` is the quickest way to check every rule at once. It logs in six users, opens a Socket.IO connection for each, and runs thirteen scenarios, printing which messages were delivered and which were blocked and why. Each check prints `PASS` or `FAIL`.

### How to run it

1. Make sure the server is running (`npm start` in one window).
2. For the cleanest run, reset the data first: stop the server, run `npm run seed -- --force`, then start the server again.
3. In a second window: `npm run demo`

The demo prepares its own starting state (for example it makes sure Fatima is not in the FYP team and that Hamza is muted), and it cleans up the groups it creates, so it can be run repeatedly. It also creates one extra student, **Loner Student** (`FA22-BCS-999`), who belongs to no group. You will see this account in the Admin console after the first run. It is useful for showing the direct message boundary.

### Scenarios

| # | Scenario | What it proves |
|---|----------|----------------|
| 1 | Authentication | Sockets without a token or with a bad token are refused |
| 2 | Group listing | Each user sees only their own groups |
| 3 | Course group (`everyone`) | A student's message reaches members only, not outsiders |
| 4 | Announcements (`faculty_only`) | Students are blocked, faculty posts reach students |
| 5 | Exam notices (`admin_only`) | Faculty and students are blocked, an admin's notice reaches all members |
| 6 | Muting | A muted student can read but not post, and live unmuting works |
| 7 | Membership boundary | Non-members cannot read, post or receive. Adding and removing a member updates delivery live |
| 8 | Group creation rules | Students cannot create class groups or faculty-only societies, faculty cannot create societies |
| 9 | Direct messages | Students can DM classmates but not strangers. Faculty can DM anyone, and a reply is then allowed |
| 10 | Message validation | Empty and over-length messages are rejected |
| 11 | Rate limiting | A burst of 15 messages is partially blocked |
| 12 | Presence | Members see a user come online and go offline |
| 13 | Deactivation | A deactivated user is disconnected instantly and cannot log in |

The demo exits with code 0 when every check passes, and 1 otherwise. Set `NO_COLOR=1` to turn off colored output.

### The single sign-on suite

`tests/sso.js` (`npm run demo:sso`) is the same idea for the platform: it checks the discovery document and JWKS, the authorization-code flow with PKCE, the token exchange, refresh-token rotation and replay detection, second-factor enrollment and verification, tenant isolation, password reset and the audit log, printing `PASS` or `FAIL` for about 75 checks. It restores everything it changes except one library renewal: after a few runs that demo loan is at its renewal limit, so the suite checks the limit instead of a successful renewal. Re-seed to get the renewal path back.

```bash
npm run demo:sso
```

---

## 16. REST API Reference

Base URL: `http://localhost:3000`
All chat endpoints except `/api/health`, `/api/meta` and `/api/auth/login` need the header `Authorization: Bearer <token>`. The single sign-on endpoints at the end of this section are the exception: they identify the caller with the platform session cookie, and the administration endpoints need an administrator's bearer token.

All errors use one format:

```json
{ "error": { "code": "NOT_MEMBER", "message": "You are not a member of this group." } }
```

### General

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server status |
| GET | `/api/meta` | Roles, group types, policies, creation rules, departments, message limit, and the platform endpoints (issuer, authorize, token, userinfo, discovery, JWKS, scopes, social providers) |

### Authentication

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | `{ loginId, password }` | Returns `{ token, expiresIn, refreshToken, tokenType, user, tenant }`, or `401` with an MFA ticket for an account that has a second factor |
| GET | `/api/auth/me` | none | Returns the current user |

### Users

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/api/users` | Any user | List users. Query: `role`, `department`, `search`, `includeInactive=true` (admin only) |
| GET | `/api/users/me/conversations` | Any user | Your direct-message partners with the last message |
| GET | `/api/users/:id` | Any user | One user |
| GET | `/api/users/:id/messages` | Any user | Your DM history with that user. Query: `limit`, `before` |
| POST | `/api/users` | **Admin** | Create a user. Body: `{ loginId, name, role, department, password }` |
| PATCH | `/api/users/:id` | **Admin** | Update `name`, `department`, `active`, `password` |

### Groups

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/api/groups` | Any user | Groups you belong to, including `myGroupRole` and `muted` |
| GET | `/api/groups/all` | **Admin** | Every group |
| POST | `/api/groups` | Any user (rules apply) | Create a group. Body: `{ name, type, postPolicy?, description?, memberIds? }` |
| GET | `/api/groups/:id` | Member or admin | Group details with the member list |
| PATCH | `/api/groups/:id` | Owner or admin | Update `name`, `description`, `postPolicy` |
| DELETE | `/api/groups/:id` | Owner or admin | Delete the group, its memberships and its messages |
| POST | `/api/groups/:id/members` | Owner or admin | Add a member. Body: `{ userId }` |
| DELETE | `/api/groups/:id/members/:userId` | Owner or admin, or the member themselves | Remove a member, or leave the group |
| PATCH | `/api/groups/:id/members/:userId` | Owner or admin | Mute or unmute. Body: `{ muted: true }` |
| GET | `/api/groups/:id/messages` | **Members only** | Group history. Query: `limit`, `before` |

### History paging

`limit` returns the newest N messages (default 50, maximum 200), oldest first. To load older messages, pass `before` set to the `createdAt` of the oldest message you already have. The chat page uses this for "Load earlier messages".

### Example: create a group

```
POST /api/groups
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Debate Society",
  "type": "society",
  "postPolicy": "everyone",
  "description": "Weekly debates",
  "memberIds": ["usr_ab12cd34ef56"]
}
```

### Single sign-on and administration

These endpoints belong to the platform rather than to the chat.

**OAuth 2.0 / OpenID Connect**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/.well-known/openid-configuration` | Discovery document (also served at `/sso/.well-known/openid-configuration`) |
| GET | `/sso/jwks.json` | The public signing keys |
| GET | `/sso/authorize` | Authorization endpoint. Query: `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method` |
| POST | `/sso/token` | Token endpoint: the `authorization_code`, `refresh_token` and `revocation` grants |
| GET, POST | `/sso/userinfo` | Claims of the access token |
| POST | `/sso/revoke` | Revokes an access or refresh token |
| GET | `/sso/end-session` | Single sign-out; ends the platform session |
| GET | `/sso/social/:provider/start` | Starts Google or Facebook sign-in |
| GET | `/sso/social/:provider/callback` | The provider's callback |

**Sign-in, account and password**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sso/api/login-context` | The application, organization, policies and social providers behind a sign-in request |
| POST | `/sso/api/login` | `{ loginId, password }` plus the authorize parameters; returns tokens, or the second-factor step |
| POST | `/sso/api/login/mfa` | A TOTP code, or a recovery code |
| POST | `/sso/api/login/enroll/start`, `/sso/api/login/enroll/confirm` | Enrollment when the organization requires a factor |
| POST | `/sso/api/register` | Self-registration, where the organization allows it |
| POST | `/sso/api/password/forgot`, `/sso/api/password/reset` | Request and complete a password reset |
| GET | `/sso/api/session` | The current platform session |
| POST | `/sso/api/logout` | Ends the platform session |
| GET | `/sso/api/account` | Profile, linked providers and active sessions |
| POST | `/sso/api/account/password` | Changes the password (revokes every session) |
| POST | `/sso/api/account/mfa/start`, `/confirm`, `/recovery-codes`, `/disable` | Two-step verification |
| POST | `/sso/api/account/sessions/:id/revoke` | Ends one session |
| POST | `/sso/api/account/social/:provider/unlink` | Unlinks a provider |

**Administration** (bearer token of an `admin` or `tenant_admin`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/me` | The signed-in administrator and their organization |
| GET | `/api/admin/meta` | Roles, departments, token and password limits, social providers, scopes |
| GET | `/api/admin/overview` | Dashboard counts, including failed sign-ins |
| GET, POST, PATCH | `/api/admin/tenants`, `/api/admin/tenants/:id` | List, create and edit organizations and their policies |
| GET, POST, PATCH | `/api/admin/apps`, `/api/admin/apps/:id` | List, register and edit client applications |
| POST | `/api/admin/apps/:id/secret` | Rotates a client secret |
| GET, POST, PATCH | `/api/admin/users`, `/api/admin/users/:id` | List, create and edit users |
| POST | `/api/admin/users/:id/reset-link` | Issues a password-reset link |
| GET | `/api/admin/password-resets` | Pending reset requests |
| GET | `/api/admin/audit` | Audit events with a failure summary. Query: `type`, `outcome`, `limit`, `tenantId` |

**Sample applications**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/apps/chat/login`, `/apps/library/login` | Starts the flow at the application |
| GET | `/apps/chat/callback`, `/apps/library/callback` | The application's callback, where the code is exchanged |
| GET | `/apps/chat/api/session`, `/apps/library/api/session` | The session of the signed-in application user |
| GET | `/apps/library/api/loans` | Loans of the signed-in library user |
| POST | `/apps/library/api/loans/:id/renew` | Renews a loan |
| POST | `/apps/chat/logout`, `/apps/library/logout` | Application sign-out |

---

## 17. Socket.IO Reference

### Connecting

Send the JWT from `/api/auth/login` in the handshake:

```js
const { io } = require('socket.io-client');
const socket = io('http://localhost:3000', { auth: { token } });
```

In the browser the client script comes from the server itself, so no install is needed:

```html
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io({ auth: { token } });
</script>
```

A connection without a valid token, or for a deactivated account, is rejected with a `connect_error` whose `err.data.code` explains why.

### Acknowledgements

Every client-to-server event takes an acknowledgement callback as the last argument and receives one of:

```js
{ ok: true, ...result }
{ ok: false, error: { code: 'MUTED', message: '...' } }
```

### Client to server events

| Event | Payload | Success reply | Description |
|-------|---------|---------------|-------------|
| `groups:list` | none | `{ ok, groups }` | Your groups, each with `onlineMemberIds` |
| `group:message` | `{ groupId, text }` | `{ ok, message }` | Post to a group |
| `direct:message` | `{ toUserId, text }` | `{ ok, message }` | Send a direct message |
| `group:history` | `{ groupId, limit?, before? }` | `{ ok, messages }` | Group history (members only) |
| `direct:history` | `{ withUserId, limit?, before? }` | `{ ok, messages }` | Your DM history with one user |
| `typing` | `{ groupId, isTyping }` or `{ toUserId, isTyping }` | `{ ok }` | Typing indicator, silently ignored if you could not post |

### Server to client events

| Event | Payload | Sent to |
|-------|---------|---------|
| `group:message` | `{ id, groupId, senderId, senderName, senderRole, text, createdAt }` | All sockets in the group room, **including the sender** |
| `direct:message` | `{ id, fromId, toId, senderName, text, createdAt }` | Both users' personal rooms |
| `typing` | Group: `{ groupId, userId, name, isTyping }`. DM: `{ fromUserId, name, isTyping }` | Other members, or the DM recipient |
| `presence:update` | `{ userId, name, online }` | Users who share a group with that user |
| `group:added` | `{ group }` | A user who was just added to a group (and their sockets join the room) |
| `group:removed` | `{ groupId }` | A user who was removed, or all members when a group is deleted |
| `group:updated` | `{ group }` to the group room, or `{ groupId, muted }` to a user who was muted or unmuted | Members |

Because the sender is also in the group room, they receive their own message through the broadcast as well as the acknowledgement. Clients should de-duplicate by `message.id`. The chat page does this.

### Minimal client example

```js
const { io } = require('socket.io-client');

async function main() {
  const res = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'FA23-BCS-050', password: 'Comsats@123' }),
  });
  const { token } = await res.json();

  const socket = io('http://localhost:3000', { auth: { token } });

  socket.on('group:message', (m) => console.log(m.senderName + ': ' + m.text));
  socket.on('presence:update', (p) => console.log(p.name + (p.online ? ' is online' : ' went offline')));

  socket.on('connect', () => {
    socket.emit('groups:list', {}, (reply) => {
      const group = reply.groups.find((g) => g.name === 'Venturify FYP Team');
      socket.emit('group:message', { groupId: group.id, text: 'Hello team' }, (r) => {
        console.log(r.ok ? 'sent' : 'blocked: ' + r.error.code);
      });
    });
  });
}

main();
```

---

## 18. Manual Testing Guide

You can test with the browser, with the demo, with PowerShell, or with Postman.

### With the browser

Follow [Demo Walkthrough in the Browser](#14-demo-walkthrough-in-the-browser). It covers every boundary with two or three tabs.

### With PowerShell

Log in and keep the token in a header:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body '{"loginId":"FA23-BCS-050","password":"Comsats@123"}'
$h = @{ Authorization = "Bearer $($login.token)" }
```

List your groups:

```powershell
(Invoke-RestMethod -Uri http://localhost:3000/api/groups -Headers $h).groups | Select-Object name,type,postPolicy,myGroupRole,muted | Format-List
```

A student tries to create a class group (refused with `GROUP_TYPE_FORBIDDEN`):

```powershell
try { Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/groups -Headers $h -ContentType 'application/json' -Body '{"name":"Fake Class","type":"class"}' } catch { $_.ErrorDetails.Message }
```

A student tries to create a user (refused with `ROLE_FORBIDDEN`):

```powershell
try { Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/users -Headers $h -ContentType 'application/json' -Body '{"loginId":"FA22-BCS-099","name":"Test","role":"student","department":"Computer Science","password":"Comsats@123"}' } catch { $_.ErrorDetails.Message }
```

An admin creates a user:

```powershell
$a = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body '{"loginId":"admin.it","password":"Comsats@123"}'
$ah = @{ Authorization = "Bearer $($a.token)" }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/users -Headers $ah -ContentType 'application/json' -Body '{"loginId":"FA22-BCS-099","name":"Test Student","role":"student","department":"Computer Science","password":"Comsats@123"}'
```

A non-member reads a group's history (refused with `NOT_MEMBER`):

```powershell
$f = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body '{"loginId":"FA22-BEE-031","password":"Comsats@123"}'
$fh = @{ Authorization = "Bearer $($f.token)" }
$gid = ((Invoke-RestMethod -Uri http://localhost:3000/api/groups/all -Headers $ah).groups | Where-Object { $_.name -eq 'Venturify FYP Team' }).id
try { Invoke-RestMethod -Uri "http://localhost:3000/api/groups/$gid/messages" -Headers $fh } catch { $_.ErrorDetails.Message }
```

### With Postman

REST endpoints work with a normal HTTP request and the `Authorization: Bearer <token>` header. Postman can also open a Socket.IO connection (New, then Socket.IO). Put the token in the **Auth** section of the handshake, then add listeners for the server events in section 17.

### Watching real-time delivery by hand

Open three PowerShell windows, save the client example from section 17 with different login IDs (for example Muaaz, Ayesha and Fatima), and run them. Messages sent to the Venturify FYP Team reach Muaaz and Ayesha but never Fatima, until you add her with `POST /api/groups/:id/members`. In the browser, the same test is steps 2 and 8 of the walkthrough.

---

## 19. Error Codes

### Authentication and request errors

| Code | HTTP | Meaning |
|------|------|---------|
| `NO_TOKEN` | 401 | No token was supplied |
| `INVALID_TOKEN` | 401 | Token is invalid, expired, or its user no longer exists |
| `INVALID_CREDENTIALS` | 401 | Wrong login ID or password |
| `TOO_MANY_ATTEMPTS` | 429 | Too many failed logins, wait one minute |
| `ACCOUNT_DISABLED` | 403 | The account has been deactivated |
| `ROLE_FORBIDDEN` | 403 | The route needs a different role (for example admin) |
| `ROUTE_NOT_FOUND` | 404 | Unknown URL |
| `BAD_JSON` | 400 | Request body is not valid JSON |
| `BODY_TOO_LARGE` | 413 | Request body over 100 KB |
| `BAD_PAYLOAD` | 400 | A required socket field is missing or malformed |
| `INTERNAL_ERROR` | 500 | Unexpected server error (details are logged on the server) |

### User errors

| Code | HTTP | Meaning |
|------|------|---------|
| `BAD_NAME` | 400 | Name must be 2 to 80 characters |
| `BAD_ROLE` | 400 | Role must be admin, faculty or student |
| `BAD_LOGIN_ID` | 400 | Login ID does not match the format for that role |
| `BAD_DEPARTMENT` | 400 | Department is not in the COMSATS list |
| `WEAK_PASSWORD` | 400 | Password shorter than 8 characters |
| `USER_EXISTS` | 409 | Login ID already taken |
| `USER_NOT_FOUND` | 404 | No such user |
| `BAD_ACTIVE` | 400 | `active` must be true or false |
| `LAST_ADMIN` | 400 | Cannot deactivate the last active admin |
| `USER_INACTIVE` | 400 | The user's account is deactivated |

### Group and membership errors

| Code | HTTP | Meaning |
|------|------|---------|
| `GROUP_NOT_FOUND` | 404 | No such group |
| `BAD_GROUP_NAME` | 400 | Name must be 2 to 60 characters |
| `BAD_DESCRIPTION` | 400 | Description too long (300 characters) or not text |
| `GROUP_EXISTS` | 409 | Group name already used |
| `GROUP_FULL` | 400 | Group has reached 500 members |
| `BAD_GROUP_TYPE` | 400 | Unknown group type |
| `BAD_POST_POLICY` | 400 | Unknown posting policy |
| `GROUP_TYPE_FORBIDDEN` | 403 | Your role cannot create that group type |
| `POST_POLICY_FORBIDDEN` | 403 | Your role cannot use that posting policy |
| `NOT_GROUP_OWNER` | 403 | Only the owner or an admin can do that |
| `ALREADY_MEMBER` | 409 | User is already in the group |
| `NOT_MEMBER` | 403 or 404 | You are not a member of that group, or the user is not a member |
| `OWNER_PROTECTED` | 400 | The owner cannot be removed or muted |
| `ADMIN_PROTECTED` | 403 | Admins cannot be muted |
| `BAD_MUTED` | 400 | `muted` must be true or false |

### Messaging boundary errors

| Code | HTTP | Meaning |
|------|------|---------|
| `MUTED` | 403 | You are muted in that group |
| `POLICY_FACULTY_ONLY` | 403 | Only faculty and admins can post here |
| `POLICY_ADMIN_ONLY` | 403 | Only admins can post here |
| `POLICY_FORBIDDEN` | 403 | Your role cannot post here |
| `DM_NOT_ALLOWED` | 403 | A student may not message that person |
| `RECIPIENT_UNAVAILABLE` | 404 | The recipient is missing or deactivated |
| `SELF_DM` | 400 | You cannot message yourself |
| `BAD_MESSAGE` | 400 | Message text must be a string |
| `EMPTY_MESSAGE` | 400 | Message is empty |
| `MESSAGE_TOO_LONG` | 400 | Message is over the length cap |
| `RATE_LIMITED` | n/a | Sending too fast. The reply includes `retryAfterMs` |
| `INACTIVE` | 403 | Your account is not active |

### Single sign-on errors

| Code | HTTP | Meaning |
|------|------|---------|
| `NO_SESSION` | 401 | No platform session; sign in first |
| `MFA_REQUIRED` | 401 | The account has a second factor; send the code to `/sso/api/login/mfa` |
| `MFA_ENROLL_REQUIRED` | 401 | The organization requires a second factor; enroll first |
| `MFA_CODE_INVALID` | 400 | The TOTP code or recovery code did not match |
| `MFA_NOT_ENABLED` / `MFA_NOT_STARTED` | 400 | No second factor is enabled, or enrollment was not started |
| `REGISTRATION_DISABLED` | 403 | The organization does not allow self-registration |
| `INVALID_RESET_TOKEN` | 400 | The password-reset link is unknown, already used or expired |
| `INVALID_TICKET` | 400 | The short-lived ticket between sign-in steps expired |
| `INVALID_PKCE` | 400 | The PKCE verifier is missing or does not match the challenge |
| `BAD_REDIRECT_URI` | 400 | The callback does not match the one registered for the application |
| `UNKNOWN_CLIENT` / `INVALID_CLIENT` | 400, 401 | Unknown client, or a wrong client secret |
| `BAD_APP` / `APP_DISABLED` | 400, 403 | The application is malformed or has been disabled |
| `INVALID_GRANT` | 400 | The authorization code or refresh token cannot be used: expired, already redeemed or replayed |
| `INVALID_STATE` | 400 | The `state` the application sent back does not match |
| `UNSUPPORTED_RESPONSE_TYPE` / `UNSUPPORTED_GRANT` | 400 | The requested flow is not supported |
| `TENANT_NOT_FOUND` / `TENANT_SUSPENDED` | 404, 403 | The organization is unknown or suspended |
| `WRONG_TENANT` / `CROSS_TENANT` / `TENANT_FORBIDDEN` | 403 | The account or data belongs to another organization |
| `TENANT_EXISTS` | 409 | An organization with that slug already exists |
| `SESSION_NOT_FOUND` | 404 | The session to revoke does not exist |
| `SOCIAL_ALREADY_LINKED` / `SOCIAL_ACCOUNT_NOT_LINKED` | 409, 403 | The provider account is linked elsewhere, or nothing is linked |
| `PROVIDER_NOT_CONFIGURED` / `PROVIDER_DISABLED` | 503, 403 | The provider has no credentials, or is switched off for the organization |
| `PROVIDER_ERROR` | 502 | The provider refused the sign-in |
| `UNKNOWN_PROVIDER` | 404 | No such social provider |
| `TOKEN_EXPIRED` | 401 | The access token has expired |
| `BAD_ORIGIN` | 403 | The request came from an origin the platform does not accept |
| `SCOPE_FORBIDDEN` | 403 | The application asked for a scope it is not registered for |
| `APP_NOT_FOUND` / `APP_EXISTS` | 404, 409 | Application not found, or a client id already in use |
| `LOAN_NOT_FOUND` / `LOAN_FORBIDDEN` / `LOAN_OVERDUE` / `LOAN_RETURNED` / `RENEWAL_LIMIT` | 404, 403, 400 | Library portal loan errors |

---

## 20. Data Storage

All data is kept in `server/data/db.json`, created on first run. It is loaded into memory at startup, and writes are batched (about 200 ms after the last change) and saved safely through a temporary file. Pending writes are flushed when the process exits, on Ctrl+C, and when nodemon restarts the server.

If `db.json` is ever corrupted, the server copies it to `db.json.corrupt-<timestamp>` and starts with an empty database. The database file, its temporary file and any corrupt backups are excluded from Git.

### Collections

**Chat application**

| Collection | Fields |
|------------|--------|
| `users` | `id`, `tenantId`, `loginId`, `name`, `role`, `department`, `email`, `passwordHash`, `active`, `createdAt`, `lastLoginAt`, plus `mfa` (second factor) and `socialLinks` |
| `groups` | `id`, `tenantId`, `name`, `type`, `postPolicy`, `description`, `createdBy`, `createdAt`, `updatedAt` |
| `memberships` | `groupId`, `userId`, `groupRole` (owner or member), `muted`, `joinedAt` |
| `messages` | `id`, `groupId`, `senderId`, `senderName`, `senderRole`, `text`, `createdAt` |
| `directMessages` | `id`, `fromId`, `toId`, `senderName`, `text`, `createdAt` |

**Single sign-on platform**

| Collection | Holds |
|------------|-------|
| `tenants` | Organizations: name, slug, status and their security policy (second factor, self-registration, password rules, token lifetimes, social providers) |
| `clientApps` | Registered applications: client id, hashed client secret, organization, redirect URIs, post-logout redirect URIs and scopes |
| `authCodes` | Single-use authorization codes with their PKCE challenge, redirect URI and expiry |
| `refreshTokens` | Refresh tokens (hashed) with their token family and rotation state |
| `sessions` | Platform sessions: the account, the organization, the browser and when it was last seen |
| `auditLogs` | Authentication and administration events with their outcome, actor, organization and request details |
| `passwordResets` | Single-use password-reset tokens and whether they have been used |
| `appSessions` | The sample applications' own sessions, separate from the platform session |
| `libraryLoans` | The library portal's data: item, author, due date, renewals, return date |

Anyone who clones the repository runs `npm run seed` to create their own database.

---

## 21. Security Notes

- Passwords are hashed with bcrypt and never returned by the API.
- The user's **role and active status are read from the database on every request and every socket event**, not trusted from the token. Demoting or deactivating a user takes effect immediately.
- Failed logins are limited per IP and login ID. Login errors are deliberately generic, and a dummy hash comparison keeps timing similar when a login ID does not exist.
- Message text is stored exactly as typed (trimmed). The bundled web client renders all text with `textContent`, so messages cannot inject markup. Any other front end that displays messages must escape them to prevent cross-site scripting.
- The web client keeps its access token in `sessionStorage`, so it disappears when the tab closes. Access tokens are short-lived (60 to 3600 seconds, configured per organization), a refresh rotates the token, and an expired session sends the user back to the sign-in page. The platform session itself is an HTTP-only cookie.
- The browser never decides what is allowed. The checks that hide or lock controls are a convenience, and the server repeats every check.
- Tokens are signed RS256 with a key pair that is generated on first start (`server/data/keys.json`, gitignored); set `SSO_PRIVATE_KEY_PEM` to use your own key, and serve the platform over HTTPS. Never commit your `.env` file (it is in `.gitignore`).
- The demo accounts share one published password. Remove them, or change their passwords, before any real use.
- For a public deployment, set `CLIENT_ORIGIN` to your real front-end origin(s) instead of `*`, and serve over HTTPS.

---

## 22. Troubleshooting

| Problem | Cause and fix |
|---------|---------------|
| `npm : File ... cannot be loaded because running scripts is disabled` | Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once |
| `Error: listen EADDRINUSE :::3000` | Port 3000 is taken, usually by an earlier copy of the server. Find the process with `Get-NetTCPConnection -LocalPort 3000 -State Listen`, stop it with `Stop-Process -Id <pid> -Force`, or start on another port with `$env:PORT = 3001` |
| The login page shows "Route not found" or JSON instead of the page | The server is not serving the `public` folder. Make sure `server/server.js` contains the `express.static` line and restart the server |
| "Invalid login ID or password" with a demo account | Browsers may autofill an old saved login over what you typed. Click one of the demo account buttons, or run `npm run seed -- --force` and restart the server |
| Chat area is blank | Press F12, open the Console tab and read the red error. Hard-refresh with Ctrl+F5 after any file change |
| A group does not appear after being added | The page updates live. If it does not, the socket is probably disconnected. Check the connection status under your name in the sidebar |
| Demo says it cannot reach the server | Start it with `npm start` in another window, and check `BASE_URL` if you changed the port |
| Demo says "Login failed ... Did you run npm run seed?" | The database is empty. Run `npm run seed -- --force`, then restart the server |
| Demo says a group was not found | The seed data was changed. Run `npm run seed -- --force` and restart the server |
| "Continue with Google" or "Continue with Facebook" stays disabled | The provider has no credentials yet, or it is switched off for the organization. Add the keys (see [Credentials for Google and Facebook](docs/SSO-SETUP.md)) and enable the provider in the admin console |
| Sign-in fails with `BAD_REDIRECT_URI` after the address changed | The callback registered for the application no longer matches `PUBLIC_BASE_URL`. The three bundled applications are re-pointed on start-up, so restart the server; register the new callback for any application you added yourself |
| Changes to `.env` have no effect | Restart the server, since `.env` is read only at startup |
| Data seems stale after running `npm run seed -- --force` while the server is running | The running server holds the old data in memory. Stop the server, seed, then start it again |
| `The database already contains users, so nothing was changed` | This is the normal safety check. Use `--force` to wipe and reseed |
| A socket connects but receives no messages | The user is not a member of that group. This is the boundary working. Check `GET /api/groups` for that user |
| Messages seem to arrive twice in a client | The sender gets both the broadcast and the acknowledgement. De-duplicate on `message.id` |
| `RATE_LIMITED` replies | You exceeded 10 messages per 10 seconds on one socket. Wait or raise `RATE_LIMIT_MESSAGES` |
| Git shows `LF will be replaced by CRLF` warnings | Harmless line-ending notices on Windows |
| `npm audit` reports vulnerabilities | They come from development packages. Do not use `--force` |

---

## 23. Phase Build History

| Phase | Name | What was built |
|-------|------|----------------|
| 0 | Project Init and Config | Project setup, `.gitignore`, `.env.example`, `package.json` scripts, and `policies.js` with all roles, group types, rules, limits and event names |
| 1 | Data Layer and Domain Services | JSON store, permission rules, user service (login, DMs), group service (groups, membership, muting, messages), and the seed script |
| 2 | Auth and REST API | JWT authentication, role guard, error handling, auth, user and group routes, and the Express server |
| 3 | Socket.IO Real-Time Engine | Authenticated sockets, room-based delivery boundaries, live membership sync, rate limiting, presence, typing |
| 4 | Demo Script and Finalize | The thirteen-scenario boundary demo |
| 5 | Frontend Foundation and Login | Static file serving, shared styles, session and API helpers, sign-in page with demo accounts |
| 6 | Chat Client | Group and direct chat, locked message bar for read-only groups, members panel, group creation, direct message dialog, unread counts, typing, presence, reconnect sync |
| 7 | Admin Console | User management and full group management for admins |
| 8 | Single Sign-On Provider | OAuth 2.0 / OpenID Connect: discovery document, JWKS with RS256, authorization code flow with PKCE, access, ID and refresh tokens, sessions and revocation |
| 9 | Multi-Tenancy, MFA and Social Sign-In | Organizations with their own data and policies, TOTP second factor with recovery codes, Google and Facebook sign-in, password policy and reset, audit log |
| 10 | Sample Applications and Documentation | The chat and library applications moved onto the platform, with the landing, sign-in, account and reset pages; SSO screenshots, `docs/SSO-SETUP.md` and this section |

**Later changes**

- Fixed a header that showed the text "null" when a chat had no subtitle details.
- Tightened the student direct message rule so only open groups count as a shared group. Sharing a read-only notice group no longer lets two students message each other.
- Stopped tracking the temporary database files in Git.
- Added this README with screenshots and a browser walkthrough.
- Merged the chat application and the single sign-on platform into one server: the chat now signs its users in through the platform, so `/` is the platform landing page and the chat entry point is `/apps/chat/login`.
- Pointed the three bundled applications at the current `PUBLIC_BASE_URL` on start-up, so a changed deployment address no longer breaks their registered callbacks.
- Documented the single sign-on platform, its endpoints, its environment variables and its screenshots in this README.

---

## 24. Limitations and Future Work

**Current limitations**

- The JSON file store suits a lab or small deployment. It is a single process and writes the whole file, so it does not scale to many thousands of users.
- Running more than one server instance would require a shared database and the Socket.IO Redis adapter.
- Presence and rate-limit state are held in memory and reset when the server restarts. The rate limit is per socket, so reconnecting resets the budget.
- Only text messages are supported. There are no file attachments, reactions, edits or deletions.
- A password reset has no mail provider behind it: the single-use link is printed to the server console, and an administrator can issue one from the admin console. Self-registration is off until an organization switches it on.
- The chat client keeps its tokens in `sessionStorage`, so a user signs in again in every new tab. The platform session itself is a cookie, so the SSO pages remember you.
- The platform does not federate with external identity providers: Google and Facebook are the only social options, and there is no SAML or LDAP support.
- The web client has no read receipts, sound or desktop notifications.

**Ideas for extension**

- A real database (MongoDB or PostgreSQL) behind `store/db.js`.
- Read receipts and desktop notifications.
- File sharing for course material.
- Scheduled announcements and message pinning.
- Group join requests that an owner can approve.
- Audit logs of moderation actions.
- Email or push notifications for offline users.
- A mobile client using the same events.

---

## 25. Contributing

1. Fork the repository and create a feature branch.
2. Keep every communication rule inside `server/services/permissionService.js` so REST and Socket.IO stay consistent.
3. In the frontend, insert user text with `textContent` (the `el` helper does this) and never with `innerHTML`.
4. Add a scenario to `tests/demo.js` for any new rule, and make sure `npm run demo` passes against a freshly seeded database.
5. Use commit messages in the form `Area: short description`.
6. Open a pull request describing the change.

---

## 26. License

MIT

Copyright (c) Muaaz Tasawar