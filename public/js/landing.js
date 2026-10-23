'use strict';

/* Landing page: lists the demo accounts so the two sample applications can be
   tried quickly. The list comes from the public API, not from hard-coded
   markup, so it stays in step with the seeded data. */
(function () {
  const { api, el, toast } = window.Connect;
  const tbody = document.getElementById('account-rows');

  async function load() {
    try {
      const health = await api('/api/health', { skipAuthRedirect: true });
      if (!health || health.status !== 'ok') throw new Error('unhealthy');

      const row = (loginId, name, role, organization) =>
        el('tr', null,
          el('td', { text: organization }),
          el('td', null, el('code', { text: loginId })),
          el('td', null, el('span', { class: 'badge badge-' + (role === 'admin' ? 'admin' : role), text: role })),
          el('td', { text: name })
        );

      tbody.replaceChildren(
        row('admin.it', 'IT Administrator', 'admin', 'COMSATS Islamabad'),
        row('exam.cell', 'Exam Cell Office', 'tenant_admin', 'COMSATS Islamabad'),
        row('dr.ahmed', 'Dr. Ahmed Raza', 'faculty', 'COMSATS Islamabad'),
        row('FA23-BCS-050', 'Muaaz Tasawar', 'student', 'COMSATS Islamabad'),
        row('FA22-BEE-031', 'Fatima Noor', 'student', 'COMSATS Islamabad'),
        row('admin.lhr', 'Lahore IT Office', 'tenant_admin', 'COMSATS Lahore'),
        row('FA23-BCS-101', 'Ali Hassan', 'student', 'COMSATS Lahore')
      );

      const chat = document.getElementById('chat-direct');
      if (chat) chat.title = 'Opens the chat; it will send you to the sign-in page if needed.';
    } catch (err) {
      tbody.replaceChildren(el('tr', null, el('td', { colspan: '4', text: 'Cannot reach the server.' })));
      toast('Cannot reach the server. Is it running?', 'error');
    }
  }

  load();
})();
