# Single sign-on setup

This project is one server that plays both roles of the assignment: it *is* the
multi-tenant SSO platform (identity provider) and it *hosts* two sample client
applications that use it.

```
   browser ──▶ /index.html                     landing page (start here)
               ├─ /apps/chat/login     ─┐
               └─ /apps/library/login  ─┴─▶ /sso/authorize   (SSO platform)
                                              │ no session
                                              ▼
                                          /sso/login        (password, MFA, social)
                                              │ session cookie
                                              ▼
                                     /sso/token  ⇄  /sso/userinfo, /sso/jwks.json
                                              │ code + tokens
                        /apps/chat/callback, /apps/library/callback
```

## 1. Run it

```bash
cp .env.example .env          # optional: the app starts without any credentials
npm install
npm run seed                  # demo tenants, users, applications and loans
npm start                     # http://localhost:3000
```

Then open <http://localhost:3000> and click **Sign in with SSO** on either
application card.

Demo accounts all use the password `Comsats@123`:

| Login ID | Role | Organization |
| --- | --- | --- |
| `admin.it` | platform administrator (all organizations) | COMSATS Islamabad |
| `exam.cell` | organization administrator | COMSATS Islamabad |
| `dr.ahmed`, `dr.sana`, `dr.bilal` | faculty | COMSATS Islamabad |
| `FA23-BCS-050`, `FA22-BCS-012`, `FA22-BEE-031`, … | students | COMSATS Islamabad |
| `admin.lhr` | organization administrator (**MFA required**) | COMSATS Lahore |
| `FA23-BCS-101`, `FA23-BCS-102` | students (**MFA required**) | COMSATS Lahore |

Useful checks:

```bash
npm run demo        # the original chat/authorisation boundary demo (13 scenarios)
npm run demo:sso    # end-to-end check of the SSO platform (discovery, PKCE, MFA, isolation, reset)
```

## 2. Seeing single sign-on work

1. Open <http://localhost:3000/apps/chat/login> → sign in as `FA23-BCS-050`.
2. In the same browser, open <http://localhost:3000/apps/library/login>.
   The platform recognizes the existing session and returns a code without
   asking for a password - that is single sign-on.
3. `Sign out everywhere` (in the account page or the chat) ends the platform
   session, so both applications ask again.

Two-factor authentication can be seen with the Lahore organization (its policy
requires it) or by turning it on for Islamabad in the admin console
(**Organizations → Edit → Require two-factor authentication**). The next sign-in
then shows the enrollment step: add the secret to any authenticator application
(Google Authenticator, Authy, Microsoft Authenticator), enter one code, save the
recovery codes.

## 3. Credentials for Google and Facebook

Everything works without these; the buttons are simply disabled until the keys
are in `.env`. Nothing else in the project needs credentials.

### Google Sign-In (OAuth 2.0 / OpenID Connect)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and sign
   in with your Google account.
2. Create a project (top bar → **Select a project → New project**). Name it
   something like `comsats-sso`.
3. **APIs & Services → OAuth consent screen**:
   * User type: **External** (or **Internal** for a Workspace organisation).
   * App name, support e-mail and developer e-mail are required.
   * **Scopes**: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
   * While the app is in **Testing**, add your own Google address under
     **Test users**, otherwise Google refuses the sign-in.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   * Application type: **Web application**.
   * Name: `COMSATS SSO`.
   * **Authorized redirect URIs** → Add URI:
     `http://localhost:3000/sso/social/google/callback`
     (any address you also serve it from, e.g. `https://sso.example.edu/sso/social/google/callback`).
   * Click **Create**; the dialog shows the client ID and client secret.
5. Put them in `.env`:

   ```
   GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
   ```
6. In the admin console make sure the organization has **Google** switched on
   (**Organizations → Edit → Google**), then restart the server. The
   "Continue with Google" button on the sign-in page now works.
   The first Google sign-in links to an account with the same verified e-mail
   address; an unknown address creates a new student account when the
   organization allows self-registration.

### Facebook Login (Meta OAuth 2.0)

1. Open <https://developers.facebook.com/apps/> and sign in with a Facebook
   account.
2. **Create app** → use case **Authenticate and request data from users with
   Facebook Login** → type **Consumer** (or **Business** if it belongs to an
   organisation). Name it e.g. `COMSATS SSO`.
