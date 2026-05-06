const express = require('express');
const router = express.Router();
const db = require('../db');
const { getBusinessTodayDateString } = require('../utils/businessDate');
const { requireAuth, requireRole, isElevatedRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const { logSensitiveAccess } = require('../utils/auditLogger');
const { requireProPlan } = require('../middleware/planMiddleware');

// All report routes require authentication and active shop (x-shop-id)
router.use(requireAuth);
router.use(requireShopContext);
// Dashboard route is accessible to both admins and cashiers (but cashiers see limited data)
// Other report routes still require admin role

// Removed checkFeature - allow all API calls, frontend handles operation blocking

function ymdFromPgDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function addCalendarDaysYmd(ymd, deltaDays) {
  const parts = String(ymd).slice(0, 10).split('-').map(Number);
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Helper function to get date range for periods

// Helper function to get date range for periods
function getDateRange(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startDate, endDate;

  switch (period) {
    case 'today':
    case 'daily':
      startDate = new Date(today);
      endDate = new Date(today);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'weekly': {
      // Last 7 calendar days inclusive (matches Reports UI rolling week)
      const end = new Date(today);
      end.setHours(23, 59, 59, 999);
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      startDate = start;
      endDate = end;
      break;
    }

    case 'monthly':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'last3months':
      startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'last6months':
      startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'yearly':
    case 'thisyear':
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), 11, 31);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'lastyear':
      const lastYear = now.getFullYear() - 1;
      startDate = new Date(lastYear, 0, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(lastYear, 11, 31);
      endDate.setHours(23, 59, 59, 999);
      break;

    default:
      startDate = null;
      endDate = null;
  }

  return { startDate, endDate };
}

/** Format a JS Date as YYYY-MM-DD in local calendar (server TZ) for SQL DATE params */
function formatYmd(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse query start_date/end_date as calendar YYYY-MM-DD for safe SQL ::date filters */
function ymdRangeFromQuery(start_date, end_date) {
  const s = String(start_date || '').trim().slice(0, 10);
  const e = String(end_date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return null;
  return { startYmd: s, endYmd: e };
}

// Get comprehensive report with sales, purchases, and cash - Admin only
router.get('/comprehensive', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    // Log sensitive access
    await logSensitiveAccess(
      req.user.user_id,
      'reports',
      req.ip || req.connection.remoteAddress,
      req.get('user-agent')
    );

    const { period = 'monthly', productId, supplierId } = req.query;
    const { startDate, endDate } = getDateRange(period);
    const shopId = req.shopId;

    let params = [shopId];
    let paramIndex = 2;

    let salesWhere = 'WHERE s.shop_id = $1';
    let purchasesWhere = 'WHERE p.shop_id = $1';

    if (startDate && endDate) {
      salesWhere += ` AND s.date >= $${paramIndex} AND s.date <= $${paramIndex + 1}`;
      purchasesWhere += ` AND p.date >= $${paramIndex} AND p.date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (productId) {
      salesWhere += ` AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.sale_id AND si.product_id = $${paramIndex})`;
      purchasesWhere += ` AND EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = p.purchase_id AND pi.item_id = $${paramIndex})`;
      params.push(parseInt(productId));
      paramIndex++;
    }

    if (supplierId) {
      salesWhere += ` AND EXISTS (
        SELECT 1 FROM sale_items si 
        JOIN products pr ON si.product_id = pr.product_id AND pr.shop_id = $1
        WHERE si.sale_id = s.sale_id AND pr.supplier_id = $${paramIndex}
      )`;
      purchasesWhere += ` AND p.supplier_id = $${paramIndex}`;
      params.push(parseInt(supplierId));
      paramIndex++;
    }

    // Get sales data
    const salesQuery = `
      SELECT 
        s.sale_id,
        s.invoice_number,
        s.date,
        s.customer_name,
        s.total_amount,
        s.total_profit
      FROM sales s
      ${salesWhere}
      ORDER BY s.date DESC
    `;

    // Get purchases data (header totals; line items live in purchase_items)
    const purchasesQuery = `
      SELECT 
        p.purchase_id,
        p.date,
        p.total_amount,
        sup.name as supplier_name
      FROM purchases p
      LEFT JOIN suppliers sup ON p.supplier_id = sup.supplier_id
      ${purchasesWhere}
      ORDER BY p.date DESC
    `;

    const [salesResult, purchasesResult] = await Promise.all([
      db.query(salesQuery, params),
      db.query(purchasesQuery, params),
    ]);

    // Calculate totals
    let totalSales = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let totalPurchases = 0;

    salesResult.rows.forEach(sale => {
      totalSales += parseFloat(sale.total_amount);
      const profit = parseFloat(sale.total_profit);
      if (profit >= 0) {
        totalProfit += profit;
      } else {
        totalLoss += Math.abs(profit);
      }
    });

    purchasesResult.rows.forEach(purchase => {
      totalPurchases += parseFloat(purchase.total_amount);
    });

    const netProfit = totalProfit - totalLoss;
    // Cash in hand = Total Sales - Total Purchases (simplified calculation)
    // In a real system, this would account for payments to suppliers, expenses, etc.
    const cashInHand = totalSales - totalPurchases;

    res.json({
      period,
      dateRange: {
        start: startDate ? startDate.toISOString() : null,
        end: endDate ? endDate.toISOString() : null,
      },
      totals: {
        totalSales,
        totalProfit,
        totalLoss,
        netProfit,
        totalPurchases,
        cashInHand,
      },
      sales: salesResult.rows,
      purchases: purchasesResult.rows,
    });
  } catch (error) {
    console.error('Error fetching comprehensive report:', error);
    res.status(500).json({ error: 'Failed to fetch report', message: error.message });
  }
});

// Get all products for filter dropdown
router.get('/products', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT product_id, name, item_name_english FROM products WHERE shop_id = $1 ORDER BY COALESCE(item_name_english, name) ASC',
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products', message: error.message });
  }
});

// Get all suppliers for filter dropdown
// Suppliers Report - Admin only
router.get('/suppliers', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT supplier_id, name FROM suppliers WHERE shop_id = $1 ORDER BY name ASC',
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    res.status(500).json({ error: 'Failed to fetch suppliers', message: error.message });
  }
});

// Stock Report - All products with stock levels
// Stock Report - Admin only
router.get('/stock', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        p.product_id,
        p.name,
        p.sku,
        p.category,
        p.purchase_price,
        p.selling_price,
        p.quantity_in_stock,
        s.name as supplier_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = p.shop_id
      WHERE p.shop_id = $1
      ORDER BY p.quantity_in_stock ASC, p.name ASC
    `, [req.shopId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching stock report:', error);
    res.status(500).json({ error: 'Failed to fetch stock report', message: error.message });
  }
});

// Customer Outstanding Report
// Customers Outstanding - Admin only
router.get('/customers-outstanding', requireRole('administrator'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        customer_id,
        name,
        phone,
        current_balance,
        opening_balance
      FROM customers
      WHERE current_balance != 0 AND shop_id = $1
      ORDER BY ABS(current_balance) DESC
    `, [req.shopId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer outstanding:', error);
    res.status(500).json({ error: 'Failed to fetch customer outstanding', message: error.message });
  }
});

// Supplier Payable Report
// Suppliers Payable - Admin only
router.get('/suppliers-payable', requireRole('administrator'), async (req, res) => {
  try {
    const { balance_only } = req.query;
    
    // Don't apply date filters - show all suppliers with payable amounts (like customer due list)
    // Filter by balance > 0 only if requested
    let balanceFilter = '';
    if (balance_only === 'true') {
      balanceFilter = ` AND (
        opening_balance + 
        COALESCE((
          SELECT SUM(total_amount) 
          FROM purchases 
          WHERE supplier_id = suppliers.supplier_id 
          AND shop_id = suppliers.shop_id
          AND payment_type = 'credit'
        ), 0) - 
        COALESCE((
          SELECT SUM(amount) 
          FROM supplier_payments 
          WHERE supplier_id = suppliers.supplier_id
        ), 0)
      ) > 0`;
    }
    
    const result = await db.query(`
      SELECT 
        supplier_id,
        name,
        contact_number,
        NULL as address,
        opening_balance,
        COALESCE((
          SELECT SUM(total_amount) 
          FROM purchases 
          WHERE supplier_id = suppliers.supplier_id 
          AND shop_id = suppliers.shop_id
          AND payment_type = 'credit'
        ), 0) as total_credit_purchases,
        COALESCE((
          SELECT SUM(amount) 
          FROM supplier_payments 
          WHERE supplier_id = suppliers.supplier_id
        ), 0) as total_paid,
        (opening_balance + 
         COALESCE((
           SELECT SUM(total_amount) 
           FROM purchases 
           WHERE supplier_id = suppliers.supplier_id 
           AND shop_id = suppliers.shop_id
           AND payment_type = 'credit'
         ), 0) - 
         COALESCE((
           SELECT SUM(amount) 
           FROM supplier_payments 
           WHERE supplier_id = suppliers.supplier_id
         ), 0)
        ) as current_payable_balance,
        (
          SELECT MAX(date) 
          FROM purchases 
          WHERE supplier_id = suppliers.supplier_id AND shop_id = suppliers.shop_id
        ) as last_purchase_date,
        (
          SELECT MAX(payment_date) 
          FROM supplier_payments 
          WHERE supplier_id = suppliers.supplier_id
        ) as last_payment_date
      FROM suppliers
      WHERE shop_id = $1${balanceFilter}
      ORDER BY current_payable_balance DESC, name ASC
    `, [req.shopId]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching supplier payable:', error);
    res.status(500).json({ error: 'Failed to fetch supplier payable', message: error.message });
  }
});

// Get Customer Due List Report
// Customers Due - Admin only
router.get('/customers-due', requireRole('administrator'), async (req, res) => {
  try {
    const { balance_greater_than_zero } = req.query;
    
    // Don't apply date filters - show all customers with due amounts (like supplier payables)
    let query = `
      SELECT 
        c.customer_id,
        c.name as customer_name,
        c.phone as mobile_number,
        c.current_balance as total_due,
        MAX(s.date) as last_purchase_date,
        MAX(cp.payment_date) as last_payment_date,
        c.opening_balance,
        COALESCE(SUM(CASE WHEN s.payment_type IN ('credit', 'split') THEN s.total_amount - s.paid_amount ELSE 0 END), 0) as total_sales_due,
        COALESCE(SUM(cp.amount), 0) as total_paid
      FROM customers c
      LEFT JOIN sales s ON c.customer_id = s.customer_id AND s.shop_id = c.shop_id AND s.payment_type IN ('credit', 'split')
      LEFT JOIN customer_payments cp ON c.customer_id = cp.customer_id
      WHERE c.shop_id = $1
    `;
    
    const params = [req.shopId];
    let paramIndex = 2;
    
    if (balance_greater_than_zero === 'true') {
      query += ` AND c.current_balance > 0`;
    }
    
    query += `
      GROUP BY c.customer_id, c.name, c.phone, c.current_balance, c.opening_balance, c.shop_id
      HAVING c.current_balance > 0 OR $${paramIndex}::boolean = false
      ORDER BY c.current_balance DESC, c.name ASC
    `;
    
    // If balance_greater_than_zero is not true, we want all customers
    params.push(balance_greater_than_zero === 'true');
    
    const result = await db.query(query, params);
    
    res.json({
      customers: result.rows,
      total_customers: result.rows.length,
      total_due: result.rows.reduce((sum, c) => sum + parseFloat(c.total_due || 0), 0)
    });
  } catch (error) {
    console.error('Error fetching customer due list:', error);
    res.status(500).json({ error: 'Failed to fetch customer due list', message: error.message });
  }
});

// Dashboard Summary - Get all key metrics for selected period
// Dashboard Summary - Admin only
router.get('/dashboard-summary', requireRole('administrator'), async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date } = req.query;

    let startYmd;
    let endYmd;
    let rangeStartForJson;
    let rangeEndForJson;
    if (start_date && end_date) {
      startYmd = String(start_date).slice(0, 10);
      endYmd = String(end_date).slice(0, 10);
      rangeStartForJson = startYmd;
      rangeEndForJson = endYmd;
    } else {
      const range = getDateRange(period);
      startYmd = formatYmd(range.startDate);
      endYmd = formatYmd(range.endDate);
      rangeStartForJson = range.startDate;
      rangeEndForJson = range.endDate;
    }

    const sid = req.shopId;
    const params = [sid];
    let dateWhereSales = 'WHERE shop_id = $1';
    let dateWherePurchases = 'WHERE p.shop_id = $1';
    let dateWhereExpenses = 'WHERE shop_id = $1';
    if (startYmd && endYmd) {
      dateWhereSales += ' AND date >= $2::date AND date <= $3::date';
      dateWherePurchases += ' AND p.date >= $2::date AND p.date <= $3::date';
      dateWhereExpenses += ' AND expense_date >= $2::date AND expense_date <= $3::date';
      params.push(startYmd, endYmd);
    }

    // Get Sales totals
    const salesQuery = `
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_sales,
        COUNT(*) as invoice_count,
        COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN total_amount ELSE 0 END), 0) as cash_sales,
        COALESCE(SUM(CASE WHEN payment_type IN ('credit', 'split') THEN total_amount ELSE 0 END), 0) as credit_sales,
        COALESCE(SUM(paid_amount), 0) as cash_received
      FROM sales
      ${dateWhereSales}
    `;

    // Get Purchases totals (purchases.total_amount is the bill total)
    const purchasesQuery = `
      SELECT 
        COALESCE(SUM(p.total_amount), 0) as total_purchases
      FROM purchases p
      ${dateWherePurchases}
    `;

    // Get Expenses totals
    const expensesQuery = `
      SELECT 
        COALESCE(SUM(amount), 0) as total_expenses
      FROM daily_expenses
      ${dateWhereExpenses}
    `;

    // Get Customer Credit (Udhaar)
    const creditQuery = `
      SELECT 
        COALESCE(SUM(current_balance), 0) as total_credit_given
      FROM customers
      WHERE current_balance > 0 AND shop_id = $1
    `;

    const salesByDayQuery = `
      SELECT
        s.date::date AS d,
        COALESCE(SUM(s.total_amount), 0)::float AS revenue,
        COALESCE(SUM(
          CASE
            WHEN s.payment_type = 'cash' THEN s.total_amount
            WHEN s.payment_type = 'split' THEN COALESCE(s.paid_amount, 0)
            ELSE 0
          END
        ), 0)::float AS cash_day,
        COALESCE(SUM(
          CASE
            WHEN s.payment_type = 'credit' THEN s.total_amount
            WHEN s.payment_type = 'split' THEN GREATEST(s.total_amount - COALESCE(s.paid_amount, 0), 0)
            ELSE 0
          END
        ), 0)::float AS credit_day
      FROM sales s
      ${dateWhereSales.replace(/^WHERE shop_id/, 'WHERE s.shop_id').replace(/ AND date /g, ' AND s.date ')}
      GROUP BY (s.date::date)
      ORDER BY (s.date::date) ASC
    `;

    const expenseCategoryDashQuery = `
      SELECT 
        expense_category,
        COALESCE(SUM(amount), 0)::float AS category_total
      FROM daily_expenses
      ${dateWhereExpenses}
      GROUP BY expense_category
      ORDER BY category_total DESC
      LIMIT 12
    `;

    const lowStockCountQuery = `
      SELECT COUNT(*)::int AS c
      FROM products
      WHERE quantity_in_stock <= 5 AND shop_id = $1
    `;

    const lowStockTopQuery = `
      SELECT
        product_id,
        COALESCE(item_name_english, name) AS product_name,
        quantity_in_stock::int AS qty
      FROM products
      WHERE quantity_in_stock <= 5 AND shop_id = $1
      ORDER BY quantity_in_stock ASC, product_id ASC
      LIMIT 6
    `;

    const creditParams = [sid];
    const lowStockParams = [sid];
    const [
      salesResult,
      purchasesResult,
      expensesResult,
      creditResult,
      salesByDayResult,
      expenseCatResult,
      lowStockCountResult,
      lowStockTopResult,
    ] = await Promise.all([
      db.query(salesQuery, params),
      db.query(purchasesQuery, params),
      db.query(expensesQuery, params),
      db.query(creditQuery, creditParams),
      db.query(salesByDayQuery, params),
      db.query(expenseCategoryDashQuery, params),
      db.query(lowStockCountQuery, lowStockParams),
      db.query(lowStockTopQuery, lowStockParams),
    ]);

    const totalSales = parseFloat(salesResult.rows[0].total_sales) || 0;
    const totalPurchases = parseFloat(purchasesResult.rows[0].total_purchases) || 0;
    const totalExpenses = parseFloat(expensesResult.rows[0].total_expenses) || 0;
    const netProfit = totalSales - totalPurchases - totalExpenses;
    const cashReceived = parseFloat(salesResult.rows[0].cash_received) || 0;
    const creditGiven = parseFloat(creditResult.rows[0].total_credit_given) || 0;

    const salesTrend = (salesByDayResult.rows || []).map((row) => ({
      date: row.d instanceof Date ? row.d.toISOString().slice(0, 10) : String(row.d).slice(0, 10),
      revenue: parseFloat(row.revenue) || 0,
      cash: parseFloat(row.cash_day) || 0,
      credit: parseFloat(row.credit_day) || 0,
    }));

    const expenseCategoryBreakdown = (expenseCatResult.rows || []).map((row) => ({
      category: row.expense_category || 'Other',
      total: parseFloat(row.category_total) || 0,
    }));

    const lowStockCount = parseInt(lowStockCountResult.rows[0]?.c, 10) || 0;
    const lowStockPreview = (lowStockTopResult.rows || []).map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      current_qty: row.qty,
    }));

    res.json({
      totalSales,
      totalPurchases,
      totalExpenses,
      netProfit,
      cashReceived,
      creditGiven,
      invoiceCount: parseInt(salesResult.rows[0].invoice_count) || 0,
      cashSales: parseFloat(salesResult.rows[0].cash_sales) || 0,
      creditSales: parseFloat(salesResult.rows[0].credit_sales) || 0,
      salesTrend,
      expenseCategoryBreakdown,
      lowStockCount,
      lowStockPreview,
      dateRange: {
        start: rangeStartForJson instanceof Date ? rangeStartForJson.toISOString() : rangeStartForJson,
        end: rangeEndForJson instanceof Date ? rangeEndForJson.toISOString() : rangeEndForJson
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard summary', message: error.message });
  }
});

// Sales invoices in range (stacked cash/credit + table)
router.get('/sales-invoices', requireRole('administrator'), async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date, product_id } = req.query;
    let startDate;
    let endDate;
    if (start_date && end_date) {
      startDate = new Date(start_date);
      endDate = new Date(end_date);
      endDate.setHours(23, 59, 59, 999);
    } else {
      const range = getDateRange(period);
      startDate = range.startDate;
      endDate = range.endDate;
    }
    const sid = req.shopId;
    const params = [sid];
    let where = 'WHERE s.shop_id = $1';
    let i = 2;
    if (startDate && endDate) {
      where += ` AND s.date >= $${i} AND s.date <= $${i + 1}`;
      params.push(startDate, endDate);
      i += 2;
    }
    if (product_id) {
      where += ` AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.sale_id AND si.product_id = $${i})`;
      params.push(parseInt(product_id, 10));
      i += 1;
    }
    const q = `
      SELECT
        s.sale_id,
        s.invoice_number,
        s.date::date AS sale_date,
        s.total_amount,
        s.paid_amount,
        s.payment_type,
        CASE
          WHEN s.payment_type = 'cash' THEN s.total_amount
          WHEN s.payment_type = 'split' THEN COALESCE(s.paid_amount, 0)
          ELSE 0
        END::float AS cash_amount,
        CASE
          WHEN s.payment_type = 'credit' THEN s.total_amount
          WHEN s.payment_type = 'split' THEN GREATEST(s.total_amount - COALESCE(s.paid_amount, 0), 0)
          ELSE 0
        END::float AS credit_amount
      FROM sales s
      ${where}
      ORDER BY s.date DESC, s.sale_id DESC
      LIMIT 200
    `;
    const result = await db.query(q, params);
    const invoices = result.rows.map((row) => {
      const total = parseFloat(row.total_amount) || 0;
      const creditAmt = parseFloat(row.credit_amount) || 0;
      const paid = parseFloat(row.paid_amount) || 0;
      let status = 'Paid';
      if (row.payment_type === 'credit' && creditAmt > 0) status = creditAmt <= 0.01 ? 'Paid' : 'Open';
      else if (row.payment_type === 'split') status = creditAmt > 0.01 ? 'Partial' : 'Paid';
      else if (row.payment_type === 'cash') status = 'Paid';
      return {
        sale_id: row.sale_id,
        invoice_number: row.invoice_number,
        date: row.sale_date,
        total,
        cash: parseFloat(row.cash_amount) || 0,
        credit: creditAmt,
        payment_type: row.payment_type,
        status,
      };
    });
    res.json({ invoices, dateRange: { start: startDate?.toISOString(), end: endDate?.toISOString() } });
  } catch (error) {
    console.error('Error fetching sales invoices:', error);
    res.status(500).json({ error: 'Failed to fetch sales invoices', message: error.message });
  }
});

// Customer analytics (KPIs for period + optional table support)
router.get('/customers-analytics', requireRole('administrator'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const sid = req.shopId;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }
    const startYmd = String(start_date).slice(0, 10);
    const endYmd = String(end_date).slice(0, 10);
    const params = [sid, startYmd, endYmd];
    const [cnt, coll, creditSales, outQ] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS c FROM customers WHERE shop_id = $1', [sid]),
      db.query(
        `SELECT COALESCE(SUM(cp.amount), 0)::float AS v
         FROM customer_payments cp
         INNER JOIN customers c ON c.customer_id = cp.customer_id AND c.shop_id = $1
         WHERE cp.payment_date >= $2::date AND cp.payment_date <= $3::date`,
        params
      ),
      db.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float AS v
         FROM sales
         WHERE shop_id = $1 AND date >= $2::date AND date <= $3::date
           AND payment_type IN ('credit', 'split')`,
        params
      ),
      db.query(
        `SELECT COALESCE(SUM(CASE WHEN current_balance > 0 THEN current_balance ELSE 0 END), 0)::float AS v
         FROM customers WHERE shop_id = $1`,
        [sid]
      ),
    ]);
    const totalCustomers = parseInt(cnt.rows[0].c, 10) || 0;
    const totalCollected = parseFloat(coll.rows[0].v) || 0;
    const totalCreditSales = parseFloat(creditSales.rows[0].v) || 0;
    const outstanding = parseFloat(outQ.rows[0].v) || 0;
    const denom = totalCollected + outstanding;
    const collectionRatePct = denom > 0 ? Math.round((totalCollected / denom) * 1000) / 10 : 0;
    res.json({
      totalCustomers,
      totalCreditSales,
      totalCollected,
      outstanding,
      collectionRatePct,
    });
  } catch (error) {
    console.error('Error fetching customers analytics:', error);
    res.status(500).json({ error: 'Failed to fetch customers analytics', message: error.message });
  }
});

