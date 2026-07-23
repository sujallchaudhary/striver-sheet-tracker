const crypto = require('crypto');
const { getDb, saveDb } = require('./store');

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const keyFrom = (req) => req.get('x-access-key') || req.query.key || '';

function status() { return { configured: Boolean(getDb().accessKeyHash) }; }

function setup(key) {
  const db = getDb();
  if (db.accessKeyHash) return { error: 'An access key is already configured.' };
  if (typeof key !== 'string' || key.trim().length < 8) return { error: 'Use an access key with at least 8 characters.' };
  db.accessKeyHash = hash(key);
  saveDb();
  return { ok: true };
}

function verify(key) {
  const db = getDb();
  return Boolean(db.accessKeyHash && key && crypto.timingSafeEqual(Buffer.from(db.accessKeyHash), Buffer.from(hash(key))));
}

function requireAccess(req, res, next) {
  const db = getDb();
  // Until an owner creates a key, keep the initial setup flow available.
  if (!db.accessKeyHash || verify(keyFrom(req))) return next();
  return res.status(401).json({ error: 'Unlock the tracker with its access key.' });
}

module.exports = { status, setup, verify, requireAccess };
