'use strict';

/*
 * Account self-service: profile, password, second factor, recovery codes,
 * linked providers and the list of signed-in sessions.
 */
(function () {
  const { el, toast } = window.Connect;

  const $ = (id) => document.getElementById(id);
  const errorBox = $('page-error');
  let current = null;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  async function call(path, options) {
    const opts = options || {};
    const response = await fetch(path, {
      method: opts.method || 'GET',
      headers: Object.assign({ Accept: 'application/json' }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok) {
      const info = (data && data.error) || {};
      throw new Error(info.message || 'Request failed (' + response.status + ').');
    }
    return data;
  }

  /* ---------- Rendering ---------- */

  function renderProfile() {
    const user = current.user;
    $('account-me').textContent = user.name + ' - ' + current.tenant.name;
    $('profile').replaceChildren(
      el('dt', { text: 'Name' }), el('dd', { text: user.name }),
      el('dt', { text: 'Login ID' }), el('dd', null, el('code', { text: user.loginId })),
      el('dt', { text: 'Role' }), el('dd', { text: user.role }),
      el('dt', { text: 'Department' }), el('dd', { text: user.department || '-' }),
      el('dt', { text: 'E-mail' }), el('dd', { text: user.email || 'not set' }),
      el('dt', { text: 'Organization' }), el('dd', { text: current.tenant.name })
    );
  }

  function renderMfa() {
    const mfa = current.mfa || {};
    const required = current.tenant.settings.mfaRequired;
    $('mfa-status').textContent = mfa.enabled
      ? 'Enabled. Recovery codes left: ' + mfa.recoveryCodesLeft + '.'
      : (required
        ? 'Your organization requires two-step verification.'
        : 'Not enabled. You can turn it on with any authenticator application.');

    const actions = $('mfa-actions');
    actions.replaceChildren();
    $('mfa-enroll-form').hidden = true;
    $('mfa-disable-form').hidden = true;

    if (mfa.enabled) {
      actions.append(
        el('button', {
          type: 'button', class: 'btn btn-quiet', text: 'New recovery codes',
          onclick: async () => {
            try {
              const data = await call('/sso/api/account/mfa/recovery-codes', { method: 'POST' });
              $('mfa-codes').hidden = false;
              $('mfa-codes-box').replaceChildren(...data.recoveryCodes.map((code) => el('code', { text: code })));
              toast('New recovery codes generated.');
            } catch (err) {
              showError(err.message);
            }
          },
        }),
        required
          ? el('span', { class: 'hint', text: 'Required by ' + current.tenant.name + ', so it cannot be turned off.' })
          : el('button', {
            type: 'button', class: 'btn btn-danger', text: 'Turn off',
            onclick: () => {
              $('mfa-disable-form').hidden = false;
              $('mfa-password').focus();
            },
          })
      );
      return;
    }

    actions.append(el('button', {
      type: 'button', class: 'btn', text: 'Set up two-step verification',
      onclick: async () => {
        try {
          const data = await call('/sso/api/account/mfa/start', { method: 'POST' });
          $('mfa-secret').textContent = data.secret;
          $('mfa-uri').textContent = data.otpauthUri;
          $('mfa-otpauth').setAttribute('href', data.otpauthUri);
          $('mfa-enroll-form').hidden = false;
          $('mfa-confirm').focus();
        } catch (err) {
          showError(err.message);
        }
      },
    }));
  }

  function renderSessions() {
    const rows = (current.sessions || []).map((session) => {
      const client = session.userAgent ? String(session.userAgent).slice(0, 40) : '-';
      const state = session.active
        ? (session.id === current.sessionId ? el('span', { class: 'session-current', text: 'this browser' }) : el('span', { text: 'active' }))
        : el('span', { class: 'session-revoked', text: session.revokedReason || 'revoked' });

      return el('tr', null,
        el('td', { text: new Date(session.createdAt).toLocaleString() }),
        el('td', { text: new Date(session.lastSeenAt).toLocaleString() }),
        el('td', { text: (session.amr || []).join(', ') }),
        el('td', { text: client }),
        el('td', null, state),
        el('td', null, session.active
          ? el('button', {
            type: 'button', class: 'btn btn-quiet btn-small', text: 'Revoke',
            onclick: async () => {
              try {
                await call('/sso/api/account/sessions/' + session.id + '/revoke', { method: 'POST' });
                toast('Session revoked.');
                await load();
              } catch (err) {
                showError(err.message);
              }
            },
          })
          : null)
      );
    });

    $('session-rows').replaceChildren(...(rows.length ? rows : [el('tr', null, el('td', { colspan: '6', text: 'No sessions.' }))]));
  }

  function renderSocial() {
    const links = {};
    (current.user.socialLinks || []).forEach((link) => {
      links[link.provider] = link;
    });

    $('social-list').replaceChildren(
      ...(current.social || []).flatMap((provider) => {
        const linked = links[provider.provider];
        const rows = [
          el('div', { class: 'row', style: 'margin-bottom:8px' },
            el('strong', { text: provider.label }),
            linked
              ? el('span', { class: 'badge badge-open', text: 'linked' })
              : el('span', { class: 'hint', text: provider.available ? 'not linked' : (provider.configured ? 'switched off for this organization' : 'credentials missing in .env') }),
            linked
              ? el('button', {
                type: 'button', class: 'btn btn-quiet btn-small', text: 'Unlink',
                onclick: async () => {
                  try {
                    await call('/sso/api/account/social/' + provider.provider + '/unlink', { method: 'POST' });
                    toast(provider.label + ' unlinked.');
                    await load();
                  } catch (err) {
                    showError(err.message);
                  }
                },
              })
              : el('button', {
                type: 'button', class: 'btn btn-quiet btn-small', text: 'Link ' + provider.label,
                disabled: !provider.available,
                onclick: () => {
                  location.assign('/sso/social/' + provider.provider + '/start?mode=link');
                },
              })
          ),
        ];
        return rows;
      })
    );
  }

  async function load() {
    try {
      current = await call('/sso/api/account');
      renderProfile();
      renderMfa();
      renderSessions();
      renderSocial();
      const policy = current.passwordPolicy || {};
      const requirements = ['at least ' + (policy.minLength || 8) + ' characters'];
      if (policy.requireUpper) requirements.push('an uppercase letter');
      if (policy.requireLower) requirements.push('a lowercase letter');
      if (policy.requireNumber) requirements.push('a digit');
      if (policy.requireSymbol) requirements.push('a symbol');
      $('pw-policy').textContent = 'Password: ' + requirements.join(', ') + '.';
    } catch (err) {
      showError('You are not signed in. Open the sign-in page first.');
      $('profile').replaceChildren(el('dd', { text: err.message }));
    }
  }

  /* ---------- Actions ---------- */

  $('mfa-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('mfa-secret').textContent);
      toast('Secret copied.');
    } catch (err) {
      toast('Copy the secret manually.', 'error');
    }
  });

  $('mfa-confirm-btn').addEventListener('click', async () => {
    try {
      const data = await call('/sso/api/account/mfa/confirm', {
        method: 'POST',
        body: { code: $('mfa-confirm').value },
      });
      $('mfa-codes').hidden = false;
      $('mfa-codes-box').replaceChildren(...data.recoveryCodes.map((code) => el('code', { text: code })));
      toast('Two-step verification is on. Save the recovery codes.');
      await load();
    } catch (err) {
      showError(err.message);
    }
  });

  $('mfa-disable-btn').addEventListener('click', async () => {
    try {
      await call('/sso/api/account/mfa/disable', {
        method: 'POST',
        body: { password: $('mfa-password').value },
      });
      toast('Two-step verification is off.');
      await load();
    } catch (err) {
      showError(err.message);
    }
  });

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await call('/sso/api/account/password', {
        method: 'POST',
        body: { currentPassword: $('pw-current').value, newPassword: $('pw-new').value },
      });
      toast('Password changed. Sign in again.');
      setTimeout(() => location.assign('/index.html'), 800);
    } catch (err) {
      showError(err.message);
    }
  });

  $('signout-btn').addEventListener('click', () => {
    location.assign('/sso/end-session');
  });

  load();
})();
