const express = require('express');
const { getBusinessTodayDateString } = require('../utils/businessDate');
const router = express.Router();
const db = require('../db');
const { requireAuth, isElevatedRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const { logAuditEvent } = require('../utils/auditLogger');
const notificationsModule = require('./notifications');
const createNotification = notificationsModule.createNotification || (async () => {
  // Fallback if createNotification is not available
  console.warn('[Sales] createNotification helper not available');
});

// All sales routes require authentication and active shop (x-shop-id)
router.use(requireAuth);
router.use(requireShopContext);

// Generate next invoice number (per shop) in Bill-0000X format
async function generateInvoiceNumber(shopId) {
  try {
    const result = await db.query(
      `SELECT invoice_number FROM sales 
       WHERE shop_id = $1
       ORDER BY sale_id DESC LIMIT 1`,
      [shopId]
    );

    if (result.rows.length === 0) {
      return 'Bill-00001';
    }

    const lastInvoice = String(result.rows[0].invoice_number || '').trim();
    // Accept legacy INV-xxxx and newer Bill-xxxxx, continue numeric sequence safely.
    const match = lastInvoice.match(/(?:INV|Bill)-(\d+)/i);
    
    if (match) {
      const lastNumber = parseInt(match[1]);
      const nextNumber = lastNumber + 1;
      return `Bill-${String(nextNumber).padStart(5, '0')}`;
    }

    // Fallback if format doesn't match
    return 'Bill-00001';
  } catch (error) {
    console.error('Error generating invoice number:', error);
    return 'Bill-00001';
  }
}

// Get all sales
router.get('/', async (req, res) => {
  try {
    const { search, limit = 100, customer_id } = req.query;
    let query = `
      SELECT 
        s.sale_id,
        s.invoice_number,
        s.date,
        s.customer_id,
        COALESCE(c.name, s.customer_name) AS customer_name,
        s.total_amount,
        s.paid_amount,
        s.payment_type,
        s.total_profit,
        s.is_finalized,
        s.finalized_at,
        s.created_by,
        (SELECT COUNT(*)::int FROM sale_items si0 WHERE si0.sale_id = s.sale_id) AS item_count,
        (
          SELECT string_agg(sub2.nm, ', ')
          FROM (
            SELECT COALESCE(p.item_name_english, p.name) AS nm
            FROM sale_items si2
            JOIN products p ON si2.product_id = p.product_id AND p.shop_id = s.shop_id
            WHERE si2.sale_id = s.sale_id
            ORDER BY si2.sale_item_id
            LIMIT 5
          ) sub2
        ) AS items_preview
      FROM sales s
      LEFT JOIN customers c
        ON s.customer_id = c.customer_id
       AND c.shop_id = s.shop_id
      WHERE s.shop_id = $1
    `;
    const params = [req.shopId];

    if (customer_id != null && String(customer_id).trim() !== '') {
      const cid = parseInt(customer_id, 10);
      if (!Number.isNaN(cid)) {
        query += ` AND s.customer_id = $${params.length + 1}`;
        params.push(cid);
      }
    }
    
    if (search) {
      query += ` AND (
        s.invoice_number ILIKE $${params.length + 1} OR 
        COALESCE(c.name, s.customer_name, '') ILIKE $${params.length + 1} OR 
        CAST(s.date AS TEXT) ILIKE $${params.length + 1}
      )`;
      params.push(`%${search}%`);
    }
    
    query += ` ORDER BY s.sale_id DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10) || 100);
    
    const result = await db.query(query, params);
    // Map payment_type to payment_mode for frontend consistency
    const salesWithPaymentMode = result.rows.map(sale => ({
      ...sale,
      payment_mode: sale.payment_type || 'cash'
    }));
    
    res.json(salesWithPaymentMode);
  } catch (error) {
    console.error('Error fetching sales:', error);
    res.status(500).json({ error: 'Failed to fetch sales', message: error.message });
  }
});

// Get single sale with items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [saleResult, itemsResult] = await Promise.all([
      db.query(
        `SELECT 
          s.sale_id,
          s.invoice_number,
          s.date,
          COALESCE(c.name, s.customer_name) AS customer_name,
          s.customer_id,
          s.subtotal,
          s.discount,
          s.tax,
          s.total_amount,
          s.paid_amount,
          s.payment_type,
          s.total_profit,
          s.is_finalized,
          s.finalized_at,
          s.created_by,
          s.updated_by
        FROM sales s
        LEFT JOIN customers c
          ON s.customer_id = c.customer_id
         AND c.shop_id = s.shop_id
        WHERE s.sale_id = $1 AND s.shop_id = $2`,
        [id, req.shopId]
      ),
      db.query(
        `SELECT 
          si.sale_item_id,
          si.sale_id,
          si.product_id,
          si.quantity,
          si.selling_price,
          si.purchase_price,
          si.profit,
          p.name as product_name,
          p.item_name_english,
          p.sku
        FROM sale_items si
        JOIN products p ON si.product_id = p.product_id AND p.shop_id = $2
        WHERE si.sale_id = $1`,
        [id, req.shopId]
      )
    ]);

    if (saleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    const sale = saleResult.rows[0];
    // Map payment_type to payment_mode for frontend consistency
    sale.payment_mode = sale.payment_type || 'cash';
    
    // Use item_name_english if available, otherwise use product_name
    const items = itemsResult.rows.map(item => ({
      ...item,
      product_name: item.item_name_english || item.product_name || 'N/A',
      name: item.item_name_english || item.product_name || 'N/A'
    }));
    
    res.json({
      ...sale,
      items: items
    });
  } catch (error) {
    console.error('Error fetching sale:', error);
    res.status(500).json({ error: 'Failed to fetch sale', message: error.message });
  }
});

// Create new sale/invoice
router.post('/', async (req, res) => {
  const { customer_id, customer_name, items, payment_type, paid_amount, discount, tax, sale_notes, notes } = req.body;
  const saleNotes = (sale_notes != null && sale_notes !== '') ? String(sale_notes).trim() : (notes != null ? String(notes).trim() : null);

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // If customer_id provided, verify it exists
    if (customer_id) {
      const customerCheck = await client.query(
        'SELECT customer_id FROM customers WHERE customer_id = $1 AND shop_id = $2',
        [customer_id, req.shopId]
      );
      if (customerCheck.rows.length === 0) {
        throw new Error('Customer not found');
      }
    }

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber(req.shopId);

    // Validate each line + aggregate quantities per product (same product on multiple lines)
    const qtyByProduct = new Map();
    let subtotalAmount = 0;
    let totalProfit = 0;

    for (const item of items) {
      const { product_id, quantity, selling_price } = item;

      if (!product_id || !quantity || !selling_price) {
        throw new Error('Invalid item: product_id, quantity, and selling_price are required');
      }

      if (quantity <= 0) {
        throw new Error('Quantity must be greater than 0');
      }

      if (selling_price <= 0) {
        throw new Error('Selling price must be greater than 0');
      }

      const productResult = await client.query(
        'SELECT quantity_in_stock, purchase_price FROM products WHERE product_id = $1 AND shop_id = $2',
        [product_id, req.shopId]
      );

      if (productResult.rows.length === 0) {
        throw new Error(`Product with ID ${product_id} not found`);
      }

      const product = productResult.rows[0];
      const pid = parseInt(product_id, 10);
      const q = parseFloat(quantity);
      qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + q);

      const purchasePrice = parseFloat(product.purchase_price);
      const itemTotal = parseFloat(selling_price) * quantity;
      const itemProfit = (parseFloat(selling_price) - purchasePrice) * quantity;

      subtotalAmount += itemTotal;
      totalProfit += itemProfit;
    }

    // Enforce stock: cannot sell more than on hand (total per product across all lines)
    for (const [pid, totalQty] of qtyByProduct) {
      const stockRow = await client.query(
        'SELECT quantity_in_stock, name, item_name_english FROM products WHERE product_id = $1 AND shop_id = $2',
        [pid, req.shopId]
      );
      if (stockRow.rows.length === 0) {
        throw new Error(`Product with ID ${pid} not found`);
      }
      const available = parseFloat(stockRow.rows[0].quantity_in_stock) || 0;
      if (totalQty > available) {
        throw new Error(
          `Insufficient stock. Available: ${available} units. Please add stock first.`
        );
      }
    }

    // Calculate totals
    const discountAmount = parseFloat(discount) || 0;
    const taxAmount = parseFloat(tax) || 0;
    const subtotal = subtotalAmount;
    const grandTotal = subtotal - discountAmount + taxAmount;
    // Settlement type (cash | credit | split) must come from payment_type — NOT payment_mode
    // (payment_mode is cash/card/bank for how money was received; mixing them breaks udhar/split).
    const paidRaw = paid_amount !== undefined && paid_amount !== null ? parseFloat(paid_amount) : NaN;
    const reqPaid = Number.isFinite(paidRaw)
      ? Math.min(grandTotal, Math.max(0, paidRaw))
      : null;

    let settlementType;
    let paidAmount;
    if (!customer_id) {
      settlementType = 'cash';
      paidAmount = grandTotal;
    } else if (reqPaid !== null && reqPaid <= 0.00001) {
      settlementType = 'credit';
      paidAmount = 0;
    } else if (reqPaid !== null && reqPaid < grandTotal - 0.00001) {
      settlementType = 'split';
      paidAmount = reqPaid;
    } else {
      settlementType = 'cash';
      paidAmount = grandTotal;
    }

    const paymentTypeToSave = settlementType;
    
    // Create sale record with user tracking — business calendar date (not raw UTC CURRENT_DATE)
    const userId = req.user?.user_id || null;
    const saleBusinessDate = await getBusinessTodayDateString(client);
    const insertParams = [invoiceNumber, customer_id || null, customer_name || null, subtotal, discountAmount, taxAmount, grandTotal, paidAmount, paymentTypeToSave, totalProfit, userId, saleBusinessDate, req.shopId, saleNotes || null];
    let saleResult;
    // Any failed statement aborts the whole txn in Postgres. Use SAVEPOINT so a failed
    // INSERT (e.g. missing `notes` column → 42703) can be recovered before retrying without notes.
    await client.query('SAVEPOINT sp_sale_insert');
    try {
      saleResult = await client.query(
        `INSERT INTO sales (invoice_number, customer_id, customer_name, subtotal, discount, tax, total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        insertParams
      );
      await client.query('RELEASE SAVEPOINT sp_sale_insert');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_sale_insert');
      if (e.code === '42703') {
        saleResult = await client.query(
          `INSERT INTO sales (invoice_number, customer_id, customer_name, subtotal, discount, tax, total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          insertParams.slice(0, 13)
        );
      } else {
        throw e;
      }
    }

    const saleId = saleResult.rows[0].sale_id;

    // Create sale items and update stock
    for (const item of items) {
      const { product_id, quantity, selling_price } = item;

      // Get product purchase price
      const productResult = await client.query(
        'SELECT purchase_price FROM products WHERE product_id = $1 AND shop_id = $2',
        [product_id, req.shopId]
      );
      const purchasePrice = parseFloat(productResult.rows[0].purchase_price);
      const profit = (parseFloat(selling_price) - purchasePrice) * quantity;

      // Insert sale item
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, selling_price, purchase_price, profit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, product_id, quantity, selling_price, purchasePrice, profit]
      );

      // Update product stock (allow negative stock for hardware shops)
      await client.query(
        `UPDATE products 
         SET quantity_in_stock = quantity_in_stock - $1
         WHERE product_id = $2 AND shop_id = $3`,
        [quantity, product_id, req.shopId]
      );
    }

    // Update customer balance for all sales (including partial payments)
    if (customer_id) {
      await client.query(
        `UPDATE customers 
         SET current_balance = opening_balance + 
             COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
             COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
         WHERE customer_id = $1`,
        [customer_id, req.shopId]
      );
    }

    await client.query('COMMIT');

    // Create notification for new sale
    try {
      const username = req.user?.username || 'System';
      await createNotification({
        userId: null, // Global notification for all admins
        title: 'New Sale Completed',
        message: `Sale ${invoiceNumber} completed successfully by ${username}. Total: PKR ${grandTotal.toFixed(2)}`,
        type: 'success',
        link: '/sales',
        metadata: { sale_id: saleId, invoice_number: invoiceNumber, shopId: req.shopId },
        shopId: req.shopId,
      });
    } catch (notifError) {
      console.error('Error creating notification:', notifError);
      // Don't fail the sale if notification fails
    }

    // Log audit event
    await logAuditEvent({
      userId,
      action: 'create',
      tableName: 'sales',
      recordId: saleId,
      newValues: { invoice_number: invoiceNumber, total_amount: grandTotal },
      notes: `Created invoice ${invoiceNumber}`,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent')
    });

    // Fetch complete sale with items for response
    const [saleResultFinal, itemsResult] = await Promise.all([
      db.query('SELECT * FROM sales WHERE sale_id = $1 AND shop_id = $2', [saleId, req.shopId]),
      db.query(
        `SELECT 
          si.*,
          p.name as product_name,
          p.sku
        FROM sale_items si
        JOIN products p ON si.product_id = p.product_id AND p.shop_id = $2
        WHERE si.sale_id = $1`,
        [saleId, req.shopId]
      )
    ]);

    const saleData = saleResultFinal.rows[0];
    // Map payment_type to payment_mode for frontend
    saleData.payment_mode = saleData.payment_type || 'cash';
    
    res.status(201).json({
      ...saleData,
      items: itemsResult.rows
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating sale:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create sale',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Update sale (admin only)
router.put('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    // Check if user is admin
    if (!isElevatedRole(req.user.role)) {
      return res.status(403).json({ error: 'Only administrators can update sales' });
    }
    
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { items, payment_type, paid_amount, discount, tax, customer_id, customer_name } = req.body;
    const userId = req.user?.user_id || null;

    // Get existing sale (this shop only)
    const existingSale = await client.query(
      'SELECT * FROM sales WHERE sale_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );

    if (existingSale.rows.length === 0) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    const sale = existingSale.rows[0];

    // Check if finalized
    if (sale.is_finalized) {
      return res.status(400).json({ error: 'Cannot update finalized invoice' });
    }

    // If items provided, update items
    if (items && Array.isArray(items) && items.length > 0) {
      // Delete old items and restore stock
      const oldItems = await client.query(
        'SELECT product_id, quantity FROM sale_items WHERE sale_id = $1',
        [id]
      );

      for (const oldItem of oldItems.rows) {
        // Restore stock
        await client.query(
          'UPDATE products SET quantity_in_stock = quantity_in_stock + $1 WHERE product_id = $2 AND shop_id = $3',
          [oldItem.quantity, oldItem.product_id, req.shopId]
        );
      }

      // Delete old items
      await client.query('DELETE FROM sale_items WHERE sale_id = $1', [id]);

      // Recalculate totals
      let subtotalAmount = 0;
      let totalProfit = 0;

      for (const item of items) {
        const { product_id, quantity, selling_price } = item;
        const productResult = await client.query(
          'SELECT purchase_price FROM products WHERE product_id = $1 AND shop_id = $2',
          [product_id, req.shopId]
        );
        const purchasePrice = parseFloat(productResult.rows[0].purchase_price);
        const itemTotal = parseFloat(selling_price) * quantity;
        const itemProfit = (parseFloat(selling_price) - purchasePrice) * quantity;

        subtotalAmount += itemTotal;
        totalProfit += itemProfit;

        // Insert new item
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, quantity, selling_price, purchase_price, profit)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, product_id, quantity, selling_price, purchasePrice, itemProfit]
        );

        // Update stock
        await client.query(
          'UPDATE products SET quantity_in_stock = quantity_in_stock - $1 WHERE product_id = $2 AND shop_id = $3',
          [quantity, product_id, req.shopId]
        );
      }

      const discountAmount = parseFloat(discount) || sale.discount || 0;
      const taxAmount = parseFloat(tax) || sale.tax || 0;
      const grandTotal = subtotalAmount - discountAmount + taxAmount;
      const paymentType = payment_type || sale.payment_type || 'cash';
      
      let paidAmount = sale.paid_amount;
      if (paymentType === 'cash') {
        paidAmount = grandTotal;
      } else if (paymentType === 'credit') {
        paidAmount = 0;
      } else if (paymentType === 'split') {
        paidAmount = parseFloat(paid_amount) || sale.paid_amount || 0;
      }

      // Update sale
      await client.query(
        `UPDATE sales 
         SET subtotal = $1, discount = $2, tax = $3, total_amount = $4, 
             paid_amount = $5, payment_type = $6, total_profit = $7,
             customer_id = $8, customer_name = $9, updated_by = $10, updated_at = NOW()
         WHERE sale_id = $11 AND shop_id = $12`,
        [subtotalAmount, discountAmount, taxAmount, grandTotal, paidAmount, 
         paymentType, totalProfit, customer_id || sale.customer_id, 
         customer_name || sale.customer_name, userId, id, req.shopId]
      );
    } else {
      // Update only payment/amount fields
      const discountAmount = parseFloat(discount) !== undefined ? parseFloat(discount) : sale.discount;
      const taxAmount = parseFloat(tax) !== undefined ? parseFloat(tax) : sale.tax;
      const paymentType = payment_type || sale.payment_type;
      const grandTotal = (sale.subtotal || 0) - discountAmount + taxAmount;
      
      let paidAmount = sale.paid_amount;
      if (paymentType === 'cash') {
        paidAmount = grandTotal;
      } else if (paymentType === 'credit') {
        paidAmount = 0;
      } else if (paymentType === 'split' && paid_amount !== undefined) {
        paidAmount = parseFloat(paid_amount);
      }

      await client.query(
        `UPDATE sales 
         SET discount = $1, tax = $2, total_amount = $3, 
             paid_amount = $4, payment_type = $5, updated_by = $6, updated_at = NOW()
         WHERE sale_id = $7 AND shop_id = $8`,
        [discountAmount, taxAmount, grandTotal, paidAmount, paymentType, userId, id, req.shopId]
      );
    }

    // Update customer balance if customer_id changed
    if (customer_id !== undefined && customer_id !== sale.customer_id) {
      // Recalculate balance for old customer
      if (sale.customer_id) {
        await client.query(
          `UPDATE customers 
           SET current_balance = opening_balance + 
               COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
               COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
           WHERE customer_id = $1`,
          [sale.customer_id, req.shopId]
        );
      }
      // Recalculate balance for new customer
      if (customer_id) {
        await client.query(
          `UPDATE customers 
           SET current_balance = opening_balance + 
               COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
               COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
           WHERE customer_id = $1`,
          [customer_id, req.shopId]
        );
      }
    } else if (customer_id && (paid_amount !== undefined || payment_type !== undefined)) {
      // Update balance if payment changed
      await client.query(
        `UPDATE customers 
         SET current_balance = opening_balance + 
             COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit', 'split')), 0) -
             COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
         WHERE customer_id = $1`,
        [customer_id, req.shopId]
      );
    }

    await client.query('COMMIT');

    // Log audit event
    await logAuditEvent({
      userId,
      action: 'update',
      tableName: 'sales',
      recordId: parseInt(id),
      notes: `Updated invoice ${sale.invoice_number}`,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent')
    });

    // Fetch updated sale
    const [saleResult, itemsResult] = await Promise.all([
      db.query('SELECT * FROM sales WHERE sale_id = $1 AND shop_id = $2', [id, req.shopId]),
      db.query(
        `SELECT 
          si.*,
          p.name as product_name,
          p.item_name_english,
          p.sku
        FROM sale_items si
        JOIN products p ON si.product_id = p.product_id AND p.shop_id = $2
        WHERE si.sale_id = $1`,
        [id, req.shopId]
      )
    ]);

    const saleData = saleResult.rows[0];
    saleData.payment_mode = saleData.payment_type || 'cash';
    
    res.json({
      ...saleData,
      items: itemsResult.rows.map(item => ({
        ...item,
        product_name: item.item_name_english || item.product_name || 'N/A',
        name: item.item_name_english || item.product_name || 'N/A'
      }))
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating sale:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to update sale',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Delete sale (admin only)
router.delete('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    // Check if user is admin
    if (!isElevatedRole(req.user.role)) {
      return res.status(403).json({ error: 'Only administrators can delete sales' });
    }
    
    await client.query('BEGIN');
    
    const { id } = req.params;
    const userId = req.user?.user_id || null;

    // Get sale info (this shop only)
    const saleResult = await client.query(
      'SELECT * FROM sales WHERE sale_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );

    if (saleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    const sale = saleResult.rows[0];

    // Check if finalized
    if (sale.is_finalized) {
      return res.status(400).json({ error: 'Cannot delete finalized invoice' });
    }

    // Get sale items to restore stock
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM sale_items WHERE sale_id = $1',
      [id]
    );

    // Restore stock for each item
    for (const item of itemsResult.rows) {
      await client.query(
        'UPDATE products SET quantity_in_stock = quantity_in_stock + $1 WHERE product_id = $2 AND shop_id = $3',
        [item.quantity, item.product_id, req.shopId]
      );
    }

    // Delete sale items
    await client.query('DELETE FROM sale_items WHERE sale_id = $1', [id]);

    // Update customer balance if customer exists
    if (sale.customer_id) {
      await client.query(
        `UPDATE customers 
         SET current_balance = opening_balance + 
             COALESCE((SELECT SUM(total_amount - paid_amount) FROM sales WHERE customer_id = $1 AND shop_id = $3 AND payment_type IN ('credit', 'split') AND sale_id != $2), 0) -
             COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
         WHERE customer_id = $1`,
        [sale.customer_id, id, req.shopId]
      );
    }

    // Delete sale
    await client.query('DELETE FROM sales WHERE sale_id = $1 AND shop_id = $2', [id, req.shopId]);

    await client.query('COMMIT');

    // Log audit event
    await logAuditEvent({
      userId,
      action: 'delete',
      tableName: 'sales',
      recordId: parseInt(id),
      oldValues: { invoice_number: sale.invoice_number, total_amount: sale.total_amount },
      notes: `Deleted invoice ${sale.invoice_number}`,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent')
    });

    res.json({
      success: true,
      message: 'Sale deleted successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting sale:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to delete sale',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Finalize invoice (prevent further editing)
router.post('/:id/finalize', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.user_id || null;

    // Check if sale exists (this shop only)
    const saleCheck = await db.query(
      'SELECT sale_id, is_finalized FROM sales WHERE sale_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );

    if (saleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    if (saleCheck.rows[0].is_finalized) {
      return res.status(400).json({ error: 'Invoice is already finalized' });
    }

    // Finalize the invoice
    await db.query(
      `UPDATE sales 
       SET is_finalized = true, 
           finalized_at = NOW(), 
           finalized_by = $1,
           updated_by = $1
       WHERE sale_id = $2 AND shop_id = $3`,
      [userId, id, req.shopId]
    );

    // Log audit event
    await logAuditEvent({
      userId,
      action: 'finalize',
      tableName: 'sales',
      recordId: parseInt(id),
      notes: `Finalized invoice`,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent')
    });

    res.json({
      success: true,
      message: 'Invoice finalized successfully'
    });
  } catch (error) {
    console.error('Error finalizing invoice:', error);
    res.status(500).json({ error: 'Failed to finalize invoice', message: error.message });
  }
});

module.exports = router;

