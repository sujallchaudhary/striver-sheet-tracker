const { Router } = require('express');
const { todayStr } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');
const { parseChat } = require('../lib/chat');
const notion = require('../lib/notion');

const router = Router();
const MAX_MESSAGE_LENGTH = 6000;
const MAX_HISTORY_ITEMS = 8;
const MAX_HISTORY_ENTRY_LENGTH = 1200;

router.post('/chat', async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'empty message' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
  }

  const problemId = body.problemId == null || body.problemId === '' ? null : String(body.problemId);
  const hintLevel = Math.min(4, Math.max(1, Number.parseInt(body.hintLevel, 10) || 1));
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-MAX_HISTORY_ITEMS)
    .filter((entry) => entry && ['user', 'assistant'].includes(entry.role))
    .map((entry) => ({
      role: entry.role,
      content: String(entry.content || '').slice(0, MAX_HISTORY_ENTRY_LENGTH),
    }))
    .filter((entry) => entry.content.trim());

  try {
    const result = await parseChat(message, todayStr(), { problemId, hintLevel, history });
    const { updates, adds = [], removes = [], reply, mode, problem, hintLevel: usedLevel } = result;
    const total = updates.length + adds.length + removes.length;
    console.log(`[chat] parser=${mode}, actions=${total}, coach=${problem ? problem.id : 'none'}, level=${usedLevel}`);
    if (total) notion.scheduleAutoSync();
    res.json({
      updates, adds, removes, reply, mode,
      problem, hintLevel: usedLevel,
      dashboard: buildDashboard(),
    });
  } catch (err) {
    console.error('[chat] failed:', err.message);
    const status = err.message === 'unknown coaching problem' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
