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

  // Snapshot the fields that influence daily assignment generation so we only
  // regenerate today's list when one of them actually changes. Unrelated saves
  // (API key, model, provider, Notion) must not reshuffle today's questions.
  const assignmentKeyBefore = JSON.stringify({
    dailyCount: s.dailyCount,
    currentTopic: s.currentTopic,
    preferredTopics: s.preferredTopics,
    revisionTopics: s.revisionTopics,
  });

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

  // Only regenerate today's assignment when an assignment-affecting preference
  // changed. Statuses live on problems, so completed work is always preserved.
  const assignmentKeyAfter = JSON.stringify({
    dailyCount: s.dailyCount,
    currentTopic: s.currentTopic,
    preferredTopics: s.preferredTopics,
    revisionTopics: s.revisionTopics,
  });
  const regenerated = assignmentKeyAfter !== assignmentKeyBefore;
  if (regenerated) delete db.assignments[todayStr()];

  saveDb();
  res.json({ ok: true, regenerated, dashboard: buildDashboard() });
});

module.exports = router;
