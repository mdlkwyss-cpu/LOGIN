const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();

app.use(express.json({
  limit: '20kb',
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined
});

const PREFIX = process.env.KEY_PREFIX || 'IRONE';

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS issued_keys (
      discord_user_id TEXT PRIMARY KEY,
      discord_tag TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )
  `);
}

const ready = initializeDatabase();

function verifyDiscordRequest(req) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');

  if (
    !publicKey ||
    !/^[a-f0-9]{64}$/i.test(publicKey) ||
    !signature ||
    !/^[a-f0-9]{128}$/i.test(signature) ||
    !timestamp ||
    !req.rawBody
  ) {
    return false;
  }

  try {
    const rawPublicKey = Buffer.from(publicKey, 'hex');

    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        rawPublicKey
      ]),
      format: 'der',
      type: 'spki'
    });

    return crypto.verify(
      null,
      Buffer.concat([
        Buffer.from(timestamp, 'utf8'),
        req.rawBody
      ]),
      keyObject,
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

function makeKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';

  for (let i = 0; i < 8; i++) {
    value += alphabet[crypto.randomInt(alphabet.length)];
  }

  return `${PREFIX}-${value}`;
}

async function createKeyFor(user) {
  await ready;

  const existing = await pool.query(
    'SELECT key FROM issued_keys WHERE discord_user_id = $1',
    [user.id]
  );

  if (existing.rowCount > 0) {
    return { existing: true };
  }

  for (;;) {
    const key = makeKey();

    try {
      const inserted = await pool.query(
        `INSERT INTO issued_keys
          (discord_user_id, discord_tag, key)
         VALUES ($1, $2, $3)
         ON CONFLICT (discord_user_id) DO NOTHING
         RETURNING key`,
        [user.id, user.tag || user.username || user.id, key]
      );

      if (inserted.rowCount > 0) {
        return { existing: false, key: inserted.rows[0].key };
      }

      return { existing: true };
    } catch (error) {
      if (error.code === '23505') {
        continue;
      }
      throw error;
    }
  }
}

app.get('/health', async (_req, res) => {
  try {
    await ready;
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      service: 'irone-key-api'
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.status(503).json({
      ok: false,
      error: 'DATABASE_UNAVAILABLE'
    });
  }
});

app.post('/api/discord/interactions', async (req, res) => {
  if (!verifyDiscordRequest(req)) {
    return res.status(401).send('Invalid Discord signature');
  }

  const body = req.body;

  if (body?.type === 1) {
    return res.json({ type: 1 });
  }

  if (body?.type !== 2 || body?.data?.name !== 'key') {
    return res.status(400).json({
      error: 'UNKNOWN_INTERACTION'
    });
  }

  if (
    !process.env.GUILD_ID ||
    body.guild_id !== process.env.GUILD_ID
  ) {
    return res.json({
      type: 4,
      data: {
        content: '❌ هذا الأمر غير متاح في هذا الخادم.',
        flags: 64
      }
    });
  }

  const user = body.member?.user || body.user;

  if (!user?.id) {
    return res.status(400).json({
      error: 'MISSING_USER'
    });
  }

  try {
    await ready;

    const result = await createKeyFor(user);

    if (result.existing) {
      return res.json({
        type: 4,
        data: {
          content:
            '⚠️ لقد طلبت مفتاحًا من قبل. لا يمكنك الحصول على مفتاح آخر.\n\n' +
            'إذا فقدت مفتاحك، فلن يتم إنشاء مفتاح جديد للحساب نفسه.',
          flags: 64
        }
      });
    }

    return res.json({
      type: 4,
      data: {
        content:
          '✅ **تم الحصول على مفتاحك بنجاح!**\n\n' +
          '🔑 مفتاح IRONE الخاص بك:\n' +
          `\`${result.key}\`\n\n` +
          '⚠️ هذا المفتاح مرتبط بحساب Discord الخاص بك ويمكن استخدامه مرة واحدة فقط.',
        flags: 64
      }
    });
  } catch (error) {
    console.error('Discord interaction failed:', error.message);

    return res.json({
      type: 4,
      data: {
        content: '❌ حدث خطأ مؤقت. حاول لاحقًا.',
        flags: 64
      }
    });
  }
});

app.post('/api/keys/consume', async (req, res) => {
  const key = String(req.body?.key || '').trim().toUpperCase();

  if (!/^IRONE-[A-Z0-9]{8}$/.test(key)) {
    return res.status(400).json({
      ok: false,
      reason: 'INVALID'
    });
  }

  try {
    await ready;

    const result = await pool.query(
      `UPDATE issued_keys
       SET used = TRUE, used_at = NOW()
       WHERE UPPER(key) = $1 AND used = FALSE
       RETURNING key`,
      [key]
    );

    if (result.rowCount > 0) {
      return res.json({ ok: true });
    }

    const existing = await pool.query(
      'SELECT used FROM issued_keys WHERE UPPER(key) = $1',
      [key]
    );

    if (existing.rowCount === 0) {
      return res.status(409).json({
        ok: false,
        reason: 'INVALID'
      });
    }

    return res.status(409).json({
      ok: false,
      reason: 'USED'
    });
  } catch (error) {
    console.error('Key validation failed:', error.message);

    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR'
    });
  }
});

module.exports = app;
