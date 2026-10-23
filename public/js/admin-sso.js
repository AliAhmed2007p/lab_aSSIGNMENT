'use strict';

/*
 * Admin console tabs for the single sign-on platform: organizations (with
 * their security policies), registered applications, and the audit log.
 *
 * The Users and Groups tabs come from admin.js; this file adds the rest and
 * takes over tab switching so both sets behave the same way.
 */
(function () {
  const C = window.Connect;
  const $ = (id) => document.getElementById(id);
  const { api, el, toast } = C;

  const TABS = ['users', 'groups', 'orgs', 'apps', 'audit'];
  let scope = null;
  let meta = null;
  let tenants = [];

  function showTab(name) {
    TABS.forEach((key) => {
      const active = key === name;
      const view = $('view-' + key);
      if (view) view.hidden = !active;
      const tab = $('tab-' + key);
      if (tab) {
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      }
    });

    if (name === 'orgs') loadOrgs();
    if (name === 'apps') loadApps();
    if (name === 'audit') loadAudit();
  }

  ['orgs', 'apps', 'audit'].forEach((name) => {
    $('tab-' + name).addEventListener('click', () => showTab(name));
  });
  ['users', 'groups'].forEach((name) => {
    $('tab-' + name).addEventListener('click', () => {
      TABS.filter((key) => key !== name).forEach((key) => {
        const view = $('view-' + key);
        if (view) view.hidden = true;
      });
    });
  });

  /* ---------- Small form helpers ---------- */

  function field(labelText, input) {
    return el('div', { class: 'field' }, el('label', { text: labelText }), input);
  }

  function checkbox(labelText, checked, disabled) {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(checked);
    input.disabled = Boolean(disabled);
    return el('label', { class: 'check' }, input, el('span', { text: labelText }));
  }

  function textInput(value, type) {
    return el('input', { class: 'input', type: type || 'text', value: value === undefined || value === null ? '' : String(value) });
  }

  function selectInput(options, value) {
    const select = el('select', { class: 'input' });
    options.forEach((option) => {
      const node = el('option', { value: option[0], text: option[1] });
      if (String(option[0]) === String(value)) node.selected = true;
      select.append(node);
    });
    return select;
  }

  function numberInput(value, min, max) {
    const input = el('input', { class: 'input', type: 'number', value: String(value) });
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    return input;
  }

  /* ---------- Organizations ---------- */

  async function loadOrgs() {
    try {
      tenants = (await api('/api/admin/tenants')).tenants;

      const rows = await Promise.all(tenants.map(async (tenant) => {
        let userCount = '-';
        let appCount = '-';
        try {
          userCount = (await api('/api/admin/users?tenantId=' + tenant.id + '&includeInactive=true')).users.length;
        } catch (err) {
          userCount = '-';
        }
        try {
          appCount = (await api('/api/admin/apps?tenantId=' + tenant.id)).apps.length;
        } catch (err) {
          appCount = '-';
        }

        return el('tr', null,
          el('td', null, el('strong', { text: tenant.name })),
          el('td', null, el('code', { text: tenant.slug })),
          el('td', null, el('span', {
            class: 'badge ' + (tenant.status === 'active' ? 'badge-open' : 'badge-readonly'),
            text: tenant.status,
          })),
          el('td', { text: tenant.settings.mfaRequired ? 'required' : 'optional' }),
          el('td', { text: String(userCount) }),
          el('td', { text: String(appCount) }),
          el('td', null, el('button', {
            type: 'button', class: 'btn btn-quiet btn-small', text: 'Edit',
            onclick: () => editTenant(tenant),
          }))
        );
      }));

      $('org-body').replaceChildren(...rows);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function editTenant(tenant) {
    const settings = tenant.settings;
    const name = textInput(tenant.name);
    const status = selectInput([['active', 'Active'], ['suspended', 'Suspended']], tenant.status);
    const mfaRequired = checkbox('Require two-factor authentication', settings.mfaRequired);
    const selfRegistration = checkbox('Allow self-registration', settings.allowSelfRegistration);

    const social = {};
    meta.socialProviders.forEach((provider) => {
      social[provider.provider] = checkbox(
        provider.label + (provider.configured ? '' : ' (credentials missing in .env)'),
        settings.socialProviders[provider.provider],
        !provider.configured
      );
    });

    const accessTtl = numberInput(settings.tokens.accessTtlSeconds, meta.tokenLimits.accessTtlSeconds.min, meta.tokenLimits.accessTtlSeconds.max);
    const refreshDays = numberInput(settings.tokens.refreshTtlDays, meta.tokenLimits.refreshTtlDays.min, meta.tokenLimits.refreshTtlDays.max);
    const sessionHours = numberInput(settings.tokens.sessionTtlHours, meta.tokenLimits.sessionTtlHours.min, meta.tokenLimits.sessionTtlHours.max);
    const minLength = numberInput(settings.passwordPolicy.minLength, meta.passwordPolicyLimits.minLength.min, meta.passwordPolicyLimits.minLength.max);
    const requireUpper = checkbox('Uppercase letter', settings.passwordPolicy.requireUpper);
    const requireNumber = checkbox('Digit', settings.passwordPolicy.requireNumber);
    const requireSymbol = checkbox('Symbol', settings.passwordPolicy.requireSymbol);
    const maxFailed = numberInput(settings.maxFailedLogins, meta.passwordPolicyLimits.maxFailedLogins.min, meta.passwordPolicyLimits.maxFailedLogins.max);
    const lockout = numberInput(settings.lockoutMinutes, meta.passwordPolicyLimits.lockoutMinutes.min, meta.passwordPolicyLimits.lockoutMinutes.max);

    const save = el('button', {
      type: 'button', class: 'btn', text: 'Save changes',
      onclick: async () => {
        try {
          await api('/api/admin/tenants/' + tenant.id, {
            method: 'PATCH',
            body: {
              name: name.value.trim(),
              status: status.value,
              settings: {
                mfaRequired: mfaRequired.querySelector('input').checked,
                allowSelfRegistration: selfRegistration.querySelector('input').checked,
                socialProviders: {
                  google: social.google.querySelector('input').checked,
                  facebook: social.facebook.querySelector('input').checked,
                },
                tokens: {
                  accessTtlSeconds: Number(accessTtl.value),
                  refreshTtlDays: Number(refreshDays.value),
                  sessionTtlHours: Number(sessionHours.value),
                },
                passwordPolicy: {
                  minLength: Number(minLength.value),
                  requireUpper: requireUpper.querySelector('input').checked,
                  requireNumber: requireNumber.querySelector('input').checked,
                  requireSymbol: requireSymbol.querySelector('input').checked,
                },
                maxFailedLogins: Number(maxFailed.value),
                lockoutMinutes: Number(lockout.value),
              },
            },
          });
          toast('Organization saved.');
          await loadOrgs();
          $('org-editor').hidden = true;
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    });

    const editor = $('org-editor');
    editor.hidden = false;
    editor.replaceChildren(
      el('div', { class: 'card' },
        el('h3', { text: 'Edit ' + tenant.name }),
        el('div', { class: 'account-grid' },
          el('div', null,
            field('Name', name),
            field('State', status),
            el('div', { style: 'margin-top:12px' }, mfaRequired),
            el('div', null, selfRegistration),
            el('div', { style: 'margin-top:8px; display:grid; gap:6px' }, social.google, social.facebook)
          ),
          el('div', null,
            field('Access token lifetime (seconds)', accessTtl),
            field('Refresh token lifetime (days)', refreshDays),
            field('Session lifetime (hours)', sessionHours),
            field('Minimum password length', minLength),
            el('div', { style: 'display:grid; gap:6px; margin-top:8px' }, requireUpper, requireNumber, requireSymbol)
          ),
          el('div', null,
            field('Failed sign-ins before lockout', maxFailed),
            field('Lockout duration (minutes)', lockout),
            el('p', { class: 'hint', text: 'Values are clamped to the platform limits, so nothing unsafe can be configured.' })
          )
        ),
        el('div', { class: 'row', style: 'margin-top:12px' },
          save,
          el('button', {
            type: 'button', class: 'btn btn-quiet', text: 'Close',
            onclick: () => {
              $('org-editor').hidden = true;
            },
          })
        )
      )
    );
    editor.scrollIntoView({ block: 'nearest' });
  }

  function newTenantForm() {
    const name = textInput('');
    const slug = textInput('');
    const editor = $('org-editor');
    editor.hidden = false;
    editor.replaceChildren(
      el('div', { class: 'card' },
        el('h3', { text: 'New organization' }),
        field('Name', name),
        field('Slug (optional)', slug),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', {
            type: 'button', class: 'btn', text: 'Create',
            onclick: async () => {
              try {
                await api('/api/admin/tenants', {
                  method: 'POST',
                  body: { name: name.value.trim(), slug: slug.value.trim() || undefined },
                });
                toast('Organization created.');
                await loadOrgs();
                editor.hidden = true;
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }),
          el('button', {
            type: 'button', class: 'btn btn-quiet', text: 'Cancel',
            onclick: () => {
              editor.hidden = true;
            },
          })
        )
      )
    );
  }

  /* ---------- Applications ---------- */

  async function loadApps() {
    try {
      const apps = (await api('/api/admin/apps')).apps;

      const rows = apps.map((app) => el('tr', null,
        el('td', null, el('strong', { text: app.name }), el('br'), el('small', { text: app.description || '' })),
        el('td', { text: app.tenantName || '-' }),
        el('td', null, el('code', { text: app.clientId })),
        el('td', null, ...app.redirectUris.map((uri) => el('div', null, el('code', { text: uri })))),
        el('td', { text: app.scopes.join(', ') }),
        el('td', null, el('span', {
          class: 'badge ' + (app.status === 'active' ? 'badge-open' : 'badge-readonly'),
          text: app.status,
        })),
        el('td', null,
          el('button', {
            type: 'button', class: 'btn btn-quiet btn-small', text: 'Edit',
            onclick: () => editApp(app),
          }),
          el('button', {
            type: 'button', class: 'btn btn-quiet btn-small', text: 'Rotate secret',
            onclick: async () => {
              try {
                const rotated = await api('/api/admin/apps/' + app.id + '/secret', { method: 'POST' });
                $('app-secret').hidden = false;
                $('app-secret').textContent =
                  'New secret for ' + rotated.app.name + ': ' + rotated.clientSecret +
                  '  (copy it now - it is stored only as a hash. Sample applications read theirs from .env.)';
                toast('Secret rotated.');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          })
        )
      ));

      $('app-body').replaceChildren(...(rows.length ? rows : [el('tr', null, el('td', { colspan: '7', text: 'No applications yet.' }))]));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function appForm(app) {
    const isNew = !app;
    const name = textInput(app ? app.name : '');
    const tenant = selectInput(tenants.map((t) => [t.id, t.name]), app ? app.tenantId : (scope.tenant ? scope.tenant.id : undefined));
    const redirects = el('textarea', { class: 'input', rows: '3' });
    redirects.value = app ? app.redirectUris.join('\n') : (meta.publicBaseUrl + '/apps/new/callback');
    const status = selectInput([['active', 'Active'], ['disabled', 'Disabled']], app ? app.status : 'active');

    const scopeBoxes = {};
    meta.scopes.forEach((s) => {
      scopeBoxes[s] = checkbox(s, app ? app.scopes.includes(s) : ['openid', 'profile', 'email'].includes(s));
    });

    const editor = $('app-editor');
    editor.hidden = false;
    editor.replaceChildren(
      el('div', { class: 'card' },
        el('h3', { text: isNew ? 'Register an application' : 'Edit ' + app.name }),
        el('div', { class: 'account-grid' },
          el('div', null,
            field('Name', name),
            field('Organization', tenant),
            isNew ? null : field('State', status)
          ),
          el('div', null,
            field('Redirect URIs (one per line)', redirects),
            el('p', { class: 'hint', text: 'They must match exactly; the authorization endpoint refuses anything else.' })
          ),
          el('div', null,
            el('label', { text: 'Allowed scopes' }),
            el('div', { style: 'display:grid; gap:6px; margin-top:6px' }, ...meta.scopes.map((s) => scopeBoxes[s]))
          )
        ),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', {
            type: 'button', class: 'btn', text: isNew ? 'Register' : 'Save',
            onclick: async () => {
              const body = {
                name: name.value.trim(),
                redirectUris: redirects.value.split('\n').map((line) => line.trim()).filter(Boolean),
                scopes: meta.scopes.filter((s) => scopeBoxes[s].querySelector('input').checked),
              };
              if (isNew) {
                body.tenantId = tenant.value;
                body.kind = 'confidential';
              } else {
                body.status = status.value;
              }

              try {
                const result = isNew
                  ? await api('/api/admin/apps', { method: 'POST', body })
                  : await api('/api/admin/apps/' + app.id, { method: 'PATCH', body });

                if (isNew) {
                  $('app-secret').hidden = false;
                  $('app-secret').textContent =
                    'Client ID: ' + result.app.clientId + '   Secret: ' + result.clientSecret +
                    '  (copy the secret now - only its hash is stored)';
                } else {
                  $('app-secret').hidden = true;
                }
                toast(isNew ? 'Application registered.' : 'Application saved.');
                await loadApps();
                editor.hidden = true;
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }),
          el('button', {
            type: 'button', class: 'btn btn-quiet', text: 'Cancel',
            onclick: () => {
              editor.hidden = true;
            },
          })
        )
      )
    );
  }

  function editApp(app) {
    appForm(app);
  }

  /* ---------- Audit ---------- */

  async function loadAudit() {
    const params = new URLSearchParams();
    if ($('audit-outcome').value) params.set('outcome', $('audit-outcome').value);
    if ($('audit-type').value.trim()) params.set('type', $('audit-type').value.trim());

    try {
      const data = await api('/api/admin/audit?' + params.toString());
      const overview = await api('/api/admin/overview');

      $('audit-total').textContent = overview.eventsLast24h;
      $('audit-failed').textContent = overview.failedLast24h;
      $('audit-sessions').textContent = overview.activeSessions;

      $('audit-failed-body').replaceChildren(
        ...(data.summary.failedLogins.length
          ? data.summary.failedLogins.map((row) => el('tr', null,
            el('td', null, el('code', { text: row.loginId })),
            el('td', { text: String(row.count) }),
            el('td', { text: new Date(row.lastAt).toLocaleString() })
          ))
          : [el('tr', null, el('td', { colspan: '3', text: 'No failed sign-ins in the last 24 hours.' }))])
      );

      $('audit-body').replaceChildren(
        ...data.events.map((event) => el('tr', null,
          el('td', { text: new Date(event.at).toLocaleString() }),
          el('td', null,
            el('span', { class: 'badge ' + (event.outcome === 'failure' ? 'badge-readonly' : 'badge-open'), text: event.type })
          ),
          el('td', { text: event.actorLoginId || '-' }),
          el('td', { text: event.clientId || '-' }),
          el('td', { text: event.detail || '-' })
        ))
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- Bootstrap ---------- */

  async function init() {
    try {
      const info = await api('/api/admin/me');
      scope = info;

      if (!['admin', 'tenant_admin'].includes(info.user.role)) {
        location.replace('/index.html');
        return;
      }

      meta = await api('/api/admin/meta');
      meta.scopes = meta.scopes || [];

      const brand = document.querySelector('.admin-brand');
      const note = el('span', {
        text: info.isPlatformAdmin
          ? 'Platform administrator: every organization'
          : 'Administrator of ' + info.tenant.name,
      });
      brand.append(note);

      if (!info.isPlatformAdmin) {
        $('new-app-btn').hidden = false;
      }

      $('new-app-btn').addEventListener('click', () => {
        if (!tenants.length) {
          api('/api/admin/tenants').then((data) => {
            tenants = data.tenants;
            appForm(null);
          }).catch((err) => toast(err.message, 'error'));
          return;
        }
        appForm(null);
      });

      $('audit-refresh').addEventListener('click', loadAudit);
      $('audit-outcome').addEventListener('change', loadAudit);

      // The tenant list is needed for the organization and application forms.
      tenants = (await api('/api/admin/tenants')).tenants;

      if (info.isPlatformAdmin) {
        const create = el('button', {
          type: 'button', class: 'btn btn-small', text: 'New organization',
          onclick: newTenantForm,
        });
        document.querySelector('#view-orgs .toolbar') ||
          document.querySelector('#view-orgs .card').prepend(el('div', { class: 'toolbar' }, create));

        const toolbar = document.querySelector('#view-orgs .card .toolbar');
        if (toolbar) {
          toolbar.append(el('span', { class: 'toolbar-end' }));
          toolbar.append(create);
        }
      }
    } catch (err) {
      toast('Could not load the administration data: ' + err.message, 'error');
    }
  }

  init();
})();
