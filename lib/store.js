// Data layer: per-user state persistence, statuses, and date helpers.
//
// The tracker was originally single-user with one global `db` object loaded
// from db.json. It is now multi-user, but the shape of that object is
// unchanged — instead of one global there is one per signed-in user, held in
// an AsyncLocalStorage scope for the duration of a request. `getDb()` and
// `saveDb()` keep their original signatures, so every caller in lib/ and
// routes/ works exactly as before and simply operates on the current user's
// state.
const { AsyncLocalStorage } = require('async_hooks');
const { db: sqlite } = require('./db');
const { CATALOG } = require('./catalog');

const DEFAULT_SETTINGS = {
  dailyCount: 5,          // problems per day (3–8)
  videoDailyCount: 2,     // videos per day (1–20)
  preferredPlaylistIds: [], // playlists included in the daily video queue
  youtubeApiKey: '',      // optional YouTube Data API v3 key for playlist metadata
  currentTopic: null,     // step name to draw new problems from first; null = sheet order
  preferredTopics: [],    // steps prioritized after currentTopic
  revisionTopics: [],     // steps whose finished problems cycle back for revision
  provider: 'auto',       // 'auto' | 'anthropic' | 'gemini' | 'none'
  coachMode: 'coach',     // 'coach' | 'interview'
  apiKey: '',             // each account brings its own key
  model: '',              // optional model override; blank = provider default
  notionToken: '',        // Notion internal integration secret (ntn_...)
  notionParentPageId: '', // page the tracker database gets created under (ID or URL)
  notionDatabaseId: '',   // filled automatically once the database is created
};

const VALID_STATUSES = ['pending', 'attempted', 'completed', 'solved_with_help', 'revision_needed'];
const DONE_STATUSES = ['completed', 'solved_with_help'];
const STATUS_LABEL = {
  pending: 'Pending',
  attempted: 'Attempted',
  completed: 'Completed',
  solved_with_help: 'Solved w/ help',
  revision_needed: 'Revision needed',
};

// Fields persisted per user per problem. Everything else (title, links, step)
// comes from the shared catalog and is re-merged on load.
const PROGRESS_FIELDS = [
  'status', 'revision', 'statusUpdatedAt', 'completionCount', 'everCompleted',
  'revisionFlaggedAt', 'timesAssigned', 'lastAssignedDate',
];

const als = new AsyncLocalStorage();

// ---------- per-request scope ----------

function getStore() {
  const store = als.getStore();
  if (!store) throw new Error('No user scope: getDb() called outside a request');
  return store;
}

function getDb() {
  return getStore().db;
}

function currentUserId() {
  return getStore().userId;
}

// Runs `fn` with `userId`'s state loaded and available to getDb()/saveDb().
function runForUser(userId, fn) {
  return als.run({ userId, db: loadState(userId) }, fn);
}

// ---------- persistence ----------

const selectState = sqlite.prepare('SELECT json FROM user_state WHERE user_id = ?');
const upsertState = sqlite.prepare(`
  INSERT INTO user_state (user_id, json, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
`);

function loadState(userId) {
  const row = selectState.get(userId);
  const state = row ? JSON.parse(row.json) : freshState();
  return normalize(state);
}

function saveDb() {
  const { userId, db } = getStore();
  upsertState.run(userId, JSON.stringify(serialize(db)), new Date().toISOString());
}

function freshState() {
  return { problems: [], assignments: {}, activity: {}, playlists: [], videoAssignments: {}, videoProgress: {}, settings: {} };
}

// Strips catalog fields back out before writing, so each user's row holds only
// their own progress.
function serialize(state) {
  return {
    ...state,
    problems: state.problems.map((p) => {
      const slim = { id: p.id };
      for (const field of PROGRESS_FIELDS) slim[field] = p[field];
      return slim;
    }),
  };
}

