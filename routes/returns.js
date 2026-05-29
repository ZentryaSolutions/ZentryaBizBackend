const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

router.use(requireAuth);
router.use(requireShopContext);

function parseNotesMeta(notes) {
  const raw = String(notes || '');
  const refMatch = raw.match(/REF:([^|]+)/i);
  const reasonMatch = raw.match(/REASON:([^|]*)/i);
  return {
    ref: refMatch ? String(refMatch[1]).trim() : '',
    reason: reasonMatch ? String(reasonMatch[1]).trim() : raw.trim(),
  };
}

const RETURN_WHERE = `
  s.shop_id = $1
  AND (
    lower(COALESCE(s.sale_kind, '')) = 'return'
    OR s.invoice_number ILIKE 'CN-%'
  )
`;

/** List returns for active shop */
router.get('/', async (req, res) => {
  try {
    const { search, limit = 500, refund_type: refundTypeFilter } = req.query;
    const params = [req.shopId];
    let extra = '';

    if (refundTypeFilter && ['cash', 'credit'].includes(String(refundTypeFilter).toLowerCase())) {
      params.push(String(refundTypeFilter).toLowerCase());
      extra += ` AND COALESCE(sr.refund_type, CASE WHEN lower(COALESCE(s.payment_type, 'cash')) = 'credit' THEN 'credit' ELSE 'cash' END) = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      extra += ` AND (
        COALESCE(sr.return_number, s.invoice_number) ILIKE $${p}
        OR COALESCE(sr.return_reason, s.notes, '') ILIKE $${p}
        OR COALESCE(c.name, s.customer_name, '') ILIKE $${p}
        OR orig.invoice_number ILIKE $${p}
      )`;
    }

    params.push(Math.min(parseInt(limit, 10) || 500, 2000));

    const sql = `
      SELECT
        COALESCE(sr.return_id, s.sale_id) AS return_id,
        s.sale_id,
        COALESCE(sr.original_sale_id, s.original_sale_id) AS original_sale_id,
        COALESCE(sr.return_number, s.invoice_number) AS return_number,
        COALESCE(sr.return_reason, '') AS return_reason,
        COALESCE(
          sr.refund_type,
          CASE WHEN lower(COALESCE(s.payment_type, 'cash')) = 'credit' THEN 'credit' ELSE 'cash' END
        ) AS refund_type,
        COALESCE(sr.return_date, s.date::date) AS return_date,
        COALESCE(sr.total_amount, s.total_amount) AS total_amount,
        COALESCE(sr.paid_amount, s.paid_amount) AS paid_amount,
        COALESCE(sr.payment_type, s.payment_type) AS payment_type,
        s.customer_id,
        COALESCE(c.name, sr.customer_name, s.customer_name) AS customer_name,
        orig.invoice_number AS original_invoice_number,
        (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.sale_id) AS item_count,
        (
          SELECT string_agg(sub.nm, ', ')
          FROM (
            SELECT COALESCE(p.item_name_english, p.name) AS nm
            FROM sale_items si2
            JOIN products p ON p.product_id = si2.product_id AND p.shop_id = s.shop_id
            WHERE si2.sale_id = s.sale_id
            ORDER BY si2.sale_item_id
            LIMIT 5
          ) sub
        ) AS items_preview,
        s.notes,
        sr.created_at
      FROM sales s
      LEFT JOIN sales_returns sr ON sr.sale_id = s.sale_id AND sr.shop_id = s.shop_id
      LEFT JOIN customers c ON c.customer_id = s.customer_id AND c.shop_id = s.shop_id
      LEFT JOIN sales orig
        ON orig.sale_id = COALESCE(sr.original_sale_id, s.original_sale_id)
       AND orig.shop_id = s.shop_id
      WHERE ${RETURN_WHERE}
      ${extra}
      ORDER BY COALESCE(sr.created_at, s.date::timestamptz, now()) DESC, s.sale_id DESC
      LIMIT $${params.length}
    `;

    const result = await db.query(sql, params);
    const rows = result.rows.map((row) => {
      const meta = parseNotesMeta(row.notes);
      const reason =
        String(row.return_reason || '').trim() ||
        meta.reason ||
        '';
      const originalInvoice =
        row.original_invoice_number || meta.ref || '';
      return {
        ...row,
        return_reason: reason,
        original_invoice_number: originalInvoice,
        notes: undefined,
      };
    });

    res.json(rows);
  } catch (error) {
    console.error('Error fetching returns:', error);
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Returns tables missing. Run database/migrations/016_sales_returns_tables.sql in Supabase.',
      });
    }
    res.status(500).json({ error: 'Failed to fetch returns', message: error.message });
  }
});

/** Return detail by return_id (sales_returns) or sale_id (legacy CN row) */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid return id' });
    }

    let headerRes = await db.query(
      `SELECT sr.*,
              orig.invoice_number AS original_invoice_number,
              u.name AS created_by_name
       FROM sales_returns sr
       LEFT JOIN sales orig
         ON orig.sale_id = sr.original_sale_id AND orig.shop_id = sr.shop_id
       LEFT JOIN users u ON u.user_id = sr.created_by
       WHERE sr.shop_id = $1 AND (sr.return_id = $2 OR sr.sale_id = $2)
       LIMIT 1`,
      [req.shopId, id]
    );

    let header = headerRes.rows[0];
    let saleId = header?.sale_id;

    if (!header) {
      const saleRes = await db.query(
        `SELECT s.*,
                orig.invoice_number AS original_invoice_number
         FROM sales s
         LEFT JOIN sales orig
           ON orig.sale_id = s.original_sale_id AND orig.shop_id = s.shop_id
         WHERE s.shop_id = $1 AND s.sale_id = $2
           AND (
             lower(COALESCE(s.sale_kind, '')) = 'return'
             OR s.invoice_number ILIKE 'CN-%'
           )
         LIMIT 1`,
        [req.shopId, id]
      );
      if (!saleRes.rows.length) {
        return res.status(404).json({ error: 'Return not found' });
      }
      const s = saleRes.rows[0];
      const meta = parseNotesMeta(s.notes);
      saleId = s.sale_id;
      header = {
        return_id: s.sale_id,
        shop_id: s.shop_id,
        sale_id: s.sale_id,
        original_sale_id: s.original_sale_id,
        return_number: s.invoice_number,
        return_reason: meta.reason,
        refund_type:
          String(s.payment_type || '').toLowerCase() === 'credit' ? 'credit' : 'cash',
        subtotal: s.subtotal,
        discount: s.discount,
        tax: s.tax,
        total_amount: s.total_amount,
        paid_amount: s.paid_amount,
        payment_type: s.payment_type,
        customer_id: s.customer_id,
        customer_name: s.customer_name,
        return_date: s.date,
        original_invoice_number: s.original_invoice_number || meta.ref,
        created_by: s.created_by,
        created_by_name: null,
      };
    }

    let items = [];
    if (header.return_id && Number.isFinite(header.return_id)) {
      try {
        const itemsFromReturn = await db.query(
          `SELECT sri.*,
                  COALESCE(p.item_name_english, p.name) AS product_name,
                  p.sku
           FROM sales_return_items sri
           JOIN sales_returns sr ON sr.return_id = sri.return_id
           LEFT JOIN products p ON p.product_id = sri.product_id AND p.shop_id = sr.shop_id
           WHERE sr.shop_id = $1 AND sr.return_id = $2
           ORDER BY sri.return_item_id`,
          [req.shopId, header.return_id]
        );
        if (itemsFromReturn.rows.length) {
          items = itemsFromReturn.rows;
        }
      } catch (e) {
        if (e.code !== '42P01') throw e;
      }
    }

    if (!items.length && saleId) {
      const itemsRes = await db.query(
        `SELECT si.sale_item_id,
                si.product_id,
                si.quantity,
                si.selling_price,
                si.purchase_price,
                COALESCE(si.line_discount, 0) AS line_discount,
                GREATEST(
                  0,
                  COALESCE(si.selling_price, 0) * si.quantity - COALESCE(si.line_discount, 0)
                ) AS line_total,
                COALESCE(p.item_name_english, p.name) AS product_name,
                p.sku
         FROM sale_items si
         LEFT JOIN products p ON p.product_id = si.product_id AND p.shop_id = $2
         WHERE si.sale_id = $1
         ORDER BY si.sale_item_id`,
        [saleId, req.shopId]
      );
      items = itemsRes.rows;
    }

    let originalSale = null;
    if (header.original_sale_id) {
      const origRes = await db.query(
        `SELECT sale_id, invoice_number, date, total_amount, customer_id, customer_name
         FROM sales
         WHERE sale_id = $1 AND shop_id = $2`,
        [header.original_sale_id, req.shopId]
      );
      originalSale = origRes.rows[0] || null;
    }

    res.json({
      ...header,
      items,
      original_sale: originalSale,
    });
  } catch (error) {
    console.error('Error fetching return detail:', error);
    res.status(500).json({ error: 'Failed to fetch return', message: error.message });
  }
});

module.exports = router;
