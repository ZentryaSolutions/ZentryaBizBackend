const express = require('express');

const db = require('../db');
const { issueEmailOtp } = require('../utils/emailOtpIssue');
const { verifyAndConsumeEmailOtp, normalizeEmail } = require('../utils/emailOtpVerify');

const router = express.Router();

// POST /api/otp/request
// body: { email, purpose?: 'signup'|'login'|'reset' }
router.post('/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const purpose = String(req.body?.purpose || 'signup');

    if (!email || !email.includes('@') || email.length > 254) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (!['signup', 'login', 'reset'].includes(purpose)) {
      return res.status(400).json({ error: 'Invalid purpose' });
    }

    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      if (purpose === 'signup') {
        const taken = await db.query(
          `SELECT 1 FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
          [email]
        );
        if (taken.rows.length > 0) {
          return res.status(400).json({ error: 'Email already registered' });
        }
      }
      if (purpose === 'login') {
        try {
          const found = await db.query(
            `SELECT COALESCE(mfa_email_enabled, false) AS mfa_email_enabled
             FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
            [email]
          );
          if (found.rows.length === 0) {
            return res.status(400).json({ error: 'No account for this email' });
          }
          if (!found.rows[0].mfa_email_enabled) {
            return res.status(400).json({
              error: 'Two-factor email is not enabled for this account. Enable it under Settings → Security after signing in.',
            });
          }
        } catch (e) {
          if (e.code === '42703') {
            return res.status(503).json({ error: 'Database migration required', message: 'mfa_email_enabled column missing.' });
          }
          throw e;
        }
      }
      if (purpose === 'reset') {
        const found = await db.query(
          `SELECT 1 FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
          [email]
        );
        if (found.rows.length === 0) {
          return res.status(400).json({ error: 'No account for this email' });
        }
      }
    } catch (e) {
      if (e.code === '42703') {
        return res.status(503).json({
          error: 'Email column missing',
          message: 'Run database/zentrya_biz_zb_simple_users_email.sql in Supabase',
        });
      }
      throw e;
    }

    try {
      await issueEmailOtp(req, email, purpose);
    } catch (e) {
      if (e.code === 'OTP_RATE_LIMIT') {
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
      }
      throw e;
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('[otp/request] error:', e.message);
    return res.status(500).json({
      error: 'Failed to send OTP',
      message: process.env.NODE_ENV === 'development' ? e.message : undefined,
    });
  }
});

// POST /api/otp/verify
// body: { email, code, purpose?: 'signup'|'login'|'reset' }
router.post('/verify', async (req, res) => {
  try {
    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    const purpose = String(req.body?.purpose || 'signup');

    const result = await verifyAndConsumeEmailOtp(email, code, purpose);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'Verification failed' });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('[otp/verify] error:', e.message);
    return res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

module.exports = router;