// Supplier analytics + purchases in period
router.get('/suppliers-analytics', requireRole('administrator'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const sid = req.shopId;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }
    const startYmd = String(start_date).slice(0, 10);
    const endYmd = String(end_date).slice(0, 10);
    const params = [sid, startYmd, endYmd];
    const [supCnt, purch, paid, purchasesList] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS c FROM suppliers WHERE shop_id = $1', [sid]),
      db.query(
        `SELECT COALESCE(SUM(total_amount), 0)::float AS v FROM purchases WHERE shop_id = $1 AND date >= $2::date AND date <= $3::date`,
        params
      ),
      db.query(
        `SELECT COALESCE(SUM(sp.amount), 0)::float AS v
         FROM supplier_payments sp
         INNER JOIN suppliers s ON s.supplier_id = sp.supplier_id AND s.shop_id = $1
         WHERE sp.payment_date >= $2::date AND sp.payment_date <= $3::date`,
        params
      ),
      db.query(
        `SELECT
           p.purchase_id,
           p.date::date AS purchase_date,
           p.total_amount,
           p.payment_type,
           s.name AS supplier_name
         FROM purchases p
         INNER JOIN suppliers s ON s.supplier_id = p.supplier_id AND s.shop_id = p.shop_id
         WHERE p.shop_id = $1 AND p.date >= $2::date AND p.date <= $3::date
         ORDER BY p.date DESC, p.purchase_id DESC
         LIMIT 100`,
        params
      ),
    ]);
    const payRows = await db.query(
      `SELECT
         s.supplier_id,
         s.name,
         (s.opening_balance +
          COALESCE((SELECT SUM(total_amount) FROM purchases pu WHERE pu.supplier_id = s.supplier_id AND pu.shop_id = s.shop_id AND pu.payment_type = 'credit'), 0) -
          COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.supplier_id = s.supplier_id), 0)
         )::float AS payable
       FROM suppliers s
       WHERE s.shop_id = $1`,
      [sid]
    );
    let outstanding = 0;
    payRows.rows.forEach((r) => {
      const b = parseFloat(r.payable) || 0;
      if (b > 0) outstanding += b;
    });
    res.json({
      supplierCount: parseInt(supCnt.rows[0].c, 10) || 0,
      totalPurchased: parseFloat(purch.rows[0].v) || 0,
      totalPaid: parseFloat(paid.rows[0].v) || 0,
      outstandingPayable: outstanding,
      purchases: purchasesList.rows.map((row) => ({
        purchase_id: row.purchase_id,
        date: row.purchase_date,
        supplier_name: row.supplier_name,
        total_amount: parseFloat(row.total_amount) || 0,
        payment_type: row.payment_type,
      })),
    });
  } catch (error) {
    console.error('Error fetching suppliers analytics:', error);
    res.status(500).json({ error: 'Failed to fetch suppliers analytics', message: error.message });
  }
});

