'use strict';

/* Chat page: sockets, conversation list, messages, composer. */
(async function () {
  const C = window.Connect;
  // The token comes from the chat application's OAuth session; with no session
  // the user is sent to the platform sign-in page.
  if (!(await C.requireLogin())) return;

  const el = C.el;
  const api = C.api;
  const request = C.request;
  const toast = C.toast;

  const HISTORY_PAGE = 50;

  const state = {
    me: C.session.user(),
    meta: null,
    groups: [],
    conversations: [],
    dmUsers: new Map(),
    online: new Set(),
    active: null,
    messages: new Map(),
    canLoadMore: new Map(),
    unread: new Map(),
    typing: new Map(),
    quiet: new Set(),
  };

  let socket = null;
  let panels = null;
  let composer = null;
  let composerSig = null;
  let sending = false;
  let booted = false;
  let typingSentAt = 0;
  let typingStopTimer = null;
  let typingTarget = null;
  let refreshing = null;
  let refreshAgain = false;

  const $ = (id) => document.getElementById(id);
  const ui = {
    app: $('app'),
    meCard: $('me-card'),
    conn: $('conn-status'),
    connText: $('conn-text'),
    groupList: $('group-list'),
    dmList: $('dm-list'),
    newGroup: $('new-group-btn'),
    newDm: $('new-dm-btn'),
    menu: $('menu-btn'),
    scrim: $('scrim'),
    title: $('chat-title'),
    sub: $('chat-sub'),
    actions: $('chat-actions'),
    messages: $('messages'),
    typing: $('typing'),
    composerWrap: $('composer-wrap'),
    panel: $('panel'),
  };

  /* ---------- Small helpers ---------- */

  const ICONS = {
    lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    menu: '<path d="M2 4h12M2 8h12M2 12h12"/>',
    members: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13c.4-2.4 2.3-3.8 4.5-3.8s4.1 1.4 4.5 3.8"/><path d="M10.5 3.2a2.4 2.4 0 0 1 0 4.6M12 9.4c1.5.5 2.5 1.7 2.8 3.6"/>',
    send: '<path d="M14 2L7 9M14 2l-4.5 12-2.5-5.5L1.5 6 14 2z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    close: '<path d="M3 3l10 10M13 3L3 13"/>',
  };

  // The markup is a fixed string from the table above, never user text.
  function icon(name) {
    const holder = document.createElement('span');
    holder.className = 'icon';
    holder.setAttribute('aria-hidden', 'true');
    holder.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      ICONS[name] +
      '</svg>';
    return holder;
  }

  const capitalize = (word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : '');
  const groupKey = (id) => 'g:' + id;
  const dmKey = (id) => 'd:' + id;
  const activeKey = () => (state.active ? state.active.key : null);
  const findGroup = (id) => state.groups.find((g) => g.id === id) || null;
  const activeGroup = () => (state.active && state.active.kind === 'group' ? findGroup(state.active.id) : null);
  const dmPartner = (id) => state.dmUsers.get(id) || null;
  const senderIdOf = (m) => m.senderId || m.fromId;

  function updateTitle() {
    let total = 0;
    state.unread.forEach((n) => {
      total += n;
    });
    document.title = (total ? '(' + total + ') ' : '') + 'COMSATS Connect';
  }

  function closeDrawer() {
    ui.app.classList.remove('drawer-open');
  }

  function setConn(status) {
    const labels = { online: 'Connected', connecting: 'Connecting...', offline: 'Reconnecting...' };
    ui.conn.className = 'conn ' + status;
    ui.connText.textContent = labels[status];
  }

  /* ---------- Sidebar ---------- */

  function renderMe() {
    const me = state.me;
    ui.meCard.replaceChildren(
      el(
        'div',
        { class: 'me-row' },
        el('span', { class: 'avatar', text: C.initials(me.name) }),
        el('div', { class: 'me-info' }, el('strong', { text: me.name }), el('small', { text: capitalize(me.role) + ', ' + me.department }))
      ),
      el(
        'div',
        { class: 'me-actions' },
        ['admin', 'tenant_admin'].includes(me.role)
          ? el('a', { class: 'link-btn', href: '/admin.html', text: 'Admin console' })
          : null,
        el('button', { type: 'button', class: 'link-btn', text: 'Sign out', onclick: () => C.logout() })
      )
    );
  }

  function chatItem(options) {
    const unread = state.unread.get(options.key) || 0;
    const isActive = activeKey() === options.key;
    return el(
      'button',
      {
        type: 'button',
        class: 'chat-item' + (isActive ? ' active' : ''),
        'aria-current': isActive ? 'true' : null,
        title: options.title || null,
        onclick: options.onclick,
      },
      options.online === undefined ? null : el('span', { class: 'presence' + (options.online ? ' on' : '') }),
      el('span', { class: 'chat-item-name', text: options.name }),
      options.locked ? icon('lock') : null,
      unread ? el('span', { class: 'unread', text: unread > 99 ? '99+' : String(unread) }) : null
    );
  }

  function renderGroupList() {
    const nodes = [];
    C.TYPE_SECTIONS.forEach((section) => {
      const items = state.groups.filter((g) => g.type === section[0]);
      if (!items.length) return;
      nodes.push(el('h3', { class: 'side-label', text: section[1] }));
      items.forEach((g) =>
        nodes.push(
          chatItem({
            key: groupKey(g.id),
            name: g.name,
            locked: g.postPolicy !== 'everyone',
            title: C.POLICY_LABELS[g.postPolicy],
            onclick: () => openGroup(g.id),
          })
        )
      );
    });
    if (!nodes.length) {
      nodes.push(el('p', { class: 'side-empty', text: 'You are not in any group yet. Create one, or ask an admin to add you.' }));
    }
    ui.groupList.replaceChildren(...nodes);
  }

  function renderDmList() {
    const nodes = state.conversations.map((entry) =>
      chatItem({
        key: dmKey(entry.partner.id),
        name: entry.partner.name,
        online: state.online.has(entry.partner.id),
        onclick: () => openDm(entry.partner.id),
      })
    );

    // A conversation you just opened but have not written in yet
    const t = state.active;
    if (t && t.kind === 'dm' && !state.conversations.some((c) => c.partner.id === t.id) && dmPartner(t.id)) {
      nodes.unshift(
        chatItem({ key: t.key, name: dmPartner(t.id).name, online: state.online.has(t.id), onclick: () => openDm(t.id) })
      );
    }
    if (!nodes.length) nodes.push(el('p', { class: 'side-empty', text: 'No conversations yet.' }));
    ui.dmList.replaceChildren(...nodes);
  }

  function renderSidebar() {
    renderGroupList();
    renderDmList();
  }

  /* ---------- Header ---------- */

  // replaceChildren turns a null argument into the text null, so empty slots are dropped first
  function setSub() {
    ui.sub.replaceChildren(...Array.prototype.slice.call(arguments).filter(Boolean));
  }

  function renderHeader() {
    const t = state.active;
    ui.actions.replaceChildren();

    if (!t) {
      ui.title.textContent = 'COMSATS Connect';
      setSub(el('span', { text: 'Choose a group or a conversation.' }));
      return;
    }

    if (t.kind === 'group') {
      const g = findGroup(t.id);
      if (!g) return;
      const restricted = g.postPolicy !== 'everyone';
      ui.title.textContent = g.name;
      setSub(
        el('span', { class: 'badge', text: C.TYPE_LABELS[g.type] || g.type }),
        el('span', { class: 'badge ' + (restricted ? 'badge-readonly' : 'badge-open'), text: C.POLICY_LABELS[g.postPolicy] || g.postPolicy }),
        el('span', { text: g.memberCount + (g.memberCount === 1 ? ' member' : ' members') }),
        g.description ? el('span', { class: 'desc', title: g.description, text: g.description }) : null
      );
      ui.actions.append(
        el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => panels.toggleMembers() }, icon('members'), 'Members')
      );
      return;
    }

    const u = dmPartner(t.id);
    ui.title.textContent = u ? u.name : 'Direct message';
    setSub(
      u ? el('span', { class: 'badge badge-' + u.role, text: capitalize(u.role) }) : null,
      u ? el('span', { text: u.department }) : null,
      state.online.has(t.id) ? el('span', { class: 'badge badge-open', text: 'Online' }) : null
    );
  }

  /* ---------- Messages ---------- */

  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }

  function messageNode(m, prev) {
    const sid = senderIdOf(m);
    const mine = sid === state.me.id;
    const compact =
      prev && senderIdOf(prev) === sid && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60 * 1000;

    const body = [];
    if (!compact) {
      body.push(
        el(
          'div',
          { class: 'msg-head' },
          el('strong', { text: mine ? 'You' : m.senderName }),
          m.senderRole && m.senderRole !== 'student' ? el('span', { class: 'badge badge-' + m.senderRole, text: capitalize(m.senderRole) }) : null,
          el('time', { datetime: m.createdAt, text: C.formatTime(m.createdAt) })
        )
      );
    }
    body.push(el('div', { class: 'msg-text', title: compact ? C.formatTime(m.createdAt) : null, text: m.text }));

    return el(
      'div',
      { class: 'msg' + (mine ? ' mine' : '') + (compact ? ' compact' : ''), 'data-id': m.id },
      compact ? el('span', { class: 'avatar-spacer' }) : el('span', { class: 'avatar', text: C.initials(m.senderName) }),
      el('div', { class: 'msg-body' }, body)
    );
  }

  function nodesFor(m, prev) {
    const nodes = [];
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
    if (newDay) nodes.push(el('div', { class: 'day', text: dayLabel(m.createdAt) }));
    nodes.push(messageNode(m, newDay ? null : prev));
    return nodes;
  }

  function emptyChat(title, text, isError) {
    return el('div', { class: 'chat-empty' + (isError ? ' error' : '') }, el('strong', { text: title }), el('span', { text }));
  }

  function renderMessages(options) {
    const keepScroll = options && options.keepScroll;
    const key = activeKey();

    if (!key) {
      ui.messages.replaceChildren(
        emptyChat(
          'Welcome to COMSATS Connect',
          state.groups.length
            ? 'Pick a group or a direct message from the list.'
            : 'You are not in any group yet. Create one, or ask an admin or group owner to add you.'
        )
      );
      return;
    }

    const list = state.messages.get(key);
    if (!list) {
      ui.messages.replaceChildren(emptyChat('Loading messages...', ''));
      return;
    }

    const nodes = [];
    if (state.canLoadMore.get(key)) {
      nodes.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small load-more', text: 'Load earlier messages', onclick: loadEarlier }));
    }
    if (!list.length) {
      const g = activeGroup();
      const verdict = g ? C.postState(state.me, g) : { allowed: true };
      nodes.push(
        emptyChat(
          'No messages yet',
          state.active.kind === 'dm' ? 'Say hello to start the conversation.' : verdict.allowed ? 'Be the first to post here.' : 'Nothing has been posted in this group yet.'
        )
      );
    }
    list.forEach((m, i) => nodesFor(m, list[i - 1]).forEach((n) => nodes.push(n)));
    ui.messages.replaceChildren(...nodes);
    if (!keepScroll) ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function appendLive(m) {
    const list = state.messages.get(activeKey());
    if (list.length === 1) {
      renderMessages();
      return;
    }
    const box = ui.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    nodesFor(m, list[list.length - 2]).forEach((n) => box.append(n));
    if (nearBottom || senderIdOf(m) === state.me.id) box.scrollTop = box.scrollHeight;
  }

  async function fetchHistory(target, before) {
    if (target.kind === 'group') {
      return (await request(socket, 'group:history', { groupId: target.id, limit: HISTORY_PAGE, before })).messages;
    }
    return (await request(socket, 'direct:history', { withUserId: target.id, limit: HISTORY_PAGE, before })).messages;
  }

  async function loadHistory(target) {
    try {
      const messages = await fetchHistory(target);
      state.messages.set(target.key, messages);
      state.canLoadMore.set(target.key, messages.length >= HISTORY_PAGE);
    } catch (err) {
      if (activeKey() === target.key) ui.messages.replaceChildren(emptyChat('Could not load messages', err.message, true));
      if (err.code === 'NOT_MEMBER') refreshGroups();
      return;
    }
    if (activeKey() === target.key) renderMessages();
  }

  async function loadEarlier() {
    const target = state.active;
    if (!target) return;
    const current = state.messages.get(target.key);
    if (!current || !current.length) return;

    const previousHeight = ui.messages.scrollHeight;
    try {
      const older = await fetchHistory(target, current[0].createdAt);
      state.canLoadMore.set(target.key, older.length >= HISTORY_PAGE);
      state.messages.set(target.key, older.concat(state.messages.get(target.key) || []));
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (activeKey() === target.key) {
      renderMessages({ keepScroll: true });
      ui.messages.scrollTop = ui.messages.scrollHeight - previousHeight;
    }
  }

  /* ---------- Typing indicator ---------- */

  function typingPayload(target, isTyping) {
    return target.kind === 'group' ? { groupId: target.id, isTyping } : { toUserId: target.id, isTyping };
  }

  function noteTyping() {
    const target = state.active;
    if (!target || !socket || !socket.connected) return;
    const now = Date.now();
    if (now - typingSentAt > 2000) {
      socket.emit('typing', typingPayload(target, true));
      typingSentAt = now;
    }
    typingTarget = target;
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 2500);
  }

  function stopTyping() {
    clearTimeout(typingStopTimer);
    typingStopTimer = null;
    if (typingTarget && typingSentAt && socket && socket.connected) {
      socket.emit('typing', typingPayload(typingTarget, false));
    }
    typingSentAt = 0;
    typingTarget = null;
  }

  function renderTyping() {
    const map = state.typing.get(activeKey());
    const names = map ? Array.from(map.values()).map((v) => v.name) : [];
    let text = '';
    if (names.length === 1) text = names[0] + ' is typing...';
    else if (names.length === 2) text = names[0] + ' and ' + names[1] + ' are typing...';
    else if (names.length > 2) text = 'Several people are typing...';
    ui.typing.textContent = text;
  }

  function clearTypingFor(key, userId) {
    const map = state.typing.get(key);
    if (!map || !map.has(userId)) return;
    clearTimeout(map.get(userId).timer);
    map.delete(userId);
    if (key === activeKey()) renderTyping();
  }

  function onTyping(p) {
    const userId = p.userId || p.fromUserId;
    if (!userId || userId === state.me.id) return;
    const key = p.groupId ? groupKey(p.groupId) : dmKey(p.fromUserId);

    let map = state.typing.get(key);
    if (!map) {
      map = new Map();
      state.typing.set(key, map);
    }
    if (map.has(userId)) clearTimeout(map.get(userId).timer);

    if (p.isTyping) {
      const timer = setTimeout(() => {
        map.delete(userId);
        if (key === activeKey()) renderTyping();
      }, 4000);
      map.set(userId, { name: p.name, timer });
    } else {
      map.delete(userId);
    }
    if (key === activeKey()) renderTyping();
  }

  /* ---------- Composer ---------- */

  function autosize() {
    if (!composer) return;
    const box = composer.textarea;
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 160) + 'px';
  }

  function showNote(text) {
    if (!composer) return;
    composer.note.textContent = text;
    composer.note.hidden = false;
  }

  function renderComposer() {
    const t = state.active;
    if (!t) {
      composerSig = null;
      composer = null;
      ui.composerWrap.replaceChildren();
      ui.composerWrap.hidden = true;
      return;
    }

    let verdict = { allowed: true, reason: '' };
    let placeholder = '';
    if (t.kind === 'group') {
      const g = activeGroup();
      if (!g) return;
      verdict = C.postState(state.me, g);
      placeholder = 'Message ' + g.name;
    } else {
      placeholder = 'Message ' + (dmPartner(t.id) ? dmPartner(t.id).name : 'this person');
    }

    // Keep what the person is typing when only unrelated data changed
    const sig = t.key + ':' + (verdict.allowed ? 'open' : verdict.reason);
    if (sig === composerSig) return;
    composerSig = sig;

    ui.composerWrap.hidden = false;

    if (!verdict.allowed) {
      composer = null;
      ui.composerWrap.replaceChildren(el('div', { class: 'locked', role: 'note' }, icon('lock'), el('span', { text: verdict.reason })));
      return;
    }

    const textarea = el('textarea', {
      class: 'input composer-input',
      rows: 1,
      maxlength: state.meta.messageMaxLength,
      placeholder,
      'aria-label': 'Message',
    });
    const send = el('button', { type: 'submit', class: 'btn' }, icon('send'), 'Send');
    const note = el('p', { class: 'composer-note', role: 'alert', hidden: true });
    const form = el(
      'form',
      {
        class: 'composer',
        onsubmit: (event) => {
          event.preventDefault();
          submit();
        },
      },
      textarea,
      send
    );

    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    textarea.addEventListener('input', () => {
      note.hidden = true;
      autosize();
      noteTyping();
    });

    composer = { textarea, send, note };
    ui.composerWrap.replaceChildren(note, form);
  }

  async function submit() {
    const box = composer;
    if (!box || sending) return;
    const text = box.textarea.value.trim();
    const target = state.active;
    if (!text || !target) return;

    sending = true;
    box.send.disabled = true;
    box.note.hidden = true;
    try {
      if (target.kind === 'group') await request(socket, 'group:message', { groupId: target.id, text });
      else await request(socket, 'direct:message', { toUserId: target.id, text });
      box.textarea.value = '';
      if (composer === box) autosize();
      stopTyping();
    } catch (err) {
      box.note.textContent = err.message;
      box.note.hidden = false;
      if (err.code === 'NOT_MEMBER') refreshGroups();
    } finally {
      sending = false;
      box.send.disabled = false;
      if (composer === box) box.textarea.focus();
    }
  }

  /* ---------- Opening conversations ---------- */

  async function openChat(target) {
    stopTyping();
    state.active = target;
    state.unread.delete(target.key);
    history.replaceState(null, '', '#' + target.key);
    closeDrawer();
    panels.onChatChanged();

    renderSidebar();
    renderHeader();
    renderComposer();
    renderTyping();
    updateTitle();

    if (state.messages.has(target.key)) {
      renderMessages();
    } else {
      renderMessages();
      await loadHistory(target);
    }
    if (composer && activeKey() === target.key) composer.textarea.focus();
  }

  function openGroup(id) {
    if (!findGroup(id)) return Promise.resolve();
    return openChat({ key: groupKey(id), kind: 'group', id });
  }

  async function openDm(userId, user) {
    if (user) state.dmUsers.set(userId, user);
    if (!dmPartner(userId)) {
      try {
        const data = await api('/api/users/' + encodeURIComponent(userId));
        state.dmUsers.set(userId, data.user);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
    }
    await openChat({ key: dmKey(userId), kind: 'dm', id: userId });
  }

  function leaveActive() {
    stopTyping();
    state.active = null;
    history.replaceState(null, '', location.pathname);
    panels.onChatChanged();
    renderSidebar();
    renderHeader();
    renderComposer();
    renderTyping();
    renderMessages();
  }

  function firstGroup() {
    for (let i = 0; i < C.TYPE_SECTIONS.length; i += 1) {
      const found = state.groups.find((g) => g.type === C.TYPE_SECTIONS[i][0]);
      if (found) return found;
    }
    return null;
  }

  async function openInitial() {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (hash.indexOf('g:') === 0 && findGroup(hash.slice(2))) return openGroup(hash.slice(2));
    if (hash.indexOf('d:') === 0) return openDm(hash.slice(2));
    const first = firstGroup();
    if (first) return openGroup(first.id);
    renderHeader();
    renderComposer();
    renderMessages();
    return null;
  }

  /* ---------- Loading groups and conversations ---------- */

  async function doRefreshGroups() {
    let reply;
    try {
      reply = await request(socket, 'groups:list');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    state.groups = reply.groups;
    state.online = new Set();
    reply.groups.forEach((g) => (g.onlineMemberIds || []).forEach((id) => state.online.add(id)));

    if (state.active && state.active.kind === 'group' && !findGroup(state.active.id)) {
      state.messages.delete(state.active.key);
      leaveActive();
    } else {
      renderHeader();
      renderComposer();
    }
    renderSidebar();
    if (panels) panels.onGroupsChanged();
  }

  // Several events can arrive together, so refreshes are merged into one follow-up
  function refreshGroups() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = doRefreshGroups().finally(() => {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        refreshGroups();
      }
    });
    return refreshing;
  }

  async function refreshConversations() {
    try {
      const data = await api('/api/users/me/conversations');
      state.conversations = data.conversations;
      data.conversations.forEach((entry) => state.dmUsers.set(entry.partner.id, entry.partner));
      renderDmList();
    } catch (err) {
      /* the list is not critical, so a failure is ignored */
    }
  }

  /* ---------- Live events ---------- */

  function addToCache(key, m) {
    const list = state.messages.get(key);
    if (!list || list.some((x) => x.id === m.id)) return false;
    list.push(m);
    return true;
  }

  function handleIncoming(key, m, added) {
    if (key === activeKey()) {
      if (added) appendLive(m);
      return;
    }
    if (senderIdOf(m) !== state.me.id) {
      state.unread.set(key, (state.unread.get(key) || 0) + 1);
      renderSidebar();
      updateTitle();
    }
  }

  function onGroupMessage(m) {
    const key = groupKey(m.groupId);
    clearTypingFor(key, m.senderId);
    handleIncoming(key, m, addToCache(key, m));
  }

  function onDirectMessage(m) {
    const partnerId = m.fromId === state.me.id ? m.toId : m.fromId;
    const key = dmKey(partnerId);
    clearTypingFor(key, m.fromId);

    const index = state.conversations.findIndex((c) => c.partner.id === partnerId);
    if (index === -1) {
      refreshConversations();
    } else {
      const entry = state.conversations.splice(index, 1)[0];
      entry.lastMessage = m;
      state.conversations.unshift(entry);
      renderDmList();
    }
    handleIncoming(key, m, addToCache(key, m));
  }

  function onPresence(p) {
    if (p.online) state.online.add(p.userId);
    else state.online.delete(p.userId);
    renderDmList();
    if (state.active && state.active.kind === 'dm' && state.active.id === p.userId) renderHeader();
    if (panels) panels.onPresence();
  }

  function onGroupAdded(p) {
    if (p.group && p.group.createdBy !== state.me.id) toast('You were added to ' + p.group.name);
    refreshGroups();
  }

  function onGroupRemoved(p) {
    const group = findGroup(p.groupId);
    state.messages.delete(groupKey(p.groupId));
    state.unread.delete(groupKey(p.groupId));
    if (!state.quiet.delete(p.groupId)) {
      toast('You were removed from ' + (group ? group.name : 'a group'), 'error');
    }
    refreshGroups();
  }

  function onGroupUpdated(p) {
    if (p && typeof p.muted === 'boolean') {
      const group = findGroup(p.groupId);
      const name = group ? group.name : 'a group';
      toast(p.muted ? 'You were muted in ' + name : 'You can post again in ' + name, p.muted ? 'error' : 'success');
    }
    refreshGroups();
  }

  /* ---------- Connection ---------- */

  async function syncAfterConnect() {
    await Promise.all([refreshGroups(), refreshConversations()]);

    if (!booted) {
      booted = true;
      await openInitial();
      return;
    }

    // Messages may have arrived while offline: reload the open chat, drop the other caches
    const key = activeKey();
    Array.from(state.messages.keys()).forEach((k) => {
      if (k !== key) state.messages.delete(k);
    });
    if (state.active) {
      state.messages.delete(key);
      await loadHistory(state.active);
    }
  }

  function connect() {
    setConn('connecting');
    socket = C.connectSocket();

    socket.on('connect', () => {
      setConn('online');
      syncAfterConnect();
    });
    socket.on('disconnect', (reason) => {
      setConn('offline');
      // The server closed the connection (for example the account was deactivated): try once to come back
      if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1000);
    });
    socket.on('connect_error', (err) => {
      const code = err.data && err.data.code;
      if (code === 'INVALID_TOKEN' || code === 'NO_TOKEN' || code === 'ACCOUNT_DISABLED') {
        toast(err.message, 'error');
        setTimeout(() => C.logout(), 1200);
        return;
      }
      setConn('offline');
    });

    socket.on('group:message', onGroupMessage);
    socket.on('direct:message', onDirectMessage);
    socket.on('typing', onTyping);
    socket.on('presence:update', onPresence);
    socket.on('group:added', onGroupAdded);
    socket.on('group:removed', onGroupRemoved);
    socket.on('group:updated', onGroupUpdated);
  }

  /* ---------- Start ---------- */

  async function boot() {
    try {
      const results = await Promise.all([api('/api/auth/me'), api('/api/meta')]);
      state.me = results[0].user;
      state.meta = results[1];
      C.session.save(C.session.token(), state.me);
    } catch (err) {
      if (err.status !== 401) toast(err.message, 'error');
      if (err.status === 403) setTimeout(() => C.logout(), 1500);
      return;
    }

    panels = window.ChatPanels.create({ state, ui, icon, refreshGroups, openGroup, openDm, leaveActive });

    ui.newGroup.append(icon('plus'));
    ui.newDm.append(icon('plus'));
    ui.menu.append(icon('menu'));
    ui.newGroup.addEventListener('click', () => panels.openNewGroup());
    ui.newDm.addEventListener('click', () => panels.openNewDm());
    ui.menu.addEventListener('click', () => ui.app.classList.add('drawer-open'));
    ui.scrim.addEventListener('click', closeDrawer);

    renderMe();
    renderSidebar();
    renderHeader();
    renderMessages();
    connect();
  }

  boot();
})();
