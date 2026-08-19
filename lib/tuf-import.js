// Imports a CSV exported from takeuforward.org by the browser console snippet
// (see public/import.html) into the signed-in user's progress.
//
// The snippet emits these columns:
//   Step, Subsection, Problem ID, Problem, Completed, Revision, Difficulty,
//   Problem URL, TUF Plus Solve URL, TUF Plus Editorial URL, Article URL,
//   YouTube URL, Practice URL, Other Resources
//
// Only "Problem ID", "Completed" and "Revision" are used — the rest is catalog
// data the tracker already has. Rows are matched on Problem ID, falling back to
// a normalized title match for rows whose checkbox had no id.
const { getDb, saveDb, todayStr } = require('./store');
const { parseCsvRecords } = require('./catalog');

const isYes = (value) => String(value || '').trim().toLowerCase() === 'yes';
const normalizeTitle = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function looksLikeTufExport(records) {
  if (!records.length) return false;
  const columns = Object.keys(records[0]);
  return columns.includes('Completed') && (columns.includes('Problem ID') || columns.includes('Problem'));
}

// mode 'merge'   — only ever adds progress; rows marked No are left alone.
// mode 'replace' — the CSV becomes the source of truth, so a row marked No
//                  resets that problem to pending.
function importTufCsv(text, { mode = 'merge' } = {}) {
  const records = parseCsvRecords(text);
  if (!looksLikeTufExport(records)) {
    return { error: 'That does not look like a TUF export — expected a CSV with "Problem ID" and "Completed" columns.' };
  }

  const db = getDb();
  const today = todayStr();
  const byId = new Map(db.problems.map((p) => [String(p.id), p]));
  const byTitle = new Map(db.problems.map((p) => [normalizeTitle(p.title), p]));

  let matched = 0, newlyCompleted = 0, reopened = 0, flagged = 0, unflagged = 0, unknown = 0;

  for (const row of records) {
    const p = byId.get(String(row['Problem ID'] || '').trim())
      || byTitle.get(normalizeTitle(row['Problem']));
    if (!p) { unknown++; continue; }
    matched++;

    const completed = isYes(row['Completed']);
    const revision = isYes(row['Revision']);

    if (completed && !p.everCompleted) {
      // Preserve any richer local history: only fill in what is missing.
      p.status = 'completed';
      p.everCompleted = true;
      p.completionCount = Math.max(1, p.completionCount || 0);
      p.statusUpdatedAt = p.statusUpdatedAt || today;
      newlyCompleted++;
    } else if (!completed && mode === 'replace' && p.everCompleted) {
      p.status = 'pending';
      p.everCompleted = false;
      p.completionCount = 0;
      p.statusUpdatedAt = null;
      reopened++;
    }

    if (revision && !p.revision) {
      p.revision = true;
      p.revisionFlaggedAt = p.revisionFlaggedAt || today;
      flagged++;
    } else if (!revision && p.revision && mode === 'replace') {
      p.revision = false;
      p.revisionFlaggedAt = null;
      unflagged++;
    }
  }

  saveDb();
  return { ok: true, rows: records.length, matched, newlyCompleted, reopened, flagged, unflagged, unknown, mode };
}

module.exports = { importTufCsv, looksLikeTufExport };
