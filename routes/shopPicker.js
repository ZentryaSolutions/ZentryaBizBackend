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
const {
  refreshPlanLifecycleForProfile,
  getShopPlanAccess,
  formatShopPlanAccessForViewer,
  computeTrialProgress,
  TRIAL_DAYS,
} = require('../utils/planLifecycle');
const { DEFAULT_TZ } = require('../utils/businessDate');

router.use(requireAuth);

async function insertShopRow(client, row) {
  const {
    ownerId,
    name,
    phone,
    address,
    businessType,
    city,
    currency,
  } = row;
  try {
    return await client.query(
      `INSERT INTO public.shops (owner_id, name, phone, address, business_type, city, currency)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [ownerId, name, phone, address, businessType, city, currency]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
    return client.query(
      `INSERT INTO public.shops (owner_id, name, business_type, city, currency)
       VALUES ($1::uuid, $2, $3, $4, $5)
       RETURNING id::text AS id`,
      [ownerId, name, businessType, city, currency]
    );
  }
}

async function createShopViaRpc(ownerId, payload) {
  try {
    const rpc = await db.query(
      `SELECT public.zb_create_shop(
         $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text
       ) AS data`,
      [
        ownerId,
        payload.name,
        payload.phone,
        payload.address,
        payload.businessType,
        payload.city,
        payload.currency,
      ]
    );
    const raw = rpc.rows[0]?.data;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (data?.ok && (data.shopId || data.id)) return data;
    if (data?.error) {
      const err = new Error(String(data.error));
      err.code = 'ZB_CREATE_SHOP_RPC';
      throw err;
    }
  } catch (e) {
    if (e.code === '42883' || /zb_create_shop/i.test(String(e.message || ''))) {
      return null;
    }
    throw e;
  }
  return null;
}

/**
 * Shop picker quick stats (multi-shop).
 * - Requires auth (x-session-id)
 * - Does NOT require x-shop-id because the user is selecting a shop
 * - Validates that the user belongs to each shop via `shop_users`
 *
 * Body: { shopIds: (string|number)[] }
 * Response: { ok: true, stats: { [shopId: string]: { todaySales: number, productCount: number } } }
 */

async function resolveProfileId(req) {
  const headerId = String(req.headers['x-zb-profile-id'] || '').trim();
  if (UUID_RE.test(headerId)) return headerId;

  const uidRow = await db.query(
    `SELECT zb_profile_id::text AS zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`,
    [req.user.user_id]
  );
  return uidRow.rows[0]?.zb_profile_id || null;
}

/** Collect every profile UUID tied to this login (fixes legacy split zb_simple_users vs profiles ids). */
async function resolveLinkedProfileIds(req) {
  const base = await resolveProfileId(req);
  if (!base) return [];

  const ids = new Set([String(base)]);

  const linkRes = await db.query(
    `SELECT DISTINCT x.id::text AS id
       FROM (
         SELECT u.zb_profile_id AS id
           FROM users u
          WHERE u.user_id = $1 AND u.is_active = true AND u.zb_profile_id IS NOT NULL
         UNION
         SELECT su.user_id AS id
           FROM shop_users su
          WHERE su.user_id = $2::uuid
         UNION
         SELECT s.owner_id AS id
           FROM shops s
          WHERE s.owner_id = $2::uuid
       ) x
      WHERE x.id IS NOT NULL`,
    [req.user.user_id, base]
  );
  (linkRes.rows || []).forEach((r) => {
    const id = String(r.id || '').trim();
    if (UUID_RE.test(id)) ids.add(id);
  });

  return [...ids];
}

/** Ensure owner shops have shop_users rows for every linked profile id. */
async function repairOwnerShopLinks(profileIds) {
  const ids = (profileIds || []).filter((id) => UUID_RE.test(String(id)));
  if (!ids.length) return;

  const shopRoleCandidates = ['owner', 'admin', 'administrator'];
  const missing = await db.query(
    `SELECT s.id::text AS shop_id, s.owner_id::text AS owner_id
       FROM public.shops s
      WHERE s.owner_id = ANY($1::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM public.shop_users su
           WHERE su.shop_id = s.id AND su.user_id = s.owner_id
        )`,
    [ids]
  );

  for (const row of missing.rows || []) {
    const shopId = row.shop_id;
    const linkAs = UUID_RE.test(String(row.owner_id || '')) ? row.owner_id : ids[0];
    for (const roleTry of shopRoleCandidates) {
      try {
        await db.query(
          `INSERT INTO public.shop_users (shop_id, user_id, role)
           VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
          [shopId, linkAs, roleTry]
        );
        break;
      } catch (e) {
        if (e.code === '23505') break;
      }
    }
  }
}

