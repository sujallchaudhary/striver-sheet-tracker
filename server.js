// Entry point: express wiring only. Logic lives in lib/, routes in routes/.
const express = require('express');
const path = require('path');
const { runForUser } = require('./lib/store');
const auth = require('./lib/auth');

const app = express();
app.set('trust proxy', true); // honour X-Forwarded-Proto when behind a proxy

// The TUF export is ~330KB, well over the 100KB default.
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

// Auth endpoints and the login page must stay reachable while signed out.
app.use(require('./routes/auth'));

// Unauthenticated visitors get the login page instead of the tracker.
const PUBLIC_FILES = new Set(['/login.html', '/auth.js', '/favicon.ico']);
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !PUBLIC_FILES.has(req.path)) {
    const isPage = req.path === '/' || req.path.endsWith('.html');
    if (isPage && !auth.userFromRequest(req)) return res.redirect('/login.html');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Every /api call below runs inside the signed-in user's data scope, so the
// existing getDb()/saveDb() calls throughout lib/ read and write that user's
// state and nothing else.
app.use('/api', (req, res, next) => {
  const user = auth.userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Sign in to use the tracker.', signedOut: true });
  req.user = user;
  runForUser(user.id, () => next());
});

app.use('/api', require('./routes/dashboard'));
app.use('/api', require('./routes/problems'));
app.use('/api', require('./routes/chat'));
app.use('/api', require('./routes/assignment'));
app.use('/api', require('./routes/playlists'));
app.use('/api', require('./routes/settings'));
app.use('/api', require('./routes/notion'));
app.use('/api', require('./routes/backup'));
app.use('/api', require('./routes/import'));

if (!auth.isConfigured()) {
  console.warn('[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — sign-in will fail.');
}

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => console.log(`DSA tracker running at http://localhost:${PORT}`));
