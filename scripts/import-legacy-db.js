#!/usr/bin/env node
// One-off migration: moves the old single-user data/db.json into a real
// account in the new SQLite database.
//
//   node scripts/import-legacy-db.js you@gmail.com [path/to/db.json]
//
// The email must match the Google account you sign in with. If that account
// has not signed in yet a placeholder user is created and linked on first
// sign-in by email.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db: sqlite } = require('../lib/db');
const { writeStateFor } = require('../lib/store');

const [email, dbPath] = process.argv.slice(2);
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/import-legacy-db.js <google-email> [path/to/db.json]');
  process.exit(1);
}

const legacyPath = dbPath || path.join(process.env.DSA_DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json');
if (!fs.existsSync(legacyPath)) {
  console.error(`No legacy db.json found at ${legacyPath}`);
  process.exit(1);
}

const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));

// Reuse the account if it already exists, otherwise pre-create it. A
// placeholder google_sub is replaced the first time that email signs in.
let user = sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (!user) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO users (id, google_sub, email, name, picture, created_at, last_seen_at)
    VALUES (?, ?, ?, '', '', ?, ?)
  `).run(id, `pending:${email}`, email, now, now);
  user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id);
  console.log(`Created account for ${email}`);
}

writeStateFor(user.id, legacy);

const done = legacy.problems.filter((p) => ['completed', 'solved_with_help'].includes(p.status)).length;
console.log(`Imported ${legacy.problems.length} problems (${done} completed), ` +
  `${Object.keys(legacy.assignments || {}).length} assignment days, ` +
  `${(legacy.playlists || []).length} playlists into ${email}.`);
console.log('Sign in with that Google account to see it.');
