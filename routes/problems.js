const { Router } = require('express');
const { getDb, saveDb, todayStr, setStatus, setRevision, DONE_STATUSES } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');
const notion = require('../lib/notion');

const router = Router();

router.post('/problems/:id/status', (req, res) => {
  const p = setStatus(req.params.id, req.body.status, todayStr());
  if (!p) return res.status(400).json({ error: 'unknown problem or invalid status' });
  console.log(`[status] "${p.title}" (${p.id}) -> ${p.status}${p.revision ? ' +revision' : ''} (completed ${p.completionCount}x)`);
  saveDb();
  notion.scheduleAutoSync();
  res.json({ ok: true, dashboard: buildDashboard() });
});

// Toggle the revision flag. Flagging ON marks the problem completed if it wasn't.
router.post('/problems/:id/revision', (req, res) => {
  const p = setRevision(req.params.id, Boolean(req.body.revision), todayStr());
  if (!p) return res.status(400).json({ error: 'unknown problem' });
  console.log(`[revision] "${p.title}" (${p.id}) -> ${p.revision ? 'flagged' : 'unflagged'} (status ${p.status})`);
  saveDb();
  notion.scheduleAutoSync();
  res.json({ ok: true, dashboard: buildDashboard() });
});

// Lightweight list for the add-problem search box.
router.get('/problems', (req, res) => {
  res.json(getDb().problems.map((p) => ({
    id: p.id, title: p.title, step: p.step, status: p.status,
    revision: p.revision, everCompleted: p.everCompleted, completionCount: p.completionCount,
  })));
});

// Full sheet — all problem fields + per-step progress totals.
router.get('/sheet', (req, res) => {
  const db = getDb();
  const DONE = ['completed', 'solved_with_help'];
  const steps = [];
  const stepMap = {};
  for (const p of db.problems) {
    if (!stepMap[p.step]) { stepMap[p.step] = { step: p.step, total: 0, done: 0 }; steps.push(stepMap[p.step]); }
    stepMap[p.step].total++;
    if (DONE.includes(p.status)) stepMap[p.step].done++;
  }
  res.json({ problems: db.problems, steps });
});

module.exports = router;