/**
 * Plan / trial status (expires trial when due, returns fresh profile plan fields).
 */
router.get('/plan-status', async (req, res) => {
  try {
    const ownerId = await resolveProfileId(req);
    if (!ownerId) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }
    const status = await refreshPlanLifecycleForProfile(ownerId);
    const trial = computeTrialProgress(status);
    return res.json({
      ok: true,
      plan: status?.plan || 'trial',
      shop_limit: status?.shop_limit,
      trial_started_at: status?.trial_started_at || null,
      trial_ends_at: status?.trial_ends_at || null,
      trial_day: trial?.day ?? null,
      trial_total: trial?.total ?? TRIAL_DAYS,
      trial_days_left: trial?.daysLeft ?? null,
      trial_expired: Boolean(trial?.expired),
      business_timezone: DEFAULT_TZ,
    });
  } catch (e) {
    console.error('[shop-picker] plan-status:', e);
    return res.status(500).json({ error: e.message || 'Failed to load plan status' });
  }
});

/**
 * Verify owner plan allows opening a shop (trial not expired, etc.).
 */
async function buildShopPlanAccessMap(shopRows, viewerProfileId) {
  const out = {};
  for (const row of shopRows || []) {
    const shopId = String(row.id || '').trim();
    if (!UUID_RE.test(shopId)) continue;
    const access = await getShopPlanAccess(shopId);
    const isOwner =
      viewerProfileId && String(row.owner_id || '') === String(viewerProfileId);
    out[shopId] = formatShopPlanAccessForViewer(access, isOwner);
  }
  return out;
}

router.get('/shop-access/:shopId', async (req, res) => {
  try {
    const shopId = String(req.params.shopId || '').trim();
    if (!UUID_RE.test(shopId)) {
      return res.status(400).json({ error: 'Invalid shop id' });
    }
    const profileIds = await resolveLinkedProfileIds(req);
    if (!profileIds.length) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }

    const mem = await db.query(
      `SELECT 1 FROM public.shops s
        WHERE s.id = $1::uuid
          AND (
            s.owner_id = ANY($2::uuid[])
            OR EXISTS (
              SELECT 1 FROM public.shop_users su
               WHERE su.shop_id = s.id AND su.user_id = ANY($2::uuid[])
            )
          )
        LIMIT 1`,
      [shopId, profileIds]
    );
    if (!mem.rows.length) {
      return res.status(403).json({ error: 'Shop access denied' });
    }

    const ownerRow = await db.query(
      `SELECT owner_id::text AS owner_id FROM public.shops WHERE id = $1::uuid LIMIT 1`,
      [shopId]
    );
    const viewerId = await resolveProfileId(req);
    const isOwner =
      viewerId && String(ownerRow.rows[0]?.owner_id || '') === String(viewerId);

    const access = await getShopPlanAccess(shopId);
    if (!access.ok) {
      const body = formatShopPlanAccessForViewer(access, isOwner);
      return res.status(access.status || 402).json({
        error: 'Subscription expired',
        ...body,
      });
    }
    return res.json({ ok: true, plan: access.status?.plan || null });
  } catch (e) {
    console.error('[shop-picker] shop-access:', e);
    return res.status(500).json({ error: e.message || 'Failed to verify shop access' });
  }
});

