/**
 * Subscription plan checks via public.profiles (linked from users.zb_profile_id).
 * trial/starter = rank 1, pro = 2, premium = 3, expired = 0.
 */

const db = require('../db');

function planRank(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'expired') return 0;
  if (p === 'trial' || p === 'starter') return 1;
  if (p === 'pro') return 2;
  if (p === 'premium') return 3;
  return 1;
}

async function getPlanForUser(userId) {
  const r = await db.query(
    `SELECT p.plan::text AS plan
     FROM users u
     JOIN public.profiles p ON p.id = u.zb_profile_id
     WHERE u.user_id = $1 AND u.is_active = true`,
    [userId]
  );
  return r.rows[0]?.plan ?? null;
}

function requirePlanMin(minRank) {
  return async function planMinMiddleware(req, res, next) {
    try {
      if (!db.isDatabaseConfigured()) {
        return next();
      }
      const plan = await getPlanForUser(req.user.user_id);
      if (!plan) {
        return res.status(403).json({
          error: 'Plan required',
          message: 'Could not determine subscription plan.',
          upgrade: true,
        });
      }
      const rank = planRank(plan);
      if (rank === 0) {
        return res.status(403).json({
          error: 'Subscription expired',
          message: 'Renew your plan to use this feature.',
          upgrade: true,
        });
      }
      if (rank < minRank) {
        return res.status(403).json({
          error: 'Upgrade required',
          message:
            minRank >= 3
              ? 'This feature requires a Premium plan.'
              : 'This feature requires Pro or Premium.',
          upgrade: true,
        });
      }
      return next();
    } catch (e) {
      console.error('[planMiddleware]', e);
      return next(e);
    }
  };
}

const requireProPlan = requirePlanMin(2);
const requirePremiumPlan = requirePlanMin(3);

module.exports = {
  planRank,
  getPlanForUser,
  requireProPlan,
  requirePremiumPlan,
};
