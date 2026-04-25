const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

// Expenses management is admin-only (cashiers cannot manage expenses)
router.use(requireAuth);
router.use(requireShopContext);
router.use(requireRole('administrator'));

// Get all expenses with optional date filter
router.get('/', async (req, res) => {
  try {
    const { start_date, end_date, category } = req.query;
    
    let query = 'SELECT * FROM daily_expenses WHERE shop_id = $1';
    const params = [req.shopId];
    let paramIndex = 2;

    if (start_date) {
      query += ` AND expense_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND expense_date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    if (category) {
      query += ` AND expense_category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    query += ' ORDER BY expense_date DESC, expense_id DESC';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: 'Failed to fetch expenses', message: error.message });
  }
});

// Get expense summary by category
router.get('/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    
    let query = `
      SELECT 
        expense_category,
        SUM(amount) as total_amount,
        COUNT(*) as expense_count
      FROM daily_expenses
      WHERE shop_id = $1
    `;
    const params = [req.shopId];
    let paramIndex = 2;

    if (start_date) {
      query += ` AND expense_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND expense_date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    query += ' GROUP BY expense_category ORDER BY total_amount DESC';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expense summary:', error);
    res.status(500).json({ error: 'Failed to fetch expense summary', message: error.message });
  }
});

// Get monthly expense summary
router.get('/monthly', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        DATE_TRUNC('month', expense_date) as month,
        SUM(amount) as total_amount,
        COUNT(*) as expense_count
      FROM daily_expenses
      WHERE shop_id = $1
      GROUP BY DATE_TRUNC('month', expense_date)
      ORDER BY month DESC
      LIMIT 12`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly expenses:', error);
    res.status(500).json({ error: 'Failed to fetch monthly expenses', message: error.message });
  }
});

// Get single expense
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM daily_expenses WHERE expense_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching expense:', error);
    res.status(500).json({ error: 'Failed to fetch expense', message: error.message });
  }
});

// Create new expense
router.post('/', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { expense_category, amount, expense_date, payment_method, notes } = req.body;

    // Validation
    if (!expense_category || !expense_category.trim()) {
      throw new Error('Expense name is required');
    }

    const expenseAmount = parseFloat(amount);
    if (!expenseAmount || expenseAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    const expenseDate = expense_date ? new Date(expense_date) : new Date();
    const paymentMethod = payment_method || 'cash';

    const result = await client.query(
      `INSERT INTO daily_expenses (expense_category, amount, expense_date, payment_method, notes, shop_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [expense_category.trim(), expenseAmount, expenseDate, paymentMethod, notes || null, req.shopId]
    );

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating expense:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create expense',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Update expense
router.put('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { expense_category, amount, expense_date, payment_method, notes } = req.body;

    if (!expense_category || !expense_category.trim()) {
      throw new Error('Expense category is required');
    }

    const expenseAmount = parseFloat(amount);
    if (!expenseAmount || expenseAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    const expenseDate = expense_date ? new Date(expense_date) : null;

    const result = await client.query(
      `UPDATE daily_expenses 
       SET expense_category = $1, amount = $2, expense_date = COALESCE($3, expense_date), 
           payment_method = $4, notes = $5
       WHERE expense_id = $6 AND shop_id = $7
       RETURNING *`,
      [expense_category.trim(), expenseAmount, expenseDate, payment_method || 'cash', notes || null, id, req.shopId]
    );

    if (result.rows.length === 0) {
      throw new Error('Expense not found');
    }

    await client.query('COMMIT');

    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating expense:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to update expense',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Delete expense
router.delete('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    
    const result = await client.query(
      'DELETE FROM daily_expenses WHERE expense_id = $1 AND shop_id = $2 RETURNING expense_id',
      [id, req.shopId]
    );

    if (result.rows.length === 0) {
      throw new Error('Expense not found');
    }

    await client.query('COMMIT');

    res.json({ message: 'Expense deleted successfully', expense_id: id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting expense:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to delete expense',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

module.exports = router;







