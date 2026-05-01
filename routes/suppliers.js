const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdministratorOrProfileOwner } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

/** Trim / lowercase; empty → null. Caller may validate format. */
function normalizeSupplierEmail(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.toLowerCase();
}

// Suppliers: legacy administrator role OR Zentrya profile owner/admin (matches frontend isAdmin)
router.use(requireAuth);
router.use(requireShopContext);
router.use(requireAdministratorOrProfileOwner);

/** Normalize a DB row (including SELECT *) to the shape the frontend expects. */
function mapSupplierRowForApi(row) {
  if (!row) return null;
  const opening = Number(row.opening_balance ?? row.balance ?? 0);
  const tcp = Number(row.total_credit_purchases ?? 0);
  const tp = Number(row.total_paid ?? 0);
  let cpb = row.current_payable_balance;
  if (cpb == null || cpb === '') {
    cpb = opening + tcp - tp;
  } else {
    cpb = Number(cpb);
  }
  return {
    supplier_id: row.supplier_id,
    name: row.name ?? '',
    contact_number: row.contact_number != null ? row.contact_number : row.phone ?? null,
    email: row.email != null && String(row.email).trim() !== '' ? String(row.email).trim() : null,
    address: row.address ?? null,
    notes: row.notes ?? null,
    opening_balance: opening,
    total_credit_purchases: tcp,
    total_paid: tp,
    current_payable_balance: cpb,
    status: row.status != null ? String(row.status) : 'active',
    created_at: row.created_at,
    last_purchase_date: row.last_purchase_date ?? null,
    last_payment_date: row.last_payment_date ?? null,
  };
}

/** When purchases / supplier_payments tables or columns differ, full aggregate query can 500 — still return rows from suppliers. */
async function querySuppliersList(shopId) {
  const fullSql = `
      SELECT 
        supplier_id,
        name,
        contact_number,
        email,
        address,
        notes,
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
        'active'::text as status,
        created_at,
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
      WHERE shop_id = $1
      ORDER BY current_payable_balance DESC, name ASC`;

  const basicSql = `
      SELECT 
        supplier_id,
        name,
        contact_number,
        email,
        address,
        notes,
        COALESCE(opening_balance, 0)::numeric as opening_balance,
        0::numeric as total_credit_purchases,
        0::numeric as total_paid,
        COALESCE(opening_balance, 0)::numeric as current_payable_balance,
        'active'::text as status,
        created_at,
        NULL::timestamptz as last_purchase_date,
        NULL::timestamptz as last_payment_date
      FROM suppliers
      WHERE shop_id = $1
      ORDER BY current_payable_balance DESC, name ASC`;

  try {
    return await db.query(fullSql, [shopId]);
  } catch (err) {
    console.warn('[suppliers] list: full aggregate query failed:', err.code, err.message);
    try {
      return await db.query(basicSql, [shopId]);
    } catch (err2) {
      console.warn('[suppliers] list: basic query failed, using SELECT *:', err2.code, err2.message);
      const sid = String(shopId).trim();
      const r = await db.query(
        'SELECT * FROM suppliers WHERE shop_id::text = $1 ORDER BY name ASC',
        [sid]
      );
      return { rows: r.rows.map(mapSupplierRowForApi) };
    }
  }
}

// Get all suppliers (sorted by highest payable balance first by default)
router.get('/', async (req, res) => {
  try {
    const result = await querySuppliersList(req.shopId);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to fetch suppliers', 
      message: error.message,
      code: error.code,
      detail: error.detail
    });
  }
});

async function querySupplierById(supplierId, shopId) {
  const fullSql = `
      SELECT 
        supplier_id,
        name,
        contact_number,
        email,
        address,
        notes,
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
        'active'::text as status,
        created_at
      FROM suppliers
      WHERE supplier_id = $1 AND shop_id = $2`;

  const basicSql = `
      SELECT 
        supplier_id,
        name,
        contact_number,
        email,
        address,
        notes,
        COALESCE(opening_balance, 0)::numeric as opening_balance,
        0::numeric as total_credit_purchases,
        0::numeric as total_paid,
        COALESCE(opening_balance, 0)::numeric as current_payable_balance,
        'active'::text as status,
        created_at
      FROM suppliers
      WHERE supplier_id = $1 AND shop_id = $2`;

  try {
    return await db.query(fullSql, [supplierId, shopId]);
  } catch (err) {
    console.warn('[suppliers] getById: full query failed:', err.code, err.message);
    try {
      return await db.query(basicSql, [supplierId, shopId]);
    } catch (err2) {
      console.warn('[suppliers] getById: basic failed, using SELECT *:', err2.code, err2.message);
      const sid = String(shopId).trim();
      const spid = String(supplierId).trim();
      const r = await db.query(
        `SELECT * FROM suppliers 
         WHERE supplier_id::text = $1 AND shop_id::text = $2
         LIMIT 1`,
        [spid, sid]
      );
      return { rows: r.rows.map(mapSupplierRowForApi) };
    }
  }
}

// Get single supplier by ID with calculated balance
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await querySupplierById(id, req.shopId);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching supplier:', error);
    res.status(500).json({ error: 'Failed to fetch supplier', message: error.message });
  }
});

