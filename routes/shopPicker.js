const express = require('express');
const router = express.Router();
const db = require('../db');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeShopUuidList(ids) {
  return ids.map((x) => String(x).trim()).filter((id) => UUID_RE.test(id));
}
const { requireAuth } = require('../middleware/authMiddleware');
const { getBusinessTodayDateString } = require('../utils/businessDate');

/**
 * Shop picker quick stats (multi-shop).
 * - Requires auth (x-session-id)
 * - Does NOT require x-shop-id because the user is selecting a shop
 * - Validates that the user belongs to each shop via `shop_users`
 *
 * Body: { shopIds: (string|number)[] }
 * Response: { ok: true, stats: { [shopId: string]: { todaySales: number, productCount: number } } }
 */
router.use(requireAuth);

router.post('/quick-stats', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.shopIds) ? req.body.shopIds : [];
    let shopIds = raw
      .map((x) => (x == null ? '' : String(x).trim()))
      .filter(Boolean)
      .slice(0, 50);

    shopIds = normalizeShopUuidList(shopIds);
    if (shopIds.length === 0) {
      return res.json({ ok: true, stats: {} });
    }

    const uidRow = await db.query(
      `SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`,
      [req.user.user_id]
    );
    const profileId = uidRow.rows[0]?.zb_profile_id;
    if (!profileId) {
      return res.json({ ok: true, stats: {} });
    }

    // shop_users.user_id is the Supabase/Zentrya profile UUID, not users.user_id (integer)
    const allowedRes = await db.query(
      `SELECT shop_id::text AS shop_id
         FROM shop_users
        WHERE user_id = $1::uuid
          AND shop_id = ANY($2::uuid[])`,
      [profileId, shopIds]
    );
    const allowed = new Set((allowedRes.rows || []).map((r) => String(r.shop_id || '').trim()));
    const allowedIds = shopIds.filter((id) => allowed.has(String(id)));

    if (allowedIds.length === 0) {
      return res.json({ ok: true, stats: {} });
    }

    const todayStr = getBusinessTodayDateString(); // YYYY-MM-DD (server/business TZ)

    const [salesRes, prodRes] = await Promise.all([
      db.query(
        `SELECT shop_id, COALESCE(SUM(total_amount), 0) AS total
           FROM sales
          WHERE shop_id = ANY($1::text[])
            AND date = $2::date
          GROUP BY shop_id`,
        [allowedIds, todayStr]
      ),
      db.query(
        `SELECT shop_id, COUNT(*)::int AS cnt
           FROM products
          WHERE shop_id = ANY($1::text[])
          GROUP BY shop_id`,
        [allowedIds]
      ),
    ]);

    const byShop = {};
    allowedIds.forEach((id) => {
      byShop[String(id)] = { todaySales: 0, productCount: 0 };
    });

    (salesRes.rows || []).forEach((r) => {
      const sid = String(r.shop_id);
      if (!byShop[sid]) byShop[sid] = { todaySales: 0, productCount: 0 };
      byShop[sid].todaySales = Number(r.total) || 0;
    });
    (prodRes.rows || []).forEach((r) => {
      const sid = String(r.shop_id);
      if (!byShop[sid]) byShop[sid] = { todaySales: 0, productCount: 0 };
      byShop[sid].productCount = Number(r.cnt) || 0;
    });

    return res.json({ ok: true, stats: byShop });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'quick-stats failed' });
  }
});

module.exports = router;

