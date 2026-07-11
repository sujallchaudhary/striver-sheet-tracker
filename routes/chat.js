const { Router } = require('express');
const { todayStr } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');
const { parseChat } = require('../lib/chat');
const notion = require('../lib/notion');

const router = Router();

router.post('/chat', async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty message' });
  console.log(`[chat] received: "${message}"`);
  try {
    const { updates, adds, removes, reply, mode } = await parseChat(message, todayStr());
    const total = updates.length + (adds||[]).length + (removes||[]).length;
    console.log(`[chat] parser=${mode}, actions=${total}${total ? ': updates=' + updates.length + ' adds=' + (adds||[]).length + ' removes=' + (removes||[]).length : ''}`);
    if (total) notion.scheduleAutoSync();
    res.json({ updates, adds: adds||[], removes: removes||[], reply, mode, dashboard: buildDashboard() });
  } catch (err) {
    console.error('[chat] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
