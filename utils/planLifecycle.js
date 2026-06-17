const db = require('../db');
const { shopLimitForPlan } = require('../lib/planShopLimits');
const { sendTransactionalEmail } = require('./transactionalMail');
const { getAppBaseUrl } = require('./appBaseUrl');
const { DEFAULT_TZ } = require('./businessDate');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14;
const RENEWAL_REMINDER_DAYS_BEFORE = 5;

let lifecycleColumnsReady = false;
let lifecycleColumnsPromise = null;

function normalizePlan(plan) {
  return String(plan || 'trial').trim().toLowerCase();
}

function planLabel(plan) {
  const p = normalizePlan(plan);
  if (p === 'premium') return 'Business';
  if (p === 'pro') return 'Growth';
  if (p === 'starter') return 'Starter';
  if (p === 'expired') return 'Expired';
  return 'Trial';
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function daysUntil(value) {
  if (!value) return null;
  const d = new Date(value).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.max(0, Math.ceil((d - Date.now()) / DAY_MS));
}

/** Calendar day index in business TZ (default Asia/Karachi — not UTC). */
function businessDayIndex(value, timeZone = DEFAULT_TZ) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const [y, m, day] = key.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !day) return null;
  return Math.floor(Date.UTC(y, m - 1, day) / DAY_MS);
}

/**
 * Trial progress from DB timestamps (profiles.trial_started_at / trial_ends_at).
 * Day 1 = first calendar day of trial in business timezone (Pakistan by default).
 */
function computeTrialProgress(status, timeZone = DEFAULT_TZ) {
  const plan = normalizePlan(status?.plan);
  if (plan !== 'trial') return null;

  const now = new Date();
  let start = status?.trial_started_at ? new Date(status.trial_started_at) : null;
  const end = status?.trial_ends_at ? new Date(status.trial_ends_at) : null;

  if ((!start || Number.isNaN(start.getTime())) && end && !Number.isNaN(end.getTime())) {
    start = new Date(end.getTime() - TRIAL_DAYS * DAY_MS);
  }
  if (!start || Number.isNaN(start.getTime())) {
    return {
      day: 1,
      total: TRIAL_DAYS,
      daysLeft: TRIAL_DAYS - 1,
      expired: false,
    };
  }

  const startIdx = businessDayIndex(start, timeZone);
  const todayIdx = businessDayIndex(now, timeZone);
  const day = Math.min(TRIAL_DAYS, Math.max(1, todayIdx - startIdx + 1));
  const expired =
    plan === 'expired' ||
    Number(status?.shop_limit) <= 0 ||
    (end && Number.isFinite(end.getTime()) && end.getTime() <= now.getTime());

  let daysLeft = TRIAL_DAYS - day;
  if (end && !Number.isNaN(end.getTime())) {
    const endIdx = businessDayIndex(end, timeZone);
    daysLeft = Math.max(0, endIdx - todayIdx);
  }

  return { day, total: TRIAL_DAYS, daysLeft, expired };
}

async function ensurePlanLifecycleColumns() {
  if (lifecycleColumnsReady) return;
  if (lifecycleColumnsPromise) return lifecycleColumnsPromise;

  lifecycleColumnsPromise = (async () => {
    await db.query(`
      ALTER TABLE public.profiles
        ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
        ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
        ADD COLUMN IF NOT EXISTS plan_reminder_last_sent_at timestamptz,
        ADD COLUMN IF NOT EXISTS plan_reminder_period_end timestamptz
    `);

    await db.query(`
      UPDATE public.profiles
      SET trial_started_at = COALESCE(trial_started_at, now()),
          trial_ends_at = COALESCE(trial_ends_at, COALESCE(trial_started_at, now()) + ($1::int * interval '1 day'))
      WHERE lower(coalesce(plan::text, 'trial')) = 'trial'
        AND (trial_started_at IS NULL OR trial_ends_at IS NULL)
    `, [TRIAL_DAYS]);

    lifecycleColumnsReady = true;
  })().finally(() => {
    lifecycleColumnsPromise = null;
  });

  return lifecycleColumnsPromise;
}

async function expireTrialIfNeeded(profileId) {
  if (!profileId || !db.isDatabaseConfigured()) return null;
  await ensurePlanLifecycleColumns();

  const expired = await db.query(
    `UPDATE public.profiles
        SET plan = 'expired'::public.zb_plan,
            shop_limit = 0
      WHERE id = $1::uuid
        AND lower(coalesce(plan::text, 'trial')) = 'trial'
        AND COALESCE(trial_ends_at, trial_started_at + ($2::int * interval '1 day'), now() + interval '14 days') <= now()
      RETURNING id::text, plan::text AS plan, shop_limit, trial_started_at, trial_ends_at,
                stripe_current_period_end, plan_reminder_period_end`,
    [profileId, TRIAL_DAYS]
  );

  if (expired.rows[0]) return expired.rows[0];
  const current = await db.query(
    `SELECT id::text, plan::text AS plan, shop_limit, trial_started_at, trial_ends_at,
            stripe_current_period_end, plan_reminder_period_end
       FROM public.profiles
      WHERE id = $1::uuid
      LIMIT 1`,
    [profileId]
  );
  return current.rows[0] || null;
}