// Create new supplier
router.post('/', async (req, res) => {
  try {
    const { name, contact_number, email, address, opening_balance, notes } = req.body;
    const notesVal = notes != null && String(notes).trim() !== '' ? String(notes).trim() : null;
    const emailNorm = normalizeSupplierEmail(email);
    if (!emailNorm) {
      return res.status(400).json({ error: 'Supplier email is required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }

    const openingBal = parseFloat(opening_balance) || 0;

    // Validate numeric values
    if (isNaN(openingBal)) {
      return res.status(400).json({ error: 'Opening balance must be a valid number' });
    }

    // Balance will be auto-calculated by triggers/app logic
    // Note: address column may not exist, so we'll try to insert without it if it fails
    let result;
    try {
      result = await db.query(
        `INSERT INTO suppliers (name, contact_number, email, address, opening_balance, status, shop_id, notes)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
         RETURNING 
           supplier_id,
           name,
           contact_number,
           email,
           address,
           opening_balance,
           0 as total_credit_purchases,
           0 as total_paid,
           opening_balance as current_payable_balance,
           status,
           created_at,
           notes`,
        [name.trim(), contact_number || null, emailNorm, address || null, openingBal, req.shopId, notesVal]
      );
    } catch (err) {
      if (err.code === '42703' && String(err.message || '').includes('email')) {
        result = await db.query(
          `INSERT INTO suppliers (name, contact_number, address, opening_balance, status, shop_id, notes)
           VALUES ($1, $2, $3, $4, 'active', $5, $6)
           RETURNING 
             supplier_id,
             name,
             contact_number,
             address,
             opening_balance,
             0 as total_credit_purchases,
             0 as total_paid,
             opening_balance as current_payable_balance,
             status,
             created_at,
             notes`,
          [name.trim(), contact_number || null, address || null, openingBal, req.shopId, notesVal]
        );
      } else if (err.code === '42703' && (err.message.includes('notes') || err.column === 'notes')) {
        result = await db.query(
          `INSERT INTO suppliers (name, contact_number, email, address, opening_balance, status, shop_id)
           VALUES ($1, $2, $3, $4, $5, 'active', $6)
           RETURNING 
             supplier_id,
             name,
             contact_number,
             email,
             address,
             opening_balance,
             0 as total_credit_purchases,
             0 as total_paid,
             opening_balance as current_payable_balance,
             status,
             created_at`,
          [name.trim(), contact_number || null, emailNorm, address || null, openingBal, req.shopId]
        );
      } else if (err.code === '42703' && err.message.includes('address')) {
        result = await db.query(
          `INSERT INTO suppliers (name, contact_number, email, opening_balance, status, shop_id)
           VALUES ($1, $2, $3, $4, 'active', $5)
           RETURNING 
             supplier_id,
             name,
             contact_number,
             email,
             NULL as address,
             opening_balance,
             0 as total_credit_purchases,
             0 as total_paid,
             opening_balance as current_payable_balance,
             status,
             created_at`,
          [name.trim(), contact_number || null, emailNorm, openingBal, req.shopId]
        );
      } else {
        throw err;
      }
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating supplier:', error);
    res.status(500).json({ error: 'Failed to create supplier', message: error.message });
  }
});

// Update supplier (name, contact, email, address, opening_balance, status — balance auto-calculated)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, contact_number, email, address, opening_balance, status, notes } = req.body;
    const notesVal = notes != null && String(notes).trim() !== '' ? String(notes).trim() : null;
    const emailNorm = normalizeSupplierEmail(email);
    if (!emailNorm) {
      return res.status(400).json({ error: 'Supplier email is required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }

    const openingBal = parseFloat(opening_balance);
    if (isNaN(openingBal)) {
      return res.status(400).json({ error: 'Opening balance must be a valid number' });
    }

    // Check if supplier has purchases or payments - if yes, prevent changing opening_balance
    const [purchasesCheck, paymentsCheck] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM purchases WHERE supplier_id = $1 AND shop_id = $2', [id, req.shopId]),
      db.query('SELECT COUNT(*) as count FROM supplier_payments WHERE supplier_id = $1', [id]),
    ]);

    const hasTransactions = parseInt(purchasesCheck.rows[0].count) > 0 || 
                            parseInt(paymentsCheck.rows[0].count) > 0;

    // If supplier has transactions, get current opening_balance and don't allow change
    let finalOpeningBalance = openingBal;
    if (hasTransactions) {
      const currentSupplier = await db.query(
        'SELECT opening_balance FROM suppliers WHERE supplier_id = $1 AND shop_id = $2',
        [id, req.shopId]
      );
      if (currentSupplier.rows.length > 0) {
        finalOpeningBalance = parseFloat(currentSupplier.rows[0].opening_balance);
      }
    }

    // Try to update with address, fallback if column doesn't exist
    let result;
    try {
      result = await db.query(
        `UPDATE suppliers 
         SET name = $1, 
             contact_number = $2, 
             email = $3,
             address = $4, 
             opening_balance = $5,
             status = COALESCE($6, status)
         WHERE supplier_id = $7 AND shop_id = $8
         RETURNING 
           supplier_id,
           name,
           contact_number,
           email,
           address,
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
           status,
           created_at`,
        [name.trim(), contact_number || null, emailNorm, address || null, finalOpeningBalance, status || 'active', id, req.shopId]
      );
    } catch (err) {
      if (err.code === '42703' && err.message.includes('address')) {
        result = await db.query(
          `UPDATE suppliers 
           SET name = $1, 
               contact_number = $2, 
               email = $3,
               opening_balance = $4,
               status = COALESCE($5, status)
           WHERE supplier_id = $6 AND shop_id = $7
           RETURNING 
             supplier_id,
             name,
             contact_number,
             email,
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
             status,
             created_at`,
          [name.trim(), contact_number || null, emailNorm, finalOpeningBalance, status || 'active', id, req.shopId]
        );
      } else {
        throw err;
      }
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    const row = { ...result.rows[0], notes: notesVal };
    try {
      await db.query(
        `UPDATE suppliers SET notes = $1 WHERE supplier_id = $2 AND shop_id = $3`,
        [notesVal, id, req.shopId]
      );
    } catch (e) {
      if (e.code !== '42703') throw e;
      delete row.notes;
    }

    res.json(row);
  } catch (error) {
    console.error('Error updating supplier:', error);
    res.status(500).json({ error: 'Failed to update supplier', message: error.message });
  }
});

// Delete supplier
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if supplier is referenced in products, purchases, or payments
    const [productsCheck, purchasesCheck, paymentsCheck] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM products WHERE supplier_id = $1 AND shop_id = $2', [id, req.shopId]),
      db.query('SELECT COUNT(*) as count FROM purchases WHERE supplier_id = $1 AND shop_id = $2', [id, req.shopId]),
      db.query('SELECT COUNT(*) as count FROM supplier_payments WHERE supplier_id = $1', [id]),
    ]);

    const productCount = parseInt(productsCheck.rows[0].count);
    const purchaseCount = parseInt(purchasesCheck.rows[0].count);
    const paymentCount = parseInt(paymentsCheck.rows[0].count);

    if (productCount > 0 || purchaseCount > 0 || paymentCount > 0) {
      return res.status(400).json({ 
        error: `Cannot delete supplier: it has ${productCount} product(s), ${purchaseCount} purchase(s), and ${paymentCount} payment(s)` 
      });
    }

    const result = await db.query(
      'DELETE FROM suppliers WHERE supplier_id = $1 AND shop_id = $2 RETURNING supplier_id',
      [id, req.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    res.json({ message: 'Supplier deleted successfully', supplier_id: id });
  } catch (error) {
    console.error('Error deleting supplier:', error);
    res.status(500).json({ error: 'Failed to delete supplier', message: error.message });
  }
});