// Sales Summary Report
// Sales Summary - Admin only
router.get('/sales-summary', requireRole('administrator'), async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date, product_id, customer_id } = req.query;
    
    let startDate, endDate;
    if (start_date && end_date) {
      startDate = new Date(start_date);
      endDate = new Date(end_date);
      endDate.setHours(23, 59, 59, 999);
    } else {
      const range = getDateRange(period);
      startDate = range.startDate;
      endDate = range.endDate;
    }

    const sid = req.shopId;
    let whereClause = 'WHERE s.shop_id = $1';
    const params = [sid];
    let paramIndex = 2;

    if (startDate && endDate) {
      whereClause += ` AND s.date >= $${paramIndex} AND s.date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (product_id) {
      whereClause += ` AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.sale_id AND si.product_id = $${paramIndex})`;
      params.push(parseInt(product_id));
      paramIndex++;
    }

    if (customer_id) {
      whereClause += ` AND s.customer_id = $${paramIndex}`;
      params.push(parseInt(customer_id));
      paramIndex++;
    }

    const query = `
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_sales,
        COUNT(*) as invoice_count,
        COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN total_amount ELSE 0 END), 0) as cash_sales,
        COALESCE(SUM(CASE WHEN payment_type IN ('credit', 'split') THEN total_amount ELSE 0 END), 0) as credit_sales
      FROM sales s
      ${whereClause}
    `;

    const result = await db.query(query, params);
    
    res.json({
      totalSales: parseFloat(result.rows[0].total_sales) || 0,
      invoiceCount: parseInt(result.rows[0].invoice_count) || 0,
      cashSales: parseFloat(result.rows[0].cash_sales) || 0,
      creditSales: parseFloat(result.rows[0].credit_sales) || 0,
      dateRange: {
        start: startDate ? startDate.toISOString() : null,
        end: endDate ? endDate.toISOString() : null
      }
    });
  } catch (error) {
    console.error('Error fetching sales summary:', error);
    res.status(500).json({ error: 'Failed to fetch sales summary', message: error.message });
  }
});

// Sales by Product Report
// Sales by Product - Admin only
router.get('/sales-by-product', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date, product_id } = req.query;
    
    let startDate, endDate;
    if (start_date && end_date) {
      startDate = new Date(start_date);
      endDate = new Date(end_date);
      endDate.setHours(23, 59, 59, 999);
    } else {
      const range = getDateRange(period);
      startDate = range.startDate;
      endDate = range.endDate;
    }

    const sid = req.shopId;
    let dateWhere = '';
    const params = [sid];
    let paramIndex = 2;

    if (startDate && endDate) {
      dateWhere = `AND s.date >= $${paramIndex} AND s.date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    let productFilter = '';
    if (product_id) {
      productFilter = `AND si.product_id = $${paramIndex}`;
      params.push(parseInt(product_id));
      paramIndex++;
    }

    const query = `
      SELECT 
        p.product_id,
        COALESCE(p.item_name_english, p.name) as product_name,
        SUM(si.quantity) as quantity_sold,
        COALESCE(SUM(si.quantity * si.selling_price), 0) as total_sale_amount
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      JOIN products p ON si.product_id = p.product_id AND p.shop_id = s.shop_id
      WHERE s.shop_id = $1 ${dateWhere} ${productFilter}
      GROUP BY p.product_id, p.item_name_english, p.name
      ORDER BY total_sale_amount DESC
    `;

    const result = await db.query(query, params);
    
    res.json({
      products: result.rows.map(row => ({
        product_id: row.product_id,
        product_name: row.product_name,
        quantity_sold: parseFloat(row.quantity_sold) || 0,
        total_sale_amount: parseFloat(row.total_sale_amount) || 0
      })),
      dateRange: {
        start: startDate ? startDate.toISOString() : null,
        end: endDate ? endDate.toISOString() : null
      }
    });
  } catch (error) {
    console.error('Error fetching sales by product:', error);
    res.status(500).json({ error: 'Failed to fetch sales by product', message: error.message });
  }
});

