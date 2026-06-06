/**
 * Sync Stripe subscription → public.profiles (plan, shop_limit) + optional purchase email.
 */

const Stripe = require('stripe');
const db = require('../db');
const { shopLimitForPlan } = require('../lib/planShopLimits');
const { sendTransactionalEmail } = require('./transactionalMail');
const { buildPlanPurchaseEmail } = require('./planPurchaseEmailContent');
const { getAppBaseUrl } = require('./appBaseUrl');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const e = new Error('Missing STRIPE_SECRET_KEY');
    e.code = 'MISSING_STRIPE_SECRET_KEY';
    throw e;
  }
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

function mapPriceToPlan(priceId) {
  const starter = String(process.env.STRIPE_PRICE_STARTER || '').trim();
  const pro = String(process.env.STRIPE_PRICE_PRO || '').trim();
  const premium = String(process.env.STRIPE_PRICE_PREMIUM || '').trim();
  const id = String(priceId || '').trim();
  if (!id) return null;
  if (starter && id === starter) return 'starter';
  if (pro && id === pro) return 'pro';
  if (premium && id === premium) return 'premium';
  console.warn('[stripePlanSync] Unknown Stripe price id:', id, { pro, premium, starter });
  return null;
}

function formatAmountFromPrice(price) {
  if (!price) return null;
  const unit = price.unit_amount;
  const cur = String(price.currency || 'pkr').toUpperCase();
  if (unit == null) return null;
  const major = unit / 100;
  if (cur === 'PKR') return `Rs ${major.toLocaleString('en-PK')}`;
  return `${major} ${cur}`;
}

async function resolveSupabaseUserId(stripe, sub) {
  let userId = sub.metadata?.supabase_user_id;
  if (userId) return userId;

  const custId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!custId) return null;

  try {
    const customer = await stripe.customers.retrieve(custId);
    userId = customer.metadata?.supabase_user_id || null;
    if (userId) return userId;
  } catch (e) {
    console.warn('[stripePlanSync] customer retrieve:', e.message);
  }

  try {
    const row = await db.query(
      `SELECT id::text AS id FROM public.profiles WHERE stripe_customer_id = $1 LIMIT 1`,
      [custId]
    );
    return row.rows[0]?.id || null;
  } catch (e) {
    console.warn('[stripePlanSync] profile lookup by customer:', e.message);
    return null;
  }
}

async function sendPlanPurchaseEmail({ to, plan, price, periodEnd }) {
  const email = String(to || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return;

  const appName = process.env.APP_NAME || 'Zentrya Biz';
  const fe = getAppBaseUrl();
  const shopsUrl = fe ? `${fe}/shops` : '';

  const amountLine = formatAmountFromPrice(price) || undefined;
  const { subject, text, html } = buildPlanPurchaseEmail({
    planKey: plan,
    amountLine,
    periodEnd,
    appName,
    shopsUrl,
  });

  try {
    await sendTransactionalEmail({ to: email, subject, text, html });
    console.log('[stripePlanSync] Purchase confirmation email sent to', email);
  } catch (e) {
    console.warn('[stripePlanSync] Purchase email failed:', e.message);
  }
}

/**
 * @returns {{ userId: string, plan: string, shopLimit: number } | null}
 */
async function syncProfileFromSubscription(sub, { sendEmail = false } = {}) {
  const stripe = getStripe();
  const userId = await resolveSupabaseUserId(stripe, sub);
  if (!userId) {
    console.warn('[stripePlanSync] Missing supabase_user_id; cannot sync subscription', sub.id);
    return null;
  }

  let previousPlan = 'trial';
  try {
    const prev = await db.query(`SELECT plan::text AS plan FROM public.profiles WHERE id = $1::uuid`, [
      userId,
    ]);
    previousPlan = String(prev.rows[0]?.plan || 'trial').toLowerCase();
  } catch {
    /* ignore */
  }

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id || null;
  const priceObj = item?.price || null;
  let mappedPlan = mapPriceToPlan(priceId);
  if (!mappedPlan) {
    mappedPlan = 'pro';
    console.warn('[stripePlanSync] Falling back plan=pro for price', priceId);
  }

  const isActive = ['active', 'trialing'].includes(sub.status);
  const plan = isActive ? mappedPlan : 'expired';
  const shopLimit = shopLimitForPlan(plan);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  let pmBrand = null;
  let pmLast4 = null;
  let defaultPmId = null;
  try {
    defaultPmId =
      typeof sub.default_payment_method === 'string'
        ? sub.default_payment_method
        : sub.default_payment_method?.id || null;
  } catch {
    /* ignore */
  }
  if (defaultPmId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(defaultPmId);
      pmBrand = pm?.card?.brand || null;
      pmLast4 = pm?.card?.last4 || null;
    } catch (e) {
      console.warn('[stripePlanSync] payment method:', e.message);
    }
  }

  await db.query(
    `UPDATE public.profiles
     SET plan = $2::public.zb_plan,
         shop_limit = $9,
         stripe_subscription_id = $3,
         stripe_price_id = $4,
         stripe_current_period_end = $5,
         stripe_default_payment_method_id = $6,
         payment_method_brand = $7,
         payment_method_last4 = $8
     WHERE id = $1::uuid`,
    [userId, plan, sub.id, priceId, periodEnd, defaultPmId, pmBrand, pmLast4, shopLimit]
  );

  const upgradedFromTrial = ['trial', 'expired', ''].includes(previousPlan) && isActive;
  if (sendEmail && upgradedFromTrial) {
    let to = sub.customer_email || null;
    if (!to && sub.customer) {
      const custId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (custId) {
        try {
          const c = await stripe.customers.retrieve(custId);
          to = c.email || null;
        } catch {
          /* ignore */
        }
      }
    }
    if (!to) {
      try {
        const pr = await db.query(
          `SELECT u.email
           FROM users u
           WHERE u.zb_profile_id = $1::uuid AND u.is_active = true
           ORDER BY u.user_id ASC
           LIMIT 1`,
          [userId]
        );
        to = pr.rows[0]?.email || null;
      } catch {
        /* ignore */
      }
    }
    await sendPlanPurchaseEmail({ to, plan, price: priceObj, periodEnd });
  }

  return { userId, plan, shopLimit };
}

