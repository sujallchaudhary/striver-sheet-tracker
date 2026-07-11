const { Router } = require('express');
const { todayStr } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');
const { addProblemToDay } = require('../lib/assignment');
const notion = require('../lib/notion');

const router = Router();

router.post('/assignment/add', (req, res) => {
  const result = addProblemToDay(todayStr(), req.body && req.body.problemId);
  if (result.error) return res.status(400).json({ error: result.error });
  console.log(`[assignment] added "${result.added.title}" (${result.added.id}) as ${result.added.type}`);
  notion.scheduleAutoSync();
  res.json({ ok: true, added: result.added, dashboard: buildDashboard() });
});

module.exports = router;
