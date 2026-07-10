// Daily assignment generation.
//
// Instead of one strict priority order (which lets the current topic starve
// everything else), each day's set is budgeted into slots:
//   - up to 2 revision slots  — problems due for revision; if none are due yet
//     but revision topics are set, the oldest finished problems from those
//     topics are pulled in early so revision always shows up.
//   - 1–2 preferred slots     — round-robin across the preferred topics.
//   - remaining slots         — current topic first, then preferred, then sheet order.
const { getDb, saveDb, daysBetween } = require('./store');

const REVISION_COOLDOWN_DAYS = 2;   // revision-flagged problems come back after this many days
const HELP_REVISIT_DAYS = 4;        // solved_with_help auto-returns for revision after this
const TOPIC_REVISION_DAYS = 7;      // completed problems in a "revise this topic" cycle back after this

function getOrCreateAssignment(date) {
  const db = getDb();
  if (db.assignments[date]) return db.assignments[date];

  const s = db.settings;
  const dailyCount = Math.min(8, Math.max(3, s.dailyCount || 5));
  const byId = Object.fromEntries(db.problems.map((p) => [p.id, p]));
  const picked = new Set();
  const items = [];

  const add = (p, type) => {
    if (!p || picked.has(p.id)) return false;
    picked.add(p.id);
    items.push({ problemId: p.id, type });
    return true;
  };

  // --- 1. Revision slots ---------------------------------------------------
  const revisionTarget = dailyCount >= 5 ? 2 : 1;

  const dueForRevision = db.problems
    .filter((p) => {
      if (p.revision) {
        const anchor = p.revisionFlaggedAt || p.statusUpdatedAt;
        return anchor && daysBetween(anchor, date) >= REVISION_COOLDOWN_DAYS;
      }
      if (!p.statusUpdatedAt) return false;
      const age = daysBetween(p.statusUpdatedAt, date);
      if (p.status === 'solved_with_help') return age >= HELP_REVISIT_DAYS;
      if (p.status === 'completed' && s.revisionTopics.includes(p.step)) return age >= TOPIC_REVISION_DAYS;
      return false;
    })
    .sort((a, b) => {
      const ra = s.revisionTopics.includes(a.step) ? 0 : 1;
      const rb = s.revisionTopics.includes(b.step) ? 0 : 1;
      const aAnchor = a.revisionFlaggedAt || a.statusUpdatedAt || '';
      const bAnchor = b.revisionFlaggedAt || b.statusUpdatedAt || '';
      return ra - rb || aAnchor.localeCompare(bAnchor) || a.order - b.order;
    });

  for (const p of dueForRevision) {
    if (items.length >= revisionTarget) break;
    add(p, 'revision');
  }

  // Nothing due yet but the user asked to revise specific topics → pull the
  // least-recently-touched finished problems from those topics early.
  if (items.length < revisionTarget && s.revisionTopics.length) {
    const fallback = db.problems
      .filter((p) =>
        s.revisionTopics.includes(p.step) &&
        ['completed', 'solved_with_help'].includes(p.status) &&
        p.lastAssignedDate !== date
      )
      .sort((a, b) =>
        (a.statusUpdatedAt || '').localeCompare(b.statusUpdatedAt || '') || a.order - b.order
      );
    for (const p of fallback) {
      if (items.length >= revisionTarget) break;
      add(p, 'revision');
    }
  }

  // --- 2. Preferred-topic slots --------------------------------------------
  const unfinished = (p) => p.status === 'pending' || p.status === 'attempted';
  const newType = (p) => (p.status === 'attempted' ? 'retry' : 'new');

  const preferredTarget = s.preferredTopics.length ? (dailyCount >= 6 ? 2 : 1) : 0;
  if (preferredTarget) {
    // Round-robin one problem per preferred topic so no single topic dominates.
    const queues = s.preferredTopics.map((step) =>
      db.problems.filter((p) => p.step === step && unfinished(p) && !picked.has(p.id))
        .sort((a, b) => a.order - b.order)
    );
    let taken = 0, qi = 0, empty = 0;
    while (taken < preferredTarget && empty < queues.length) {
      const q = queues[qi % queues.length];
      qi++;
      if (!q.length) { empty++; continue; }
      empty = 0;
      const p = q.shift();
      if (add(p, newType(p))) taken++;
    }
  }

  // --- 3. Fill the rest: current topic → preferred → sheet order ------------
  const topicRank = (p) => {
    if (s.currentTopic && p.step === s.currentTopic) return 0;
    if (s.preferredTopics.includes(p.step)) return 1;
    return 2;
  };
  const fillPool = db.problems
    .filter((p) => unfinished(p) && !picked.has(p.id))
    .sort((a, b) => topicRank(a) - topicRank(b) || a.order - b.order);
  for (const p of fillPool) {
    if (items.length >= dailyCount) break;
    add(p, newType(p));
  }

  // Sheet exhausted → top up with whatever else is due for revision.
  for (const p of dueForRevision) {
    if (items.length >= dailyCount) break;
    add(p, 'revision');
  }

  // Order the day: new/retry first (sheet order), revision last.
  items.sort((a, b) => {
    const ra = a.type === 'revision' ? 1 : 0, rb = b.type === 'revision' ? 1 : 0;
    return ra - rb || byId[a.problemId].order - byId[b.problemId].order;
  });

  for (const it of items) {
    byId[it.problemId].timesAssigned++;
    byId[it.problemId].lastAssignedDate = date;
  }

  db.assignments[date] = { date, items };
  saveDb();
  return db.assignments[date];
}

// Append one problem to an existing day. With a problemId, adds that specific
// problem; without one, picks the next unfinished problem by the usual
// current-topic → preferred → sheet order ranking.
function addProblemToDay(date, problemId) {
  const db = getDb();
  const s = db.settings;
  const assignment = getOrCreateAssignment(date);
  const inDay = new Set(assignment.items.map((it) => it.problemId));

  let p;
  if (problemId) {
    p = db.problems.find((x) => x.id === String(problemId));
    if (!p) return { error: 'unknown problem' };
    if (inDay.has(p.id)) return { error: 'already in today\'s assignment' };
  } else {
    const topicRank = (x) => {
      if (s.currentTopic && x.step === s.currentTopic) return 0;
      if (s.preferredTopics.includes(x.step)) return 1;
      return 2;
    };
    p = db.problems
      .filter((x) => (x.status === 'pending' || x.status === 'attempted') && !inDay.has(x.id))
      .sort((a, b) => topicRank(a) - topicRank(b) || a.order - b.order)[0];
    if (!p) return { error: 'no unfinished problems left' };
  }

  const type =
    p.status === 'attempted' ? 'retry' :
    p.status === 'pending' ? 'new' : 'revision';
  assignment.items.push({ problemId: p.id, type });
  p.timesAssigned++;
  p.lastAssignedDate = date;
  saveDb();
  return { added: { id: p.id, title: p.title, type } };
}

module.exports = { getOrCreateAssignment, addProblemToDay, removeProblemFromDay };

// Remove a problem from today's assignment (by problemId or by slot index).
function removeProblemFromDay(date, problemId) {
  const db = getDb();
  const assignment = getOrCreateAssignment(date);
  const idx = assignment.items.findIndex((it) => it.problemId === String(problemId));
  if (idx === -1) return { error: 'problem not in today\'s assignment' };
  const [removed] = assignment.items.splice(idx, 1);
  const p = db.problems.find((x) => x.id === removed.problemId);
  saveDb();
  return { removed: { id: removed.problemId, title: p ? p.title : removed.problemId } };
}