3. In the app dashboard open **Facebook Login → Settings**:
   * **Client OAuth login**: on.
   * **Valid OAuth Redirect URIs**:
     `http://localhost:3000/sso/social/facebook/callback`
   * Save.
4. **App settings → Basic**: copy the **App ID** and the **App secret**
   (click *Show*).
5. Put them in `.env`:

   ```
   FACEBOOK_APP_ID=1234567890123456
   FACEBOOK_APP_SECRET=abcdef1234567890abcdef1234567890
   ```
6. Switch **Facebook** on for the organization in the admin console, restart the
   server. Facebook only returns an e-mail address when the account has a
   verified one; without it the sign-in is refused unless the identity is
   already linked, which prevents accidental account merging.

### Notes

* While a Meta app is in development mode only its administrators, developers
  and testers can sign in; add testers under **App roles**.
* `PUBLIC_BASE_URL` must match the address in the browser, otherwise the
  redirect URI that is sent to Google/Meta will not match the one you
  registered.
* To see the exact URI this deployment will send, open
  <http://localhost:3000/api/meta> (`socialProviders[].redirectUri`), or the
  **Applications** tab shows the same information with the platform's own
  callbacks.

## 4. How the requirements map to the code

| Requirement | Where |
| --- | --- |
| Central authentication service, sign in/out, registration | `/sso/login`, `/sso/api/*`, `server/routes/ssoRoutes.js` |
| OAuth 2.0 / OpenID Connect (authorization code + PKCE) | `/sso/authorize`, `/sso/token`, `/sso/userinfo`, `server/services/ssoService.js` |
| Discovery document and JWKS (RS256) | `/.well-known/openid-configuration`, `/sso/jwks.json`, `server/security/tokens.js` |
| Multi-tenancy and isolation | `server/services/tenantService.js`, tenant id on users/groups/apps/logs, scoping in `server/middleware/auth.js` |
| Organization admin dashboard | `public/admin.html`, `public/js/admin-sso.js`, `/api/admin/*` |
| MFA with a TOTP app, recovery codes, account recovery | `server/security/totp.js`, `server/services/mfaService.js` |
| Password hashing, strength policy, lockout, reset | `server/security/passwords.js`, `server/services/userService.js` |
| Access + refresh tokens, rotation, revocation, logout | `server/services/ssoService.js` (`issueTokens`, `rotateRefreshToken`, `revokeRefreshToken`, `destroySession`) |
| Google and Facebook sign-in, per-organization switches | `server/services/socialService.js` |
| Two sample client applications | `server/apps/chatApp.js` (chat SPA), `server/apps/libraryApp.js` (server-rendered portal) |
| Registering a new application | Admin console → **Applications**, then use `/sso/authorize` with the new client id |
| Audit log and failed sign-in monitoring | `server/services/auditService.js`, admin console → **Audit log** |

## 5. Registering a third application

1. Admin console → **Applications → Register application**: name, organization,
   redirect URIs (one per line) and the scopes it may ask for.
2. Copy the client id and secret that are shown once.
3. The application sends the browser to
   `/sso/authorize?response_type=code&client_id=...&redirect_uri=...&scope=openid+profile&state=...&code_challenge=...&code_challenge_method=S256`
4. It exchanges the returned code at `POST /sso/token`
   (`grant_type=authorization_code`, `code_verifier`, plus its secret) and
   verifies the ID token with the public key from `/sso/jwks.json`.

`server/apps/chatApp.js` and `server/apps/libraryApp.js` are both complete
examples of that flow (one for a browser SPA, one for a server-rendered app).

## 6. Security notes and limits

* Passwords are stored as bcrypt hashes; the TOTP secret and recovery codes are
  never returned again after enrollment.
* Redirect URIs must match exactly; authorization codes are single use and
  bound to the PKCE verifier and the client.
* Access tokens live 60-3600 seconds (per organization), refresh tokens rotate
  on every use and a replayed refresh token revokes the whole family.
* Changing or resetting a password revokes every session and refresh token.
* Token signing uses a generated RSA-2048 key pair in `server/data/keys.json`
  (gitignored). Set `SSO_PRIVATE_KEY_PEM` to use your own key.
* There is **no mail provider** in this deployment: a password reset prints its
  single-use link to the server console and records the request so that an
  administrator can issue a fresh link from the admin console. Add an e-mail
  provider before using this for real.
* Serve it over HTTPS in any real deployment: set `PUBLIC_BASE_URL` to the
  `https://` address, which also marks the session cookies as `Secure`.