router.post('/shop-plan-access', async (req, res) => {
  try {
    const shopIds = normalizeShopUuidList(
      Array.isArray(req.body?.shopIds) ? req.body.shopIds : []
    ).slice(0, 50);
    if (!shopIds.length) {
      return res.json({ ok: true, access: {} });
    }

    const profileIds = await resolveLinkedProfileIds(req);
    if (!profileIds.length) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }

    const allowedRes = await db.query(
      `SELECT s.id::text AS id, s.owner_id::text AS owner_id
         FROM public.shops s
        WHERE s.id = ANY($2::uuid[])
          AND (
            s.owner_id = ANY($1::uuid[])
            OR EXISTS (
              SELECT 1 FROM public.shop_users su
               WHERE su.shop_id = s.id AND su.user_id = ANY($1::uuid[])
            )
          )`,
      [profileIds, shopIds]
    );

    const viewerId = await resolveProfileId(req);
    const access = await buildShopPlanAccessMap(allowedRes.rows || [], viewerId);
    return res.json({ ok: true, access });
  } catch (e) {
    console.error('[shop-picker] shop-plan-access:', e);
    return res.status(500).json({ error: e.message || 'Failed to load shop plan access' });
  }
});

/**
 * Shops for My Shops page (owner + membership). Uses Postgres, not Supabase RLS joins.
 */
