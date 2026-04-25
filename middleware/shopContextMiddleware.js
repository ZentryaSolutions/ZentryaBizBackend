/**
 * Multi-tenant shop scope: requires x-shop-id (UUID) and membership in shop_users.
 * Prerequisite: users.zb_profile_id = profiles.id (set by /api/auth/zb-simple-session).
 */

const db = require('../db');

function parseShopUuid(headerVal) {
  if (!headerVal || typeof headerVal !== 'string') return null;
  const v = headerVal.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;
}

async function requireShopContext(req, res, next) {
  try {
    const shopId = parseShopUuid(req.headers['x-shop-id']);
    if (!shopId) {
      return res.status(400).json({
        error: 'Shop required',
        message: 'Send header x-shop-id with the active shop UUID (from shop selection).',
      });
    }

    const uidResult = await db.query(
      `SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`,
      [req.user.user_id]
    );
    if (uidResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    const profileId = uidResult.rows[0].zb_profile_id;
    if (!profileId) {
      return res.status(403).json({
        error: 'Account not linked',
        message: 'Log out and log in again after updating the app (zb_profile_id required for multi-shop).',
      });
    }

    const mem = await db.query(
      `SELECT 1 FROM shop_users WHERE user_id = $1::uuid AND shop_id = $2::uuid`,
      [profileId, shopId]
    );
    if (mem.rows.length === 0) {
      return res.status(403).json({
        error: 'Shop access denied',
        message: 'You are not a member of this shop.',
      });
    }

    req.shopId = shopId;
    next();
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({
        error: 'Schema not ready',
        message: 'Run database/zentrya_biz_pos_shop_scoping.sql and ensure shop_users exists.',
      });
    }
    console.error('[requireShopContext]', e);
    return res.status(500).json({ error: 'Shop context failed', message: e.message });
  }
}

module.exports = { requireShopContext, parseShopUuid };