// Merges the shared catalog with stored progress and repairs older shapes.
// Problems present in the catalog but not yet in the user's state (e.g. after
// the sheet CSV gains rows) are added as pending.
function normalize(state) {
  if (!Array.isArray(state.problems)) state.problems = [];
  const progressById = new Map(state.problems.map((p) => [String(p.id), p]));

  state.problems = CATALOG.map((base) => {
    const saved = progressById.get(base.id) || {};
    const p = { ...base, ...pickProgress(saved) };

    // Completion tracking fields.
    if (p.completionCount == null) {
      p.completionCount = DONE_STATUSES.includes(p.status) ? 1 : 0;
      p.everCompleted = p.completionCount > 0;
    }
    // Revision used to be a status; it's now an independent flag that does
    // NOT imply completion — a problem can be flagged while still pending.
    if (p.revision == null) p.revision = false;
    if (p.status === 'revision_needed') {
      p.revision = true;
      p.status = p.everCompleted ? 'completed' : 'pending';
    }
    if (p.revisionFlaggedAt == null) p.revisionFlaggedAt = p.revision ? p.statusUpdatedAt : null;
    return p;
  });

  if (!state.assignments || typeof state.assignments !== 'object') state.assignments = {};
  if (!state.activity || typeof state.activity !== 'object') state.activity = {};
  if (!Array.isArray(state.playlists)) state.playlists = [];
  if (!state.videoAssignments || typeof state.videoAssignments !== 'object') state.videoAssignments = {};
  if (!state.videoProgress || typeof state.videoProgress !== 'object') state.videoProgress = {};

  for (const playlist of state.playlists) {
    playlist.id = String(playlist.id || `playlist-${Date.now()}`);
    playlist.title = String(playlist.title || 'Untitled playlist');
    playlist.url = String(playlist.url || '');
    playlist.totalVideos = Math.max(1, Number.parseInt(playlist.totalVideos, 10) || 1);
    playlist.targetDays = Math.max(1, Number.parseInt(playlist.targetDays, 10) || Math.ceil(playlist.totalVideos / (state.settings?.videoDailyCount || 2)));
    playlist.nextVideo = Math.max(1, Number.parseInt(playlist.nextVideo, 10) || 1);
    if (!Array.isArray(playlist.videos)) playlist.videos = [];
    playlist.createdAt = playlist.createdAt || todayStr();
  }
  // Repair assignments made by the initial playlist queue: it advanced the
  // cursor too late and could add the same video twice in one day.
  for (const assignment of Object.values(state.videoAssignments)) {
    const seen = new Set();
    assignment.items = (assignment.items || []).filter((item) => {
      const id = `${item.playlistId}:${item.position}`;
      if (seen.has(id)) return false;
      seen.add(id);
      if (!item.type) item.type = 'new';
      return true;
    });
  }

  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  return state;
}

function pickProgress(saved) {
  const out = {};
  for (const field of PROGRESS_FIELDS) if (saved[field] !== undefined) out[field] = saved[field];
  if (out.status === undefined) out.status = 'pending';
  if (out.timesAssigned === undefined) out.timesAssigned = 0;
  if (out.lastAssignedDate === undefined) out.lastAssignedDate = null;
  if (out.statusUpdatedAt === undefined) out.statusUpdatedAt = null;
  return out;
}

// Writes a state object for a user outside of any request scope (used by the
// legacy-import script and the TUF importer's tests).
function writeStateFor(userId, state) {
  upsertState.run(userId, JSON.stringify(serialize(normalize(state))), new Date().toISOString());
}

// ---------- helpers ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
}

const isDone = (p) => DONE_STATUSES.includes(p.status);

// Status and the revision flag are two independent axes:
//   status   — pending / attempted / completed / solved_with_help
//   revision — a boolean "bring this back later" tag, settable at any status
//
// completionCount only increments on a GENUINE completion event: either the
// first time a problem moves out of pending/attempted into a done status, or
// a re-completion of a problem that was flagged for revision (i.e. the user
// actually revisited it). Re-clicking "Completed" on an already-completed,
// unflagged problem is a no-op for the counter — it just re-confirms status.
function setStatus(problemId, status, date) {
  const db = getDb();
  const p = db.problems.find((x) => x.id === problemId);
  if (!p || !VALID_STATUSES.includes(status)) return null;

  // 'revision_needed' is kept as an accepted status value for backward
  // compatibility (chat parser, old clients) but only ever sets the flag —
  // it never touches status or the completion count.
  if (status === 'revision_needed') return setRevision(problemId, true, date);

  const wasDone = DONE_STATUSES.includes(p.status);
  const wasFlagged = p.revision;

  if (DONE_STATUSES.includes(status)) {
    if (!wasDone || wasFlagged) {
      p.completionCount = (p.completionCount || 0) + 1;
      p.everCompleted = true;
      db.activity[date] = (db.activity[date] || 0) + 1;
    }
    p.revision = false; // solved (again) → the flag has done its job
  }
  if (status === 'pending') p.revision = false; // resetting clears any pending revision too

  p.status = status;
  p.statusUpdatedAt = date;

  // Mark this problem as completed-today in today's assignment (for revision tracking).
  const todayAssignment = db.assignments[date];
  if (todayAssignment) {
    const slot = todayAssignment.items.find((it) => it.problemId === problemId);
    if (slot) slot.completedToday = DONE_STATUSES.includes(status);
  }

  return p;
}

// Toggle the revision flag directly — independent of status. Flagging a
// still-unsolved problem is allowed (case: "revisit this later") and does
// NOT mark it completed or touch the completion count.
function setRevision(problemId, on, date) {
  const p = getDb().problems.find((x) => x.id === problemId);
  if (!p) return null;
  p.revision = on;
  if (on) p.revisionFlaggedAt = date; // anchors the reappearance cooldown
  return p;
}

module.exports = {
  DEFAULT_SETTINGS, VALID_STATUSES, DONE_STATUSES, STATUS_LABEL,
  getDb, saveDb, runForUser, currentUserId, loadState, writeStateFor, normalize,
  todayStr, daysBetween, isDone, setStatus, setRevision,
};
