const { Router } = require('express');
const { getDb, saveDb } = require('../lib/store');
const notion = require('../lib/notion');

const router = Router();

router.post('/notion/sync', async (req, res) => {
  try {
    const b = req.body || {};
    // Persist credentials sent with the sync so "type token → click Sync" works without saving first.
    const s = getDb().settings;
    if (b.notionToken && b.notionToken !== '••••') s.notionToken = String(b.notionToken).trim();
    if (b.notionParentPageId && String(b.notionParentPageId).trim() !== s.notionParentPageId) {
      s.notionParentPageId = String(b.notionParentPageId).trim();
      s.notionDatabaseId = '';
    }
    saveDb();
    const result = await notion.sync(b.scope === 'all' ? 'all' : 'today');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
