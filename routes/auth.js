const { Router } = require('express');
const auth = require('../lib/auth');

const router = Router();

// Session/profile probe used by the browser gate. Always 200 so the front-end
// can tell "not signed in" apart from a server error.
router.get('/api/auth/me', (req, res) => {
  const user = auth.userFromRequest(req);
  res.json({ configured: auth.isConfigured(), user: auth.publicUser(user) || null });
});

router.get('/auth/google', auth.startLogin);
router.get('/auth/google/callback', (req, res) => {
  auth.completeLogin(req, res).catch((err) => {
    console.error('[auth] callback failed:', err);
    res.redirect('/login.html?error=server');
  });
});
router.post('/api/auth/logout', auth.logout);

module.exports = router;
