const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

router.use(requireAuth);
router.use(requireShopContext);
router.use(requireRole('administrator'));

// Get all supplier payments (with optional supplier filter)
router.get('/', async (req, res) => {
  try {
    const { supplier_id } = req.query;
    let query = `
      SELECT 
        sp.payment_id,
        sp.supplier_id,
        s.name as supplier_name,
        sp.payment_date,
        sp.amount,
        sp.payment_method,
        sp.notes,
        sp.created_at
      FROM supplier_payments sp
      JOIN suppliers s ON sp.supplier_id = s.supplier_id AND s.shop_id = $1
    `;
    const params = [req.shopId];
    
    if (supplier_id) {
      query += ' WHERE sp.supplier_id = $2';
      params.push(supplier_id);
    }
    
    query += ' ORDER BY sp.payment_date DESC, sp.payment_id DESC';
    
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching supplier payments:', error);
    res.status(500).json({ error: 'Failed to fetch supplier payments', message: error.message });
  }
});

// Get single payment by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT 
        sp.payment_id,
        sp.supplier_id,
        s.name as supplier_name,
        s.contact_number as supplier_phone,
        sp.payment_date,
        sp.amount,
        sp.payment_method,
        sp.notes,
        sp.created_at
      FROM supplier_payments sp
      JOIN suppliers s ON sp.supplier_id = s.supplier_id
      WHERE sp.payment_id = $1 AND s.shop_id = $2`,
      [id, req.shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching supplier payment:', error);
    res.status(500).json({ error: 'Failed to fetch supplier payment', message: error.message });
  }
});

// Create new supplier payment
router.post('/', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { supplier_id, amount, payment_method, payment_date, notes } = req.body;

    // Validation
    if (!supplier_id) {
      throw new Error('Supplier ID is required');
    }

    const paymentAmount = parseFloat(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      throw new Error('Payment amount must be greater than 0');
    }

    // Verify supplier exists
    const supplierCheck = await client.query(
      'SELECT supplier_id, opening_balance FROM suppliers WHERE supplier_id = $1 AND shop_id = $2',
      [supplier_id, req.shopId]
    );

    if (supplierCheck.rows.length === 0) {
      throw new Error('Supplier not found');
    }

    // Calculate current payable balance
    const [purchasesResult, paymentsResult] = await Promise.all([
      client.query(
        `SELECT COALESCE(SUM(total_amount), 0) as total 
         FROM purchases 
         WHERE supplier_id = $1 AND shop_id = $2 AND payment_type = 'credit'`,
        [supplier_id, req.shopId]
      ),
      client.query(
        `SELECT COALESCE(SUM(amount), 0) as total 
         FROM supplier_payments 
         WHERE supplier_id = $1`,
        [supplier_id]
      )
    ]);

    const openingBalance = parseFloat(supplierCheck.rows[0].opening_balance) || 0;
    const totalCreditPurchases = parseFloat(purchasesResult.rows[0].total) || 0;
    const totalPaid = parseFloat(paymentsResult.rows[0].total) || 0;
    const currentBalance = openingBalance + totalCreditPurchases - totalPaid;

    // Prevent negative balance (optional - you can remove this if you want to allow overpayment)
    if (paymentAmount > currentBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Payment amount (${paymentAmount}) exceeds payable balance (${currentBalance.toFixed(2)})` 
      });
    }

    // Insert payment
    const paymentDate = payment_date ? new Date(payment_date) : new Date();
    const result = await client.query(
      `INSERT INTO supplier_payments (supplier_id, payment_date, amount, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [supplier_id, paymentDate, paymentAmount, payment_method || 'cash', notes || null]
    );

    await client.query('COMMIT');

    // Fetch complete payment with supplier info
    const paymentFinal = await db.query(
      `SELECT 
        sp.payment_id,
        sp.supplier_id,
        s.name as supplier_name,
        s.contact_number as supplier_phone,
        sp.payment_date,
        sp.amount,
        sp.payment_method,
        sp.notes,
        sp.created_at
      FROM supplier_payments sp
      JOIN suppliers s ON sp.supplier_id = s.supplier_id
      WHERE sp.payment_id = $1 AND s.shop_id = $2`,
      [result.rows[0].payment_id, req.shopId]
    );

    res.status(201).json(paymentFinal.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating supplier payment:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create supplier payment',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Update supplier payment
router.put('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { amount, payment_method, payment_date, notes } = req.body;

    // Get existing payment
    const existingPayment = await client.query(
      `SELECT sp.* FROM supplier_payments sp
       JOIN suppliers s ON sp.supplier_id = s.supplier_id
       WHERE sp.payment_id = $1 AND s.shop_id = $2`,
      [id, req.shopId]
    );

    if (existingPayment.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }

    const oldAmount = parseFloat(existingPayment.rows[0].amount);
    const supplierId = existingPayment.rows[0].supplier_id;

    // Validation
    const paymentAmount = parseFloat(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment amount must be greater than 0' });
    }

    // Calculate current balance (excluding this payment)
    const [purchasesResult, paymentsResult] = await Promise.all([
      client.query(
        `SELECT COALESCE(SUM(total_amount), 0) as total 
         FROM purchases 
         WHERE supplier_id = $1 AND shop_id = $2 AND payment_type = 'credit'`,
        [supplierId, req.shopId]
      ),
      client.query(
        `SELECT COALESCE(SUM(amount), 0) as total 
         FROM supplier_payments 
         WHERE supplier_id = $1 AND payment_id != $2`,
        [supplierId, id]
      )
    ]);

    const supplier = await client.query(
      'SELECT opening_balance FROM suppliers WHERE supplier_id = $1 AND shop_id = $2',
      [supplierId, req.shopId]
    );

    const openingBalance = parseFloat(supplier.rows[0].opening_balance) || 0;
    const totalCreditPurchases = parseFloat(purchasesResult.rows[0].total) || 0;
    const totalPaidExcludingThis = parseFloat(paymentsResult.rows[0].total) || 0;
    const currentBalance = openingBalance + totalCreditPurchases - totalPaidExcludingThis;

    // Prevent negative balance
    if (paymentAmount > currentBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Payment amount (${paymentAmount}) exceeds payable balance (${currentBalance.toFixed(2)})` 
      });
    }

    // Update payment
    const paymentDate = payment_date ? new Date(payment_date) : existingPayment.rows[0].payment_date;
    const result = await client.query(
      `UPDATE supplier_payments sp
       SET amount = $1, 
           payment_method = $2, 
           payment_date = $3, 
           notes = $4
       FROM suppliers s
       WHERE sp.payment_id = $5 AND sp.supplier_id = s.supplier_id AND s.shop_id = $6
       RETURNING sp.*`,
      [paymentAmount, payment_method || 'cash', paymentDate, notes || null, id, req.shopId]
    );

    await client.query('COMMIT');

    // Fetch complete payment with supplier info
    const paymentFinal = await db.query(
      `SELECT 
        sp.payment_id,
        sp.supplier_id,
        s.name as supplier_name,
        s.contact_number as supplier_phone,
        sp.payment_date,
        sp.amount,
        sp.payment_method,
        sp.notes,
        sp.created_at
      FROM supplier_payments sp
      JOIN suppliers s ON sp.supplier_id = s.supplier_id
      WHERE sp.payment_id = $1 AND s.shop_id = $2`,
      [id, req.shopId]
    );

    res.json(paymentFinal.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating supplier payment:', error);
    res.status(500).json({ error: 'Failed to update supplier payment', message: error.message });
  } finally {
    client.release();
  }
});

// Delete supplier payment
router.delete('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Get payment details
    const paymentResult = await client.query(
      `SELECT sp.* FROM supplier_payments sp
       JOIN suppliers s ON sp.supplier_id = s.supplier_id
       WHERE sp.payment_id = $1 AND s.shop_id = $2`,
      [id, req.shopId]
    );

    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }

    const supplierId = paymentResult.rows[0].supplier_id;

    await client.query(
      `DELETE FROM supplier_payments sp USING suppliers s
       WHERE sp.payment_id = $1 AND sp.supplier_id = s.supplier_id AND s.shop_id = $2`,
      [id, req.shopId]
    );

    await client.query('COMMIT');

    res.json({ message: 'Supplier payment deleted successfully', payment_id: id });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting supplier payment:', error);
    res.status(500).json({ error: 'Failed to delete supplier payment', message: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;




