// The Striver A2Z sheet itself — static reference data shared by every user.
//
// Only *progress* is per-user (status, revision flag, counters). The problem
// text, links and ordering are identical for everyone, so they are loaded from
// the CSV once at boot and merged into each user's state on read. That keeps
// per-user rows small and means updating the CSV adds new problems to every
// account automatically.
const fs = require('fs');
const path = require('path');

const CSV_FILE = path.join(__dirname, '..', 'striver_a2z_complete_sheet.csv');

// RFC4180-ish parser: handles quoted fields, escaped quotes and CRLF.
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

// Maps a parsed CSV into rows keyed by header name, tolerating reordered or
// missing columns. Used for both the bundled sheet and user-uploaded exports.
function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const record = {};
    header.forEach((name, i) => { record[name] = (r[i] ?? '').trim(); });
    return record;
  });
}

// The static half of a problem. Progress fields live in per-user state.
function buildCatalog() {
  const records = parseCsvRecords(fs.readFileSync(CSV_FILE, 'utf8'));
  return records
    .filter((r) => r['Problem ID'])
    .map((r, i) => ({
      id: String(r['Problem ID']),
      order: i,
      step: r['Step'],
      subsection: r['Subsection'],
      title: r['Problem'],
      difficulty: r['Difficulty'] || 'Easy',
      url: r['Problem URL'] || r['TUF Plus Solve URL'] || '',
      practiceUrl: r['Practice URL'] || '',
      youtubeUrl: r['YouTube URL'] || '',
    }));
}

const CATALOG = buildCatalog();
const CATALOG_IDS = new Set(CATALOG.map((p) => p.id));

module.exports = { CATALOG, CATALOG_IDS, parseCsv, parseCsvRecords };
