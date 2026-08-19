const { Router } = require('express');
const { importTufCsv } = require('../lib/tuf-import');
const { buildDashboard } = require('../lib/dashboard');

const router = Router();

// Accepts the CSV either as a raw text/csv body or as JSON {csv, mode}.
router.post('/import/tuf', (req, res) => {
  const body = req.body;
  const csv = typeof body === 'string' ? body : body?.csv;
  const mode = (typeof body === 'object' && body?.mode === 'replace') ? 'replace' : 'merge';

  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'No CSV received — upload the file the console snippet downloaded.' });
  }

  const result = importTufCsv(csv, { mode });
  if (result.error) return res.status(400).json(result);

  console.log(`[tuf-import] ${result.matched}/${result.rows} matched, ${result.newlyCompleted} newly completed (${mode})`);
  res.json({ ...result, dashboard: buildDashboard() });
});

module.exports = router;
