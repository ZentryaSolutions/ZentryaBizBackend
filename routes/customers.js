const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

router.use(requireAuth);
router.use(requireShopContext);

// Get all customers (active shop only)
router.get('/', async (req, res) => {
  try {
    // Check if credit_limit column exists, if not use NULL
    let creditLimitColumn = 'NULL as credit_limit';
    try {
      const columnCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'customers' AND column_name = 'credit_limit'
      `);
      if (columnCheck.rows.length > 0) {
        creditLimitColumn = 'c.credit_limit';
      }
    } catch (err) {
      // If check fails, use NULL
      creditLimitColumn = 'NULL as credit_limit';
    }

    const result = await db.query(
      `SELECT 
        c.customer_id,
        c.name,
        c.phone,
        c.address,
        c.opening_balance,
        c.current_balance as current_due,
        c.customer_type,
        ${creditLimitColumn},
        c.status,
        c.created_at,
        COALESCE(SUM(CASE WHEN s.payment_type IN ('credit', 'split') THEN s.total_amount - s.paid_amount ELSE 0 END), 0) as total_sales_due,
        COALESCE(SUM(cp.amount), 0) as total_paid,
        MAX(s.date) as last_sale_date,
        MAX(cp.payment_date) as last_payment_date
      FROM customers c
      LEFT JOIN sales s ON c.customer_id = s.customer_id AND s.shop_id = c.shop_id AND s.payment_type IN ('credit', 'split')
      LEFT JOIN customer_payments cp ON c.customer_id = cp.customer_id
      WHERE c.shop_id = $1
      GROUP BY c.customer_id, c.name, c.phone, c.address, c.opening_balance, c.current_balance, c.customer_type, c.status, c.created_at, c.shop_id${creditLimitColumn.includes('c.credit_limit') ? ', c.credit_limit' : ''}
      ORDER BY c.current_balance DESC, c.name ASC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers', message: error.message });
  }
});

// Get single customer by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Check if credit_limit column exists, if not use NULL
    let creditLimitColumn = 'NULL as credit_limit';
    try {
      const columnCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'customers' AND column_name = 'credit_limit'
      `);
      if (columnCheck.rows.length > 0) {
        creditLimitColumn = 'c.credit_limit';
      }
    } catch (err) {
      // If check fails, use NULL
      creditLimitColumn = 'NULL as credit_limit';
    }

    const result = await db.query(
      `SELECT 
        c.customer_id,
        c.name,
        c.phone,
        c.address,
        c.opening_balance,
        c.current_balance as current_due,
        c.customer_type,
        ${creditLimitColumn},
        c.status,
        c.created_at,
        COALESCE(SUM(CASE WHEN s.payment_type IN ('credit', 'split') THEN s.total_amount - s.paid_amount ELSE 0 END), 0) as total_sales_due,
        COALESCE(SUM(cp.amount), 0) as total_paid
      FROM customers c
      LEFT JOIN sales s ON c.customer_id = s.customer_id AND s.shop_id = c.shop_id AND s.payment_type IN ('credit', 'split')
      LEFT JOIN customer_payments cp ON c.customer_id = cp.customer_id
      WHERE c.customer_id = $1 AND c.shop_id = $2
      GROUP BY c.customer_id, c.name, c.phone, c.address, c.opening_balance, c.current_balance, c.customer_type, c.status, c.created_at, c.shop_id${creditLimitColumn.includes('c.credit_limit') ? ', c.credit_limit' : ''}`,
      [id, req.shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: 'Failed to fetch customer', message: error.message });
  }
});

// Get customer ledger (Money History)
router.get('/:id/ledger', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get customer info
    const customerResult = await db.query(
      'SELECT customer_id, name, opening_balance, current_balance, created_at FROM customers WHERE customer_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );
    
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    const customer = customerResult.rows[0];
    const openingBalance = parseFloat(customer.opening_balance) || 0;
    
    // Credit/split sales only — `notes` column may not exist on older DBs
    let salesResult;
    try {
      salesResult = await db.query(
        `SELECT 
          sale_id,
          invoice_number,
          date,
          total_amount,
          paid_amount,
          payment_type,
          (total_amount - paid_amount) as due_amount,
          notes
        FROM sales
        WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')
        ORDER BY date ASC, sale_id ASC`,
        [id, req.shopId]
      );
    } catch (e) {
      if (e.code === '42703') {
        salesResult = await db.query(
          `SELECT 
            sale_id,
            invoice_number,
            date,
            total_amount,
            paid_amount,
            payment_type,
            (total_amount - paid_amount) as due_amount,
            NULL::text as notes
          FROM sales
          WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')
          ORDER BY date ASC, sale_id ASC`,
          [id, req.shopId]
        );
      } else {
        throw e;
      }
    }
    
    // Get payments (scoped to this shop via customer)
    const paymentsResult = await db.query(
      `SELECT 
        cp.payment_id,
        cp.payment_date as date,
        cp.amount,
        cp.payment_method,
        cp.notes
      FROM customer_payments cp
      INNER JOIN customers c ON c.customer_id = cp.customer_id AND c.shop_id = $2
      WHERE cp.customer_id = $1
      ORDER BY cp.payment_date ASC, cp.payment_id ASC`,
      [id, req.shopId]
    );
    
    const transactions = [];
    let runningBalance = openingBalance;

    if (openingBalance !== 0) {
      transactions.push({
        date: customer.created_at || new Date(),
        type: 'opening',
        description: 'Previous Due',
        amount: openingBalance,
        running_balance: runningBalance,
        invoice_number: null,
        payment_method: null,
        notes: null
      });
    }

    const events = [];
    salesResult.rows.forEach((sale) => {
      const dueAmount = parseFloat(sale.due_amount) || 0;
      if (dueAmount <= 0) return;
      const ts = new Date(sale.date).getTime();
      events.push({
        ts,
        tie: 0,
        id: sale.sale_id,
        kind: 'sale',
        sale,
        dueAmount
      });
    });
    paymentsResult.rows.forEach((payment) => {
      const amount = parseFloat(payment.amount) || 0;
      events.push({
        ts: new Date(payment.date).getTime(),
        tie: 1,
        id: payment.payment_id,
        kind: 'payment',
        payment,
        amount
      });
    });

    events.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.tie !== b.tie) return a.tie - b.tie;
      return (a.id || 0) - (b.id || 0);
    });

    events.forEach((e) => {
      if (e.kind === 'sale') {
        const sale = e.sale;
        const dueAmount = e.dueAmount;
        runningBalance += dueAmount;
        const noteStr = sale.notes != null ? String(sale.notes).trim() : '';
        transactions.push({
          date: sale.date,
          type: 'sale',
          description: `Sale - Invoice #${sale.invoice_number}`,
          amount: dueAmount,
          running_balance: runningBalance,
          invoice_number: sale.invoice_number,
          sale_id: sale.sale_id,
          payment_method: null,
          notes: noteStr || null
        });
      } else {
        const payment = e.payment;
        const amt = parseFloat(payment.amount) || 0;
        runningBalance -= amt;
        const noteStr = payment.notes != null ? String(payment.notes).trim() : '';
        transactions.push({
          date: payment.date,
          type: 'payment',
          description: 'Payment Received',
          amount: -amt,
          running_balance: runningBalance,
          invoice_number: null,
          payment_id: payment.payment_id,
          payment_method: payment.payment_method,
          notes: noteStr || null
        });
      }
    });
    
    res.json({
      customer: {
        customer_id: customer.customer_id,
        name: customer.name,
        opening_balance: openingBalance,
        current_due: parseFloat(customer.current_balance) || 0
      },
      transactions
    });
  } catch (error) {
    console.error('Error fetching customer ledger:', error);
    res.status(500).json({ error: 'Failed to fetch customer ledger', message: error.message });
  }
});

