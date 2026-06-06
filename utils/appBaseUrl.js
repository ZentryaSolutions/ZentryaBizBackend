/**
 * Public frontend URL for emails and redirects (staff invite, login revoke, Stripe, etc.).
 */

const PRODUCTION_APP_BASE = 'https://biz.zentryasolutions.com';

const LEGACY_HOSTS = new Set([
  'zentrya-biz.vercel.app',
  'www.zentrya-biz.vercel.app',
  'zentrya-biz-frontend.vercel.app',
  'www.zentrya-biz-frontend.vercel.app',
]);

function normalizeAppBaseUrl(raw) {
  const s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return '';
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    const host = u.hostname.toLowerCase();
    if (LEGACY_HOSTS.has(host)) {
      return PRODUCTION_APP_BASE;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return s;
  }
}

function getAppBaseUrl() {
  const fromEnv = normalizeAppBaseUrl(
    process.env.APP_BASE_URL || process.env.FRONTEND_URL || ''
  );
  if (fromEnv) return fromEnv;
  if (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') {
    return PRODUCTION_APP_BASE;
  }
  return 'http://localhost:3000';
}

module.exports = {
  PRODUCTION_APP_BASE,
  normalizeAppBaseUrl,
  getAppBaseUrl,
};