async function refreshPlanLifecycleForProfile(profileId) {
  return expireTrialIfNeeded(profileId);
}

async function getShopPlanAccess(shopId) {
  if (!shopId || !db.isDatabaseConfigured()) return { ok: true };
  await ensurePlanLifecycleColumns();

  const owner = await db.query(
    `SELECT s.owner_id::text AS owner_id
       FROM public.shops s
      WHERE s.id = $1::uuid
      LIMIT 1`,
    [shopId]
  );
  const ownerId = owner.rows[0]?.owner_id;
  if (!ownerId) return { ok: true };

  const status = await refreshPlanLifecycleForProfile(ownerId);
  if (normalizePlan(status?.plan) === 'expired' || Number(status?.shop_limit) <= 0) {
    return {
      ok: false,
      status: 402,
      body: {
        error: 'Subscription expired',
        message: 'Your 14-day trial or subscription has expired. Upgrade your plan to open this shop.',
        upgrade: true,
        plan: status?.plan || 'expired',
        trialEndsAt: isoOrNull(status?.trial_ends_at),
      },
    };
  }

  return { ok: true, status };
}

const STAFF_PLAN_EXPIRED_MESSAGE =
  'This shop\'s subscription has expired. Please contact your shop administrator to renew the plan.';

/** UI/API payload for a shop plan check — owners see upgrade copy; staff see contact-admin copy. */
function formatShopPlanAccessForViewer(access, isShopOwner) {
  if (access?.ok) return { ok: true };
  return {
    ok: false,
    plan: access?.body?.plan || 'expired',
    message: isShopOwner
      ? access?.body?.message ||
        'Your 14-day trial or subscription has expired. Upgrade your plan to open this shop.'
      : STAFF_PLAN_EXPIRED_MESSAGE,
    contactAdmin: !isShopOwner,
    upgrade: Boolean(isShopOwner),
    trialEndsAt: access?.body?.trialEndsAt || null,
  };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRenewalEmail({ plan, periodEnd, days, displayName, billingUrl }) {
  const appName = process.env.APP_NAME || 'Zentrya Biz';
  const label = planLabel(plan);
  const endDate = new Date(periodEnd).toLocaleDateString('en-PK', { dateStyle: 'medium' });
  const name = String(displayName || '').trim();
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const subject = `${appName}: Your ${label} plan renews in ${days} day${days === 1 ? '' : 's'}`;
  const billingLink = billingUrl || (getAppBaseUrl() ? `${getAppBaseUrl()}/shops` : '');

  const text = [
    greeting,
    '',
    `This is a friendly reminder that your ${label} plan on ${appName} is scheduled to renew soon.`,
    '',
    `Plan: ${label}`,
    `Renewal date: ${endDate} (in ${days} day${days === 1 ? '' : 's'})`,
    '',
    'Your subscription will continue automatically unless you change or cancel it before the renewal date.',
    billingLink ? `Manage billing: ${billingLink}` : 'Open My Shops → Billing to manage your subscription.',
    '',
    'Thank you for choosing Zentrya Biz.',
    '',
    '— The Zentrya Biz Team',
  ].join('\n');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f3ef;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#1e1b4b 0%,#4f46e5 100%);padding:28px 32px;color:#fff;">
            <div style="font-size:13px;opacity:.85;letter-spacing:.06em;text-transform:uppercase;">Subscription reminder</div>
            <div style="font-size:24px;font-weight:800;margin-top:8px;">${escapeHtml(label)} plan renewal</div>
            <div style="font-size:14px;opacity:.9;margin-top:6px;">${escapeHtml(appName)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px;color:#1e293b;">
            <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#334155;">
              Your <strong>${escapeHtml(label)}</strong> plan is scheduled to renew on
              <strong>${escapeHtml(endDate)}</strong> — that is <strong>${days} day${days === 1 ? '' : 's'}</strong> from now.
            </p>
            <table role="presentation" width="100%" style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:20px;">
              <tr><td style="padding:16px 20px;">
                <div style="font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Current plan</div>
                <div style="font-size:20px;font-weight:800;color:#4f46e5;margin-top:4px;">${escapeHtml(label)}</div>
                <div style="margin-top:14px;font-size:13px;color:#64748b;">Next billing date</div>
                <div style="font-size:16px;font-weight:700;margin-top:4px;color:#334155;">${escapeHtml(endDate)}</div>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.65;color:#475569;">
              Your subscription will renew automatically. To update your payment method, change your plan, or cancel before renewal, open Billing in your account.
            </p>
            ${
              billingLink
                ? `<p style="margin:24px 0 0;text-align:center;">
              <a href="${escapeHtml(billingLink)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:10px;">Manage billing</a>
            </p>`
                : ''
            }
            <p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#64748b;">
              Thank you for trusting ${escapeHtml(appName)} with your business.
            </p>
            <p style="margin:12px 0 0;font-size:14px;color:#334155;font-weight:600;">— The Zentrya Biz Team</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 24px;font-size:12px;color:#94a3b8;text-align:center;border-top:1px solid #f1f5f9;">
            You received this email because you have an active ${escapeHtml(label)} subscription.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  return { subject, text, html };
}

async function maybeSendPlanRenewalReminder(profileId) {
  if (!profileId || !db.isDatabaseConfigured()) return { sent: false };
  await ensurePlanLifecycleColumns();

  const result = await db.query(
    `SELECT p.id::text,
            p.plan::text AS plan,
            p.stripe_current_period_end,
            p.plan_reminder_period_end,
            z.email,
            z.username,
            z.full_name
       FROM public.profiles p
       LEFT JOIN public.zb_simple_users z ON z.id = p.id
      WHERE p.id = $1::uuid
      LIMIT 1`,
    [profileId]
  );
  const row = result.rows[0];
  if (!row) return { sent: false };

  const plan = normalizePlan(row.plan);
  if (!['starter', 'pro', 'premium'].includes(plan)) return { sent: false };

  const periodEnd = row.stripe_current_period_end ? new Date(row.stripe_current_period_end) : null;
  if (!periodEnd || !Number.isFinite(periodEnd.getTime())) return { sent: false };

  const days = daysUntil(periodEnd);
  if (days == null || days > RENEWAL_REMINDER_DAYS_BEFORE) return { sent: false };
  if (periodEnd.getTime() < Date.now()) return { sent: false };

  const lastCovered = row.plan_reminder_period_end ? new Date(row.plan_reminder_period_end).getTime() : 0;
  if (lastCovered === periodEnd.getTime()) return { sent: false };

  const to = String(row.email || row.username || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { sent: false };

  const displayName = String(row.full_name || '').trim() || String(row.username || '').split('@')[0] || '';
  const fe = getAppBaseUrl();
  const billingUrl = fe ? `${fe}/shops` : '';
  const email = buildRenewalEmail({ plan, periodEnd, days, displayName, billingUrl });
  await sendTransactionalEmail({ to, ...email });
  await db.query(
    `UPDATE public.profiles
        SET plan_reminder_last_sent_at = now(),
            plan_reminder_period_end = $2
      WHERE id = $1::uuid`,
    [profileId, periodEnd.toISOString()]
  );

  return { sent: true };
}

async function sendDuePlanRenewalReminders({ limit = 100 } = {}) {
  if (!db.isDatabaseConfigured()) return { checked: 0, sent: 0 };
  await ensurePlanLifecycleColumns();

  const due = await db.query(
    `SELECT id::text
       FROM public.profiles
      WHERE lower(coalesce(plan::text, 'trial')) IN ('starter', 'pro', 'premium')
        AND stripe_current_period_end IS NOT NULL
        AND stripe_current_period_end >= now()
        AND stripe_current_period_end <= now() + ($1::int * interval '1 day')
        AND (
          plan_reminder_period_end IS NULL
          OR plan_reminder_period_end IS DISTINCT FROM stripe_current_period_end
        )
      ORDER BY stripe_current_period_end ASC
      LIMIT $2`,
    [RENEWAL_REMINDER_DAYS_BEFORE, Math.max(1, Math.min(Number(limit) || 100, 500))]
  );

  let sent = 0;
  for (const row of due.rows) {
    try {
      const result = await maybeSendPlanRenewalReminder(row.id);
      if (result.sent) sent += 1;
    } catch (e) {
      console.warn('[planLifecycle] reminder failed:', row.id, e.message);
    }
  }

  return { checked: due.rows.length, sent };
}

module.exports = {
  TRIAL_DAYS,
  planLabel,
  ensurePlanLifecycleColumns,
  refreshPlanLifecycleForProfile,
  getShopPlanAccess,
  formatShopPlanAccessForViewer,
  STAFF_PLAN_EXPIRED_MESSAGE,
  computeTrialProgress,
  maybeSendPlanRenewalReminder,
  sendDuePlanRenewalReminders,
};