// Get customer with sales and payments history
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [customerResult, salesResult, paymentsResult] = await Promise.all([
      db.query('SELECT * FROM customers WHERE customer_id = $1 AND shop_id = $2', [id, req.shopId]),
      db.query(
        `SELECT 
          sale_id,
          invoice_number,
          date,
          total_amount,
          paid_amount,
          payment_type,
          (total_amount - paid_amount) as balance
        FROM sales
        WHERE customer_id = $1 AND shop_id = $2
        ORDER BY date DESC`,
        [id, req.shopId]
      ),
      db.query(
        `SELECT 
          cp.payment_id,
          cp.payment_date,
          cp.amount,
          cp.payment_method,
          cp.notes
        FROM customer_payments cp
        INNER JOIN customers c ON c.customer_id = cp.customer_id AND c.shop_id = $2
        WHERE cp.customer_id = $1
        ORDER BY cp.payment_date DESC`,
        [id, req.shopId]
      )
    ]);
    
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json({
      customer: customerResult.rows[0],
      sales: salesResult.rows,
      payments: paymentsResult.rows
    });
  } catch (error) {
    console.error('Error fetching customer history:', error);
    res.status(500).json({ error: 'Failed to fetch customer history', message: error.message });
  }
});

// Create new customer
router.post('/', async (req, res) => {
  try {
    const { name, phone, address, opening_balance, customer_type, credit_limit, status } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }

    const openingBal = parseFloat(opening_balance) || 0;
    const customerStatus = status || 'active';
    // CRITICAL: customer_type must be one of: 'walk-in', 'retail', 'wholesale', 'special'
    // Default to 'walk-in' if not provided or invalid
    const validCustomerTypes = ['walk-in', 'retail', 'wholesale', 'special'];
    const customerType = (customer_type && validCustomerTypes.includes(customer_type)) 
      ? customer_type 
      : 'walk-in';
    const creditLimit = credit_limit ? parseFloat(credit_limit) : null;

    console.log('[Customers API] Creating customer:', {
      name: name.trim(),
      phone: phone.trim(),
      openingBalance: openingBal,
      customerType: customerType,
      creditLimit: creditLimit,
      status: customerStatus
    });

    const result = await db.query(
      `INSERT INTO customers (name, phone, address, opening_balance, current_balance, customer_type, credit_limit, status, shop_id)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name.trim(), phone.trim(), address || null, openingBal, customerType, creditLimit, customerStatus, req.shopId]
    );

    console.log('[Customers API] Customer created successfully:', result.rows[0]?.customer_id);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('[Customers API] Error creating customer:', error);
    console.error('[Customers API] Error details:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      stack: error.stack
    });
    res.status(500).json({ error: 'Failed to create customer', message: error.message, detail: error.detail });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, address, opening_balance, customer_type, credit_limit, status } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }

    const openingBal = parseFloat(opening_balance) || 0;
    const customerStatus = status || 'active';
    // CRITICAL: customer_type must be one of: 'walk-in', 'retail', 'wholesale', 'special'
    // Default to 'walk-in' if not provided or invalid
    const validCustomerTypes = ['walk-in', 'retail', 'wholesale', 'special'];
    const customerType = (customer_type && validCustomerTypes.includes(customer_type)) 
      ? customer_type 
      : 'walk-in';
    const creditLimit = credit_limit ? parseFloat(credit_limit) : null;

    // Check if credit_limit column exists
    let hasCreditLimit = false;
    try {
      const columnCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'customers' AND column_name = 'credit_limit'
      `);
      hasCreditLimit = columnCheck.rows.length > 0;
    } catch (err) {
      hasCreditLimit = false;
    }

    let result;
    if (hasCreditLimit) {
      result = await db.query(
        `UPDATE customers 
         SET name = $1, phone = $2, address = $3, opening_balance = $4, customer_type = $5, credit_limit = $6, status = $7
         WHERE customer_id = $8 AND shop_id = $9
         RETURNING *`,
        [name.trim(), phone.trim(), address || null, openingBal, customerType, creditLimit, customerStatus, id, req.shopId]
      );
    } else {
      result = await db.query(
        `UPDATE customers 
         SET name = $1, phone = $2, address = $3, opening_balance = $4, customer_type = $5, status = $6
         WHERE customer_id = $7 AND shop_id = $8
         RETURNING *`,
        [name.trim(), phone.trim(), address || null, openingBal, customerType, customerStatus, id, req.shopId]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Recalculate current balance
    await db.query(
      `UPDATE customers 
       SET current_balance = opening_balance + 
           COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
           COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
       WHERE customer_id = $1`,
      [id, req.shopId]
    );

    // Fetch updated customer with recalculated balance
    const updatedResult = await db.query(
      'SELECT * FROM customers WHERE customer_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );

    res.json(updatedResult.rows[0]);
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ error: 'Failed to update customer', message: error.message });
  }
});

// Delete customer (only if no sales or payments exist)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [salesCheck, paymentsCheck] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM sales WHERE customer_id = $1 AND shop_id = $2', [id, req.shopId]),
      db.query('SELECT COUNT(*) as count FROM customer_payments WHERE customer_id = $1', [id])
    ]);

    const salesCount = parseInt(salesCheck.rows[0].count);
    const paymentsCount = parseInt(paymentsCheck.rows[0].count);

    if (salesCount > 0 || paymentsCount > 0) {
      return res.status(400).json({ 
        error: `Cannot delete customer: has ${salesCount} sale(s) and ${paymentsCount} payment(s)` 
      });
    }

    const result = await db.query(
      'DELETE FROM customers WHERE customer_id = $1 AND shop_id = $2 RETURNING customer_id',
      [id, req.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ message: 'Customer deleted successfully', customer_id: id });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: 'Failed to delete customer', message: error.message });
  }
});

module.exports = router;

