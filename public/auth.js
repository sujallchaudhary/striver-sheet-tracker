// Lightweight browser gate. The server receives the stored key on every API
// request and verifies it against a hash, so the localStorage value itself is
// never persisted on the server.
(() => {
  const STORAGE_KEY = 'dsaTrackerAccessKey';
  const nativeFetch = window.fetch.bind(window);
  const getKey = () => localStorage.getItem(STORAGE_KEY) || '';

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/api/') || url.includes('/api/auth/')) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    if (getKey()) headers.set('X-Access-Key', getKey());
    return nativeFetch(input, { ...init, headers });
  };

  const request = async (path, body) => {
    const response = await nativeFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  const showGate = (configured) => {
    const gate = document.createElement('div');
    gate.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;background:#020203;color:#f7f7fa;font:14px/1.5 system-ui,sans-serif';
    gate.innerHTML = `<form style="width:min(390px,100%);padding:28px;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:#101015"><div style="font-size:11px;color:#b2a9ff;letter-spacing:.12em;text-transform:uppercase">DSA Studio</div><h1 style="margin:8px 0;font-size:24px">${configured ? 'Unlock your tracker' : 'Protect your tracker'}</h1><p style="color:#b0b0bd;margin:0 0 18px">${configured ? 'Enter the access key stored for this browser.' : 'Create an access key. It will be saved in this browser and required before the tracker APIs respond.'}</p><input type="password" minlength="8" required autofocus placeholder="Access key (8+ characters)" style="width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid rgba(255,255,255,.15);background:#191920;color:#fff"><button style="width:100%;margin-top:10px;padding:11px;border:0;border-radius:9px;background:#8b7cff;color:#fff;font-weight:700;cursor:pointer">${configured ? 'Unlock' : 'Create key & unlock'}</button><div aria-live="polite" style="min-height:20px;margin-top:10px;color:#ff9aaa"></div></form>`;
    const form = gate.querySelector('form'), input = gate.querySelector('input'), result = gate.querySelector('[aria-live]');
    form.onsubmit = async (event) => { event.preventDefault(); try { const key = input.value; await request(configured ? '/api/auth/verify' : '/api/auth/setup', { key }); localStorage.setItem(STORAGE_KEY, key); location.reload(); } catch (error) { result.textContent = error.message; } };
    document.body.append(gate);
  };

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const status = await (await nativeFetch('/api/auth/status')).json();
      if (!status.configured) return showGate(false);
      if (!getKey()) return showGate(true);
      try { await request('/api/auth/verify', { key: getKey() }); }
      catch { localStorage.removeItem(STORAGE_KEY); showGate(true); }
      document.querySelectorAll('a[href="/api/export"]').forEach((link) => { link.href = `/api/export?key=${encodeURIComponent(getKey())}`; });
    } catch { showGate(true); }
  });
})();
