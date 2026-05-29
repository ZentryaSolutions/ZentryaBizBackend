const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const { logSensitiveAccess } = require('../utils/auditLogger');
router.use(requireAuth);
router.use(requireShopContext);
router.use(requireRole('administrator'));

function ymdOrNull(q) {
  const s = String(q || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Shop-scoped audit: rows tagged with shop_id OR performed by any user linked to this shop
 * (users.shop_id or shop_users + zb_profile_id).
 */
function shopScopeSql(shopParam = '$1') {
  return `(
    al.shop_id = ${shopParam}::uuid
    OR al.user_id IN (
      SELECT u.user_id FROM users u
      WHERE u.shop_id = ${shopParam}::uuid
      OR EXISTS (
        SELECT 1 FROM shop_users su
        WHERE su.shop_id = ${shopParam}::uuid
          AND su.user_id = u.zb_profile_id
      )
    )
  )`;
}

function shopScopeSqlFallback(shopParam = '$1') {
  return `(
    al.shop_id = ${shopParam}::uuid
    OR al.user_id IN (SELECT user_id FROM users WHERE shop_id = ${shopParam}::uuid)
  )`;
}

function buildFilters(req) {
  const shopId = req.shopId;
  const params = [shopId];
  let n = 2;
  let where = `WHERE ${shopScopeSql('$1')}`;

  const userId = req.query.userId;
  const action = req.query.action;
  const tableName = req.query.tableName;
  const search = req.query.search;
  let startYmd = ymdOrNull(req.query.start_date);
  let endYmd = ymdOrNull(req.query.end_date);
  if (startYmd && endYmd && startYmd > endYmd) {
    const tmp = startYmd;
    startYmd = endYmd;
    endYmd = tmp;
  }

  if (userId) {
    where += ` AND al.user_id = $${n++}`;
    params.push(parseInt(userId, 10));
  }
  if (action) {
    where += ` AND al.action = $${n++}`;
    params.push(String(action).trim());
  }
  if (tableName) {
    where += ` AND al.table_name = $${n++}`;
    params.push(String(tableName).trim());
  }
  if (startYmd) {
    where += ` AND al.timestamp::date >= $${n++}::date`;
    params.push(startYmd);
  }
  if (endYmd) {
    where += ` AND al.timestamp::date <= $${n++}::date`;
    params.push(endYmd);
  }
  if (search && String(search).trim()) {
    where += ` AND (
      COALESCE(al.notes, '') ILIKE $${n}
      OR COALESCE(u.username, '') ILIKE $${n}
      OR COALESCE(u.name, '') ILIKE $${n}
      OR COALESCE(al.table_name, '') ILIKE $${n}
      OR COALESCE(al.action, '') ILIKE $${n}
      OR COALESCE(al.old_values::text, '') ILIKE $${n}
      OR COALESCE(al.new_values::text, '') ILIKE $${n}
    )`;
    params.push(`%${String(search).trim()}%`);
    n++;
  }

  return { where, params, nextParam: n };
}

/**
 * GET /api/audit — shop-scoped audit history for administrators.
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { where, params, nextParam } = buildFilters(req);

    if (offset === 0) {
      const hasFilters = Boolean(
        req.query.userId ||
          req.query.action ||
          req.query.tableName ||
          req.query.search ||
          req.query.start_date ||
          req.query.end_date
      );
      await logSensitiveAccess(
        req.user.user_id,
        'audit',
        req.ip || req.connection?.remoteAddress,
        req.get('user-agent'),
        {
          shopId: req.shopId,
          description: hasFilters
            ? 'Opened Audit History (with filters)'
            : 'Opened Audit History',
        }
      );
    }

    const listSql = `
      SELECT
        al.log_id,
        al.user_id,
        COALESCE(u.name, u.username, 'System') AS user_name,
        u.username,
        al.action,
        al.table_name,
        al.record_id,
        al.old_values,
        al.new_values,
        al.ip_address,
        al.user_agent,
        al.timestamp,
        al.notes,
        al.shop_id
      FROM audit_logs al
      LEFT JOIN users u ON u.user_id = al.user_id
      ${where}
      ORDER BY al.timestamp DESC
      LIMIT $${nextParam} OFFSET $${nextParam + 1}
    `;
    const listParams = [...params, limit, offset];

    const countSql = `
      SELECT COUNT(*)::int AS c
      FROM audit_logs al
      LEFT JOIN users u ON u.user_id = al.user_id
      ${where}
    `;

    let listR;
    let countR;
    try {
      [listR, countR] = await Promise.all([
        db.query(listSql, listParams),
        db.query(countSql, params),
      ]);
    } catch (dbErr) {
      if (dbErr.code !== '42703') throw dbErr;
      const fbWhere = `WHERE ${shopScopeSqlFallback('$1')}`;
      const fbList = `
        SELECT
          al.log_id, al.user_id,
          COALESCE(u.name, u.username, 'System') AS user_name, u.username,
          al.action, al.table_name, al.record_id,
          al.old_values, al.new_values, al.ip_address, al.user_agent,
          al.timestamp, al.notes, al.shop_id
        FROM audit_logs al
        LEFT JOIN users u ON u.user_id = al.user_id
        ${fbWhere}
        ORDER BY al.timestamp DESC
        LIMIT $2 OFFSET $3
      `;
      [listR, countR] = await Promise.all([
        db.query(fbList, [req.shopId, limit, offset]),
        db.query(
          `SELECT COUNT(*)::int AS c FROM audit_logs al ${fbWhere}`,
          [req.shopId]
        ),
      ]);
    }

    let actionsR = { rows: [] };
    let tablesR = { rows: [] };
    try {
      [actionsR, tablesR] = await Promise.all([
        db.query(
          `SELECT DISTINCT al.action FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${where} ORDER BY al.action`,
          params
        ),
        db.query(
          `SELECT DISTINCT al.table_name FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id ${where} AND al.table_name IS NOT NULL ORDER BY al.table_name`,
          params
        ),
      ]);
    } catch {
      /* filter dropdowns optional */
    }

    res.json({
      logs: listR.rows,
      total: countR.rows[0]?.c ?? 0,
      limit,
      offset,
      filters: {
        actions: actionsR.rows.map((r) => r.action).filter(Boolean),
        tables: tablesR.rows.map((r) => r.table_name).filter(Boolean),
      },
    });
  } catch (error) {
    console.error('[Audit] list error:', error);
    res.status(500).json({ error: 'Failed to fetch audit history', message: error.message });
  }
});

module.exports = router;
