const { Router } = require('express');
const { getDb, saveDb, todayStr } = require('../lib/store');
const { buildDashboard } = require('../lib/dashboard');

const router = Router();

router.get('/export', (req, res) => {
  const db = getDb();
  const { apiKey, notionToken, ...safeSettings } = db.settings; // never export secrets
  const payload = {
    app: 'dsa-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    problems: db.problems.map((p) => ({
      id: p.id, status: p.status, revision: p.revision, revisionFlaggedAt: p.revisionFlaggedAt,
      statusUpdatedAt: p.statusUpdatedAt,
      completionCount: p.completionCount, everCompleted: p.everCompleted,
      timesAssigned: p.timesAssigned, lastAssignedDate: p.lastAssignedDate,
    })),
    assignments: db.assignments,
    activity: db.activity,
    settings: safeSettings,
  };
  res.setHeader('Content-Disposition', `attachment; filename="dsa-progress-${todayStr()}.json"`);
  res.json(payload);
});

router.post('/import', (req, res) => {
  const b = req.body || {};
  if (b.app !== 'dsa-tracker' || !Array.isArray(b.problems)) {
    return res.status(400).json({ error: 'not a valid dsa-tracker export file' });
  }
  const db = getDb();
  const byId = Object.fromEntries(db.problems.map((p) => [p.id, p]));
  let restored = 0;
  for (const imp of b.problems) {
    const p = byId[String(imp.id)];
    if (!p) continue;
    p.status = ['pending', 'attempted', 'completed', 'solved_with_help', 'revision_needed'].includes(imp.status) ? imp.status : p.status;
    p.revision = typeof imp.revision === 'boolean' ? imp.revision : p.revision;
    p.revisionFlaggedAt = imp.revisionFlaggedAt ?? p.revisionFlaggedAt;
    p.statusUpdatedAt = imp.statusUpdatedAt ?? p.statusUpdatedAt;
    p.completionCount = imp.completionCount ?? p.completionCount;
    p.everCompleted = imp.everCompleted ?? p.everCompleted;
    p.timesAssigned = imp.timesAssigned ?? p.timesAssigned;
    p.lastAssignedDate = imp.lastAssignedDate ?? p.lastAssignedDate;
    // Normalize old-format exports where revision was a status value.
    if (p.status === 'revision_needed') {
      p.revision = true;
      p.status = p.everCompleted ? 'completed' : 'pending';
    }
    restored++;
  }
  if (b.assignments && typeof b.assignments === 'object') db.assignments = b.assignments;
  if (b.activity && typeof b.activity === 'object') db.activity = b.activity;
  if (b.settings && typeof b.settings === 'object') {
    // Keep local secrets; take everything else from the import.
    const { apiKey, notionToken, ...incoming } = b.settings;
    db.settings = { ...db.settings, ...incoming };
  }
  saveDb();
  console.log(`[import] restored progress for ${restored} problems`);
  res.json({ ok: true, restored, dashboard: buildDashboard() });
});

module.exports = router;