// Profit Report (Simple - Sales - Purchases - Expenses)
// Profit Report - Admin only
router.get('/profit', requireRole('administrator'), async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date } = req.query;
    
    let startDate, endDate;
    if (start_date && end_date) {
      startDate = new Date(start_date);
      endDate = new Date(end_date);
      endDate.setHours(23, 59, 59, 999);
    } else {
      const range = getDateRange(period);
      startDate = range.startDate;
      endDate = range.endDate;
    }

    const sid = req.shopId;
    const params = [sid];
    let paramIndex = 2;

    let salesWhere = 'WHERE shop_id = $1';
    let purchasesWhere = 'WHERE p.shop_id = $1';
    let expensesWhere = 'WHERE shop_id = $1';

    if (startDate && endDate) {
      salesWhere += ` AND date >= $${paramIndex} AND date <= $${paramIndex + 1}`;
      purchasesWhere += ` AND p.date >= $${paramIndex} AND p.date <= $${paramIndex + 1}`;
      expensesWhere += ` AND expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    // Get Sales
    const salesQuery = `
      SELECT COALESCE(SUM(total_amount), 0) as total_sales
      FROM sales
      ${salesWhere}
    `;

    // Get Purchases
    const purchasesQuery = `
      SELECT COALESCE(SUM(p.total_amount), 0) as total_purchases
      FROM purchases p
      ${purchasesWhere}
    `;

    // Get Expenses
    const expensesQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_expenses
      FROM daily_expenses
      ${expensesWhere}
    `;

    const salesDailyQ = `
      SELECT (date::date) AS d, COALESCE(SUM(total_amount), 0)::float AS rev
      FROM sales ${salesWhere}
      GROUP BY (date::date)
      ORDER BY (date::date) ASC
    `;
    const purchDailyQ = `
      SELECT (p.date::date) AS d, COALESCE(SUM(p.total_amount), 0)::float AS amt
      FROM purchases p ${purchasesWhere}
      GROUP BY (p.date::date)
      ORDER BY (p.date::date) ASC
    `;
    const expDailyQ = `
      SELECT (expense_date::date) AS d, COALESCE(SUM(amount), 0)::float AS amt
      FROM daily_expenses ${expensesWhere}
      GROUP BY (expense_date::date)
      ORDER BY (expense_date::date) ASC
    `;
    const expCatQ = `
      SELECT expense_category, COALESCE(SUM(amount), 0)::float AS cat_total
      FROM daily_expenses ${expensesWhere}
      GROUP BY expense_category
      ORDER BY cat_total DESC
      LIMIT 12
    `;

    const [
      salesResult,
      purchasesResult,
      expensesResult,
      salesDailyR,
      purchDailyR,
      expDailyR,
      expCatR,
    ] = await Promise.all([
      db.query(salesQuery, params),
      db.query(purchasesQuery, params),
      db.query(expensesQuery, params),
      db.query(salesDailyQ, params),
      db.query(purchDailyQ, params),
      db.query(expDailyQ, params),
      db.query(expCatQ, params),
    ]);

    const totalSales = parseFloat(salesResult.rows[0].total_sales) || 0;
    const totalPurchases = parseFloat(purchasesResult.rows[0].total_purchases) || 0;
    const totalExpenses = parseFloat(expensesResult.rows[0].total_expenses) || 0;
    const netProfit = totalSales - totalPurchases - totalExpenses;
    const grossProfit = totalSales - totalPurchases;
    const netMarginPct = totalSales > 0 ? Math.round((netProfit / totalSales) * 1000) / 10 : 0;
    const expenseRatioPct = totalSales > 0 ? Math.round((totalExpenses / totalSales) * 1000) / 10 : 0;

    const revMap = {};
    salesDailyR.rows.forEach((row) => {
      const k = ymdFromPgDate(row.d);
      revMap[k] = parseFloat(row.rev) || 0;
    });
    const purchMap = {};
    purchDailyR.rows.forEach((row) => {
      const k = ymdFromPgDate(row.d);
      purchMap[k] = parseFloat(row.amt) || 0;
    });
    const expMap = {};
    expDailyR.rows.forEach((row) => {
      const k = ymdFromPgDate(row.d);
      expMap[k] = parseFloat(row.amt) || 0;
    });
    const allDays = new Set([...Object.keys(revMap), ...Object.keys(purchMap), ...Object.keys(expMap)]);
    const profitTrend = [...allDays].sort().map((d) => {
      const rev = revMap[d] || 0;
      const pc = purchMap[d] || 0;
      const ex = expMap[d] || 0;
      const costs = pc + ex;
      return { date: d, revenue: rev, costs, net: rev - costs };
    });

    const expenseCategoryBreakdown = expCatR.rows.map((row) => ({
      category: row.expense_category || 'Other',
      total: parseFloat(row.cat_total) || 0,
    }));

    res.json({
      totalSales,
      totalPurchases,
      totalExpenses,
      netProfit,
      grossProfit,
      netMarginPct,
      expenseRatioPct,
      profitTrend,
      expenseCategoryBreakdown,
      dateRange: {
        start: startDate ? startDate.toISOString() : null,
        end: endDate ? endDate.toISOString() : null
      }
    });
  } catch (error) {
    console.error('Error fetching profit report:', error);
    res.status(500).json({ error: 'Failed to fetch profit report', message: error.message });
  }
});

