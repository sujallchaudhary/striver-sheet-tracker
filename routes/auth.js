const { Router } = require('express');
const auth = require('../lib/auth');

const router = Router();
router.get('/auth/status', (req, res) => res.json(auth.status()));
router.post('/auth/setup', (req, res) => {
  const result = auth.setup(req.body?.key);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});
router.post('/auth/verify', (req, res) => {
  if (!auth.verify(req.body?.key)) return res.status(401).json({ error: 'Incorrect access key.' });
  res.json({ ok: true });
});
module.exports = router;