router.get('/my-shops', async (req, res) => {
  try {
    const profileIds = await resolveLinkedProfileIds(req);
    if (!profileIds.length) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }

    const ownerId = await resolveProfileId(req);
    if (ownerId) {
      await refreshPlanLifecycleForProfile(ownerId);
    }

    await repairOwnerShopLinks(profileIds);

    const listRes = await db.query(
      `SELECT s.id::text AS id,
              s.owner_id::text AS owner_id,
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
                  WHERE su.shop_id = s.id AND su.user_id = ANY($1::uuid[])
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
        WHERE s.owner_id = ANY($1::uuid[])
           OR EXISTS (
             SELECT 1 FROM public.shop_users su
              WHERE su.shop_id = s.id AND su.user_id = ANY($1::uuid[])
           )
        ORDER BY s.created_at DESC`,
      [profileIds]
    );

    const accessByShop = await buildShopPlanAccessMap(listRes.rows || [], ownerId);
    const shops = (listRes.rows || []).map((row) => ({
      ...row,
      planAccess: accessByShop[String(row.id)] || { ok: true },
    }));

    return res.json({ ok: true, shops, profileIds });
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

    const profileIds = await resolveLinkedProfileIds(req);
    if (!profileIds.length) {
      return res.json({ ok: true, stats: {} });
    }

    await repairOwnerShopLinks(profileIds);

    const allowedRes = await db.query(
      `SELECT s.id::text AS shop_id
         FROM public.shops s
        WHERE s.id = ANY($2::uuid[])
          AND (
            s.owner_id = ANY($1::uuid[])
            OR EXISTS (
              SELECT 1 FROM public.shop_users su
               WHERE su.shop_id = s.id AND su.user_id = ANY($1::uuid[])
            )
          )`,
      [profileIds, shopIds]
    );
    const allowed = new Set((allowedRes.rows || []).map((r) => String(r.shop_id || '').trim()));
    const allowedIds = shopIds.filter((id) => allowed.has(String(id)));

    if (allowedIds.length === 0) {
      return res.json({ ok: true, stats: {} });
    }

    const todayStr = await getBusinessTodayDateString(db);
    const byShop = {};
    allowedIds.forEach((id) => {
      byShop[String(id)] = { todaySales: 0, productCount: 0 };
    });

    const mergeStats = (rows, field) => {
      (rows || []).forEach((r) => {
        const sid = String(r.shop_id);
        if (!byShop[sid]) byShop[sid] = { todaySales: 0, productCount: 0 };
        byShop[sid][field] = Number(r.val) || 0;
      });
    };

    try {
      const salesRes = await db.query(
        `SELECT shop_id::text AS shop_id, COALESCE(SUM(total_amount), 0) AS val
           FROM sales
          WHERE shop_id::text = ANY($1::text[])
            AND date::date = $2::date
            AND COALESCE(sale_kind, 'sale') = 'sale'
          GROUP BY shop_id::text`,
        [allowedIds, todayStr]
      );
      mergeStats(salesRes.rows, 'todaySales');
    } catch (salesErr) {
      console.warn('[shop-picker] quick-stats sales:', salesErr.message);
    }

    try {
      const prodRes = await db.query(
        `SELECT shop_id::text AS shop_id, COUNT(*)::int AS val
           FROM products
          WHERE shop_id::text = ANY($1::text[])
          GROUP BY shop_id::text`,
        [allowedIds]
      );
      mergeStats(prodRes.rows, 'productCount');
    } catch (prodErr) {
      console.warn('[shop-picker] quick-stats products:', prodErr.message);
    }

    return res.json({ ok: true, stats: byShop });
  } catch (e) {
    console.error('[shop-picker] quick-stats:', e);
    return res.status(500).json({ ok: false, error: e.message || 'quick-stats failed' });
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

    const profileIds = await resolveLinkedProfileIds(req);
    const ownerId = await resolveProfileId(req);
    if (!profileIds.length || !ownerId) {
      return res.status(403).json({ error: 'Profile not linked to this account.' });
    }

    const planStatus = await refreshPlanLifecycleForProfile(ownerId);
    const planRow = planStatus
      ? { plan: planStatus.plan, shop_limit: planStatus.shop_limit }
      : null;

    if (!planRow) {
      return res.status(404).json({ error: 'Profile not found' });
    }

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
        `SELECT COUNT(DISTINCT s.id)::int AS c
           FROM public.shops s
          WHERE s.owner_id = ANY($1::uuid[])`,
        [profileIds]
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

    const rpcResult = await createShopViaRpc(ownerId, {
      name,
      phone,
      address,
      businessType,
      city,
      currency,
    });
    if (rpcResult?.ok) {
      const shopId = rpcResult.shopId || rpcResult.id;
      const shop = rpcResult.shop || { id: shopId, name };
      return res.status(201).json({
        ok: true,
        shopId,
        id: shopId,
        persisted: true,
        via: 'rpc',
        shop: { ...shop, role: 'owner', memberRole: 'owner' },
      });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const shopRes = await insertShopRow(client, {
        ownerId,
        name,
        phone,
        address,
        businessType,
        city,
        currency,
      });
      const shopId = shopRes.rows[0]?.id;
      if (!shopId) throw new Error('Shop insert failed');

      const shopRoleCandidates = ['owner', 'admin', 'administrator'];
      let linked = false;
      for (const pid of profileIds) {
        for (const roleTry of shopRoleCandidates) {
          try {
            await client.query(
              `INSERT INTO public.shop_users (shop_id, user_id, role)
               VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
              [shopId, pid, roleTry]
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
        if (linked) break;
      }
      if (!linked) {
        throw new Error('Could not link shop to owner');
      }

      await client.query('COMMIT');

      const verify = await db.query(`SELECT id::text AS id FROM public.shops WHERE id = $1::uuid`, [shopId]);
      if (!verify.rows.length) {
        throw new Error('Shop insert did not persist — check DATABASE_URL on Vercel matches this Supabase project.');
      }

      let shopRow;
      try {
        shopRow = await db.query(
          `SELECT id::text AS id, name, phone, address, business_type, city, currency, created_at
             FROM public.shops WHERE id = $1::uuid`,
          [shopId]
        );
      } catch (colErr) {
        shopRow = await db.query(
          `SELECT id::text AS id, name, business_type, city, currency, created_at
             FROM public.shops WHERE id = $1::uuid`,
          [shopId]
        );
      }
      const shop = shopRow.rows[0] || { id: shopId, name };
      return res.status(201).json({
        ok: true,
        shopId,
        id: shopId,
        persisted: true,
        via: 'api',
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

