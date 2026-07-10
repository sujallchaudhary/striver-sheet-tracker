// Notion sync: mirrors assignments into a Notion database (one row per problem per day).
// First sync creates a "DSA Tracker" database under the configured parent page;
// after that, rows are upserted by (Date, Problem ID) so status changes update in place.
const { getDb, saveDb, STATUS_LABEL, todayStr } = require('./store');

const NOTION_VERSION = '2022-06-28';

// Accepts a raw ID, a dashed UUID, or a full Notion page URL.
function extractId(input) {
  const m = String(input || '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
  return m ? m[0] : null;
}

async function notionFetch(pathname, method, body) {
  const token = getDb().settings.notionToken;
  if (!token) throw new Error('Notion token not set — add it in Settings');
  const r = await fetch('https://api.notion.com/v1' + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Notion API ${r.status}: ${detail.slice(0, 300)}`);
  }
  return r.json();
}

async function ensureDatabase() {
  const s = getDb().settings;
  if (s.notionDatabaseId) return s.notionDatabaseId;

  const parentId = extractId(s.notionParentPageId);
  if (!parentId) throw new Error('Notion parent page not set — paste the page URL or ID in Settings');

  const statusOptions = Object.values(STATUS_LABEL).map((name) => ({ name }));
  const created = await notionFetch('/databases', 'POST', {
    parent: { type: 'page_id', page_id: parentId },
    title: [{ type: 'text', text: { content: 'DSA Tracker' } }],
    properties: {
      Problem: { title: {} },
      Date: { date: {} },
      Slot: { number: {} },
      Status: { select: { options: statusOptions } },
      Type: { select: { options: [{ name: 'new' }, { name: 'retry' }, { name: 'revision' }] } },
      Topic: { select: {} },
      Difficulty: { select: {} },
      Link: { url: {} },
      'Problem ID': { rich_text: {} },
    },
  });
  s.notionDatabaseId = created.id;
  saveDb();
  return created.id;
}

function pageProperties(p, item, date, slot) {
  return {
    Problem: { title: [{ text: { content: p.title || 'Untitled' } }] },
    Date: { date: { start: date } },
    Slot: { number: slot },
    Status: { select: { name: p.revision ? 'Revision needed' : STATUS_LABEL[p.status] || 'Pending' } },
    Type: { select: { name: item.type } },
    // Select option names can't contain commas.
    Topic: { select: { name: (p.step || 'Misc').replace(/,/g, ' /').slice(0, 100) } },
    Difficulty: { select: { name: p.difficulty || 'Easy' } },
    Link: { url: p.url || null },
    'Problem ID': { rich_text: [{ text: { content: p.id } }] },
  };
}

async function syncDay(date) {
  const db = getDb();
  const assignment = db.assignments[date];
  if (!assignment) return 0;

  const databaseId = await ensureDatabase();
  const byId = Object.fromEntries(db.problems.map((p) => [p.id, p]));
  let synced = 0;

  for (const [i, item] of assignment.items.entries()) {
    const p = byId[item.problemId];
    if (!p) continue;
    const existing = await notionFetch(`/databases/${databaseId}/query`, 'POST', {
      filter: {
        and: [
          { property: 'Date', date: { equals: date } },
          { property: 'Problem ID', rich_text: { equals: p.id } },
        ],
      },
    });
    const properties = pageProperties(p, item, date, i + 1);
    if (existing.results.length) {
      await notionFetch(`/pages/${existing.results[0].id}`, 'PATCH', { properties });
    } else {
      await notionFetch('/pages', 'POST', { parent: { database_id: databaseId }, properties });
    }
    synced++;
  }
  return synced;
}

// scope: 'today' | 'all' (all = every assignment day on record, newest first)
async function sync(scope) {
  const db = getDb();
  const dates = scope === 'all'
    ? Object.keys(db.assignments).sort().reverse()
    : [todayStr()];
  let total = 0;
  for (const date of dates) total += await syncDay(date);
  return { synced: total, days: dates.length, databaseId: db.settings.notionDatabaseId };
}

function notionConfigured() {
  const s = getDb().settings;
  return Boolean(s.notionToken && (s.notionDatabaseId || extractId(s.notionParentPageId)));
}

// Debounced background sync of today's rows — called after status updates.
let syncTimer = null;
function scheduleAutoSync() {
  if (!notionConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncDay(todayStr()).catch((err) => console.error('Notion auto-sync failed:', err.message));
  }, 3000);
}

module.exports = { sync, scheduleAutoSync, notionConfigured };
