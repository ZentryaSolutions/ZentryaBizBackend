/**
 * One-time tokens for email actions (e.g. log out all sessions).
 */

const crypto = require('crypto');
const db = require('../db');

let ready = null;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function ensureTable() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.email_security_tokens (
        id BIGSERIAL PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
        purpose TEXT NOT NULL DEFAULT 'logout_all',
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      )
    `);
    await db.query(
      `CREATE INDEX IF NOT EXISTS idx_email_security_tokens_user_id ON public.email_security_tokens(user_id)`
    );
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/**
 * @returns {{ plainToken: string, expiresAt: Date }}
 */
async function createLogoutAllToken(userId) {
  if (!db.isDatabaseConfigured() || !userId) {
    throw new Error('createLogoutAllToken requires database and userId');
  }
  await ensureTable();
  const plainToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(plainToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO public.email_security_tokens (token_hash, user_id, purpose, expires_at)
     VALUES ($1, $2, 'logout_all', $3)`,
    [tokenHash, userId, expiresAt.toISOString()]
  );

  return { plainToken, expiresAt };
}

/**
 * Marks token used and returns user_id if valid.
 */
async function consumeLogoutAllToken(plainToken) {
  if (!db.isDatabaseConfigured() || !plainToken) {
    return { ok: false, error: 'Invalid request' };
  }
  await ensureTable();
  const tokenHash = sha256(String(plainToken).trim());
  const r = await db.query(
    `SELECT id, user_id, expires_at, used_at
     FROM public.email_security_tokens
     WHERE token_hash = $1 AND purpose = 'logout_all'
     LIMIT 1`,
    [tokenHash]
  );
  const row = r.rows?.[0];
  if (!row) return { ok: false, error: 'Invalid or expired link' };
  if (row.used_at) return { ok: false, error: 'This link was already used' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'This link has expired' };
  }

  await db.query(`UPDATE public.email_security_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
  return { ok: true, userId: row.user_id };
}

module.exports = {
  createLogoutAllToken,
  consumeLogoutAllToken,
};
