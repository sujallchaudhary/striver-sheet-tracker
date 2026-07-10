// Assembles the payload the frontend renders: today's items, stats, topics, history.
const { getDb, todayStr, isDone, DONE_STATUSES } = require('./store');
const { getOrCreateAssignment } = require('./assignment');
const { llmConfig } = require('./chat');

function buildDashboard() {
  const db = getDb();
  const date = todayStr();
  const assignment = getOrCreateAssignment(date);
  const byId = Object.fromEntries(db.problems.map((p) => [p.id, p]));

  const items = assignment.items.map((it, i) => {
    const p = byId[it.problemId];
    return {
      slot: i + 1, type: it.type, id: p.id, title: p.title, step: p.step,
      subsection: p.subsection, difficulty: p.difficulty, url: p.url,
      practiceUrl: p.practiceUrl, youtubeUrl: p.youtubeUrl, status: p.status,
    };
  });

  const total = db.problems.length;
  const done = db.problems.filter(isDone).length;

  // Streak: consecutive days with at least one problem finished, ending today or yesterday.
  let streak = 0;
  const d = new Date();
  if (!db.activity[todayStr()]) d.setDate(d.getDate() - 1);
  for (;;) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!db.activity[key]) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }

  const firstPending = db.problems.filter((p) => !isDone(p)).sort((a, b) => a.order - b.order)[0];

  const topics = [];
  for (const p of db.problems) {
    let t = topics.find((x) => x.step === p.step);
    if (!t) { t = { step: p.step, total: 0, done: 0 }; topics.push(t); }
    t.total++;
    if (isDone(p)) t.done++;
  }

  const history = Object.values(db.assignments)
    .filter((a) => a.date !== date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7)
    .map((a) => ({
      date: a.date,
      items: a.items.map((it) => ({
        id: it.problemId, title: byId[it.problemId].title,
        type: it.type, status: byId[it.problemId].status,
      })),
    }));

  const s = db.settings;
  return {
    date, items,
    stats: {
      total, done, percent: Math.round((done / total) * 100), streak,
      todayDone: items.filter((it) => DONE_STATUSES.includes(it.status)).length,
      todayTotal: items.length,
      currentTopic: s.currentTopic || (firstPending ? firstPending.step : 'All done 🎉'),
      currentSubsection: s.currentTopic ? '' : firstPending ? firstPending.subsection : '',
    },
    topics, history,
    settings: {
      ...s,
      apiKey: s.apiKey ? '••••' : '',
      notionToken: s.notionToken ? '••••' : '',
    },
    chatMode: llmConfig().mode,
    notionConnected: Boolean(s.notionToken && (s.notionDatabaseId || s.notionParentPageId)),
  };
}

module.exports = { buildDashboard };
