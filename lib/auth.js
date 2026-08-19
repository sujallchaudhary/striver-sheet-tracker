// Google OAuth sign-in with database-backed sessions.
//
// The old single-user access-key gate is gone: each visitor signs in with
// Google and gets their own tracker state. Sessions live in SQLite so they
// survive restarts, and the browser only ever holds an opaque httpOnly cookie.
const crypto = require('crypto');
const { db: sqlite } = require('./db');

const SESSION_COOKIE = 'dsa_sid';
const STATE_COOKIE = 'dsa_oauth_state';
const SESSION_DAYS = 30;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const isConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

// ---------- cookies ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, secure }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

const clearCookie = (res, name) => res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

// Behind a reverse proxy the protocol arrives in X-Forwarded-Proto.
const isHttps = (req) => (req.get('x-forwarded-proto') || req.protocol) === 'https';
const baseUrl = (req) => process.env.APP_URL?.replace(/\/$/, '') || `${isHttps(req) ? 'https' : 'http'}://${req.get('host')}`;
const redirectUri = (req) => `${baseUrl(req)}/auth/google/callback`;

// ---------- users & sessions ----------

const stmt = {
  userBySub: sqlite.prepare('SELECT * FROM users WHERE google_sub = ?'),
  userByPendingEmail: sqlite.prepare('SELECT * FROM users WHERE google_sub = ?'),
  claimSub: sqlite.prepare('UPDATE users SET google_sub = ? WHERE id = ?'),
  userById: sqlite.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: sqlite.prepare(`
    INSERT INTO users (id, google_sub, email, name, picture, created_at, last_seen_at)
    VALUES (@id, @google_sub, @email, @name, @picture, @now, @now)
  `),
  touchUser: sqlite.prepare('UPDATE users SET email = ?, name = ?, picture = ?, last_seen_at = ? WHERE id = ?'),
  insertSession: sqlite.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionById: sqlite.prepare('SELECT * FROM sessions WHERE id = ?'),
  deleteSession: sqlite.prepare('DELETE FROM sessions WHERE id = ?'),
  purgeExpired: sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

// Creates the account on first sign-in, refreshes the profile after that.
//
// An account pre-created by scripts/import-legacy-db.js carries a placeholder
// google_sub; the first real sign-in with that email claims it, so migrated
// progress lands in the right account instead of a duplicate.
function upsertUser(profile) {
  const now = new Date().toISOString();
  // Google omits name/picture for some accounts; the columns are NOT NULL.
  const email = String(profile.email);
  const name = profile.name || '';
  const picture = profile.picture || '';

  const existing = stmt.userBySub.get(profile.sub) || stmt.userByPendingEmail.get(`pending:${email}`);
  if (existing) {
    stmt.claimSub.run(profile.sub, existing.id);
    stmt.touchUser.run(email, name, picture, now, existing.id);
    return stmt.userById.get(existing.id);
  }
  const id = crypto.randomUUID();
  stmt.insertUser.run({ id, google_sub: profile.sub, email, name, picture, now });
  return stmt.userById.get(id);
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  stmt.purgeExpired.run(now.toISOString());
  stmt.insertSession.run(id, userId, now.toISOString(), expires.toISOString());
  return { id, maxAge: SESSION_DAYS * 86400 };
}

function userFromRequest(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = stmt.sessionById.get(sid);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    stmt.deleteSession.run(sid);
    return null;
  }
  return stmt.userById.get(session.user_id) || null;
}

// ---------- OAuth flow ----------

function startLogin(req, res) {
  if (!isConfigured()) {
    return res.status(500).send('Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  const state = crypto.randomBytes(16).toString('base64url');
  setCookie(res, STATE_COOKIE, state, { maxAge: 600, secure: isHttps(req) });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// The id_token comes straight from Google's token endpoint over TLS in
// response to our authenticated request, so per the OpenID Connect spec the
// signature does not need re-verification here — decoding the payload is enough.
function decodeIdToken(idToken) {
  const payload = idToken.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function completeLogin(req, res) {
  const cookies = parseCookies(req);
  clearCookie(res, STATE_COOKIE);

  if (req.query.error) return res.redirect('/login.html?error=denied');
  const { code, state } = req.query;
  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    return res.redirect('/login.html?error=state');
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(code),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResponse.ok) {
    console.error('[auth] token exchange failed:', await tokenResponse.text());
    return res.redirect('/login.html?error=token');
  }

  const { id_token: idToken } = await tokenResponse.json();
  const claims = decodeIdToken(idToken);
  if (!claims.email_verified) return res.redirect('/login.html?error=unverified');

  const user = upsertUser({
    sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture,
  });
  const session = createSession(user.id);
  setCookie(res, SESSION_COOKIE, session.id, { maxAge: session.maxAge, secure: isHttps(req) });
  res.redirect('/');
}

function logout(req, res) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) stmt.deleteSession.run(sid);
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
}

const publicUser = (user) => user && ({ id: user.id, email: user.email, name: user.name, picture: user.picture });

module.exports = {
  SESSION_COOKIE, isConfigured, userFromRequest, publicUser,
  startLogin, completeLogin, logout, upsertUser,
};
