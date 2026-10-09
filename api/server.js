const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20kb' }));

const PORT = Number(process.env.PORT || process.env.API_PORT || 3000);
const DB_FILE = process.env.DATABASE_FILE || path.resolve(__dirname, '../bot/keys.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS issued_keys (
  discord_user_id TEXT PRIMARY KEY,
  discord_tag TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT
);
`);

const consume = db.transaction((key) => {
  const row = db.prepare(
    'SELECT key, used FROM issued_keys WHERE UPPER(key) = ?'
  ).get(key);

  if (!row) return { ok: false, reason: 'INVALID' };
  if (row.used) return { ok: false, reason: 'USED' };

  db.prepare(
    'UPDATE issued_keys SET used = 1, used_at = CURRENT_TIMESTAMP WHERE UPPER(key) = ? AND used = 0'
  ).run(key);

  return { ok: true };
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'irone-key-api' });
});

app.post('/api/keys/consume', (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase();

  if (!/^IRONE-[A-Z0-9]{8}$/.test(key)) {
    return res.status(400).json({ ok: false, reason: 'INVALID' });
  }

  const result = consume(key);

  if (!result.ok) {
    return res.status(409).json(result);
  }

  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`IRONE Key API listening on port ${PORT}`);
});