/**
 * Pull latest subscription from Stripe for profile id (auth user uuid).
 */
async function syncSubscriptionForUserId(userId, { sendEmail = false } = {}) {
  const prof = await db.query(
    `SELECT stripe_customer_id, plan::text AS plan FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
    [userId]
  );
  if (!prof.rows.length) {
    const e = new Error('Profile not found');
    e.status = 404;
    throw e;
  }

  const stripeCustomerId = prof.rows[0].stripe_customer_id;
  if (!stripeCustomerId) {
    const e = new Error('No Stripe customer on profile yet. Complete checkout first.');
    e.status = 400;
    throw e;
  }

  const stripe = getStripe();
  const subs = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: 'all',
    limit: 5,
    expand: ['data.default_payment_method', 'data.items.data.price'],
  });

  const sub =
    subs.data.find((s) => ['active', 'trialing'].includes(s.status)) ||
    subs.data.sort((a, b) => (b.created || 0) - (a.created || 0))[0];

  if (!sub) {
    return {
      ok: true,
      synced: false,
      plan: prof.rows[0].plan,
      message: 'No subscription found in Stripe yet.',
    };
  }

  if (!sub.metadata?.supabase_user_id) {
    try {
      await stripe.subscriptions.update(sub.id, {
        metadata: { ...sub.metadata, supabase_user_id: userId },
      });
      sub.metadata = { ...(sub.metadata || {}), supabase_user_id: userId };
    } catch (e) {
      console.warn('[stripePlanSync] metadata update:', e.message);
    }
  }

  const result = await syncProfileFromSubscription(sub, { sendEmail });
  return {
    ok: true,
    synced: true,
    plan: result?.plan,
    shopLimit: result?.shopLimit,
  };
}

async function handleCheckoutSessionCompleted(session, { sendEmail = true } = {}) {
  if (session.mode !== 'subscription' || !session.subscription) return null;

  const stripe = getStripe();
  const subId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription.id;

  const sub = await stripe.subscriptions.retrieve(subId, {
    expand: ['default_payment_method', 'items.data.price'],
  });

  const uid = session.metadata?.supabase_user_id || sub.metadata?.supabase_user_id;
  if (uid && !sub.metadata?.supabase_user_id) {
    try {
      await stripe.subscriptions.update(sub.id, {
        metadata: { ...sub.metadata, supabase_user_id: uid },
      });
      sub.metadata = { ...(sub.metadata || {}), supabase_user_id: uid };
    } catch (e) {
      console.warn('[stripePlanSync] checkout metadata:', e.message);
    }
  }

  return syncProfileFromSubscription(sub, { sendEmail });
}

module.exports = {
  getStripe,
  mapPriceToPlan,
  syncProfileFromSubscription,
  syncSubscriptionForUserId,
  handleCheckoutSessionCompleted,
};