// Get supplier ledger (purchases + payments history)
router.get('/:id/ledger', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get purchases
    const purchasesResult = await db.query(
      `SELECT 
        purchase_id as transaction_id,
        'Purchase' as transaction_type,
        date as transaction_date,
        total_amount as amount,
        payment_type,
        'Credit Purchase' as description,
        NULL as payment_method
      FROM purchases
      WHERE supplier_id = $1 AND shop_id = $2
      ORDER BY date DESC, purchase_id DESC`,
      [id, req.shopId]
    );

    // Get payments
    const paymentsResult = await db.query(
      `SELECT 
        payment_id as transaction_id,
        'Payment' as transaction_type,
        payment_date as transaction_date,
        amount,
        NULL as payment_type,
        COALESCE(notes, 'Payment') as description,
        payment_method
      FROM supplier_payments
      WHERE supplier_id = $1
      ORDER BY payment_date DESC, payment_id DESC`,
      [id]
    );

    // Combine and sort by date
    const ledger = [...purchasesResult.rows, ...paymentsResult.rows]
      .sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

    // Calculate running balance
    let runningBalance = 0;
    const supplier = await db.query(
      `SELECT opening_balance FROM suppliers WHERE supplier_id = $1 AND shop_id = $2`,
      [id, req.shopId]
    );
    
    if (supplier.rows.length === 0) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    runningBalance = parseFloat(supplier.rows[0].opening_balance) || 0;

    // Add running balance to each transaction (in reverse chronological order)
    const ledgerWithBalance = ledger.map(transaction => {
      if (transaction.transaction_type === 'Purchase' && transaction.payment_type === 'credit') {
        runningBalance += parseFloat(transaction.amount);
      } else if (transaction.transaction_type === 'Payment') {
        runningBalance -= parseFloat(transaction.amount);
      }
      return {
        ...transaction,
        running_balance: runningBalance
      };
    }).reverse(); // Reverse to show oldest first

    res.json({
      supplier_id: parseInt(id),
      opening_balance: parseFloat(supplier.rows[0].opening_balance) || 0,
      current_balance: runningBalance,
      transactions: ledgerWithBalance
    });
  } catch (error) {
    console.error('Error fetching supplier ledger:', error);
    res.status(500).json({ error: 'Failed to fetch supplier ledger', message: error.message });
  }
});

module.exports = router;
