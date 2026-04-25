const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const db = require('../db');
const msGraphMail = require('../utils/msGraphMail');
const { buildOtpEmailContent } = require('../utils/otpEmailContent');
const { verifyAndConsumeEmailOtp, normalizeEmail } = require('../utils/emailOtpVerify');

const router = express.Router();

function genOtp6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildTransport() {
  const host = mustGetEnv('SMTP_HOST');
  const port = Number(mustGetEnv('SMTP_PORT'));
  const user = mustGetEnv('SMTP_USER');
  const pass = mustGetEnv('SMTP_PASS');
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function sendOtpEmail({ to, code, purpose }) {
  const { subject, text, html } = buildOtpEmailContent(code, purpose);

  if (msGraphMail.isConfigured()) {
    await msGraphMail.sendMail({ to, subject, text, html });
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) throw new Error('Missing env: SMTP_FROM (or SMTP_USER), or configure MS Graph (MS_GRAPH_*)');

  const transport = buildTransport();
  await transport.sendMail({ from, to, subject, text, html });
}

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
        const found = await db.query(
          `SELECT 1 FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
          [email]
        );
        if (found.rows.length === 0) {
          return res.status(400).json({ error: 'No account for this email' });
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

    const rl = await db.query(
      `SELECT COUNT(*)::int AS c
       FROM public.email_otps
       WHERE email=$1 AND created_at > (NOW() - INTERVAL '15 minutes')`,
      [email]
    );
    if ((rl.rows?.[0]?.c || 0) >= 3) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }

    const code = genOtp6();
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = sha256(`${salt}:${code}`);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const ipAddress = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    const userAgent = String(req.headers['user-agent'] || '');

    await db.query(
      `INSERT INTO public.email_otps (email, purpose, code_hash, salt, expires_at, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [email, purpose, codeHash, salt, expiresAt.toISOString(), ipAddress, userAgent]
    );

    await sendOtpEmail({ to: email, code, purpose });

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
