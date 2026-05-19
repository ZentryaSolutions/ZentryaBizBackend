const {
  syncProfileFromSubscription,
  handleCheckoutSessionCompleted,
} = require('../utils/stripePlanSync');

module.exports = async function stripeWebhookHandler(req, res) {
  try {
    const { getStripe } = require('../utils/stripePlanSync');
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
      case 'checkout.session.completed': {
        await handleCheckoutSessionCompleted(event.data.object, { sendEmail: true });
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncProfileFromSubscription(event.data.object, { sendEmail: false });
        break;
      }
      case 'invoice.payment_failed': {
        break;
      }
      case 'invoice.payment_succeeded': {
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