// Expense Reports
// Expenses Summary - Admin only
router.get('/expenses-summary', requireRole('administrator'), async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date, category } = req.query;

    let startDate = null;
    let endDate = null;
    let expenseYmdBounds = null;
    if (start_date && end_date) {
      expenseYmdBounds = ymdRangeFromQuery(start_date, end_date);
      if (expenseYmdBounds) {
        startDate = new Date(`${expenseYmdBounds.startYmd}T12:00:00`);
        endDate = new Date(`${expenseYmdBounds.endYmd}T12:00:00`);
      } else {
        startDate = new Date(start_date);
        endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999);
      }
    } else {
      const range = getDateRange(period);
      startDate = range.startDate;
      endDate = range.endDate;
    }

    const sid = req.shopId;
    let whereClause = 'WHERE shop_id = $1';
    const params = [sid];
    let paramIndex = 2;

    if (expenseYmdBounds) {
      whereClause += ` AND expense_date::date >= $${paramIndex}::date AND expense_date::date <= $${paramIndex + 1}::date`;
      params.push(expenseYmdBounds.startYmd, expenseYmdBounds.endYmd);
      paramIndex += 2;
    } else if (startDate && endDate) {
      whereClause += ` AND expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (category) {
      whereClause += ` AND expense_category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Total expenses
    const totalQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_expenses, COUNT(*) as expense_count
      FROM daily_expenses
      ${whereClause}
    `;

    // Category breakdown
    const categoryQuery = `
      SELECT 
        expense_category,
        COALESCE(SUM(amount), 0) as category_total,
        COUNT(*) as category_count
      FROM daily_expenses
      ${whereClause}
      GROUP BY expense_category
      ORDER BY category_total DESC
    `;

    const [totalResult, categoryResult] = await Promise.all([
      db.query(totalQuery, params),
      db.query(categoryQuery, params)
    ]);

    res.json({
      totalExpenses: parseFloat(totalResult.rows[0].total_expenses) || 0,
      expenseCount: parseInt(totalResult.rows[0].expense_count) || 0,
      categoryBreakdown: categoryResult.rows.map(row => ({
        category: row.expense_category,
        total: parseFloat(row.category_total) || 0,
        count: parseInt(row.category_count) || 0
      })),
      dateRange: {
        start: expenseYmdBounds
          ? `${expenseYmdBounds.startYmd}T00:00:00.000Z`
          : startDate
            ? startDate.toISOString()
            : null,
        end: expenseYmdBounds
          ? `${expenseYmdBounds.endYmd}T23:59:59.999Z`
          : endDate
            ? endDate.toISOString()
            : null,
      },
    });
  } catch (error) {
    console.error('Error fetching expenses summary:', error);
    res.status(500).json({ error: 'Failed to fetch expenses summary', message: error.message });
  }
});

// Expenses List - Admin only
router.get('/expenses-list', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const { period = 'monthly', start_date, end_date, category } = req.query;

    let startDate = null;
    let endDate = null;
    let expenseYmdBounds = null;
    if (start_date && end_date) {
      expenseYmdBounds = ymdRangeFromQuery(start_date, end_date);
      if (expenseYmdBounds) {
        startDate = new Date(`${expenseYmdBounds.startYmd}T12:00:00`);
        endDate = new Date(`${expenseYmdBounds.endYmd}T12:00:00`);
      } else {
        startDate = new Date(start_date);
        endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999);
      }
    } else {
      const range = getDateRange(period);
      startDate = range.startDate;
      endDate = range.endDate;
    }

    const sid = req.shopId;
    let whereClause = 'WHERE shop_id = $1';
    const params = [sid];
    let paramIndex = 2;

    if (expenseYmdBounds) {
      whereClause += ` AND expense_date::date >= $${paramIndex}::date AND expense_date::date <= $${paramIndex + 1}::date`;
      params.push(expenseYmdBounds.startYmd, expenseYmdBounds.endYmd);
      paramIndex += 2;
    } else if (startDate && endDate) {
      whereClause += ` AND expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (category) {
      whereClause += ` AND expense_category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    const query = `
      SELECT 
        expense_id,
        expense_date as date,
        expense_category as expense_name,
        expense_category as category,
        amount,
        payment_method,
        notes
      FROM daily_expenses
      ${whereClause}
      ORDER BY expense_date DESC, expense_id DESC
    `;

    const result = await db.query(query, params);
    
    res.json({
      expenses: result.rows,
      dateRange: {
        start: expenseYmdBounds
          ? `${expenseYmdBounds.startYmd}T00:00:00.000Z`
          : startDate
            ? startDate.toISOString()
            : null,
        end: expenseYmdBounds
          ? `${expenseYmdBounds.endYmd}T23:59:59.999Z`
          : endDate
            ? endDate.toISOString()
            : null,
      },
    });
  } catch (error) {
    console.error('Error fetching expenses list:', error);
    res.status(500).json({ error: 'Failed to fetch expenses list', message: error.message });
  }
});

// Stock Reports
// Stock Current - Admin only
router.get('/stock-current', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        p.product_id,
        COALESCE(p.item_name_english, p.name) as product_name,
        p.quantity_in_stock as stock_quantity,
        p.purchase_price,
        (p.quantity_in_stock * p.purchase_price) as stock_value
      FROM products p
      ORDER BY p.quantity_in_stock ASC, p.name ASC
    `);
    
    res.json({
      products: result.rows.map(row => ({
        product_id: row.product_id,
        product_name: row.product_name,
        stock_quantity: parseFloat(row.stock_quantity) || 0,
        stock_value: parseFloat(row.stock_value) || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching current stock:', error);
    res.status(500).json({ error: 'Failed to fetch current stock', message: error.message });
  }
});

// Stock Low - Admin only
router.get('/stock-low', requireRole('administrator'), async (req, res) => {
  try {
    const { min_quantity = 5 } = req.query;
    
    const result = await db.query(`
      SELECT 
        p.product_id,
        COALESCE(p.item_name_english, p.name) as product_name,
        p.quantity_in_stock as current_qty,
        $1::integer as minimum_qty
      FROM products p
      WHERE p.quantity_in_stock <= $1
      ORDER BY p.quantity_in_stock ASC, p.name ASC
    `, [parseInt(min_quantity)]);
    
    res.json({
      products: result.rows.map(row => ({
        product_id: row.product_id,
        product_name: row.product_name,
        current_qty: parseFloat(row.current_qty) || 0,
        minimum_qty: parseInt(row.minimum_qty) || 5
      }))
    });
  } catch (error) {
    console.error('Error fetching low stock:', error);
    res.status(500).json({ error: 'Failed to fetch low stock', message: error.message });
  }
});

// Customer Statement/History
// Customer Statement - Admin only
router.get('/customer-statement/:id', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;
    
    // Get customer info
    const customerResult = await db.query(
      'SELECT customer_id, name, opening_balance, current_balance FROM customers WHERE customer_id = $1',
      [id]
    );
    
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    const customer = customerResult.rows[0];
    const openingBalance = parseFloat(customer.opening_balance) || 0;
    const currentBalance = parseFloat(customer.current_balance) || 0;
    
    // Don't apply date filters - show ALL transactions to match current_balance
    // Get sales (credit/split only) - ALL sales, not filtered by date
    const salesQuery = `
      SELECT 
        sale_id,
        invoice_number,
        date,
        total_amount,
        paid_amount,
        payment_type,
        (total_amount - paid_amount) as due_amount
      FROM sales
      WHERE customer_id = $1 AND payment_type IN ('credit', 'split')
      ORDER BY date ASC, sale_id ASC
    `;
    
    // Get payments - ALL payments, not filtered by date
    const paymentsQuery = `
      SELECT 
        payment_id,
        payment_date as date,
        amount,
        payment_method,
        notes
      FROM customer_payments
      WHERE customer_id = $1
      ORDER BY payment_date ASC, payment_id ASC
    `;
    
    const [salesResult, paymentsResult] = await Promise.all([
      db.query(salesQuery, [id]),
      db.query(paymentsQuery, [id])
    ]);
    
    // Calculate totals from ALL transactions
    const totalSalesDue = salesResult.rows.reduce((sum, s) => sum + parseFloat(s.due_amount || 0), 0);
    const totalPaid = paymentsResult.rows.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    
    // Build statement with running balance
    const statement = [];
    let runningBalance = openingBalance;
    
    // Add opening balance
    statement.push({
      date: customer.created_at || new Date().toISOString(),
      type: 'opening',
      description: 'Opening Balance',
      amount: openingBalance,
      balance: runningBalance
    });
    
    // Combine and sort sales and payments
    const transactions = [
      ...salesResult.rows.map(s => ({ ...s, type: 'sale' })),
      ...paymentsResult.rows.map(p => ({ ...p, type: 'payment' }))
    ].sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      if (dateA.getTime() === dateB.getTime()) {
        // If same date, sort by ID to maintain order
        return (a.sale_id || a.payment_id || 0) - (b.sale_id || b.payment_id || 0);
      }
      return dateA - dateB;
    });
    
    transactions.forEach(trans => {
      if (trans.type === 'sale') {
        runningBalance += parseFloat(trans.due_amount || 0);
        statement.push({
          date: trans.date,
          type: 'sale',
          invoice_number: trans.invoice_number,
          description: `Sale - Invoice ${trans.invoice_number}`,
          amount: parseFloat(trans.due_amount || 0),
          balance: runningBalance
        });
      } else {
        runningBalance -= parseFloat(trans.amount || 0);
        statement.push({
          date: trans.date,
          type: 'payment',
          description: `Payment - ${trans.payment_method || 'Cash'}`,
          amount: -parseFloat(trans.amount || 0),
          balance: runningBalance
        });
      }
    });
    
    // Use the actual current_balance from database as the final balance
    // This ensures consistency with the due list
    const finalBalance = currentBalance;
    
    res.json({
      customer: {
        customer_id: customer.customer_id,
        name: customer.name,
        current_balance: finalBalance
      },
      statement,
      total_sales: totalSalesDue,
      total_payments: totalPaid,
      remaining_balance: finalBalance
    });
  } catch (error) {
    console.error('Error fetching customer statement:', error);
    res.status(500).json({ error: 'Failed to fetch customer statement', message: error.message });
  }
});

