const express = require('express');
const router = express.Router();
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

/**
 * Create Stripe Checkout Session for subscription.
 * Frontend passes:
 *  - priceId (Starter/Pro/Premium price ID)
 *  - successUrl, cancelUrl
 *  - customerEmail (optional; Stripe can create customer)
 *
 * IMPORTANT: We do NOT store card details in our DB. Stripe handles payment methods.
 */
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { priceId, successUrl, cancelUrl, customerEmail, userId } = req.body || {};
    if (!priceId || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'priceId, successUrl, cancelUrl are required' });
    }

    // userId should be auth.users.id (uuid). In a later step we will derive it from Supabase JWT.
    if (!userId) {
      return res.status(400).json({ error: 'userId is required (auth.users.id)' });
    }

    const stripe = getStripe();

    // Ensure we have a stripe_customer_id on profiles (create if missing)
    const prof = await db.query(
      `SELECT id, stripe_customer_id
       FROM public.profiles
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );

    if (prof.rowCount === 0) {
      return res.status(404).json({ error: 'Profile not found. Ensure public.profiles row exists for this user.' });
    }

    let stripeCustomerId = prof.rows[0].stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: customerEmail || undefined,
        metadata: { supabase_user_id: userId },
      });
      stripeCustomerId = customer.id;
      await db.query(
        `UPDATE public.profiles
         SET stripe_customer_id = $2
         WHERE id = $1`,
        [userId, stripeCustomerId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      customer_update: { address: 'auto', name: 'auto' },
      subscription_data: {
        metadata: { supabase_user_id: userId },
      },
      metadata: { supabase_user_id: userId },
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('[Billing] create-checkout-session error:', e);
    return res.status(500).json({ error: e.message || 'Failed to create checkout session' });
  }
});

/**
 * Create Stripe Customer Portal session.
 */
router.post('/create-portal-session', async (req, res) => {
  try {
    const { returnUrl, userId } = req.body || {};
    if (!returnUrl || !userId) {
      return res.status(400).json({ error: 'returnUrl and userId are required' });
    }

    const stripe = getStripe();
    const prof = await db.query(
      `SELECT stripe_customer_id
       FROM public.profiles
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    const stripeCustomerId = prof.rows?.[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No stripe_customer_id on profile yet.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('[Billing] create-portal-session error:', e);
    return res.status(500).json({ error: e.message || 'Failed to create portal session' });
  }
});

module.exports = router;

