// Data layer: db.json persistence, CSV import, statuses, and date helpers.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DSA_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CSV_FILE = path.join(__dirname, '..', 'striver_a2z_complete_sheet.csv');

const DEFAULT_SETTINGS = {
  dailyCount: 5,          // problems per day (3–8)
  currentTopic: null,     // step name to draw new problems from first; null = sheet order
  preferredTopics: [],    // steps prioritized after currentTopic
  revisionTopics: [],     // steps whose finished problems cycle back for revision
  provider: 'auto',       // 'auto' | 'anthropic' | 'gemini' | 'none'
  apiKey: '',             // optional; env vars ANTHROPIC_API_KEY / GEMINI_API_KEY also work
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

let db = null;

function getDb() {
  return db;
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    db = { problems: importFromCsv(), assignments: {}, activity: {} };
  }
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  // Migration: completion tracking fields (a problem in revision stays "completed").
  for (const p of db.problems) {
    if (p.completionCount == null) {
      p.completionCount = DONE_STATUSES.includes(p.status) ? 1 : 0;
      p.everCompleted = p.completionCount > 0;
    }
  }
  saveDb();
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- CSV import ----------

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function importFromCsv() {
  const rows = parseCsv(fs.readFileSync(CSV_FILE, 'utf8'));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const today = todayStr();
  return rows.slice(1).map((r, i) => {
    const completed = r[col('Completed')] === 'Yes';
    const revision = r[col('Revision')] === 'Yes';
    return {
      id: r[col('Problem ID')],
      order: i,
      step: r[col('Step')],
      subsection: r[col('Subsection')],
      title: r[col('Problem')],
      difficulty: r[col('Difficulty')] || 'Easy',
      url: r[col('Problem URL')] || r[col('TUF Plus Solve URL')] || '',
      practiceUrl: r[col('Practice URL')] || '',
      youtubeUrl: r[col('YouTube URL')] || '',
      status: revision ? 'revision_needed' : completed ? 'completed' : 'pending',
      statusUpdatedAt: completed || revision ? today : null,
      completionCount: completed ? 1 : 0,
      everCompleted: completed,
      timesAssigned: 0,
      lastAssignedDate: null,
    };
  });
}

// ---------- helpers ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
}

// A problem counts as done if its status is a done status, OR it's in revision
// after having been completed before (revision shouldn't erase progress).
const isDone = (p) => DONE_STATUSES.includes(p.status) || (p.status === 'revision_needed' && p.everCompleted);

function setStatus(problemId, status, date) {
  const p = db.problems.find((x) => x.id === problemId);
  if (!p || !VALID_STATUSES.includes(status)) return null;
  p.status = status;
  p.statusUpdatedAt = date;
  if (DONE_STATUSES.includes(status)) {
    p.completionCount = (p.completionCount || 0) + 1;
    p.everCompleted = true;
    db.activity[date] = (db.activity[date] || 0) + 1;
  }
  return p;
}

module.exports = {
  DEFAULT_SETTINGS, VALID_STATUSES, DONE_STATUSES, STATUS_LABEL,
  getDb, loadDb, saveDb,
  todayStr, daysBetween, isDone, setStatus,
};
