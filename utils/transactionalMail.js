/**
 * Send non-OTP transactional email (same transport as /api/otp — SMTP or MS Graph).
 */

const nodemailer = require('nodemailer');
const msGraphMail = require('./msGraphMail');

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function buildSmtpTransport() {
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

/**
 * @param {{ to: string, subject: string, text: string, html?: string, attachments?: Array<{filename:string,content:Buffer|string,contentType?:string,cid?:string}> }} opts
 */
async function sendTransactionalEmail(opts) {
  const { to, subject, text, html, attachments } = opts;
  if (!to || !subject || !text) {
    throw new Error('sendTransactionalEmail: to, subject, and text are required');
  }

  if (msGraphMail.isConfigured()) {
    await msGraphMail.sendMail({ to, subject, text, html: html || text, attachments });
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) {
    throw new Error('Missing env: SMTP_FROM (or SMTP_USER), or configure MS Graph (MS_GRAPH_*)');
  }
  const transport = buildSmtpTransport();
  await transport.sendMail({ from, to, subject, text, html: html || text, attachments });
}

module.exports = { sendTransactionalEmail };
