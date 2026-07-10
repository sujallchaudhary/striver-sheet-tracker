// Entry point: express wiring only. Logic lives in lib/.
const express = require('express');
const path = require('path');

const { getDb, loadDb, saveDb, todayStr, setStatus } = require('./lib/store');
const { buildDashboard } = require('./lib/dashboard');
const { addProblemToDay } = require('./lib/assignment');
const { parseChat } = require('./lib/chat');
const notion = require('./lib/notion');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard', (req, res) => res.json(buildDashboard()));

app.post('/api/problems/:id/status', (req, res) => {
  const p = setStatus(req.params.id, req.body.status, todayStr());
  if (!p) return res.status(400).json({ error: 'unknown problem or invalid status' });
  console.log(`[status] "${p.title}" (${p.id}) -> ${p.status}`);
  saveDb();
  notion.scheduleAutoSync();
  res.json({ ok: true, dashboard: buildDashboard() });
});

app.post('/api/chat', async (req, res) => {
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

// Lightweight list for the add-problem search box.
app.get('/api/problems', (req, res) => {
  res.json(getDb().problems.map((p) => ({ id: p.id, title: p.title, step: p.step, status: p.status })));
});


// Full sheet — all problem fields + per-step progress totals.
app.get('/api/sheet', (req, res) => {
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
app.post('/api/assignment/add', (req, res) => {
  const result = addProblemToDay(todayStr(), req.body && req.body.problemId);
  if (result.error) return res.status(400).json({ error: result.error });
  console.log(`[assignment] added "${result.added.title}" (${result.added.id}) as ${result.added.type}`);
  notion.scheduleAutoSync();
  res.json({ ok: true, added: result.added, dashboard: buildDashboard() });
});

app.post('/api/settings', (req, res) => {
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

app.post('/api/notion/sync', async (req, res) => {
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

loadDb();
const PORT = process.env.PORT || 3210;
app.listen(PORT, () => console.log(`DSA tracker running at http://localhost:${PORT}`));
