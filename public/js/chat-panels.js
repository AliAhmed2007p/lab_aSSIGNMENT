'use strict';

/* Dialogs and the members panel for the chat page. chat.js creates one instance with ChatPanels.create(app). */
(function () {
  const C = window.Connect;
  const el = C.el;
  const api = C.api;
  const toast = C.toast;

  const POLICY_EXPLAIN = {
    everyone: 'Every member can post.',
    faculty_only: 'Everyone can read. Only faculty and admins can post.',
    admin_only: 'Everyone can read. Only admins can post.',
  };

  function capitalize(word) {
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
  }

  function field(label, control, hint) {
    const note = typeof hint === 'string' ? el('p', { class: 'hint', text: hint }) : hint;
    return el('div', { class: 'field' }, el('label', { for: control.id, text: label }), control, note || null);
  }

  function openModal(title, content) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('h2', { text: title }), content);
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

  function create(app) {
    const state = app.state;
    const ui = app.ui;

    let open = false;
    let groupId = null;
    let details = null;

    /* ---------- People picker ---------- */

    function userSearch(options) {
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
          el('button', { type: 'button', class: 'btn btn-small btn-quiet', text: options.actionLabel, onclick: () => options.onPick(user) })
        );
      }

      async function run() {
        const mine = ++ticket;
        try {
          const data = await api('/api/users?search=' + encodeURIComponent(input.value.trim()));
          if (mine !== ticket) return;
          const exclude = options.exclude ? options.exclude() : new Set();
          const rows = data.users.filter((u) => u.id !== state.me.id && !exclude.has(u.id)).slice(0, 30);
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

    /* ---------- New direct message ---------- */

    function openNewDm() {
      const picker = userSearch({
        actionLabel: 'Message',
        onPick: (user) => {
          modal.close();
          app.openDm(user.id, user);
        },
      });
      const hint = el('p', {
        class: 'hint',
        text:
          state.me.role === 'student'
            ? 'Students can message people they share a group with, or people who messaged them first. The server blocks anything else.'
            : 'You can message anyone.',
      });
      const modal = openModal('New direct message', [
        hint,
        picker.node,
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Close', onclick: () => modal.close() })),
      ]);
    }

    /* ---------- New group ---------- */

    function openNewGroup() {
      const rules = (state.meta.groupCreationRules || {})[state.me.role] || { types: [], policies: [] };
      if (!rules.types.length) {
        toast('Your account cannot create groups.', 'error');
        return;
      }

      const chosen = new Map();
      const nameInput = el('input', { class: 'input', id: 'ng-name', type: 'text', maxlength: 60, autocomplete: 'off', placeholder: 'For example: ACM Web Dev Circle' });
      const typeSelect = el('select', { class: 'input', id: 'ng-type' }, rules.types.map((t) => el('option', { value: t, text: C.TYPE_LABELS[t] || t })));
      const policySelect = el('select', { class: 'input', id: 'ng-policy' }, rules.policies.map((p) => el('option', { value: p, text: C.POLICY_LABELS[p] || p })));
      const policyHint = el('p', { class: 'hint', text: POLICY_EXPLAIN[policySelect.value] });
      const descInput = el('textarea', { class: 'input', id: 'ng-desc', maxlength: 300, rows: 2, placeholder: 'What is this group for?' });
      const chips = el('div', { class: 'chips' });
      const errorBox = el('div', { class: 'form-error', role: 'alert', hidden: true });

      policySelect.addEventListener('change', () => {
        policyHint.textContent = POLICY_EXPLAIN[policySelect.value] || '';
      });

      const picker = userSearch({
        actionLabel: 'Add',
        exclude: () => new Set(chosen.keys()),
        onPick: (user) => {
          chosen.set(user.id, user);
          renderChips();
          picker.refresh();
        },
      });

      function renderChips() {
        if (!chosen.size) {
          chips.replaceChildren(el('span', { class: 'hint', text: 'No members added yet. You will be the owner.' }));
          return;
        }
        chips.replaceChildren(
          ...Array.from(chosen.values()).map((user) =>
            el(
              'span',
              { class: 'chip' },
              user.name,
              el('button', {
                type: 'button',
                class: 'chip-x',
                'aria-label': 'Remove ' + user.name,
                text: '\u00d7',
                onclick: () => {
                  chosen.delete(user.id);
                  renderChips();
                  picker.refresh();
                },
              })
            )
          )
        );
      }
      renderChips();

      const submit = el('button', { type: 'submit', class: 'btn', text: 'Create group' });
      const form = el(
        'form',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            errorBox.hidden = true;
            submit.disabled = true;
            try {
              const reply = await api('/api/groups', {
                method: 'POST',
                body: {
                  name: nameInput.value,
                  type: typeSelect.value,
                  postPolicy: policySelect.value,
                  description: descInput.value,
                  memberIds: Array.from(chosen.keys()),
                },
              });
              modal.close();
              toast('Created ' + reply.group.name, 'success');
              await app.refreshGroups();
              app.openGroup(reply.group.id);
            } catch (err) {
              errorBox.textContent = err.message;
              errorBox.hidden = false;
              submit.disabled = false;
            }
          },
        },
        errorBox,
        field('Group name', nameInput),
        field('Type', typeSelect, 'Your account can create: ' + rules.types.map((t) => C.TYPE_LABELS[t] || t).join(', ') + '.'),
        field('Who can post', policySelect, policyHint),
        field('Description', descInput),
        el('div', { class: 'field' }, el('label', { text: 'Members' }), chips, picker.node),
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: () => modal.close() }), submit)
      );
      const modal = openModal('Create a group', form);
    }

    /* ---------- Edit group ---------- */

    function openEditGroup() {
      const group = details;
      if (!group) return;

      const rules = (state.meta.groupCreationRules || {})[state.me.role] || { policies: [] };
      const policies = rules.policies.slice();
      if (!policies.includes(group.postPolicy)) policies.unshift(group.postPolicy);

      const nameInput = el('input', { class: 'input', id: 'eg-name', type: 'text', maxlength: 60, value: group.name });
      const descInput = el('textarea', { class: 'input', id: 'eg-desc', maxlength: 300, rows: 2 });
      descInput.value = group.description || '';
      const policySelect = el('select', { class: 'input', id: 'eg-policy' }, policies.map((p) => el('option', { value: p, text: C.POLICY_LABELS[p] || p })));
      policySelect.value = group.postPolicy;
      const policyHint = el('p', { class: 'hint', text: POLICY_EXPLAIN[policySelect.value] });
      policySelect.addEventListener('change', () => {
        policyHint.textContent = POLICY_EXPLAIN[policySelect.value] || '';
      });
      const errorBox = el('div', { class: 'form-error', role: 'alert', hidden: true });
      const save = el('button', { type: 'submit', class: 'btn', text: 'Save changes' });

      const form = el(
        'form',
        {
          onsubmit: async (event) => {
            event.preventDefault();
            const changes = {};
            if (nameInput.value.trim() !== group.name) changes.name = nameInput.value;
            if (descInput.value.trim() !== (group.description || '')) changes.description = descInput.value;
            if (policySelect.value !== group.postPolicy) changes.postPolicy = policySelect.value;
            if (!Object.keys(changes).length) {
              modal.close();
              return;
            }
            save.disabled = true;
            errorBox.hidden = true;
            try {
              await api('/api/groups/' + group.id, { method: 'PATCH', body: changes });
              modal.close();
              toast('Group updated', 'success');
              await app.refreshGroups();
            } catch (err) {
              errorBox.textContent = err.message;
              errorBox.hidden = false;
              save.disabled = false;
            }
          },
        },
        errorBox,
        field('Group name', nameInput),
        field('Description', descInput),
        field('Who can post', policySelect, policyHint),
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', text: 'Cancel', onclick: () => modal.close() }), save)
      );
      const modal = openModal('Edit group', form);
    }

    /* ---------- Members panel ---------- */

    function setPanelVisible(visible) {
      open = visible;
      ui.panel.hidden = !visible;
      ui.app.classList.toggle('has-panel', visible);
    }

    function panelHead() {
      return el(
        'div',
        { class: 'panel-head' },
        el('h2', { text: 'Group details' }),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', onclick: closeMembers }, app.icon('close'))
      );
    }

    async function loadDetails() {
      if (!open || !groupId) return;
      const wanted = groupId;
      try {
        const data = await api('/api/groups/' + wanted);
        if (wanted !== groupId) return;
        details = data.group;
        renderPanel();
      } catch (err) {
        if (wanted !== groupId) return;
        details = null;
        ui.panel.replaceChildren(panelHead(), el('p', { class: 'side-empty', text: err.message }));
      }
    }

    function memberRow(member, canManage) {
      const isMe = member.userId === state.me.id;
      const tags = [];
      if (member.groupRole === 'owner') tags.push(el('span', { class: 'badge', text: 'Owner' }));
      if (member.role !== 'student') tags.push(el('span', { class: 'badge badge-' + member.role, text: capitalize(member.role) }));
      if (member.muted) tags.push(el('span', { class: 'badge badge-readonly', text: 'Muted' }));

      const actions = [];
      if (canManage && !isMe && member.groupRole !== 'owner') {
        if (member.role !== 'admin') {
          actions.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: member.muted ? 'Unmute' : 'Mute', onclick: () => setMuted(member, !member.muted) }));
        }
        actions.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small', text: 'Remove', onclick: () => removeMember(member) }));
      }

      return el(
        'li',
        { class: 'member' },
        el('span', { class: 'avatar avatar-small', text: C.initials(member.name) }),
        el(
          'div',
          { class: 'member-info' },
          el(
            'div',
            { class: 'member-name' },
            el('span', { class: 'presence' + (state.online.has(member.userId) ? ' on' : ''), 'data-user': member.userId }),
            el('strong', { text: member.name + (isMe ? ' (you)' : '') })
          ),
          el('small', { text: member.loginId + ', ' + member.department }),
          tags.length ? el('div', { class: 'member-tags' }, tags) : null
        ),
        actions.length ? el('div', { class: 'member-actions' }, actions) : null
      );
    }

    function renderPanel() {
      if (!details) return;
      const group = details;
      const mine = group.members.find((m) => m.userId === state.me.id);
      const isOwner = Boolean(mine && mine.groupRole === 'owner');
      const canManage = state.me.role === 'admin' || isOwner;

      const sections = [
        panelHead(),
        el(
          'section',
          { class: 'panel-section' },
          el('h3', { text: group.name }),
          el('p', { text: group.description || 'No description.' }),
          el('p', { class: 'hint', text: POLICY_EXPLAIN[group.postPolicy] || '' })
        ),
        el(
          'section',
          { class: 'panel-section' },
          el('h3', { text: 'Members (' + group.members.length + ')' }),
          el('ul', { class: 'member-list' }, group.members.map((m) => memberRow(m, canManage)))
        ),
      ];

      if (canManage) {
        const picker = userSearch({
          actionLabel: 'Add',
          exclude: () => new Set(group.members.map((m) => m.userId)),
          onPick: async (user) => {
            try {
              await api('/api/groups/' + group.id + '/members', { method: 'POST', body: { userId: user.id } });
              toast(user.name + ' was added', 'success');
              await loadDetails();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        });
        sections.push(el('section', { class: 'panel-section' }, el('h3', { text: 'Add people' }), picker.node));
      }

      const buttons = [];
      if (canManage) buttons.push(el('button', { type: 'button', class: 'btn btn-quiet', text: 'Edit group', onclick: openEditGroup }));
      if (mine && !isOwner) buttons.push(el('button', { type: 'button', class: 'btn btn-quiet', text: 'Leave group', onclick: leaveGroup }));
      if (canManage) buttons.push(el('button', { type: 'button', class: 'btn btn-danger', text: 'Delete group', onclick: deleteGroup }));
      if (buttons.length) sections.push(el('div', { class: 'panel-actions' }, buttons));

      ui.panel.replaceChildren(...sections);
    }

    async function setMuted(member, muted) {
      try {
        await api('/api/groups/' + details.id + '/members/' + member.userId, { method: 'PATCH', body: { muted } });
        toast(member.name + (muted ? ' is muted' : ' can post again'), 'success');
        await loadDetails();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function removeMember(member) {
      if (!window.confirm('Remove ' + member.name + ' from ' + details.name + '?')) return;
      try {
        await api('/api/groups/' + details.id + '/members/' + member.userId, { method: 'DELETE' });
        toast(member.name + ' was removed', 'success');
        await loadDetails();
        app.refreshGroups();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function leaveGroup() {
      const group = details;
      if (!window.confirm('Leave ' + group.name + '? You will stop receiving its messages.')) return;
      try {
        state.quiet.add(group.id);
        await api('/api/groups/' + group.id + '/members/' + state.me.id, { method: 'DELETE' });
        toast('You left ' + group.name, 'success');
        await app.refreshGroups();
      } catch (err) {
        state.quiet.delete(group.id);
        toast(err.message, 'error');
      }
    }

    async function deleteGroup() {
      const group = details;
      if (!window.confirm('Delete ' + group.name + ' and all of its messages? This cannot be undone.')) return;
      try {
        state.quiet.add(group.id);
        await api('/api/groups/' + group.id, { method: 'DELETE' });
        toast('Deleted ' + group.name, 'success');
        await app.refreshGroups();
      } catch (err) {
        state.quiet.delete(group.id);
        toast(err.message, 'error');
      }
    }

    /* ---------- Hooks called by chat.js ---------- */

    function closeMembers() {
      setPanelVisible(false);
      groupId = null;
      details = null;
    }

    function toggleMembers() {
      if (open) {
        closeMembers();
        return;
      }
      if (!state.active || state.active.kind !== 'group') return;
      groupId = state.active.id;
      setPanelVisible(true);
      ui.panel.replaceChildren(panelHead(), el('p', { class: 'side-empty', text: 'Loading...' }));
      loadDetails();
    }

    function onChatChanged() {
      if (!open) return;
      if (state.active && state.active.kind === 'group') {
        groupId = state.active.id;
        loadDetails();
      } else {
        closeMembers();
      }
    }

    function onGroupsChanged() {
      if (!open) return;
      if (state.groups.some((g) => g.id === groupId)) loadDetails();
      else closeMembers();
    }

    function onPresence() {
      if (!open) return;
      ui.panel.querySelectorAll('[data-user]').forEach((dot) => {
        dot.classList.toggle('on', state.online.has(dot.getAttribute('data-user')));
      });
    }

    return { openNewGroup, openNewDm, toggleMembers, closeMembers, onChatChanged, onGroupsChanged, onPresence };
  }

  window.ChatPanels = { create };
})();