// Supplier History
// Supplier History - Admin only
router.get('/supplier-history/:id', requireRole('administrator'), requireProPlan, async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;
    
    // Get supplier info
    const supplierResult = await db.query(
      'SELECT supplier_id, name, opening_balance FROM suppliers WHERE supplier_id = $1',
      [id]
    );
    
    if (supplierResult.rows.length === 0) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    
    const supplier = supplierResult.rows[0];
    const openingBalance = parseFloat(supplier.opening_balance) || 0;
    
    // Calculate current payable balance (same way as supplier payables endpoint)
    const balanceResult = await db.query(`
      SELECT 
        opening_balance,
        COALESCE((
          SELECT SUM(total_amount) 
          FROM purchases 
          WHERE supplier_id = $1 
          AND payment_type = 'credit'
        ), 0) as total_credit_purchases,
        COALESCE((
          SELECT SUM(amount) 
          FROM supplier_payments 
          WHERE supplier_id = $1
        ), 0) as total_paid,
        (opening_balance + 
         COALESCE((
           SELECT SUM(total_amount) 
           FROM purchases 
           WHERE supplier_id = $1 
           AND payment_type = 'credit'
         ), 0) - 
         COALESCE((
           SELECT SUM(amount) 
           FROM supplier_payments 
           WHERE supplier_id = $1
         ), 0)
        ) as current_payable_balance
      FROM suppliers
      WHERE supplier_id = $1
    `, [id]);
    
    const balanceData = balanceResult.rows[0];
    const currentPayable = parseFloat(balanceData.current_payable_balance) || 0;
    const totalPurchases = parseFloat(balanceData.total_credit_purchases) || 0;
    const totalPaid = parseFloat(balanceData.total_paid) || 0;
    
    // Don't apply date filters - show ALL transactions to match current_payable_balance
    // Get purchases (credit only) - ALL purchases, not filtered by date
    const purchasesQuery = `
      SELECT 
        p.purchase_id,
        p.date,
        p.total_amount,
        p.payment_type
      FROM purchases p
      WHERE p.supplier_id = $1 AND p.payment_type = 'credit'
      ORDER BY p.date ASC, p.purchase_id ASC
    `;
    
    // Get payments - ALL payments, not filtered by date
    const paymentsQuery = `
      SELECT 
        payment_id,
        payment_date as date,
        amount,
        payment_method,
        notes
      FROM supplier_payments
      WHERE supplier_id = $1
      ORDER BY payment_date ASC, payment_id ASC
    `;
    
    const [purchasesResult, paymentsResult] = await Promise.all([
      db.query(purchasesQuery, [id]),
      db.query(paymentsQuery, [id])
    ]);
    
    // Build history with running balance
    const history = [];
    let runningBalance = openingBalance;
    
    // Add opening balance
    history.push({
      date: supplier.created_at || new Date().toISOString(),
      type: 'opening',
      description: 'Opening Balance',
      amount: openingBalance,
      balance: runningBalance
    });
    
    // Combine and sort purchases and payments
    const transactions = [
      ...purchasesResult.rows.map(p => ({ ...p, type: 'purchase' })),
      ...paymentsResult.rows.map(p => ({ ...p, type: 'payment' }))
    ].sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      if (dateA.getTime() === dateB.getTime()) {
        // If same date, sort by ID to maintain order
        return (a.purchase_id || a.payment_id || 0) - (b.purchase_id || b.payment_id || 0);
      }
      return dateA - dateB;
    });
    
    transactions.forEach(trans => {
      if (trans.type === 'purchase') {
        runningBalance += parseFloat(trans.total_amount || 0);
        history.push({
          date: trans.date,
          type: 'purchase',
          description: `Purchase #${trans.purchase_id}`,
          amount: parseFloat(trans.total_amount || 0),
          balance: runningBalance
        });
      } else {
        runningBalance -= parseFloat(trans.amount || 0);
        history.push({
          date: trans.date,
          type: 'payment',
          description: `Payment - ${trans.payment_method || 'Cash'}`,
          amount: -parseFloat(trans.amount || 0),
          balance: runningBalance
        });
      }
    });
    
    // Use the calculated current_payable as the final balance
    // This ensures consistency with the payables list
    const finalBalance = currentPayable;
    
    res.json({
      supplier: {
        supplier_id: supplier.supplier_id,
        name: supplier.name,
        current_payable: finalBalance
      },
      history,
      total_purchases: totalPurchases,
      total_paid: totalPaid,
      remaining_balance: finalBalance
    });
  } catch (error) {
    console.error('Error fetching supplier history:', error);
    res.status(500).json({ error: 'Failed to fetch supplier history', message: error.message });
  }
});

