const { Router } = require('express');
const { getDb, saveDb, todayStr } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');

const router = Router();

router.post('/settings', (req, res) => {
  const b = req.body || {};
  const db = getDb();
  const s = db.settings;
  const steps = [...new Set(db.problems.map((p) => p.step))];
  const validTopics = (arr) => (Array.isArray(arr) ? arr.filter((t) => steps.includes(t)) : []);

  if (b.dailyCount != null) s.dailyCount = Math.min(8, Math.max(3, parseInt(b.dailyCount, 10) || 5));
  if ('currentTopic' in b) s.currentTopic = steps.includes(b.currentTopic) ? b.currentTopic : null;
  if ('preferredTopics' in b) s.preferredTopics = validTopics(b.preferredTopics);
  if ('revisionTopics' in b) s.revisionTopics = validTopics(b.revisionTopics);
  if ('provider' in b && ['auto', 'anthropic', 'gemini', 'none'].includes(b.provider)) s.provider = b.provider;
  if ('apiKey' in b && b.apiKey !== '••••') s.apiKey = String(b.apiKey || '');
  if ('model' in b) s.model = String(b.model || '').trim();
  if ('notionToken' in b && b.notionToken !== '••••') s.notionToken = String(b.notionToken || '').trim();
  if ('notionParentPageId' in b) {
    const next = String(b.notionParentPageId || '').trim();
    // Changing the parent page means a new database should be created there.
    if (next !== s.notionParentPageId) s.notionDatabaseId = '';
    s.notionParentPageId = next;
  }

  // Regenerate today's assignment so the new preferences apply immediately.
  // Statuses live on problems, so completed work is preserved.
  delete db.assignments[todayStr()];
  saveDb();
  res.json({ ok: true, dashboard: buildDashboard() });
});

module.exports = router;
