/**
 * Issue a stored email OTP and send it (shared by /api/otp/request and zb-simple-session MFA).
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const db = require('../db');
const msGraphMail = require('./msGraphMail');
const { buildOtpEmailContent } = require('./otpEmailContent');

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

/**
 * @param {import('express').Request} req
 */
async function issueEmailOtp(req, email, purpose) {
  const rl = await db.query(
    `SELECT COUNT(*)::int AS c
     FROM public.email_otps
     WHERE email=$1 AND created_at > (NOW() - INTERVAL '15 minutes')`,
    [email]
  );
  if ((rl.rows?.[0]?.c || 0) >= 3) {
    const err = new Error('RATE_LIMIT');
    err.code = 'OTP_RATE_LIMIT';
    throw err;
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
}

module.exports = {
  issueEmailOtp,
  sendOtpEmail,
};
