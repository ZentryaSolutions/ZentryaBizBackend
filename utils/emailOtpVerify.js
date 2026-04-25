/**
 * Email OTP verification (same storage as POST /api/otp/*).
 */

const crypto = require('crypto');
const db = require('../db');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Validates code (always increments attempts once per check). Does not set consumed_at.
 * On success, call markEmailOtpConsumed(rowId).
 */
async function validateEmailOtpMatch(emailRaw, codeRaw, purpose) {
  const email = normalizeEmail(emailRaw);
  const code = String(codeRaw || '').trim();
  const p = String(purpose || 'signup');

  if (!email || !email.includes('@')) {
    return { ok: false, error: 'Invalid email' };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: 'Invalid code' };
  }
  if (!['signup', 'login', 'reset'].includes(p)) {
    return { ok: false, error: 'Invalid purpose' };
  }

  const q = await db.query(
    `SELECT id, code_hash, salt, attempts, expires_at, consumed_at
     FROM public.email_otps
     WHERE email=$1 AND purpose=$2
     ORDER BY created_at DESC
     LIMIT 1`,
    [email, p]
  );
  const row = q.rows?.[0];
  if (!row) return { ok: false, error: 'No OTP found. Request a new code.' };
  if (row.consumed_at) return { ok: false, error: 'Code already used. Request a new code.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Code expired. Request a new code.' };
  }
  if ((row.attempts || 0) >= 5) {
    return { ok: false, error: 'Too many attempts. Request a new code.' };
  }

  const computed = sha256(`${row.salt}:${code}`);
  const match = computed === row.code_hash;

  await db.query(`UPDATE public.email_otps SET attempts = attempts + 1 WHERE id=$1`, [row.id]);

  if (!match) return { ok: false, error: 'Incorrect code' };
  return { ok: true, rowId: row.id };
}

async function markEmailOtpConsumed(rowId) {
  if (!rowId) return;
  await db.query(
    `UPDATE public.email_otps SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL`,
    [rowId]
  );
}

async function verifyAndConsumeEmailOtp(emailRaw, codeRaw, purpose) {
  const r = await validateEmailOtpMatch(emailRaw, codeRaw, purpose);
  if (!r.ok) return { ok: false, error: r.error };
  await markEmailOtpConsumed(r.rowId);
  return { ok: true };
}

module.exports = {
  validateEmailOtpMatch,
  markEmailOtpConsumed,
  verifyAndConsumeEmailOtp,
  normalizeEmail,
};