// Dashboard: today KPIs + rolling week + rolling 30-day window for lists & snapshot (avoids empty May UI when April had sales).
// Accessible to both administrators and cashiers (cashiers see limited data)
router.get('/dashboard', async (req, res) => {
  try {
    const isAdmin = isElevatedRole(req.user.role);
    const shopId = req.shopId;
    const settingsQuery = `SELECT other_app_settings FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1`;
    const [todayDate, settingsResult] = await Promise.all([
      getBusinessTodayDateString(db),
      db.query(settingsQuery, [shopId]),
    ]);

    /** Inclusive last 30 days ending on business today (matches activity / top sellers / snapshot). */
    const dashPeriodEnd = todayDate;
    const dashPeriodStart = addCalendarDaysYmd(todayDate, -29);
    const dashRange = [shopId, dashPeriodStart, dashPeriodEnd];
    let dashPeriodLabel = 'Last 30 days';
    try {
      const [sy, sm, sd] = dashPeriodStart.split('-').map(Number);
      const [ey, em, ed] = dashPeriodEnd.split('-').map(Number);
      const ds = new Date(sy, sm - 1, sd);
      const de = new Date(ey, em - 1, ed);
      dashPeriodLabel = `${ds.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${de.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } catch {
      /* keep Last 30 days */
    }

    const weekStart = addCalendarDaysYmd(todayDate, -6);

    let openingCash = 0;
    if (settingsResult.rows.length > 0) {
      const otherSettings = settingsResult.rows[0].other_app_settings;
      if (otherSettings && typeof otherSettings === 'object') {
        openingCash = parseFloat(otherSettings.opening_cash || otherSettings.openingCash || 0) || 0;
      }
    }

    const todaySalesQuery = `
      SELECT 
        COALESCE(SUM(total_amount), 0) as today_sale,
        COUNT(*)::int as bill_count
      FROM sales
      WHERE date = $1::date AND shop_id = $2
    `;

    const todayProfitQuery = isAdmin ? `
      SELECT 
        COALESCE(SUM((si.selling_price - COALESCE(p.purchase_price, 0)) * si.quantity), 0) as today_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      LEFT JOIN products p ON si.product_id = p.product_id AND p.shop_id = s.shop_id
      WHERE s.date = $1::date AND s.shop_id = $2
    ` : null;

    const todayCollectedQuery = `
      SELECT COALESCE(SUM(paid_amount), 0) AS collected_today
      FROM sales
      WHERE date = $1::date AND shop_id = $2
    `;

    const todayCashSalesQuery = `
      SELECT COALESCE(SUM(paid_amount), 0) as cash_sales
      FROM sales
      WHERE date = $1::date AND payment_type = 'cash' AND shop_id = $2
    `;

    const customerPaymentsQuery = `
      SELECT COALESCE(SUM(cp.amount), 0) as cash_received
      FROM customer_payments cp
      INNER JOIN customers c ON cp.customer_id = c.customer_id
      WHERE cp.payment_date = $1::date
      AND c.shop_id = $2
      AND (cp.payment_method = 'cash' OR cp.payment_method IS NULL)
    `;

    const supplierPaymentsQuery = `
      SELECT COALESCE(SUM(sp.amount), 0) as cash_paid
      FROM supplier_payments sp
      INNER JOIN suppliers s ON sp.supplier_id = s.supplier_id
      WHERE sp.payment_date = $1::date
      AND s.shop_id = $2
      AND (sp.payment_method = 'cash' OR sp.payment_method IS NULL)
    `;

    const customerDueQuery = `
      SELECT 
        COALESCE(SUM(current_balance), 0) as customer_due,
        COUNT(*)::int as customer_count
      FROM customers
      WHERE current_balance > 0 AND shop_id = $1
    `;

    const supplierDueQuery = `
      WITH pur AS (
        SELECT supplier_id, shop_id, SUM(total_amount) AS credit_total
        FROM purchases
        WHERE payment_type = 'credit'
        GROUP BY supplier_id, shop_id
      ),
      pay AS (
        SELECT supplier_id, SUM(amount) AS paid_total
        FROM supplier_payments
        GROUP BY supplier_id
      )
      SELECT 
        COALESCE(SUM(
          s.opening_balance
          + COALESCE(pur.credit_total, 0)
          - COALESCE(pay.paid_total, 0)
        ), 0) AS supplier_due,
        COUNT(*)::int AS supplier_count
      FROM suppliers s
      LEFT JOIN pur ON pur.supplier_id = s.supplier_id AND pur.shop_id = s.shop_id
      LEFT JOIN pay ON pay.supplier_id = s.supplier_id
      WHERE s.shop_id = $1
        AND s.opening_balance + COALESCE(pur.credit_total, 0) - COALESCE(pay.paid_total, 0) > 0
    `;

    const lowStockQuery = `
      SELECT COUNT(*)::int as low_stock_count
      FROM products
      WHERE quantity_in_stock <= 5 AND shop_id = $1
    `;

    const lowStockPeekQuery = `
      SELECT 
        COALESCE(item_name_english, name) AS product_name,
        quantity_in_stock::int AS quantity_in_stock
      FROM products
      WHERE quantity_in_stock <= 5 AND shop_id = $1
      ORDER BY quantity_in_stock ASC, product_id ASC
      LIMIT 1
    `;

    const weekRange = [shopId, weekStart, todayDate];

    const topSellingMonthQuery = `
      SELECT 
        p.product_id,
        COALESCE(p.item_name_english, p.name) AS product_name,
        MAX(COALESCE(c.category_name, NULLIF(TRIM(p.category), ''), 'General')) AS category_name,
        SUM(si.quantity)::float AS quantity_sold,
        SUM(si.quantity * si.selling_price)::float AS revenue,
        MIN(p.quantity_in_stock)::int AS quantity_in_stock
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      JOIN products p ON si.product_id = p.product_id AND p.shop_id = s.shop_id
      LEFT JOIN categories c ON p.category_id = c.category_id AND c.shop_id = s.shop_id
      WHERE s.shop_id = $1 AND s.date >= $2::date AND s.date <= $3::date
      GROUP BY p.product_id, p.item_name_english, p.name
      ORDER BY revenue DESC NULLS LAST
      LIMIT 5
    `;

    const salesMonthQuery = `
      SELECT 
        sale_id,
        invoice_number,
        customer_name,
        total_amount,
        paid_amount,
        payment_type,
        date
      FROM sales
      WHERE shop_id = $1 AND date >= $2::date AND date <= $3::date
      ORDER BY sale_id DESC
      LIMIT 20
    `;

    const weekRevenueQuery = `
      SELECT s.date::date AS d, COALESCE(SUM(s.total_amount), 0)::float AS revenue
      FROM sales s
      WHERE s.shop_id = $1 AND s.date >= $2::date AND s.date <= $3::date
      GROUP BY s.date
    `;

    const weekExpensesQuery = `
      SELECT e.expense_date::date AS d, COALESCE(SUM(e.amount), 0)::float AS amt
      FROM daily_expenses e
      WHERE e.shop_id = $1 AND e.expense_date >= $2::date AND e.expense_date <= $3::date
      GROUP BY e.expense_date
    `;

    const weekProfitQuery = isAdmin
      ? `
      SELECT s.date::date AS d,
        COALESCE(SUM((si.selling_price - COALESCE(p.purchase_price, 0)) * si.quantity), 0)::float AS profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      LEFT JOIN products p ON si.product_id = p.product_id AND p.shop_id = s.shop_id
      WHERE s.shop_id = $1 AND s.date >= $2::date AND s.date <= $3::date
      GROUP BY s.date
    `
      : null;

    const monthSalesAggQuery = `
      SELECT 
        COALESCE(SUM(total_amount), 0)::float AS total_sales,
        COALESCE(SUM(paid_amount), 0)::float AS cash_collected
      FROM sales
      WHERE shop_id = $1 AND date >= $2::date AND date <= $3::date
    `;

    const monthPurchQuery = `
      SELECT COALESCE(SUM(total_amount), 0)::float AS total_purchases
      FROM purchases
      WHERE shop_id = $1 AND date >= $2::date AND date <= $3::date
    `;

    const monthExpQuery = `
      SELECT COALESCE(SUM(amount), 0)::float AS total_expenses
      FROM daily_expenses
      WHERE shop_id = $1 AND expense_date >= $2::date AND expense_date <= $3::date
    `;

    const monthUnitsSoldQuery = `
      SELECT COALESCE(SUM(si.quantity), 0)::float AS units
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      WHERE s.shop_id = $1 AND s.date >= $2::date AND s.date <= $3::date
    `;

    const monthInvoiceCountQuery = `
      SELECT COUNT(*)::int AS c
      FROM sales
      WHERE shop_id = $1 AND date >= $2::date AND date <= $3::date
    `;

    const activityExpensesQuery = isAdmin
      ? `
      SELECT expense_id, expense_category, amount, expense_date, payment_method, notes
      FROM daily_expenses
      WHERE shop_id = $1 AND expense_date >= $2::date AND expense_date <= $3::date
      ORDER BY expense_id DESC
      LIMIT 12
    `
      : null;

    const dayParam = [todayDate, shopId];

    const queries = [
      db.query(todaySalesQuery, dayParam),
      isAdmin ? db.query(todayProfitQuery, dayParam) : Promise.resolve({ rows: [{ today_profit: 0 }] }),
      db.query(todayCashSalesQuery, dayParam),
      db.query(customerPaymentsQuery, dayParam),
      isAdmin ? db.query(supplierPaymentsQuery, dayParam) : Promise.resolve({ rows: [{ cash_paid: 0 }] }),
      db.query(customerDueQuery, [shopId]),
      isAdmin ? db.query(supplierDueQuery, [shopId]) : Promise.resolve({ rows: [{ supplier_due: 0, supplier_count: 0 }] }),
      db.query(lowStockQuery, [shopId]),
      db.query(lowStockPeekQuery, [shopId]),
      db.query(todayCollectedQuery, dayParam),
      db.query(topSellingMonthQuery, dashRange),
      db.query(salesMonthQuery, dashRange),
      db.query(weekRevenueQuery, weekRange),
      db.query(weekExpensesQuery, weekRange),
      isAdmin ? db.query(weekProfitQuery, weekRange) : Promise.resolve({ rows: [] }),
      db.query(monthSalesAggQuery, dashRange),
      db.query(monthPurchQuery, dashRange),
      db.query(monthExpQuery, dashRange),
      db.query(monthUnitsSoldQuery, dashRange),
      db.query(monthInvoiceCountQuery, dashRange),
      isAdmin ? db.query(activityExpensesQuery, dashRange) : Promise.resolve({ rows: [] }),
    ];

    const [
      todaySalesResult,
      todayProfitResult,
      todayCashSalesResult,
      customerPaymentsResult,
      supplierPaymentsResult,
      customerDueResult,
      supplierDueResult,
      lowStockResult,
      lowStockPeekResult,
      todayCollectedResult,
      topSellingMonthResult,
      salesMonthResult,
      weekRevenueResult,
      weekExpensesResult,
      weekProfitResult,
      monthSalesAggResult,
      monthPurchResult,
      monthExpResult,
      monthUnitsSoldResult,
      monthInvoiceCountResult,
      activityExpensesResult,
    ] = await Promise.all(queries);

    let cashInHand = 0;
    if (isAdmin) {
      const todayCashSales = parseFloat(todayCashSalesResult.rows[0].cash_sales) || 0;
      const customerPayments = parseFloat(customerPaymentsResult.rows[0].cash_received) || 0;
      const supplierPayments = parseFloat(supplierPaymentsResult.rows[0].cash_paid) || 0;
      cashInHand = openingCash + todayCashSales + customerPayments - supplierPayments;
    }

    const todaySale = parseFloat(todaySalesResult.rows[0].today_sale) || 0;
    const todayBillCount = parseInt(todaySalesResult.rows[0].bill_count, 10) || 0;
    const rawTodayProfit = isAdmin ? parseFloat(todayProfitResult.rows[0].today_profit) || 0 : null;
    const todayProfit = isAdmin ? rawTodayProfit : null;
    const todayCollected = parseFloat(todayCollectedResult.rows[0].collected_today) || 0;
    const todayProfitMarginPct =
      isAdmin && todaySale > 0 && rawTodayProfit != null
        ? Math.round(((rawTodayProfit / todaySale) * 1000)) / 10
        : null;

    const dayKeys = [];
    for (let i = 0; i < 7; i++) {
      dayKeys.push(addCalendarDaysYmd(weekStart, i));
    }

    const revMap = {};
    weekRevenueResult.rows.forEach((r) => {
      revMap[ymdFromPgDate(r.d)] = parseFloat(r.revenue) || 0;
    });
    const expMap = {};
    weekExpensesResult.rows.forEach((r) => {
      expMap[ymdFromPgDate(r.d)] = parseFloat(r.amt) || 0;
    });
    const profMap = {};
    weekProfitResult.rows.forEach((r) => {
      profMap[ymdFromPgDate(r.d)] = parseFloat(r.profit) || 0;
    });

    const weeklyTrend = {
      labels: dayKeys.map((d) => {
        try {
          const [yy, mm, dd] = d.split('-').map(Number);
          const dt = new Date(yy, mm - 1, dd);
          return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        } catch {
          return d;
        }
      }),
      days: dayKeys,
      revenue: dayKeys.map((d) => revMap[d] || 0),
      expenses: dayKeys.map((d) => expMap[d] || 0),
      profit: isAdmin ? dayKeys.map((d) => profMap[d] || 0) : dayKeys.map(() => 0),
    };

    const totalSalesM = parseFloat(monthSalesAggResult.rows[0].total_sales) || 0;
    const cashCollectedM = parseFloat(monthSalesAggResult.rows[0].cash_collected) || 0;
    const totalPurchasesM = parseFloat(monthPurchResult.rows[0].total_purchases) || 0;
    const totalExpensesM = parseFloat(monthExpResult.rows[0].total_expenses) || 0;
    const unitsSoldM = parseFloat(monthUnitsSoldResult.rows[0].units) || 0;
    const netProfitMonth = isAdmin ? totalSalesM - totalPurchasesM - totalExpensesM : null;
    const custDue = parseFloat(customerDueResult.rows[0].customer_due) || 0;

    const monthSnapshot = {
      label: dashPeriodLabel,
      netProfit: netProfitMonth,
      totalExpenses: totalExpensesM,
      creditOutstanding: custDue,
      cashCollected: cashCollectedM,
      totalSales: totalSalesM,
      totalPurchases: totalPurchasesM,
      unitsSold: unitsSoldM,
    };

    const lowStockPeekRow = lowStockPeekResult.rows[0];
    const lowStockPeek =
      lowStockPeekRow &&
      typeof lowStockPeekRow.product_name === 'string'
        ? {
            product_name: lowStockPeekRow.product_name,
            quantity_in_stock: parseInt(lowStockPeekRow.quantity_in_stock, 10) || 0,
            minimum: 5,
          }
        : null;

    const salesRowsMonth = salesMonthResult.rows || [];
    const invoiceCountMonth = parseInt(monthInvoiceCountResult.rows[0]?.c, 10) || 0;

    const fmtBillWhen = (d) => {
      const ymd = ymdFromPgDate(d);
      try {
        const [yy, mm, dd] = ymd.split('-').map(Number);
        return new Date(yy, mm - 1, dd).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
      } catch {
        return ymd;
      }
    };

    const activity = [];
    salesRowsMonth.forEach((row) => {
      const total = parseFloat(row.total_amount) || 0;
      const paid = parseFloat(row.paid_amount) || 0;
      const due = Math.max(0, total - paid);
      const inv = row.invoice_number ? `#${String(row.invoice_number)}` : `#${row.sale_id}`;
      const cust = row.customer_name || 'Walk-in Customer';
      activity.push({
        sort: `${ymdFromPgDate(row.date)}#sale#${String(row.sale_id).padStart(9, '0')}`,
        accent: '#15803d',
        headline: `New sale ${inv}`,
        detail: `PKR ${total.toLocaleString('en-US', { maximumFractionDigits: 0 })} to ${cust}. PKR ${paid.toLocaleString('en-US', { maximumFractionDigits: 0 })} collected${due > 0.01 ? `, PKR ${due.toLocaleString('en-US', { maximumFractionDigits: 0 })} outstanding.` : '.'}`,
        when: fmtBillWhen(row.date),
      });
    });
    (activityExpensesResult.rows || []).forEach((e) => {
      const amt = parseFloat(e.amount) || 0;
      const label = e.expense_category || e.notes || 'Expense';
      activity.push({
        sort: `${ymdFromPgDate(e.expense_date)}#exp#${String(e.expense_id).padStart(9, '0')}`,
        accent: '#dc2626',
        headline: 'Expense added',
        detail: `${label}, PKR ${amt.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${e.payment_method || 'cash'}).`,
        when: fmtBillWhen(e.expense_date),
      });
    });
    const lc = parseInt(lowStockResult.rows[0].low_stock_count, 10) || 0;
    if (lc > 0 && lowStockPeek) {
      activity.push({
        sort: `${todayDate}#stock`,
        accent: '#d97706',
        headline: 'Low stock alert',
        detail: `${lowStockPeek.product_name} has ${lowStockPeek.quantity_in_stock} unit(s) (minimum ${lowStockPeek.minimum}).`,
        when: 'Today',
      });
    }
    activity.sort((a, b) => String(b.sort).localeCompare(String(a.sort)));

    res.json({
      businessToday: todayDate,
      todaySale,
      todayBillCount,
      todayProfit,
      todayProfitMarginPct,
      todayCollected,
      cashInHand: isAdmin ? cashInHand : null,
      customerDue: custDue,
      customerDueCustomerCount: parseInt(customerDueResult.rows[0].customer_count, 10) || 0,
      supplierDue: isAdmin ? parseFloat(supplierDueResult.rows[0].supplier_due) || 0 : null,
      lowStockCount: lc,
      lowStockPeek,
      topSellingItems: topSellingMonthResult.rows.map((row) => ({
        product_id: row.product_id,
        product_name: row.product_name,
        category_name: row.category_name || 'General',
        quantity_sold: Math.round(parseFloat(row.quantity_sold) || 0),
        revenue: parseFloat(row.revenue) || 0,
        quantity_in_stock: parseInt(row.quantity_in_stock, 10) || 0,
      })),
      recentBills: salesRowsMonth.slice(0, 8).map((row) => {
        const total = parseFloat(row.total_amount) || 0;
        const paid = parseFloat(row.paid_amount) || 0;
        return {
          sale_id: row.sale_id,
          invoice_number: row.invoice_number,
          customer_name: row.customer_name || '-',
          total_amount: total,
          paid_amount: paid,
          payment_type: row.payment_type || 'cash',
          date: row.date,
          due_remaining: Math.max(0, total - paid),
        };
      }),
      billsMonthTotals: {
        invoiceCount: invoiceCountMonth,
        totalOutstanding: custDue,
      },
      weeklyTrend,
      monthSnapshot,
      activity: activity.slice(0, 14),
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data', message: error.message });
  }
});

module.exports = router;
