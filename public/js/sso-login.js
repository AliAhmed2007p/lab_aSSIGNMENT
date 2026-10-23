'use strict';

/*
 * The central sign-in page.
 *
 * It renders whatever the authorization endpoint handed over in the query
 * string (client_id, redirect_uri, scope, state, nonce, code_challenge ...) and
 * posts those parameters back with the credentials. The server answers with
 * either a redirect back to the application, or the next step (second factor,
 * enrollment, recovery codes).
 */
(function () {
  const { el, toast } = window.Connect;

  /* ---------- State ---------- */

  const params = new URLSearchParams(location.search);
  const auth = {
    client_id: params.get('client_id') || '',
    redirect_uri: params.get('redirect_uri') || '',
    response_type: 'code',
    scope: params.get('scope') || '',
    state: params.get('state') || '',
    nonce: params.get('nonce') || '',
    code_challenge: params.get('code_challenge') || '',
    code_challenge_method: params.get('code_challenge_method') || '',
  };

  const state = {
    context: null,
    ticket: null,
    pendingCodes: null,
    pendingRedirect: null,
  };

  const $ = (id) => document.getElementById(id);
  const steps = {
    signin: $('step-signin'),
    mfa: $('step-mfa'),
    enroll: $('step-enroll'),
    codes: $('step-codes'),
    register: $('step-register'),
    forgot: $('step-forgot'),
    continue: $('step-continue'),
  };
  const errorBox = $('form-error');

  function show(step) {
    Object.keys(steps).forEach((key) => {
      steps[key].hidden = key !== step;
    });
    errorBox.hidden = true;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- Calls ---------- */

  async function call(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok) {
      const info = (data && data.error) || {};
      const error = new Error(info.message || 'Request failed (' + response.status + ').');
      error.code = info.code;
      error.payload = info;
      throw error;
    }
    return data;
  }

  // What the server told us to do next.
  function handleResult(result) {
    if (result.status === 'mfa_required') {
      state.ticket = result.ticket;
      show('mfa');
      $('mfa-code').focus();
      return;
    }
    if (result.status === 'mfa_enroll_required') {
      state.ticket = result.ticket;
      $('enroll-reason').textContent = result.reason || '';
      startEnrollment();
      return;
    }
    if (result.recoveryCodes) {
      state.pendingCodes = result.recoveryCodes;
      state.pendingRedirect = result.redirectTo || null;
      $('codes-box').replaceChildren(
        ...result.recoveryCodes.map((code) => el('code', { text: code }))
      );
      show('codes');
      return;
    }
    if (result.redirectTo) {
      location.assign(result.redirectTo);
      return;
    }
    // First-party sign-in (no application involved)
    if (result.token) {
      window.Connect.session.save(result.token, result.user);
      location.assign('/chat.html');
      return;
    }
    location.assign('/sso/account');
  }

  /* ---------- Step 1: password ---------- */

  $('signin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('signin-button');
    button.disabled = true;
    button.textContent = 'Signing in...';

    try {
      const result = await call('/sso/api/login', Object.assign({}, auth, {
        loginId: $('loginId').value.trim(),
        password: $('password').value,
      }));
      handleResult(result);
    } catch (err) {
      showError(err.message);
      $('password').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  /* ---------- Step 2: second factor ---------- */

  $('mfa-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await call('/sso/api/login/mfa', { ticket: state.ticket, code: $('mfa-code').value });
      handleResult(result);
    } catch (err) {
      showError(err.message);
      $('mfa-code').select();
    }
  });

  $('mfa-recovery-toggle').addEventListener('click', () => {
    $('recovery-form').hidden = false;
    $('recovery-code').focus();
  });

  $('recovery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await call('/sso/api/login/mfa', {
        ticket: state.ticket,
        mode: 'recovery',
        recoveryCode: $('recovery-code').value,
      });
      handleResult(result);
    } catch (err) {
      showError(err.message);
    }
  });

  /* ---------- Step 3: enrollment ---------- */

  async function startEnrollment() {
    try {
      const data = await call('/sso/api/login/enroll/start', { ticket: state.ticket });
      $('enroll-secret').textContent = data.secret;
      $('enroll-uri').textContent = data.otpauthUri;
      $('otpauth-link').setAttribute('href', data.otpauthUri);
      show('enroll');
      $('enroll-code').focus();
    } catch (err) {
      showError(err.message);
      show('signin');
    }
  }

  $('copy-secret').addEventListener('click', async () => {
    const secret = $('enroll-secret').textContent;
    try {
      await navigator.clipboard.writeText(secret);
      toast('Secret copied. Paste it into your authenticator app.');
    } catch (err) {
      toast('Copy the secret manually: ' + secret, 'error');
    }
  });

  $('enroll-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await call('/sso/api/login/enroll/confirm', {
        ticket: state.ticket,
        code: $('enroll-code').value,
      });
      handleResult(result);
    } catch (err) {
      showError(err.message);
      $('enroll-code').select();
    }
  });

  $('codes-continue').addEventListener('click', () => {
    if (state.pendingRedirect) location.assign(state.pendingRedirect);
    else location.assign('/sso/account');
  });

  /* ---------- Registration ---------- */

  $('register-toggle').addEventListener('click', () => {
    show('register');
    $('reg-dept').replaceChildren(
      ...(state.context && state.context.departments ? state.context.departments : []).map((dept) =>
        el('option', { value: dept, text: dept })
      )
    );
    $('reg-dept').value = 'Computer Science';
  });

  $('register-cancel').addEventListener('click', () => show('signin'));

  $('register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await call('/sso/api/register', Object.assign({}, auth, {
        name: $('reg-name').value.trim(),
        loginId: $('reg-login').value.trim(),
        email: $('reg-email').value.trim(),
        department: $('reg-dept').value,
        password: $('reg-password').value,
      }));
      handleResult(result);
    } catch (err) {
      showError(err.message);
    }
  });

  /* ---------- Forgot password ---------- */

  $('forgot-toggle').addEventListener('click', () => {
    show('forgot');
    $('forgot-login').value = $('loginId').value;
    $('forgot-login').focus();
  });

  $('forgot-cancel').addEventListener('click', () => show('signin'));

  $('forgot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await call('/sso/api/password/forgot', { loginId: $('forgot-login').value.trim() });
      toast(result.message);
      show('signin');
    } catch (err) {
      showError(err.message);
    }
  });

  /* ---------- Existing session ---------- */

  $('continue-button').addEventListener('click', async () => {
    // Re-enter the authorization endpoint; the session cookie makes it instant.
    const query = new URLSearchParams(auth);
    location.assign('/sso/authorize?' + query.toString());
  });

  $('switch-button').addEventListener('click', async () => {
    await fetch('/sso/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const query = new URLSearchParams(auth);
    query.set('prompt', 'login');
    location.assign('/sso/authorize?' + query.toString());
  });

  /* ---------- Social buttons ---------- */

  function renderSocial(list) {
    const row = $('social-row');
    const note = $('social-note');
    row.replaceChildren();

    (list || []).forEach((provider) => {
      const button = el('button', {
        type: 'button',
        class: 'btn btn-quiet',
        text: 'Continue with ' + provider.label,
        onclick: () => {
          const query = new URLSearchParams(auth);
          location.assign('/sso/social/' + provider.provider + '/start?' + query.toString());
        },
      });
      if (!provider.available) {
        button.disabled = true;
        button.title = provider.configured
          ? provider.label + ' is switched off for this organization.'
          : provider.label + ' credentials are missing in .env.';
      }
      row.append(button);
    });

    const unconfigured = (list || []).filter((provider) => !provider.configured);
    if (unconfigured.length) {
      note.hidden = false;
      note.textContent =
        'Add ' + unconfigured.map((p) => p.label).join(' and ') +
        ' credentials to .env to enable social sign-in (see docs/SSO-SETUP.md).';
    }
  }

  /* ---------- Demo accounts ---------- */

  const DEMO_PASSWORD = 'Comsats@123';
  const DEMO_ACCOUNTS = {
    'comsats-islamabad': [
      { loginId: 'admin.it', name: 'IT Administrator', note: 'Platform admin' },
      { loginId: 'exam.cell', name: 'Exam Cell Office', note: 'Organization admin' },
      { loginId: 'dr.ahmed', name: 'Dr. Ahmed Raza', note: 'Faculty' },
      { loginId: 'FA23-BCS-050', name: 'Muaaz Tasawar', note: 'Student' },
      { loginId: 'FA22-BEE-031', name: 'Fatima Noor', note: 'Student' },
    ],
    'comsats-lahore': [
      { loginId: 'admin.lhr', name: 'Lahore IT Office', note: 'Organization admin, MFA required' },
      { loginId: 'FA23-BCS-101', name: 'Ali Hassan', note: 'Student, MFA required' },
    ],
  };

  function renderDemo(slug) {
    const accounts = DEMO_ACCOUNTS[slug] || [];
    if (!accounts.length) return;

    $('demo-box').hidden = false;
    $('demo-list').replaceChildren(
      ...accounts.map((account) =>
        el('button', {
          type: 'button',
          class: 'demo-chip',
          onclick: () => {
            $('loginId').value = account.loginId;
            $('password').value = DEMO_PASSWORD;
            $('password').focus();
          },
        },
        el('span', { text: account.name }),
        el('small', { text: account.loginId + ', ' + account.note })
      )
    );
  }

  /* ---------- Bootstrap ---------- */

  async function init() {
    if (!auth.client_id) {
      showError('This page is opened by an application through /sso/authorize.');
      return;
    }

    try {
      const query = new URLSearchParams(auth);
      const response = await fetch('/sso/api/login-context?' + query.toString(), {
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();

      if (!response.ok) {
        showError((data.error && data.error.message) || 'This sign-in request is not valid.');
        return;
      }

      state.context = data;
      document.title = 'Sign in to ' + data.app.name;
      $('intro-text').textContent =
        'Sign in to ' + data.tenant.name + ' once and use every registered application.';
      $('request-box').hidden = false;
      $('tenant-badge').textContent = data.tenant.name;
      $('app-name').textContent = data.app.name;
      $('scope-list').replaceChildren(
        ...data.app.scopes.map((scope) => el('li', null, el('code', { text: scope })))
      );
      renderSocial(data.social);
      renderDemo(data.tenant.slug);
      $('register-hint').textContent =
        'Registration is for the ' + data.tenant.name + ' organization' +
        (data.allowSelfRegistration ? '.' : ' and is currently closed by the administrator.');
      $('register-toggle').disabled = !data.allowSelfRegistration;

      const policy = data.passwordPolicy || {};
      const requirements = ['at least ' + (policy.minLength || 8) + ' characters'];
      if (policy.requireUpper) requirements.push('an uppercase letter');
      if (policy.requireLower) requirements.push('a lowercase letter');
      if (policy.requireNumber) requirements.push('a digit');
      if (policy.requireSymbol) requirements.push('a symbol');
      $('reg-policy').textContent = 'Password: ' + requirements.join(', ') + '.';

      if (params.get('switch') === '1') {
        showError('You are signed in to another organization. Sign in here to continue.');
      }

      if (data.session && !params.get('switch')) {
        $('continue-text').textContent =
          'Signed in as ' + data.session.user.name + ' (' + data.session.user.loginId + ').';
        show('continue');
        return;
      }

      show('signin');
      $('loginId').focus();
    } catch (err) {
      showError('Cannot reach the server. Check that it is running.');
    }
  }

  init();
})();
