// Daily assignment generation.
//
// Instead of one strict priority order (which lets the current topic starve
// everything else), each day's set is budgeted into slots:
//   - up to 2 revision slots  — explicitly flagged problems first, then
//     automatic revisions that have not appeared in the last 30 days;
//     different topics are preferred whenever alternatives are due.
//   - 1–2 preferred slots     — round-robin across the preferred topics.
//   - remaining slots         — current topic first, then preferred, then sheet order.
const { getDb, saveDb, daysBetween, DONE_STATUSES } = require('./store');

const FLAGGED_REVISION_DELAY_DAYS = 2;       // explicit "Revision needed" flag; bypasses 30-day cooldown
const HELP_REVISIT_DAYS = 4;                 // solved_with_help becomes an automatic revision candidate
const TOPIC_REVISION_DAYS = 7;               // completed problem in a revision topic becomes a candidate
const AUTOMATIC_REVISION_INTERVAL_DAYS = 30; // never auto-repeat a question inside this window

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
    // Revision items start as not-completed-today; new/retry inherit current status.
    const completedToday = type === 'revision' ? false : DONE_STATUSES.includes(p.status);
    items.push({ problemId: p.id, type, completedToday });
    return true;
  };

  // --- 1. Revision slots ---------------------------------------------------
  const revisionTarget = dailyCount >= 5 ? 2 : 1;
  const automaticRevisionEligible = (p) =>
    !p.revision &&
    (!p.lastAssignedDate || daysBetween(p.lastAssignedDate, date) >= AUTOMATIC_REVISION_INTERVAL_DAYS);
  const revisionPriority = (p) =>
    p.revision ? 0 : s.revisionTopics.includes(p.step) ? 1 : 2;
  const compareRevisionCandidates = (a, b) => {
    const aAnchor = a.revisionFlaggedAt || a.statusUpdatedAt || '';
    const bAnchor = b.revisionFlaggedAt || b.statusUpdatedAt || '';
    return revisionPriority(a) - revisionPriority(b) ||
      (a.lastAssignedDate || '').localeCompare(b.lastAssignedDate || '') ||
      aAnchor.localeCompare(bAnchor) ||
      a.order - b.order;
  };

  // Explicitly flagged questions always win over automatic candidates. After
  // that, prefer a topic not already represented in today's revision slots,
  // even if that candidate would otherwise sort slightly later.
  const addBalancedRevisions = (candidates, totalTarget) => {
    const usedTopics = new Set(
      items.filter((it) => it.type === 'revision').map((it) => byId[it.problemId].step)
    );
    while (items.length < totalTarget) {
      const available = candidates.filter((p) => !picked.has(p.id));
      if (!available.length) break;
      const explicitlyFlagged = available.filter((p) => p.revision);
      const candidatePool = explicitlyFlagged.length ? explicitlyFlagged : available;
      const candidate = candidatePool.find((p) => !usedTopics.has(p.step)) || candidatePool[0];
      add(candidate, 'revision');
      usedTopics.add(candidate.step);
    }
  };

  const dueForRevision = db.problems
    .filter((p) => {
      // An explicit flag is the only way to bypass the 30-day repeat guard.
      if (p.revision) {
        const anchor = p.revisionFlaggedAt || p.statusUpdatedAt;
        return anchor && daysBetween(anchor, date) >= FLAGGED_REVISION_DELAY_DAYS;
      }
      if (!automaticRevisionEligible(p) || !p.statusUpdatedAt) return false;
      const age = daysBetween(p.statusUpdatedAt, date);
      if (p.status === 'solved_with_help') return age >= HELP_REVISIT_DAYS;
      if (p.status === 'completed' && s.revisionTopics.includes(p.step)) {
        return age >= TOPIC_REVISION_DAYS;
      }
      return false;
    })
    .sort(compareRevisionCandidates);

  addBalancedRevisions(dueForRevision, revisionTarget);

  // If regular due dates leave a revision slot open, use a finished problem
  // from a selected revision topic only when its last assignment was 30+ days
  // ago. Explicitly flagged questions are handled above after their 2-day delay.
  if (items.length < revisionTarget && s.revisionTopics.length) {
    const fallback = db.problems
      .filter((p) =>
        automaticRevisionEligible(p) &&
        s.revisionTopics.includes(p.step) &&
        ['completed', 'solved_with_help'].includes(p.status)
      )
      .sort(compareRevisionCandidates);
    addBalancedRevisions(fallback, revisionTarget);
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

  // Sheet exhausted → top up with any remaining due revisions, still keeping
  // topic diversity where candidates of the same priority are available.
  addBalancedRevisions(dueForRevision, dailyCount);

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
  const completedToday = type === 'revision' ? false : DONE_STATUSES.includes(p.status);
  assignment.items.push({ problemId: p.id, type, completedToday });
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
