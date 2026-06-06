/**
 * "New sign-in" notification — optional logout-all link (email security token).
 */

const nodemailer = require('nodemailer');
const msGraphMail = require('./msGraphMail');
const { createLogoutAllToken } = require('./emailSecurityTokens');
const { parseUserAgent } = require('./parseUserAgent');
const { getAppBaseUrl } = require('./appBaseUrl');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Local time for emails (default Pakistan — override with APP_TIMEZONE). */
function formatLoginTimes(date = new Date()) {
  const tz = process.env.APP_TIMEZONE || 'Asia/Karachi';
  let local = '';
  let tzLabel = tz;
  try {
    local = new Intl.DateTimeFormat('en-PK', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(date);
    tzLabel =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')?.value || tz;
  } catch {
    local = date.toLocaleString('en-PK', { timeZone: tz, hour12: true });
  }
  const utc = date.toUTCString();
  return { local, utc, tz, tzLabel };
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

function backendBaseFromReq(req) {
  const env = process.env.BACKEND_PUBLIC_URL || process.env.API_PUBLIC_URL;
  if (env) return String(env).replace(/\/$/, '');
  const xf = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(xf) ? xf[0] : xf;
  const p = proto === 'https' || proto === 'http' ? proto : 'http';
  const host = req.get && req.get('host');
  if (host) return `${p}://${host}`.replace(/\/$/, '');
  return '';
}

/**
 * Notify user of a successful sign-in. Best-effort — failures are logged, not thrown to caller.
 * @param {import('express').Request} req
 * @param {{ to: string, displayName?: string, userId: number }} user
 */
async function sendLoginAlertEmail(req, user) {
  const to = String(user?.to || '').trim().toLowerCase();
  if (!to || !to.includes('@')) return;

  const appName = process.env.APP_NAME || 'Zentrya Biz';
  const { local: whenLocal, utc: whenUtc, tzLabel } = formatLoginTimes(new Date());
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').toString().split(',')[0].trim();
  const uaRaw = String(req.get?.('user-agent') || req.headers['user-agent'] || '');
  const deviceLabel = parseUserAgent(uaRaw);
  const name = String(user.displayName || '').trim() || 'there';

  let revokeUrl = '';
  try {
    if (user.userId) {
      const { plainToken } = await createLogoutAllToken(user.userId);
      const base = backendBaseFromReq(req);
      if (base) {
        revokeUrl = `${base}/api/auth/email-revoke-sessions?token=${encodeURIComponent(plainToken)}`;
      }
    }
  } catch (e) {
    console.warn('[loginAlertEmail] revoke token:', e.message);
  }

  const fe = getAppBaseUrl();
  const textLines = [
    `Hi ${name},`,
    '',
    `Your ${appName} account was signed in successfully.`,
    `Time (${tzLabel}): ${whenLocal}`,
    `Time (UTC): ${whenUtc}`,
    `IP: ${ip || 'unknown'}`,
    `Browser: ${deviceLabel}`,
    '',
    revokeUrl
      ? `If this was not you, open this link to sign out all devices and invalidate sessions:\n${revokeUrl}`
      : `If this was not you, sign in to ${appName} and sign out from Settings, or contact support.`,
    '',
    fe ? `App: ${fe}` : '',
  ].filter(Boolean);

  const text = textLines.join('\n');

  const revokeBlock = revokeUrl
    ? `<p style="margin:16px 0;"><a href="${revokeUrl.replace(/"/g, '&quot;')}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Sign out all devices</a></p>
       <p style="font-size:12px;color:#6b7280;">This link expires in 7 days and works once.</p>`
    : `<p style="font-size:13px;color:#374151;">If this was not you, sign in to the app and sign out from Settings.</p>`;

  const html = `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#f7f8fb; padding:24px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border:1px solid #e6e8ef; border-radius:14px; overflow:hidden;">
      <div style="padding:18px 20px; background:linear-gradient(135deg,#4f46e5,#6366f1); color:#fff;">
        <div style="font-weight:700; font-size:16px;">${appName}</div>
        <div style="opacity:.9; font-size:13px; margin-top:4px;">Account sign-in</div>
      </div>
      <div style="padding:20px;">
        <div style="font-size:14px; color:#111827;">Hi ${name},</div>
        <p style="font-size:14px; color:#374151; margin:12px 0 0 0;">Your account was signed in successfully.</p>
        <table style="font-size:13px; color:#374151; margin-top:14px; border-collapse:collapse;">
          <tr><td style="padding:4px 12px 4px 0; color:#6b7280;">Time</td><td>${escapeHtml(whenLocal)} <span style="color:#6b7280;">(${escapeHtml(tzLabel)})</span></td></tr>
          <tr><td style="padding:4px 12px 4px 0; color:#6b7280;">UTC</td><td style="color:#6b7280;">${escapeHtml(whenUtc)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0; color:#6b7280;">IP</td><td>${escapeHtml(ip || 'unknown')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0; color:#6b7280;">Browser</td><td>${escapeHtml(deviceLabel)}</td></tr>
        </table>
        ${revokeBlock}
      </div>
      <div style="padding:14px 20px; border-top:1px solid #eef0f5; font-size:12px; color:#6b7280;">
        Sent by ${appName}
      </div>
    </div>
  </div>`;

  const subject = `${appName}: account sign-in notification`;

  try {
    if (msGraphMail.isConfigured()) {
      await msGraphMail.sendMail({ to, subject, text, html });
      return;
    }

    const host = process.env.SMTP_HOST;
    if (!host) {
      console.warn('[loginAlertEmail] No MS Graph and no SMTP_HOST — skip mail');
      return;
    }
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!from) {
      console.warn('[loginAlertEmail] Missing SMTP_FROM');
      return;
    }
    const transport = buildTransport();
    await transport.sendMail({ from, to, subject, text, html });
  } catch (e) {
    console.warn('[loginAlertEmail] send failed:', e.message);
  }
}

function getFrontendBaseUrl() {
  return getAppBaseUrl();
}

module.exports = {
  sendLoginAlertEmail,
  backendBaseFromReq,
  getFrontendBaseUrl,
};
