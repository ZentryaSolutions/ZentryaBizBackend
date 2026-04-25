const Stripe = require('stripe');
const db = require('../db');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const e = new Error('Missing STRIPE_SECRET_KEY in backend/.env');
    e.code = 'MISSING_STRIPE_SECRET_KEY';
    throw e;
  }
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

function mapPriceToPlan(priceId) {
  const starter = process.env.STRIPE_PRICE_STARTER;
  const pro = process.env.STRIPE_PRICE_PRO;
  const premium = process.env.STRIPE_PRICE_PREMIUM;
  if (starter && priceId === starter) return 'starter';
  if (pro && priceId === pro) return 'pro';
  if (premium && priceId === premium) return 'premium';
  return null;
}

/** Align with pricing: Trial/Starter 1, Pro 3, Premium “unlimited” as high cap (schema requires >= 1). */
function shopLimitForPlan(plan) {
  switch (plan) {
    case 'trial':
    case 'starter':
      return 1;
    case 'pro':
      return 3;
    case 'premium':
      return 99999;
    case 'expired':
    default:
      return 1;
  }
}

async function upsertFromSubscription(sub) {
  const userId = sub.metadata?.supabase_user_id || sub.customer?.metadata?.supabase_user_id;
  if (!userId) {
    console.warn('[StripeWebhook] Missing supabase_user_id metadata; cannot sync subscription');
    return;
  }

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id || null;
  const mappedPlan = mapPriceToPlan(priceId) || 'starter';

  const isActive = ['active', 'trialing'].includes(sub.status);
  const plan = isActive ? mappedPlan : 'expired';
  const shopLimit = shopLimitForPlan(plan);
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

  // Fetch default payment method details (NON-SENSITIVE)
  let pmBrand = null;
  let pmLast4 = null;
  let defaultPmId = null;

  try {
    defaultPmId = typeof sub.default_payment_method === 'string'
      ? sub.default_payment_method
      : sub.default_payment_method?.id || null;
  } catch {}

  if (defaultPmId) {
    try {
      const stripe = getStripe();
      const pm = await stripe.paymentMethods.retrieve(defaultPmId);
      pmBrand = pm?.card?.brand || null;
      pmLast4 = pm?.card?.last4 || null;
    } catch (e) {
      console.warn('[StripeWebhook] Unable to retrieve payment method details:', e.message);
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
     WHERE id = $1`,
    [userId, plan, sub.id, priceId, periodEnd, defaultPmId, pmBrand, pmLast4, shopLimit]
  );
}

module.exports = async function stripeWebhookHandler(req, res) {
  try {
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(500).send('Missing STRIPE_WEBHOOK_SECRET');
    }

    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('[StripeWebhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await upsertFromSubscription(event.data.object);
        break;
      }
      case 'invoice.payment_failed': {
        // optional: flag account; don't cut off immediately
        break;
      }
      case 'invoice.payment_succeeded': {
        // subscription update event usually follows; keep for future hooks
        break;
      }
      default:
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('[StripeWebhook] handler error:', e);
    return res.status(500).send('Server error');
  }
};

