'use strict';

/* Admin console: users, groups, organizations, applications and the audit log.
   Platform and tenant administrators only. */
(async function () {
  const C = window.Connect;
  if (!(await C.requireLogin())) return;

  const el = C.el;
  const api = C.api;
  const toast = C.toast;

  const $ = (id) => document.getElementById(id);
  const state = { me: null, meta: null, users: [], groups: [], groupsLoaded: false };

  const userEls = {
    search: $('user-search'),
    role: $('user-role'),
    dept: $('user-dept'),
    inactive: $('user-inactive'),
    count: $('user-count'),
    body: $('user-body'),
  };
  const groupEls = {
    search: $('group-search'),
    type: $('group-type'),
    policy: $('group-policy'),
    count: $('group-count'),
    body: $('group-body'),
  };

  const capitalize = (word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : '');

  /* ---------- Small helpers ---------- */

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function field(label, control, hint) {
    return el(
      'div',
      { class: 'field' },
      el('label', { for: control.id, text: label }),
      control,
      hint ? el('p', { class: 'hint', text: hint }) : null
    );
  }

  function makeSelect(id, pairs, value) {
    const select = el('select', { class: 'input', id }, pairs.map((p) => el('option', { value: p[0], text: p[1] })));
    if (value !== undefined) select.value = value;
    return select;
  }

  function errorBox() {
    return el('div', { class: 'form-error', role: 'alert', hidden: true });
  }

  function showError(box, message) {
    box.textContent = message;
    box.hidden = false;
  }

  function openModal(title, content, wide) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el(
      'div',
      { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h2', { text: title }),
      content
    );
    backdrop.append(modal);

    function onKey(event) {
      if (event.key === 'Escape') close();
    }
    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);

    const first = modal.querySelector('input, textarea, select');
    if (first) first.focus();
    return { close };
  }

  // Show-password checkbox that flips a password input between hidden and visible
  function passwordToggle(input, id) {
    const box = el('input', {
      type: 'checkbox',
      id,
      onchange: () => {
        input.type = box.checked ? 'text' : 'password';
      },
    });
    return el('div', { class: 'field field-check' }, box, el('label', { for: id, text: 'Show password' }));
  }

  function userPicker(options) {
    const input = el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Search by name or login ID',
      'aria-label': 'Search people',
      autocomplete: 'off',
    });
    const results = el('div', { class: 'picker-results' });
    let timer = null;
    let ticket = 0;

    function row(user) {
      return el(
        'div',
        { class: 'picker-row' },
        el('span', { class: 'avatar avatar-small', text: C.initials(user.name) }),
        el('div', { class: 'picker-info' }, el('strong', { text: user.name }), el('small', { text: user.loginId + ', ' + user.department })),
        el('span', { class: 'badge badge-' + user.role, text: capitalize(user.role) }),
        el('button', { type: 'button', class: 'btn btn-small btn-quiet', text: 'Add', onclick: () => options.onPick(user) })
      );
    }

    async function run() {
      const mine = ++ticket;
      try {
        const data = await api('/api/users?search=' + encodeURIComponent(input.value.trim()));
        if (mine !== ticket) return;
        const exclude = options.exclude();
        const rows = data.users.filter((u) => !exclude.has(u.id)).slice(0, 30);
        results.replaceChildren(...(rows.length ? rows.map(row) : [el('p', { class: 'picker-empty', text: 'No people found.' })]));
      } catch (err) {
        results.replaceChildren(el('p', { class: 'picker-empty', text: err.message }));
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 200);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });

    run();
    return { node: el('div', { class: 'picker' }, input, results), refresh: run };
  }

  /* ---------- Users ---------- */

  let userTicket = 0;

  async function loadUsers() {
    const mine = ++userTicket;
    const params = new URLSearchParams();
    const term = userEls.search.value.trim();
    if (term) params.set('search', term);
    if (userEls.role.value) params.set('role', userEls.role.value);
    if (userEls.dept.value) params.set('department', userEls.dept.value);
    if (userEls.inactive.checked) params.set('includeInactive', 'true');

    try {
      const data = await api('/api/users?' + params.toString());
      if (mine !== userTicket) return;
      state.users = data.users;
      renderUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderUsers() {
    const users = state.users;
    userEls.count.textContent = users.length + (users.length === 1 ? ' user' : ' users');

    if (!users.length) {
      userEls.body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: 6, text: 'No users match these filters.' })));
      return;
    }
    userEls.body.replaceChildren(...users.map(userRow));
  }

  function userRow(user) {
    const isMe = user.id === state.me.id;
    const actions = [
      el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Edit', onclick: () => openEditUser(user) }),
      el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Reset password', onclick: () => openResetPassword(user) }),
    ];
    if (!isMe) {
      actions.push(
        el('button', {
          type: 'button',
          class: 'btn btn-quiet btn-small',
          text: user.active ? 'Deactivate' : 'Activate',
          onclick: () => toggleActive(user),
        })
      );
    }

    return el(
      'tr',
      { class: user.active ? null : 'inactive' },
      el(
        'td',
        null,
        el(
          'div',
          { class: 'cell-user' },
          el('span', { class: 'avatar avatar-small', text: C.initials(user.name) }),
          el('div', { class: 'cell-name' }, el('strong', { text: user.name + (isMe ? ' (you)' : '') }), el('small', { text: user.loginId }))
        )
      ),
      el('td', null, el('span', { class: 'badge badge-' + user.role, text: capitalize(user.role) })),
      el('td', { text: user.department }),
      el('td', null, el('span', { class: 'badge ' + (user.active ? 'badge-open' : 'badge-off'), text: user.active ? 'Active' : 'Deactivated' })),
      el('td', { text: user.lastLoginAt ? C.formatTime(user.lastLoginAt) : 'Never' }),
      el('td', null, el('div', { class: 'cell-actions' }, actions))
    );
  }

  async function toggleActive(user) {
    const verb = user.active ? 'Deactivate' : 'Activate';
    const extra = user.active ? ' They will be signed out right away and cannot sign in again.' : '';
    if (!window.confirm(verb + ' ' + user.name + '?' + extra)) return;
    try {
      await api('/api/users/' + user.id, { method: 'PATCH', body: { active: !user.active } });
      toast(verb + 'd ' + user.name, 'success');
      loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openAddUser() {
    const name = el('input', { class: 'input', id: 'au-name', type: 'text', maxlength: 80, autocomplete: 'off' });
    const role = makeSelect(
      'au-role',
      ['student', 'faculty', 'admin'].filter((r) => state.meta.roles.includes(r)).map((r) => [r, capitalize(r)]),
      'student'
    );
    const loginId = el('input', { class: 'input', id: 'au-login', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const loginHint = el('p', { class: 'hint' });
    const dept = makeSelect('au-dept', state.meta.departments.map((d) => [d, d]), 'Computer Science');
    const password = el('input', { class: 'input', id: 'au-pass', type: 'password', autocomplete: 'new-password' });
    const error = errorBox();
    const save = el('button', { type: 'submit', class: 'btn', text: 'Add user' });

    function updateHint() {
      loginHint.textContent =
        role.value === 'student'
          ? 'Registration number, for example FA23-BCS-050.'
          : 'Username of 3 to 30 letters, digits, dots, dashes or underscores, for example dr.ahmed.';
    }
    role.addEventListener('change', updateHint);
    updateHint();

    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          save.disabled = true;
          try {
            const data = await api('/api/users', {
              method: 'POST',
              body: { name: name.value, loginId: loginId.value, role: role.value, department: dept.value, password: password.value },
            });
            modal.close();
            toast('Added ' + data.user.name, 'success');
            loadUsers();
          } catch (err) {
            showError(error, err.message);
            save.disabled = false;
          }
        },
      },
      error,
      field('Full name', name),
      field('Role', role),
      el('div', { class: 'field' }, el('label', { for: 'au-login', text: 'Login ID' }), loginId, loginHint),
      field('Department', dept),
      field('Password', password, 'At least 8 characters. The person can sign in with it straight away.'),
      passwordToggle(password, 'au-show'),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: () => modal.close() }), save)
    );
    const modal = openModal('Add a user', form);
  }

  function openEditUser(user) {
    const name = el('input', { class: 'input', id: 'eu-name', type: 'text', maxlength: 80, value: user.name });
    const dept = makeSelect('eu-dept', state.meta.departments.map((d) => [d, d]), user.department);
    const error = errorBox();
    const save = el('button', { type: 'submit', class: 'btn', text: 'Save changes' });

    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const changes = {};
          if (name.value.trim() !== user.name) changes.name = name.value;
          if (dept.value !== user.department) changes.department = dept.value;
          if (!Object.keys(changes).length) {
            modal.close();
            return;
          }
          error.hidden = true;
          save.disabled = true;
          try {
            await api('/api/users/' + user.id, { method: 'PATCH', body: changes });
            modal.close();
            toast('Saved changes to ' + (changes.name || user.name), 'success');
            loadUsers();
          } catch (err) {
            showError(error, err.message);
            save.disabled = false;
          }
        },
      },
      error,
      el('p', { class: 'hint', text: user.loginId + ', ' + capitalize(user.role) + '. The login ID and role cannot be changed.' }),
      field('Full name', name),
      field('Department', dept),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: () => modal.close() }), save)
    );
    const modal = openModal('Edit ' + user.name, form);
  }

  function openResetPassword(user) {
    const password = el('input', { class: 'input', id: 'rp-pass', type: 'password', autocomplete: 'new-password' });
    const error = errorBox();
    const save = el('button', { type: 'submit', class: 'btn', text: 'Reset password' });

    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          save.disabled = true;
          try {
            await api('/api/users/' + user.id, { method: 'PATCH', body: { password: password.value } });
            modal.close();
            toast('Password reset for ' + user.name, 'success');
          } catch (err) {
            showError(error, err.message);
            save.disabled = false;
          }
        },
      },
      error,
      field('New password for ' + user.name, password, 'At least 8 characters.'),
      passwordToggle(password, 'rp-show'),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: () => modal.close() }), save)
    );
    const modal = openModal('Reset password', form);
  }

  /* ---------- Groups ---------- */

  async function loadGroups() {
    try {
      const data = await api('/api/groups/all');
      state.groups = data.groups;
      state.groupsLoaded = true;
      renderGroups();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderGroups() {
    const term = groupEls.search.value.trim().toLowerCase();
    const type = groupEls.type.value;
    const policy = groupEls.policy.value;

    const groups = state.groups.filter(
      (g) =>
        (!type || g.type === type) &&
        (!policy || g.postPolicy === policy) &&
        (!term || g.name.toLowerCase().includes(term) || (g.description || '').toLowerCase().includes(term))
    );
    groupEls.count.textContent = groups.length + (groups.length === 1 ? ' group' : ' groups');

    if (!groups.length) {
      groupEls.body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: 6, text: 'No groups match these filters.' })));
      return;
    }
    groupEls.body.replaceChildren(...groups.map(groupRow));
  }

  function groupRow(group) {
    return el(
      'tr',
      null,
      el(
        'td',
        null,
        el('div', { class: 'cell-name' }, el('strong', { text: group.name }), group.description ? el('small', { text: group.description }) : null)
      ),
      el('td', null, el('span', { class: 'badge', text: C.TYPE_LABELS[group.type] || group.type })),
      el(
        'td',
        null,
        el('span', {
          class: 'badge ' + (group.postPolicy === 'everyone' ? 'badge-open' : 'badge-readonly'),
          text: C.POLICY_LABELS[group.postPolicy] || group.postPolicy,
        })
      ),
      el('td', { text: String(group.memberCount) }),
      el('td', { text: new Date(group.createdAt).toLocaleDateString() }),
      el('td', null, el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Manage', onclick: () => openManage(group.id) }))
    );
  }

  function openCreateGroup() {
    const types = C.TYPE_SECTIONS.map((s) => s[0]).filter((t) => state.meta.groupTypes.includes(t));
    const name = el('input', { class: 'input', id: 'cg-name', type: 'text', maxlength: 60, autocomplete: 'off' });
    const type = makeSelect('cg-type', types.map((t) => [t, C.TYPE_LABELS[t] || t]), types[0]);
    const policy = makeSelect('cg-policy', state.meta.postPolicies.map((p) => [p, C.POLICY_LABELS[p] || p]), 'everyone');
    const desc = el('textarea', { class: 'input', id: 'cg-desc', maxlength: 300, rows: 2, placeholder: 'What is this group for?' });
    const error = errorBox();
    const save = el('button', { type: 'submit', class: 'btn', text: 'Create group' });

    const form = el(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          save.disabled = true;
          try {
            const data = await api('/api/groups', {
              method: 'POST',
              body: { name: name.value, type: type.value, postPolicy: policy.value, description: desc.value },
            });
            modal.close();
            toast('Created ' + data.group.name, 'success');
            await loadGroups();
            openManage(data.group.id);
          } catch (err) {
            showError(error, err.message);
            save.disabled = false;
          }
        },
      },
      error,
      el('p', { class: 'hint', text: 'You become the owner of the group. Add its members on the next screen.' }),
      field('Group name', name),
      field('Type', type),
      field('Who can post', policy, 'Everyone can post, or only faculty and admins, or only admins.'),
      field('Description', desc),
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: () => modal.close() }), save)
    );
    const modal = openModal('Create a group', form);
  }

  async function openManage(groupId) {
    let group;
    try {
      group = (await api('/api/groups/' + groupId)).group;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const settingsBox = el('section', { class: 'modal-section' });
    const membersBox = el('section', { class: 'modal-section' });
    const picker = userPicker({
      exclude: () => new Set(group.members.map((m) => m.userId)),
      onPick: addMember,
    });
    const addBox = el('section', { class: 'modal-section' }, el('h3', { text: 'Add people' }), picker.node);
    const dangerBox = el(
      'section',
      { class: 'modal-section' },
      el('button', { type: 'button', class: 'btn btn-danger', text: 'Delete group', onclick: deleteGroup }),
      el('p', { class: 'hint', text: 'Deleting a group removes it and all of its messages for everyone.' })
    );
    const body = el(
      'div',
      null,
      settingsBox,
      membersBox,
      addBox,
      dangerBox,
      el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Close', onclick: () => modal.close() }))
    );
    const modal = openModal('Manage group', body, true);

    function renderSettings() {
      const name = el('input', { class: 'input', id: 'mg-name', type: 'text', maxlength: 60, value: group.name });
      const desc = el('textarea', { class: 'input', id: 'mg-desc', maxlength: 300, rows: 2 });
      desc.value = group.description || '';
      const policy = makeSelect('mg-policy', state.meta.postPolicies.map((p) => [p, C.POLICY_LABELS[p] || p]), group.postPolicy);
      const error = errorBox();
      const save = el('button', { type: 'submit', class: 'btn', text: 'Save changes' });

      const form = el(
        'form',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            const changes = {};
            if (name.value.trim() !== group.name) changes.name = name.value;
            if (desc.value.trim() !== (group.description || '')) changes.description = desc.value;
            if (policy.value !== group.postPolicy) changes.postPolicy = policy.value;
            if (!Object.keys(changes).length) {
              toast('Nothing to save');
              return;
            }
            error.hidden = true;
            save.disabled = true;
            try {
              await api('/api/groups/' + groupId, { method: 'PATCH', body: changes });
              toast('Saved changes to ' + (changes.name || group.name), 'success');
              await reload();
              renderSettings();
            } catch (err) {
              showError(error, err.message);
              save.disabled = false;
            }
          },
        },
        error,
        el('p', { class: 'hint', text: (C.TYPE_LABELS[group.type] || group.type) + ' group. The type cannot be changed.' }),
        field('Group name', name),
        field('Description', desc),
        field('Who can post', policy),
        save
      );
      settingsBox.replaceChildren(el('h3', { text: group.name }), form);
    }

    function renderMembers() {
      const rows = group.members.map((m) => {
        const tags = [];
        if (m.groupRole === 'owner') tags.push(el('span', { class: 'badge', text: 'Owner' }));
        if (m.role !== 'student') tags.push(el('span', { class: 'badge badge-' + m.role, text: capitalize(m.role) }));
        if (m.muted) tags.push(el('span', { class: 'badge badge-readonly', text: 'Muted' }));

        const actions = [];
        if (m.groupRole !== 'owner') {
          if (m.role !== 'admin') {
            actions.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: m.muted ? 'Unmute' : 'Mute', onclick: () => setMuted(m, !m.muted) }));
          }
          actions.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Remove', onclick: () => removeMember(m) }));
        }

        return el(
          'li',
          { class: 'roster-row' },
          el('span', { class: 'avatar avatar-small', text: C.initials(m.name) }),
          el(
            'div',
            { class: 'roster-info' },
            el('strong', { text: m.name }),
            el('small', { text: m.loginId + ', ' + m.department }),
            tags.length ? el('div', { class: 'member-tags' }, tags) : null
          ),
          actions.length ? el('div', { class: 'cell-actions' }, actions) : null
        );
      });
      membersBox.replaceChildren(el('h3', { text: 'Members (' + group.members.length + ')' }), el('ul', { class: 'roster' }, rows));
    }

    async function reload() {
      try {
        group = (await api('/api/groups/' + groupId)).group;
      } catch (err) {
        toast(err.message, 'error');
        modal.close();
        return;
      }
      renderMembers();
      picker.refresh();
      loadGroups();
    }

    async function addMember(user) {
      try {
        await api('/api/groups/' + groupId + '/members', { method: 'POST', body: { userId: user.id } });
        toast('Added ' + user.name, 'success');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function setMuted(member, muted) {
      try {
        await api('/api/groups/' + groupId + '/members/' + member.userId, { method: 'PATCH', body: { muted } });
        toast((muted ? 'Muted ' : 'Unmuted ') + member.name, 'success');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function removeMember(member) {
      if (!window.confirm('Remove ' + member.name + ' from ' + group.name + '?')) return;
      try {
        await api('/api/groups/' + groupId + '/members/' + member.userId, { method: 'DELETE' });
        toast('Removed ' + member.name, 'success');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function deleteGroup() {
      if (!window.confirm('Delete ' + group.name + ' and all of its messages? This cannot be undone.')) return;
      try {
        await api('/api/groups/' + groupId, { method: 'DELETE' });
        modal.close();
        toast('Deleted ' + group.name, 'success');
        loadGroups();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    renderSettings();
    renderMembers();
  }

  /* ---------- Tabs ---------- */

  function showTab(name) {
    const isUsers = name === 'users';
    $('tab-users').classList.toggle('active', isUsers);
    $('tab-users').setAttribute('aria-selected', String(isUsers));
    $('tab-groups').classList.toggle('active', !isUsers);
    $('tab-groups').setAttribute('aria-selected', String(!isUsers));
    $('view-users').hidden = !isUsers;
    $('view-groups').hidden = isUsers;
    if (!isUsers && !state.groupsLoaded) loadGroups();
  }

  /* ---------- Start ---------- */

  async function boot() {
    try {
      const results = await Promise.all([api('/api/auth/me'), api('/api/meta')]);
      state.me = results[0].user;
      state.meta = results[1];
    } catch (err) {
      if (err.status !== 401) toast(err.message, 'error');
      return;
    }

    if (!['admin', 'tenant_admin'].includes(state.me.role)) {
      toast('The admin console is for administrator accounts only.', 'error');
      setTimeout(() => location.replace('/chat.html'), 1200);
      return;
    }

    $('admin-me').textContent = 'Signed in as ' + state.me.name;
    $('signout-btn').addEventListener('click', () => C.logout());

    state.meta.departments.forEach((d) => userEls.dept.append(el('option', { value: d, text: d })));
    C.TYPE_SECTIONS.forEach((s) => groupEls.type.append(el('option', { value: s[0], text: C.TYPE_LABELS[s[0]] })));
    state.meta.postPolicies.forEach((p) => groupEls.policy.append(el('option', { value: p, text: C.POLICY_LABELS[p] || p })));

    const searchUsers = debounce(loadUsers, 250);
    userEls.search.addEventListener('input', searchUsers);
    userEls.role.addEventListener('change', loadUsers);
    userEls.dept.addEventListener('change', loadUsers);
    userEls.inactive.addEventListener('change', loadUsers);
    $('add-user-btn').addEventListener('click', openAddUser);

    groupEls.search.addEventListener('input', renderGroups);
    groupEls.type.addEventListener('change', renderGroups);
    groupEls.policy.addEventListener('change', renderGroups);
    $('add-group-btn').addEventListener('click', openCreateGroup);

    $('tab-users').addEventListener('click', () => showTab('users'));
    $('tab-groups').addEventListener('click', () => showTab('groups'));

    loadUsers();
  }

  boot();
})();
