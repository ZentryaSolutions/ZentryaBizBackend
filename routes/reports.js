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

// Helper function to get date range for periods

// Helper function to get date range for periods
function getDateRange(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startDate, endDate;

  switch (period) {
    case 'daily':
      startDate = new Date(today);
      endDate = new Date(today);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'weekly':
      // Get start of current week (Monday)
      const dayOfWeek = now.getDay();
      const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      startDate = new Date(now.setDate(diff));
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      break;

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

    const creditParams = [sid];
    const [salesResult, purchasesResult, expensesResult, creditResult] = await Promise.all([
      db.query(salesQuery, params),
      db.query(purchasesQuery, params),
      db.query(expensesQuery, params),
      db.query(creditQuery, creditParams)
    ]);

    const totalSales = parseFloat(salesResult.rows[0].total_sales) || 0;
    const totalPurchases = parseFloat(purchasesResult.rows[0].total_purchases) || 0;
    const totalExpenses = parseFloat(expensesResult.rows[0].total_expenses) || 0;
    const netProfit = totalSales - totalPurchases - totalExpenses;
    const cashReceived = parseFloat(salesResult.rows[0].cash_received) || 0;
    const creditGiven = parseFloat(creditResult.rows[0].total_credit_given) || 0;

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

    let whereClause = '';
    const params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      whereClause = `WHERE s.date >= $${paramIndex} AND s.date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (product_id) {
      whereClause += whereClause ? ' AND' : ' WHERE';
      whereClause += ` EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.sale_id AND si.product_id = $${paramIndex})`;
      params.push(parseInt(product_id));
      paramIndex++;
    }

    if (customer_id) {
      whereClause += whereClause ? ' AND' : ' WHERE';
      whereClause += ` s.customer_id = $${paramIndex}`;
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

    let dateWhere = '';
    const params = [];
    let paramIndex = 1;

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
      JOIN products p ON si.product_id = p.product_id
      WHERE 1=1 ${dateWhere} ${productFilter}
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
router.get('/profit', requireRole('administrator'), requireProPlan, async (req, res) => {
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

    const params = [];
    let paramIndex = 1;
    let dateWhere = '';
    
    if (startDate && endDate) {
      dateWhere = `WHERE date >= $${paramIndex} AND date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    // Get Sales
    const salesQuery = `
      SELECT COALESCE(SUM(total_amount), 0) as total_sales
      FROM sales
      ${dateWhere}
    `;

    // Get Purchases
    const purchasesWhere = dateWhere.replace(/date/g, 'p.date');
    const purchasesQuery = `
      SELECT COALESCE(SUM(p.total_amount), 0) as total_purchases
      FROM purchases p
      ${purchasesWhere}
    `;

    // Get Expenses
    const expensesWhere = dateWhere.replace(/date/g, 'expense_date');
    const expensesQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_expenses
      FROM daily_expenses
      ${expensesWhere}
    `;

    const [salesResult, purchasesResult, expensesResult] = await Promise.all([
      db.query(salesQuery, params),
      db.query(purchasesQuery, params),
      db.query(expensesQuery, params)
    ]);

    const totalSales = parseFloat(salesResult.rows[0].total_sales) || 0;
    const totalPurchases = parseFloat(purchasesResult.rows[0].total_purchases) || 0;
    const totalExpenses = parseFloat(expensesResult.rows[0].total_expenses) || 0;
    const netProfit = totalSales - totalPurchases - totalExpenses;

    res.json({
      totalSales,
      totalPurchases,
      totalExpenses,
      netProfit,
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

    let whereClause = '';
    const params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      whereClause = `WHERE expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (category) {
      whereClause += whereClause ? ' AND' : ' WHERE';
      whereClause += ` expense_category = $${paramIndex}`;
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
        start: startDate ? startDate.toISOString() : null,
        end: endDate ? endDate.toISOString() : null
      }
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

    let whereClause = '';
    const params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      whereClause = `WHERE expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (category) {
      whereClause += whereClause ? ' AND' : ' WHERE';
      whereClause += ` expense_category = $${paramIndex}`;
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
        start: startDate ? startDate.toISOString() : null,
        end: endDate ? endDate.toISOString() : null
      }
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

// Dashboard Data - Today's Status Only
// Accessible to both administrators and cashiers (cashiers see limited data)
router.get('/dashboard', async (req, res) => {
  try {
    const isAdmin = isElevatedRole(req.user.role);
    const shopId = req.shopId;
    // Parallel: business "today" + settings (was two sequential round-trips)
    const settingsQuery = `SELECT other_app_settings FROM settings WHERE shop_id = $1 ORDER BY id LIMIT 1`;
    const [todayDate, settingsResult] = await Promise.all([
      getBusinessTodayDateString(db),
      db.query(settingsQuery, [shopId]),
    ]);

    let openingCash = 0;
    if (settingsResult.rows.length > 0) {
      const otherSettings = settingsResult.rows[0].other_app_settings;
      if (otherSettings && typeof otherSettings === 'object') {
        openingCash = parseFloat(otherSettings.opening_cash || otherSettings.openingCash || 0) || 0;
      }
    }

    // 1. Today Sale - Total sale amount of today only (completed bills, exclude cancelled)
    const todaySalesQuery = `
      SELECT 
        COALESCE(SUM(total_amount), 0) as today_sale,
        COUNT(*) as bill_count
      FROM sales
      WHERE date = $1::date AND shop_id = $2
    `;

    // 2. Today Profit - (Selling Price - Purchase Cost) × Quantity for today's bills
    // Only calculate for administrators (cashiers don't see profit)
    const todayProfitQuery = isAdmin ? `
      SELECT 
        COALESCE(SUM((si.selling_price - COALESCE(p.purchase_price, 0)) * si.quantity), 0) as today_profit
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      LEFT JOIN products p ON si.product_id = p.product_id AND p.shop_id = s.shop_id
      WHERE s.date = $1::date AND s.shop_id = $2
    ` : null;

    // 3. Cash in Hand - Opening cash + Today cash sales + Customer payments (cash) - Supplier payments (cash)
    // Today cash sales
    const todayCashSalesQuery = `
      SELECT COALESCE(SUM(paid_amount), 0) as cash_sales
      FROM sales
      WHERE date = $1::date AND payment_type = 'cash' AND shop_id = $2
    `;

    // Customer payments received today (cash) — scoped via customer.shop_id
    const customerPaymentsQuery = `
      SELECT COALESCE(SUM(cp.amount), 0) as cash_received
      FROM customer_payments cp
      INNER JOIN customers c ON cp.customer_id = c.customer_id
      WHERE cp.payment_date = $1::date
      AND c.shop_id = $2
      AND (cp.payment_method = 'cash' OR cp.payment_method IS NULL)
    `;

    // Supplier payments made today (cash) — scoped via supplier.shop_id
    const supplierPaymentsQuery = `
      SELECT COALESCE(SUM(sp.amount), 0) as cash_paid
      FROM supplier_payments sp
      INNER JOIN suppliers s ON sp.supplier_id = s.supplier_id
      WHERE sp.payment_date = $1::date
      AND s.shop_id = $2
      AND (sp.payment_method = 'cash' OR sp.payment_method IS NULL)
    `;

    // 4. Customer Due - Sum of all unpaid/remaining amounts from customers
    const customerDueQuery = `
      SELECT 
        COALESCE(SUM(current_balance), 0) as customer_due,
        COUNT(*) as customer_count
      FROM customers
      WHERE current_balance > 0 AND shop_id = $1
    `;

    // 5. Supplier Due — same formula as legacy, but aggregated (avoids per-row correlated subqueries)
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

    // 6. Low Stock Items - Count where Current Stock <= 5 (default threshold)
    // Use same logic as /reports/stock-low endpoint
    const lowStockQuery = `
      SELECT 
        COUNT(*) as low_stock_count
      FROM products
      WHERE quantity_in_stock <= 5 AND shop_id = $1
    `;

    // 7. Top 5 Selling Items (today) - by quantity
    const topSellingQuery = `
      SELECT 
        p.product_id,
        COALESCE(p.item_name_english, p.name) as product_name,
        SUM(si.quantity) as quantity_sold
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.sale_id
      JOIN products p ON si.product_id = p.product_id AND p.shop_id = s.shop_id
      WHERE s.date = $1::date AND s.shop_id = $2
      GROUP BY p.product_id, p.item_name_english, p.name
      ORDER BY quantity_sold DESC
      LIMIT 5
    `;

    // 8. Recent 5 Bills (today)
    const recentBillsQuery = `
      SELECT 
        sale_id,
        invoice_number,
        customer_name,
        total_amount,
        date
      FROM sales
      WHERE date = $1::date AND shop_id = $2
      ORDER BY date DESC, sale_id DESC
      LIMIT 5
    `;

    // Execute all queries in parallel (conditionally include profit query for admins)
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
      db.query(topSellingQuery, dayParam),
      db.query(recentBillsQuery, dayParam)
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
      topSellingResult,
      recentBillsResult
    ] = await Promise.all(queries);

    // Calculate cash in hand (only for admins - cashiers don't see this)
    let cashInHand = 0;
    if (isAdmin) {
      const todayCashSales = parseFloat(todayCashSalesResult.rows[0].cash_sales) || 0;
      const customerPayments = parseFloat(customerPaymentsResult.rows[0].cash_received) || 0;
      const supplierPayments = parseFloat(supplierPaymentsResult.rows[0].cash_paid) || 0;
      cashInHand = openingCash + todayCashSales + customerPayments - supplierPayments;
    }

    res.json({
      todaySale: parseFloat(todaySalesResult.rows[0].today_sale) || 0,
      todayProfit: isAdmin ? (parseFloat(todayProfitResult.rows[0].today_profit) || 0) : null,
      cashInHand: isAdmin ? cashInHand : null,
      customerDue: parseFloat(customerDueResult.rows[0].customer_due) || 0,
      supplierDue: isAdmin ? (parseFloat(supplierDueResult.rows[0].supplier_due) || 0) : null,
      lowStockCount: parseInt(lowStockResult.rows[0].low_stock_count) || 0,
      topSellingItems: topSellingResult.rows.map(row => ({
        product_id: row.product_id,
        product_name: row.product_name,
        quantity_sold: parseInt(row.quantity_sold) || 0
      })),
      recentBills: recentBillsResult.rows.map(row => ({
        sale_id: row.sale_id,
        invoice_number: row.invoice_number,
        customer_name: row.customer_name || '-',
        total_amount: parseFloat(row.total_amount) || 0,
        date: row.date
      }))
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data', message: error.message });
  }
});

module.exports = router;
