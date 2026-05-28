const db = require('../db');
const { shopLimitForPlan } = require('../lib/planShopLimits');
const { sendTransactionalEmail } = require('./transactionalMail');

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

function buildRenewalEmail({ plan, periodEnd, days }) {
  const appName = process.env.APP_NAME || 'Zentrya Biz';
  const label = planLabel(plan);
  const endDate = new Date(periodEnd).toLocaleDateString('en-PK', { dateStyle: 'medium' });
  const subject = `${appName}: ${label} plan renews in ${days} day${days === 1 ? '' : 's'}`;
  const text = [
    `Your current plan is ${label}.`,
    '',
    `Your next payment is scheduled around ${endDate}.`,
    `That is in ${days} day${days === 1 ? '' : 's'}.`,
    '',
    'If you need to change or cancel your plan, open Billing in your account before the renewal date.',
  ].join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 12px;font-size:20px">${label} plan renewal reminder</h2>
        <p style="margin:0 0 12px;line-height:1.6">Your current plan is <strong>${label}</strong>.</p>
        <p style="margin:0 0 12px;line-height:1.6">Your next payment is scheduled around <strong>${endDate}</strong>, in <strong>${days} day${days === 1 ? '' : 's'}</strong>.</p>
        <p style="margin:0;color:#475569;line-height:1.6">Open Billing before the renewal date if you want to change or cancel your plan.</p>
      </div>
    </div>`;
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
            z.username
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

  const email = buildRenewalEmail({ plan, periodEnd, days });
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
  ensurePlanLifecycleColumns,
  refreshPlanLifecycleForProfile,
  getShopPlanAccess,
  maybeSendPlanRenewalReminder,
  sendDuePlanRenewalReminders,
};
