// Browser session glue. Authentication itself is a Google OAuth round-trip
// handled by the server; the browser only holds an opaque httpOnly cookie it
// cannot read, so this file just (a) bounces signed-out visitors to the login
// page, (b) renders the account chip, and (c) catches sessions that expire
// while a tab is open.
(() => {
  const nativeFetch = window.fetch.bind(window);

  // Any API call that comes back "signed out" means the cookie expired or was
  // revoked — send the user back to the login page rather than showing errors.
  window.fetch = async (input, init = {}) => {
    const response = await nativeFetch(input, { credentials: 'same-origin', ...init });
    const url = typeof input === 'string' ? input : input.url;
    if (response.status === 401 && url.includes('/api/') && !location.pathname.startsWith('/login')) {
      location.href = '/login.html?error=expired';
    }
    return response;
  };

  const chipStyles = `
    .account-chip{display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.035);border-radius:10px;padding:5px 6px 5px 5px;font-size:12px;font-weight:650}
    .account-chip img{width:24px;height:24px;border-radius:50%;object-fit:cover}
    .account-chip .who{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .account-chip button{border:0;background:transparent;color:#9898a6;cursor:pointer;font:inherit;font-size:11px;padding:2px 4px;border-radius:6px}
    .account-chip button:hover{color:#ff9aaa}
    @media(max-width:720px){.account-chip .who{display:none}}
  `;

  function renderChip(user) {
    const host = document.querySelector('.top-actions') || document.querySelector('.top');
    if (!host) return;
    const style = document.createElement('style');
    style.textContent = chipStyles;
    document.head.append(style);

    const chip = document.createElement('div');
    chip.className = 'account-chip';
    const avatar = user.picture
      ? `<img src="${user.picture}" alt="" referrerpolicy="no-referrer">`
      : '';
    chip.innerHTML = `${avatar}<span class="who"></span><button type="button" title="Sign out">Sign out</button>`;
    chip.querySelector('.who').textContent = user.name || user.email;
    chip.querySelector('button').onclick = async () => {
      await nativeFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      location.href = '/login.html';
    };
    host.append(chip);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const { user } = await (await nativeFetch('/api/auth/me', { credentials: 'same-origin' })).json();
      if (!user) return void (location.href = '/login.html');
      renderChip(user);
    } catch {
      // Network hiccup — leave the page alone rather than bouncing the user out.
    }
  });
})();
