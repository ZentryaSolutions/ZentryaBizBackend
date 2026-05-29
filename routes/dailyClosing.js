const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const { getBusinessTodayDateString } = require('../utils/businessDate');

router.use(requireAuth);
router.use(requireShopContext);

/** Today's figures for close-day modal */
router.get('/today-summary', async (req, res) => {
  try {
    const today = await getBusinessTodayDateString(db);
    const shopId = req.shopId;

    const salesRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE invoice_number NOT ILIKE 'CN-%')::int AS invoice_count,
         COALESCE(SUM(total_amount) FILTER (WHERE invoice_number NOT ILIKE 'CN-%'), 0) AS gross_sales,
         COALESCE(SUM(paid_amount) FILTER (WHERE invoice_number NOT ILIKE 'CN-%' AND payment_type = 'cash'), 0) AS cash_sales,
         COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE invoice_number NOT ILIKE 'CN-%' AND payment_type IN ('credit','split')), 0) AS credit_sales,
         COALESCE(SUM(paid_amount) FILTER (WHERE invoice_number ILIKE 'CN-%'), 0) AS cash_refunds
       FROM sales WHERE shop_id = $1 AND date::date = $2::date`,
      [shopId, today]
    );

    const payRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS credit_payments
       FROM customer_payments cp
       JOIN customers c ON c.customer_id = cp.customer_id AND c.shop_id = $1
       WHERE cp.payment_date::date = $2::date`,
      [shopId, today]
    );

    const expRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS expenses
       FROM expenses WHERE shop_id = $1 AND expense_date::date = $2::date`,
      [shopId, today]
    ).catch(() => ({ rows: [{ expenses: 0 }] }));

    const prevClose = await db.query(
      `SELECT actual_cash, closing_date FROM daily_closings
       WHERE shop_id = $1::uuid ORDER BY closing_date DESC LIMIT 1`,
      [shopId]
    ).catch(() => ({ rows: [] }));

    const row = salesRes.rows[0] || {};
    const creditPayments = parseFloat(payRes.rows[0]?.credit_payments) || 0;
    const expenses = parseFloat(expRes.rows[0]?.expenses) || 0;
    const cashSales = parseFloat(row.cash_sales) || 0;
    const cashRefunds = parseFloat(row.cash_refunds) || 0;
    const opening =
      prevClose.rows[0]?.actual_cash != null
        ? parseFloat(prevClose.rows[0].actual_cash)
        : 0;
    const expected = opening + cashSales + creditPayments - cashRefunds - expenses;

    res.json({
      date: today,
      opening_cash: opening,
      cash_sales: cashSales,
      cash_refunds: cashRefunds,
      credit_sales: parseFloat(row.credit_sales) || 0,
      credit_payments: creditPayments,
      expenses,
      invoice_count: parseInt(row.invoice_count, 10) || 0,
      gross_sales: parseFloat(row.gross_sales) || 0,
      expected_cash: expected,
      previous_closing_date: prevClose.rows[0]?.closing_date || null,
    });
  } catch (e) {
    console.error('[dailyClosing] today-summary:', e);
    res.status(500).json({ error: e.message || 'Failed to load summary' });
  }
});

router.post('/close', async (req, res) => {
  try {
    const today = await getBusinessTodayDateString(db);
    const opening = parseFloat(req.body?.opening_cash) || 0;
    const actual = parseFloat(req.body?.actual_cash);
    if (!Number.isFinite(actual)) {
      return res.status(400).json({ error: 'actual_cash is required' });
    }
    const notes = req.body?.notes != null ? String(req.body.notes).trim() : null;

    const summaryRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE invoice_number NOT ILIKE 'CN-%')::int AS invoice_count,
         COALESCE(SUM(total_amount) FILTER (WHERE invoice_number NOT ILIKE 'CN-%'), 0) AS gross_sales,
         COALESCE(SUM(paid_amount) FILTER (WHERE invoice_number NOT ILIKE 'CN-%' AND payment_type = 'cash'), 0) AS cash_sales,
         COALESCE(SUM(paid_amount) FILTER (WHERE invoice_number ILIKE 'CN-%'), 0) AS cash_refunds,
         COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE invoice_number NOT ILIKE 'CN-%' AND payment_type IN ('credit','split')), 0) AS credit_sales
       FROM sales WHERE shop_id = $1 AND date::date = $2::date`,
      [req.shopId, today]
    );

    const payRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS credit_payments
       FROM customer_payments cp
       JOIN customers c ON c.customer_id = cp.customer_id AND c.shop_id = $1
       WHERE cp.payment_date::date = $2::date`,
      [req.shopId, today]
    );

    const expRes = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS expenses FROM expenses
       WHERE shop_id = $1 AND expense_date::date = $2::date`,
      [req.shopId, today]
    ).catch(() => ({ rows: [{ expenses: 0 }] }));

    const s = summaryRes.rows[0];
    const cashSales = parseFloat(s.cash_sales) || 0;
    const cashRefunds = parseFloat(s.cash_refunds) || 0;
    const creditPayments = parseFloat(payRes.rows[0]?.credit_payments) || 0;
    const expenses = parseFloat(expRes.rows[0]?.expenses) || 0;
    const expected = opening + cashSales + creditPayments - cashRefunds - expenses;
    const difference = actual - expected;

    const ins = await db.query(
      `INSERT INTO daily_closings (
         shop_id, closing_date, opening_cash, expected_cash, actual_cash,
         cash_sales, cash_refunds, credit_sales, credit_payments, expenses,
         invoice_count, difference, notes, closed_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (shop_id, closing_date) DO UPDATE SET
         opening_cash = EXCLUDED.opening_cash,
         expected_cash = EXCLUDED.expected_cash,
         actual_cash = EXCLUDED.actual_cash,
         cash_sales = EXCLUDED.cash_sales,
         cash_refunds = EXCLUDED.cash_refunds,
         credit_sales = EXCLUDED.credit_sales,
         credit_payments = EXCLUDED.credit_payments,
         expenses = EXCLUDED.expenses,
         invoice_count = EXCLUDED.invoice_count,
         difference = EXCLUDED.difference,
         notes = EXCLUDED.notes,
         closed_by = EXCLUDED.closed_by
       RETURNING *`,
      [
        req.shopId,
        today,
        opening,
        expected,
        actual,
        cashSales,
        cashRefunds,
        parseFloat(s.credit_sales) || 0,
        creditPayments,
        expenses,
        parseInt(s.invoice_count, 10) || 0,
        difference,
        notes,
        req.user?.user_id || null,
      ]
    );

    res.status(201).json({ ok: true, closing: ins.rows[0] });
  } catch (e) {
    console.error('[dailyClosing] close:', e);
    if (e.code === '42P01') {
      return res.status(503).json({
        error: 'Run database migration 009_sales_returns_daily_closing.sql first',
      });
    }
    res.status(500).json({ error: e.message || 'Failed to save closing' });
  }
});

module.exports = router;
