'use strict';

/*
 * Library portal (sample client application 2).
 *
 * The browser only ever talks to this application's own API; the access token
 * stays in an HttpOnly cookie on the server. Every request re-checks the
 * session, and renewals additionally need the library:write scope.
 */
(function () {
  const { el, toast } = window.Connect;

  const $ = (id) => document.getElementById(id);
  let session = null;

  async function call(path, options) {
    const opts = options || {};
    const response = await fetch(path, {
      method: opts.method || 'GET',
      headers: { Accept: 'application/json' },
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
      error.status = response.status;
      error.code = info.code;
      throw error;
    }
    return data;
  }

  function stateBadge(loan) {
    if (loan.returned) return el('span', { class: 'badge', text: 'returned' });
    if (loan.overdue) return el('span', { class: 'badge badge-overdue', text: 'overdue' });
    const days = Math.ceil((new Date(loan.dueAt).getTime() - Date.now()) / 86400000);
    return el('span', { class: 'badge badge-ok', text: days + ' day(s) left' });
  }

  function renderLoans(data) {
    const showStudent = session.canManageAll;
    $('col-student').hidden = !showStudent;

    $('stat-visible').textContent = data.summary.visible;
    $('stat-overdue').textContent = data.summary.overdue;
    $('stat-mine').textContent = data.summary.mine;
    $('stat-visible-label').textContent = showStudent ? 'items at this campus' : 'items you can see';

    const rows = data.loans.map((loan) =>
      el('tr', null,
        el('td', null, el('strong', { text: loan.title }), el('br'), el('small', { text: loan.author })),
        showStudent ? el('td', { text: loan.student + ' (' + (loan.loginId || '-') + ')' }) : null,
        el('td', { text: new Date(loan.dueAt).toLocaleDateString() }),
        el('td', { text: String(loan.renewals) }),
        el('td', null, stateBadge(loan)),
        el('td', null,
          loan.returned || loan.overdue
            ? el('span', { class: 'hint', text: loan.overdue ? 'return it first' : '-' })
            : el('button', {
              type: 'button', class: 'btn btn-quiet btn-small', text: 'Renew',
              onclick: async (event) => {
                event.target.disabled = true;
                try {
                  await call('/apps/library/api/loans/' + loan.id + '/renew', { method: 'POST' });
                  toast('Renewed: ' + loan.title);
                  await loadLoans();
                } catch (err) {
                  event.target.disabled = false;
                  toast(err.message, 'error');
                }
              },
            }))
      )
    );

    $('loan-rows').replaceChildren(
      ...(rows.length ? rows : [el('tr', null, el('td', { colspan: '6', text: 'Nothing to show.' }))])
    );
  }

  async function loadLoans() {
    try {
      renderLoans(await call('/apps/library/api/loans'));
    } catch (err) {
      if (err.status === 401) return signedOut();
      $('lib-error').textContent = err.message;
      $('lib-error').hidden = false;
    }
  }

  function signedOut() {
    $('lib-content').hidden = true;
    $('lib-signin').hidden = false;
    $('lib-signout').hidden = true;
    $('lib-me').textContent = 'Not signed in';
  }

  async function load() {
    try {
      session = await call('/apps/library/api/session');
      $('lib-signin').hidden = true;
      $('lib-content').hidden = false;
      $('lib-signout').hidden = false;

      $('lib-me').textContent = session.user.name + ' - ' + session.tenant.name;
      $('lib-title').textContent = session.canManageAll ? 'Loans at this campus' : 'Your loans';
      $('lib-sub').textContent =
        'Signed in through the single sign-on platform as ' + session.user.loginId +
        ' (' + session.role + '). The provider confirmed this through its userinfo endpoint.';
      $('lib-role').textContent = session.role;
      $('lib-role').className = 'badge badge-' + (session.role === 'student' ? 'student' : session.role === 'faculty' ? 'faculty' : 'admin');
      $('lib-scopes').textContent = session.scopes.join(' ');

      await loadLoans();
    } catch (err) {
      signedOut();
    }
  }

  $('lib-signout').addEventListener('click', async () => {
    try {
      await call('/apps/library/logout', { method: 'POST' });
      toast('Signed out of the library portal.');
    } catch (err) {
      toast(err.message, 'error');
    }
    signedOut();
  });

  load();
})();
