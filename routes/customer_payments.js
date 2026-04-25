const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

router.use(requireAuth);
router.use(requireShopContext);

// Get all customer payments (active shop only)
router.get('/', async (req, res) => {
  try {
    const { customer_id, start_date, end_date } = req.query;
    
    let query = `
      SELECT 
        cp.*,
        c.name as customer_name,
        c.phone as customer_phone
      FROM customer_payments cp
      JOIN customers c ON cp.customer_id = c.customer_id
      WHERE c.shop_id = $1
    `;
    const params = [req.shopId];
    let paramIndex = 2;

    if (customer_id) {
      query += ` AND cp.customer_id = $${paramIndex}`;
      params.push(customer_id);
      paramIndex++;
    }

    if (start_date) {
      query += ` AND cp.payment_date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      query += ` AND cp.payment_date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    query += ' ORDER BY cp.payment_date DESC, cp.payment_id DESC';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer payments:', error);
    res.status(500).json({ error: 'Failed to fetch customer payments', message: error.message });
  }
});

// Get single payment
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT 
        cp.*,
        c.name as customer_name,
        c.phone as customer_phone
      FROM customer_payments cp
      JOIN customers c ON cp.customer_id = c.customer_id
      WHERE cp.payment_id = $1 AND c.shop_id = $2`,
      [id, req.shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: 'Failed to fetch payment', message: error.message });
  }
});

// Create new customer payment
router.post('/', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { customer_id, amount, payment_date, payment_method, notes } = req.body;

    // Validation
    if (!customer_id) {
      throw new Error('Customer ID is required');
    }

    const paymentAmount = parseFloat(amount);
    if (!paymentAmount || paymentAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    // Verify customer exists
    const customerCheck = await client.query(
      'SELECT customer_id FROM customers WHERE customer_id = $1 AND shop_id = $2',
      [customer_id, req.shopId]
    );

    if (customerCheck.rows.length === 0) {
      throw new Error('Customer not found');
    }

    const paymentDate = payment_date ? new Date(payment_date) : new Date();
    const paymentMethod = payment_method || 'cash';

    // Insert payment
    const result = await client.query(
      `INSERT INTO customer_payments (customer_id, payment_date, amount, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [customer_id, paymentDate, paymentAmount, paymentMethod, notes || null]
    );

    // Update customer balance (trigger will handle this, but explicit update for clarity)
    await client.query(
      `UPDATE customers 
       SET current_balance = opening_balance + 
           COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
           COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
       WHERE customer_id = $1`,
      [customer_id, req.shopId]
    );

    await client.query('COMMIT');

    // Fetch payment with customer details
    const paymentResult = await db.query(
      `SELECT 
        cp.*,
        c.name as customer_name,
        c.phone as customer_phone
      FROM customer_payments cp
      JOIN customers c ON cp.customer_id = c.customer_id
      WHERE cp.payment_id = $1 AND c.shop_id = $2`,
      [result.rows[0].payment_id, req.shopId]
    );

    res.status(201).json(paymentResult.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating payment:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create payment',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Update payment
router.put('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { amount, payment_date, payment_method, notes } = req.body;

    const paymentAmount = parseFloat(amount);
    if (paymentAmount && paymentAmount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    const paymentDate = payment_date ? new Date(payment_date) : null;

    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    if (paymentAmount) {
      updateFields.push(`amount = $${paramIndex}`);
      params.push(paymentAmount);
      paramIndex++;
    }

    if (paymentDate) {
      updateFields.push(`payment_date = $${paramIndex}`);
      params.push(paymentDate);
      paramIndex++;
    }

    if (payment_method) {
      updateFields.push(`payment_method = $${paramIndex}`);
      params.push(payment_method);
      paramIndex++;
    }

    if (notes !== undefined) {
      updateFields.push(`notes = $${paramIndex}`);
      params.push(notes);
      paramIndex++;
    }

    if (updateFields.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }

    const paymentIdIdx = paramIndex;
    const shopIdIdx = paramIndex + 1;
    params.push(id, req.shopId);

    const result = await client.query(
      `UPDATE customer_payments cp
       SET ${updateFields.join(', ')}
       FROM customers c
       WHERE cp.payment_id = $${paymentIdIdx} AND cp.customer_id = c.customer_id AND c.shop_id = $${shopIdIdx}
       RETURNING cp.*`,
      params
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Recalculate customer balance
    await client.query(
      `UPDATE customers 
       SET current_balance = opening_balance + 
           COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
           COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
       WHERE customer_id = $1`,
      [result.rows[0].customer_id, req.shopId]
    );

    await client.query('COMMIT');

    // Fetch updated payment
    const paymentResult = await db.query(
      `SELECT 
        cp.*,
        c.name as customer_name,
        c.phone as customer_phone
      FROM customer_payments cp
      JOIN customers c ON cp.customer_id = c.customer_id
      WHERE cp.payment_id = $1 AND c.shop_id = $2`,
      [id, req.shopId]
    );

    res.json(paymentResult.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating payment:', error);
    res.status(500).json({ error: error.message || 'Failed to update payment', details: error.message });
  } finally {
    client.release();
  }
});

// Delete payment
router.delete('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    const paymentResult = await client.query(
      `SELECT cp.customer_id FROM customer_payments cp
       JOIN customers c ON cp.customer_id = c.customer_id
       WHERE cp.payment_id = $1 AND c.shop_id = $2`,
      [id, req.shopId]
    );

    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }

    const customerId = paymentResult.rows[0].customer_id;

    await client.query(
      `DELETE FROM customer_payments cp USING customers c
       WHERE cp.payment_id = $1 AND cp.customer_id = c.customer_id AND c.shop_id = $2`,
      [id, req.shopId]
    );

    await client.query(
      `UPDATE customers 
       SET current_balance = opening_balance + 
           COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
           COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
       WHERE customer_id = $1`,
      [customerId, req.shopId]
    );

    await client.query('COMMIT');

    res.json({ message: 'Payment deleted successfully', payment_id: id });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting payment:', error);
    res.status(500).json({ error: 'Failed to delete payment', message: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;









