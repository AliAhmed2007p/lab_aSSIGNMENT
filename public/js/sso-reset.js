'use strict';

/* Password reset page: consumes the single-use token from the reset link. */
(function () {
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('token') || '';
  const errorBox = $('form-error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

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
      throw new Error(info.message || 'Request failed (' + response.status + ').');
    }
    return data;
  }

  if (!token) {
    showError('This page needs the token from the reset link.');
  }

  $('reset-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('password').value;
    const repeated = $('password2').value;

    if (password !== repeated) {
      showError('Both passwords must be the same.');
      return;
    }

    const button = $('reset-button');
    button.disabled = true;
    try {
      await call('/sso/api/password/reset', { token, password });
      $('reset-form').hidden = true;
      $('done').hidden = false;
    } catch (err) {
      showError(err.message);
      button.disabled = false;
    }
  });
})();
