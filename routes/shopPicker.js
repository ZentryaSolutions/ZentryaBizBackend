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
const { resolveShopLimit, isUnlimitedShopLimit } = require('../lib/planShopLimits');

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

async function resolveProfileId(req) {
  const uidRow = await db.query(
    `SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`,
    [req.user.user_id]
  );
  return uidRow.rows[0]?.zb_profile_id || null;
}

/** Ensure owner shops have a shop_users row (fixes list gaps after API-only creates). */
async function repairOwnerShopLinks(profileId) {
  const shopRoleCandidates = ['owner', 'admin', 'administrator'];
  const missing = await db.query(
    `SELECT s.id::text AS id
       FROM public.shops s
      WHERE s.owner_id = $1::uuid
        AND NOT EXISTS (
          SELECT 1 FROM public.shop_users su
           WHERE su.shop_id = s.id AND su.user_id = $1::uuid
        )`,
    [profileId]
  );
  for (const row of missing.rows || []) {
    const shopId = row.id;
    for (const roleTry of shopRoleCandidates) {
      try {
        await db.query(
          `INSERT INTO public.shop_users (shop_id, user_id, role)
           VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
          [shopId, profileId, roleTry]
        );
        break;
      } catch (e) {
        if (e.code === '23505') break;
      }
    }
  }
}

/**
 * Shops for My Shops page (owner + membership). Uses Postgres, not Supabase RLS joins.
 */
router.get('/my-shops', async (req, res) => {
  try {
    const profileId = await resolveProfileId(req);
    if (!profileId) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }

    await repairOwnerShopLinks(profileId);

    const listRes = await db.query(
      `SELECT s.id::text AS id,
              s.name,
              s.phone,
              s.address,
              s.business_type,
              s.city,
              s.currency,
              s.created_at,
              COALESCE(
                (SELECT su.role::text
                   FROM public.shop_users su
                  WHERE su.shop_id = s.id AND su.user_id = $1::uuid
                  ORDER BY CASE su.role::text
                    WHEN 'owner' THEN 0
                    WHEN 'admin' THEN 1
                    WHEN 'administrator' THEN 2
                    ELSE 3
                  END
                  LIMIT 1),
                'owner'
              ) AS role
         FROM public.shops s
        WHERE s.owner_id = $1::uuid
           OR EXISTS (
             SELECT 1 FROM public.shop_users su
              WHERE su.shop_id = s.id AND su.user_id = $1::uuid
           )
        ORDER BY s.created_at DESC`,
      [profileId]
    );

    return res.json({ ok: true, shops: listRes.rows || [] });
  } catch (e) {
    console.error('[shop-picker] my-shops:', e);
    return res.status(500).json({ error: e.message || 'Failed to load shops' });
  }
});

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

/**
 * Create shop (owner) with plan shop_limit enforced server-side.
 * Body: { name, phone, address?, business_type?, city?, currency? }
 */
router.post('/create-shop', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const phoneDigits = phone.replace(/\D/g, '');
    if (!name) return res.status(400).json({ error: 'Shop name is required' });
    if (!phone || phoneDigits.length < 10) {
      return res.status(400).json({ error: 'Enter a valid mobile number (at least 10 digits).' });
    }

    const profileId = await resolveProfileId(req);
    if (!profileId) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }

    let prof;
    try {
      prof = await db.query(
        `SELECT plan::text AS plan, shop_limit FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
        [profileId]
      );
    } catch (colErr) {
      prof = await db.query(
        `SELECT plan::text AS plan FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
        [profileId]
      );
    }
    if (!prof.rows.length) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const planRow = prof.rows[0];
    const limit = resolveShopLimit(planRow);
    if (limit <= 0) {
      return res.status(403).json({
        error: 'Subscription expired',
        message: 'Renew your plan to create shops.',
        upgrade: true,
      });
    }

    if (!isUnlimitedShopLimit(limit)) {
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS c FROM public.shops WHERE owner_id = $1::uuid`,
        [profileId]
      );
      const used = Number(countRes.rows[0]?.c) || 0;
      if (used >= limit) {
        return res.status(403).json({
          error: 'Shop limit reached',
          message: `Your plan allows ${limit} shop${limit === 1 ? '' : 's'}. Upgrade to add more.`,
          shopLimit: limit,
          shopsUsed: used,
          upgrade: true,
        });
      }
    }

    const address = req.body?.address != null ? String(req.body.address).trim() || null : null;
    const businessType = String(req.body?.business_type || 'General').trim() || 'General';
    const city = req.body?.city != null ? String(req.body.city).trim() || null : null;
    const currency = String(req.body?.currency || 'PKR').trim() || 'PKR';

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const shopRes = await client.query(
        `INSERT INTO public.shops (owner_id, name, phone, address, business_type, city, currency)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
         RETURNING id::text AS id`,
        [profileId, name, phone, address, businessType, city, currency]
      );
      const shopId = shopRes.rows[0]?.id;
      if (!shopId) throw new Error('Shop insert failed');

      const shopRoleCandidates = ['owner', 'admin', 'administrator'];
      let linked = false;
      for (const roleTry of shopRoleCandidates) {
        try {
          await client.query(
            `INSERT INTO public.shop_users (shop_id, user_id, role)
             VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
            [shopId, profileId, roleTry]
          );
          linked = true;
          break;
        } catch (e) {
          if (e.code === '23505') {
            linked = true;
            break;
          }
        }
      }
      if (!linked) {
        throw new Error('Could not link shop to owner');
      }

      await client.query('COMMIT');
      const shopRow = await db.query(
        `SELECT id::text AS id, name, phone, address, business_type, city, currency, created_at
           FROM public.shops WHERE id = $1::uuid`,
        [shopId]
      );
      const shop = shopRow.rows[0] || { id: shopId, name };
      return res.status(201).json({
        ok: true,
        shopId,
        id: shopId,
        shop: { ...shop, role: 'owner', memberRole: 'owner' },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[shop-picker] create-shop:', e);
    return res.status(500).json({ error: e.message || 'Failed to create shop' });
  }
});

module.exports = router;

