const express = require('express');
const { getBusinessTodayDateString } = require('../utils/businessDate');
const router = express.Router();
const db = require('../db');
const { requireAuth, isElevatedRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const { auditFromReq, pickFields } = require('../lib/auditTrail');
const {
  lineGross,
  parseLineDiscount,
  lineProfit,
  insertSaleItemRow,
} = require('../lib/saleLineMath');
const notificationsModule = require('./notifications');
const createNotification = notificationsModule.createNotification || (async () => {
  // Fallback if createNotification is not available
  console.warn('[Sales] createNotification helper not available');
});

// All sales routes require authentication and active shop (x-shop-id)
router.use(requireAuth);
router.use(requireShopContext);

/** cash | card | transfer — how payment was received (not credit/split settlement). */
function normalizePaymentMode(raw) {
  const m = String(raw || 'cash').toLowerCase().trim();
  if (m === 'bank' || m === 'transfer' || m === 'bank_transfer') return 'transfer';
  if (m === 'card') return 'card';
  return 'cash';
}

function withPaymentMode(sale) {
  if (!sale) return sale;
  return { ...sale, payment_mode: sale.payment_mode || 'cash' };
}

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
        s.payment_mode,
        s.total_profit,
        s.is_finalized,
        s.finalized_at,
        s.created_by,
        s.sale_kind,
        s.original_sale_id,
        s.notes,
        (SELECT o.invoice_number FROM sales o
         WHERE o.sale_id = s.original_sale_id AND o.shop_id = s.shop_id
         LIMIT 1) AS original_invoice_number,
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
    res.json(result.rows.map(withPaymentMode));
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
          c.phone AS customer_phone,
          s.customer_id,
          s.subtotal,
          s.discount,
          s.tax,
          s.total_amount,
          s.paid_amount,
          s.payment_type,
          s.payment_mode,
          s.total_profit,
          s.is_finalized,
          s.finalized_at,
          s.created_by,
          s.updated_by,
          s.sale_kind,
          s.original_sale_id,
          s.notes,
          (SELECT o.invoice_number FROM sales o
           WHERE o.sale_id = s.original_sale_id AND o.shop_id = s.shop_id
           LIMIT 1) AS original_invoice_number
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

    const sale = withPaymentMode(saleResult.rows[0]);

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
  const { customer_id, customer_name, items, payment_type, payment_mode, paid_amount, discount, tax, sale_notes, notes } = req.body;
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

    const normalizedItems = [];

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

      const purchasePrice = parseFloat(product.purchase_price) || 0;
      const gross = lineGross(q, selling_price);
      const lineDiscount = parseLineDiscount(item, gross);
      const itemProfit = lineProfit(q, selling_price, purchasePrice, lineDiscount);

      subtotalAmount += gross;
      totalProfit += itemProfit;
      normalizedItems.push({
        product_id: pid,
        quantity: q,
        selling_price: parseFloat(selling_price),
        purchase_price: purchasePrice,
        line_discount: lineDiscount,
        profit: itemProfit,
      });
    }

    let totalLineDiscount = normalizedItems.reduce((s, it) => s + it.line_discount, 0);
    const billDiscountExtra = Math.max(0, parseFloat(discount) || 0);
    if (billDiscountExtra > totalLineDiscount + 0.02) {
      totalLineDiscount = billDiscountExtra;
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
    const discountAmount = Math.round(totalLineDiscount * 100) / 100;
    const taxAmount = parseFloat(tax) || 0;
    const subtotal = subtotalAmount;
    const grandTotal = Math.max(0, subtotal - discountAmount + taxAmount);
    totalProfit = Math.round(totalProfit * 100) / 100;
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
    const paymentModeToSave = normalizePaymentMode(payment_mode);

    // Create sale record with user tracking — business calendar date (not raw UTC CURRENT_DATE)
    const userId = req.user?.user_id || null;
    const saleBusinessDate = await getBusinessTodayDateString(client);
    const insertBase = [invoiceNumber, customer_id || null, customer_name || null, subtotal, discountAmount, taxAmount, grandTotal, paidAmount, paymentTypeToSave, totalProfit, userId, saleBusinessDate, req.shopId];
    let saleResult;
    // SAVEPOINT: retry without optional columns (notes, payment_mode) if migration not applied yet.
    await client.query('SAVEPOINT sp_sale_insert');
    try {
      saleResult = await client.query(
        `INSERT INTO sales (invoice_number, customer_id, customer_name, subtotal, discount, tax, total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id, notes, payment_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [...insertBase, saleNotes || null, paymentModeToSave]
      );
      await client.query('RELEASE SAVEPOINT sp_sale_insert');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_sale_insert');
      if (e.code === '42703') {
        try {
          saleResult = await client.query(
            `INSERT INTO sales (invoice_number, customer_id, customer_name, subtotal, discount, tax, total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING *`,
            [...insertBase, saleNotes || null]
          );
        } catch (e2) {
          if (e2.code === '42703') {
            saleResult = await client.query(
              `INSERT INTO sales (invoice_number, customer_id, customer_name, subtotal, discount, tax, total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               RETURNING *`,
              insertBase
            );
          } else {
            throw e2;
          }
        }
      } else {
        throw e;
      }
    }

    const saleId = saleResult.rows[0].sale_id;

    for (const item of normalizedItems) {
      await insertSaleItemRow(client, {
        saleId,
        productId: item.product_id,
        quantity: item.quantity,
        sellingPrice: item.selling_price,
        purchasePrice: item.purchase_price,
        profit: item.profit,
        lineDiscount: item.line_discount,
      });

      await client.query(
        `UPDATE products 
         SET quantity_in_stock = quantity_in_stock - $1
         WHERE product_id = $2 AND shop_id = $3`,
        [item.quantity, item.product_id, req.shopId]
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
    await auditFromReq(req, {
      action: 'create',
      tableName: 'sales',
      recordId: saleId,
      newValues: {
        invoice_number: invoiceNumber,
        total_amount: grandTotal,
        discount: discountAmount,
        items: normalizedItems.map((it) =>
          pickFields(it, ['product_id', 'quantity', 'selling_price', 'line_discount'])
        ),
      },
      notes: `Created invoice ${invoiceNumber}`,
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

    const saleData = withPaymentMode({
      ...saleResultFinal.rows[0],
      payment_mode: saleResultFinal.rows[0].payment_mode || paymentModeToSave,
    });

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
    const { items, payment_type, payment_mode, paid_amount, discount, tax, customer_id, customer_name } = req.body;
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

    await auditFromReq(req, {
      action: 'update',
      tableName: 'sales',
      recordId: parseInt(id, 10),
      notes: `Updated invoice ${sale.invoice_number}`,
      newValues: pickFields(sale, ['invoice_number', 'total_amount', 'discount']),
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

    const saleData = withPaymentMode(saleResult.rows[0]);

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

    await auditFromReq(req, {
      action: 'delete',
      tableName: 'sales',
      recordId: parseInt(id, 10),
      oldValues: pickFields(sale, ['invoice_number', 'total_amount', 'customer_id']),
      notes: `Deleted invoice ${sale.invoice_number}`,
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

/** Sale ids for prior credit notes against this invoice (schema-safe: original_sale_id → notes → none). */
async function loadPreviousReturnSaleIds(client, shopId, originalId, invoiceNumber) {
  await client.query('SAVEPOINT sp_prev_returns');
  try {
    const r = await client.query(
      `SELECT sale_id FROM sales WHERE shop_id = $1 AND original_sale_id = $2`,
      [shopId, originalId]
    );
    await client.query('RELEASE SAVEPOINT sp_prev_returns');
    return r.rows.map((row) => row.sale_id);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_prev_returns');
    if (e.code !== '42703') throw e;
  }

  await client.query('SAVEPOINT sp_prev_returns');
  try {
    const r = await client.query(
      `SELECT sale_id FROM sales
       WHERE shop_id = $1 AND invoice_number ILIKE 'CN-%' AND COALESCE(notes, '') LIKE $2`,
      [shopId, `%REF:${invoiceNumber}%`]
    );
    await client.query('RELEASE SAVEPOINT sp_prev_returns');
    return r.rows.map((row) => row.sale_id);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_prev_returns');
    if (e.code !== '42703') throw e;
  }

  return [];
}

/** Insert credit-note row; tries extended columns, then notes only, then base columns. */
async function insertReturnSaleRecord(client, baseWithNotes, baseNoNotes, originalId) {
  const tries = [
    {
      sql: `INSERT INTO sales (
         invoice_number, customer_id, customer_name, subtotal, discount, tax,
         total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id, notes,
         sale_kind, original_sale_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'return',$15)
       RETURNING *`,
      params: [...baseWithNotes, originalId],
    },
    {
      sql: `INSERT INTO sales (
         invoice_number, customer_id, customer_name, subtotal, discount, tax,
         total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      params: baseWithNotes,
    },
    {
      sql: `INSERT INTO sales (
         invoice_number, customer_id, customer_name, subtotal, discount, tax,
         total_amount, paid_amount, payment_type, total_profit, created_by, date, shop_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      params: baseNoNotes,
    },
  ];

  for (const t of tries) {
    await client.query('SAVEPOINT sp_return_ins');
    try {
      const result = await client.query(t.sql, t.params);
      await client.query('RELEASE SAVEPOINT sp_return_ins');
      return result;
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_return_ins');
      if (e.code !== '42703') throw e;
    }
  }

  throw new Error(
    'Could not save credit note. Run database/migrations/009_sales_returns_daily_closing.sql in Supabase SQL Editor.'
  );
}

async function generateCreditNoteNumber(shopId, client) {
  const q = client || db;
  const result = await q.query(
    `SELECT invoice_number FROM sales
     WHERE shop_id = $1 AND invoice_number ILIKE 'CN-%'
     ORDER BY sale_id DESC LIMIT 1`,
    [shopId]
  );
  if (!result.rows.length) return 'CN-00001';
  const last = String(result.rows[0].invoice_number || '');
  const match = last.match(/CN-(\d+)/i);
  if (match) {
    const next = parseInt(match[1], 10) + 1;
    return `CN-${String(next).padStart(5, '0')}`;
  }
  return 'CN-00001';
}

function buildReturnNotes(originalInvoice, returnReason) {
  const reason = String(returnReason || '')
    .trim()
    .replace(/\|/g, '-')
    .slice(0, 500);
  return `REF:${originalInvoice} | REASON:${reason}`;
}

/** Persist return header + lines in sales_returns tables (optional if migration not applied). */
async function persistSalesReturnTables(client, payload) {
  await client.query('SAVEPOINT sp_sales_returns_tbl');
  try {
    const hdr = await client.query(
      `INSERT INTO sales_returns (
         shop_id, sale_id, original_sale_id, return_number, return_reason, refund_type,
         subtotal, discount, tax, total_amount, paid_amount, payment_type,
         customer_id, customer_name, created_by, return_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING return_id`,
      [
        payload.shopId,
        payload.saleId,
        payload.originalSaleId,
        payload.returnNumber,
        payload.returnReason,
        payload.refundType,
        payload.subtotal,
        payload.discount,
        payload.tax,
        payload.totalAmount,
        payload.paidAmount,
        payload.paymentType,
        payload.customerId,
        payload.customerName,
        payload.createdBy,
        payload.returnDate,
      ]
    );
    const returnId = hdr.rows[0].return_id;
    for (const line of payload.lines) {
      const lineTotal = Math.max(
        0,
        (parseFloat(line.selling_price) || 0) * (parseFloat(line.quantity) || 0) -
          (parseFloat(line.line_discount) || 0)
      );
      await client.query(
        `INSERT INTO sales_return_items (
           return_id, product_id, quantity, selling_price, purchase_price, line_discount, line_total
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          returnId,
          line.product_id,
          line.quantity,
          line.selling_price,
          line.purchase_price,
          line.line_discount || 0,
          lineTotal,
        ]
      );
    }
    await client.query('RELEASE SAVEPOINT sp_sales_returns_tbl');
    return returnId;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_sales_returns_tbl');
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

/**
 * Return / refund — creates credit note, restores stock, adjusts customer balance.
 * Body: { items: [{ product_id, quantity }], refund_type: 'cash'|'credit', return_reason: string (required) }
 */
router.post('/:id/return', async (req, res) => {
  const client = await db.getClient();
  try {
    const originalId = parseInt(req.params.id, 10);
    if (Number.isNaN(originalId)) {
      return res.status(400).json({ error: 'Invalid sale id' });
    }

    const returnItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!returnItems.length) {
      return res.status(400).json({ error: 'Select at least one item to return' });
    }

    const returnReason = String(req.body?.return_reason || '').trim();
    if (returnReason.length < 3) {
      return res.status(400).json({ error: 'Return reason is required (at least 3 characters).' });
    }

    const refundType = String(req.body?.refund_type || 'cash').toLowerCase() === 'credit' ? 'credit' : 'cash';

    await client.query('BEGIN');

    const origRes = await client.query(
      `SELECT * FROM sales WHERE sale_id = $1 AND shop_id = $2`,
      [originalId, req.shopId]
    );
    if (!origRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Original invoice not found' });
    }
    const original = origRes.rows[0];
    if (String(original.invoice_number || '').toUpperCase().startsWith('CN-')) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot return a credit note' });
    }

    let origItemsRes;
    await client.query('SAVEPOINT sp_orig_items');
    try {
      origItemsRes = await client.query(
        `SELECT sale_item_id, product_id, quantity, selling_price, purchase_price, line_discount
         FROM sale_items WHERE sale_id = $1`,
        [originalId]
      );
      await client.query('RELEASE SAVEPOINT sp_orig_items');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_orig_items');
      if (e.code !== '42703') throw e;
      origItemsRes = await client.query(
        `SELECT sale_item_id, product_id, quantity, selling_price, purchase_price
         FROM sale_items WHERE sale_id = $1`,
        [originalId]
      );
    }
    const origByProduct = new Map();
    origItemsRes.rows.forEach((row) => {
      const pid = parseInt(row.product_id, 10);
      const prev = origByProduct.get(pid) || {
        qty: 0,
        selling_price: row.selling_price,
        purchase_price: row.purchase_price,
        line_discount_total: 0,
      };
      prev.qty += parseFloat(row.quantity) || 0;
      prev.line_discount_total += parseFloat(row.line_discount) || 0;
      origByProduct.set(pid, prev);
    });

    let returnedByProduct = new Map();
    const prevReturnIds = await loadPreviousReturnSaleIds(
      client,
      req.shopId,
      originalId,
      original.invoice_number
    );
    for (const prevSaleId of prevReturnIds) {
      const ri = await client.query(
        `SELECT product_id, quantity FROM sale_items WHERE sale_id = $1`,
        [prevSaleId]
      );
      ri.rows.forEach((it) => {
        const pid = parseInt(it.product_id, 10);
        returnedByProduct.set(pid, (returnedByProduct.get(pid) || 0) + (parseFloat(it.quantity) || 0));
      });
    }

    let subtotalReturn = 0;
    let totalProfitReturn = 0;
    const linesToInsert = [];

    for (const line of returnItems) {
      const pid = parseInt(line.product_id, 10);
      const qty = parseFloat(line.quantity);
      if (!pid || !qty || qty <= 0) continue;

      const orig = origByProduct.get(pid);
      if (!orig) {
        throw new Error(`Product ${pid} was not on the original invoice`);
      }
      const already = returnedByProduct.get(pid) || 0;
      const remaining = orig.qty - already;
      if (qty > remaining + 1e-6) {
        throw new Error(`Return quantity exceeds remaining for product ${pid} (max ${remaining})`);
      }

      const sp = parseFloat(line.selling_price) || parseFloat(orig.selling_price) || 0;
      const pp = parseFloat(orig.purchase_price) || 0;
      const discPerUnit = orig.qty > 0 ? (orig.line_discount_total || 0) / orig.qty : 0;
      const lineDisc = Math.round(discPerUnit * qty * 100) / 100;
      const gross = sp * qty;
      subtotalReturn += gross;
      totalProfitReturn += gross - lineDisc - pp * qty;
      linesToInsert.push({
        product_id: pid,
        quantity: qty,
        selling_price: sp,
        purchase_price: pp,
        line_discount: lineDisc,
      });
    }

    if (!linesToInsert.length) {
      throw new Error('No valid return lines');
    }

    const returnLineDiscount = linesToInsert.reduce((s, l) => s + (l.line_discount || 0), 0);
    const grandTotal = Math.max(0, subtotalReturn - returnLineDiscount);
    let paymentType = 'cash';
    let paidAmount = grandTotal;
    if (refundType === 'credit' && original.customer_id) {
      paymentType = 'credit';
      paidAmount = 0;
    } else if (original.customer_id && ['credit', 'split'].includes(String(original.payment_type || '').toLowerCase())) {
      paymentType = 'credit';
      paidAmount = 0;
    }

    const creditNoteNumber = await generateCreditNoteNumber(req.shopId, client);
    const userId = req.user?.user_id || null;
    const saleBusinessDate = await getBusinessTodayDateString(client);
    const returnNotes = buildReturnNotes(original.invoice_number, returnReason);

    const baseNoNotes = [
      creditNoteNumber,
      original.customer_id || null,
      original.customer_name || null,
      subtotalReturn,
      returnLineDiscount,
      0,
      grandTotal,
      paidAmount,
      paymentType,
      totalProfitReturn,
      userId,
      saleBusinessDate,
      req.shopId,
    ];
    const baseWithNotes = [...baseNoNotes, returnNotes];

    const saleResult = await insertReturnSaleRecord(
      client,
      baseWithNotes,
      baseNoNotes,
      originalId
    );

    const returnSaleId = saleResult.rows[0].sale_id;

    for (const line of linesToInsert) {
      const profit = lineProfit(
        line.quantity,
        line.selling_price,
        line.purchase_price,
        line.line_discount || 0
      );
      await insertSaleItemRow(client, {
        saleId: returnSaleId,
        productId: line.product_id,
        quantity: line.quantity,
        sellingPrice: line.selling_price,
        purchasePrice: line.purchase_price,
        profit,
        lineDiscount: line.line_discount || 0,
      });
      await client.query(
        `UPDATE products SET quantity_in_stock = quantity_in_stock + $1
         WHERE product_id = $2 AND shop_id = $3`,
        [line.quantity, line.product_id, req.shopId]
      );
    }

    if (original.customer_id) {
      await client.query(
        `UPDATE customers
         SET current_balance = opening_balance +
           COALESCE((SELECT SUM(
             CASE WHEN invoice_number ILIKE 'CN-%' THEN -(total_amount - paid_amount)
                  ELSE (total_amount - paid_amount) END
           ) FROM sales WHERE customer_id = $1 AND shop_id = $2 AND payment_type IN ('credit','split')), 0) -
           COALESCE((SELECT SUM(amount) FROM customer_payments WHERE customer_id = $1), 0)
         WHERE customer_id = $1`,
        [original.customer_id, req.shopId]
      );
    }

    const returnId = await persistSalesReturnTables(client, {
      shopId: req.shopId,
      saleId: returnSaleId,
      originalSaleId: originalId,
      returnNumber: creditNoteNumber,
      returnReason,
      refundType,
      subtotal: subtotalReturn,
      discount: returnLineDiscount,
      tax: 0,
      totalAmount: grandTotal,
      paidAmount,
      paymentType,
      customerId: original.customer_id || null,
      customerName: original.customer_name || null,
      createdBy: userId,
      returnDate: saleBusinessDate,
      lines: linesToInsert,
    });

    await client.query('COMMIT');

    await auditFromReq(req, {
      action: 'create',
      tableName: 'sales',
      recordId: returnSaleId,
      newValues: {
        invoice_number: creditNoteNumber,
        original_invoice: original.invoice_number,
        return_reason: returnReason,
        total_amount: grandTotal,
      },
      notes: `Sales return ${creditNoteNumber} for ${original.invoice_number}`,
    });

    const detail = await db.query(
      `SELECT s.*, (
         SELECT json_agg(json_build_object(
           'product_id', si.product_id,
           'quantity', si.quantity,
           'selling_price', si.selling_price,
           'product_name', COALESCE(p.item_name_english, p.name)
         ))
         FROM sale_items si
         JOIN products p ON p.product_id = si.product_id AND p.shop_id = s.shop_id
         WHERE si.sale_id = s.sale_id
       ) AS items
       FROM sales s WHERE s.sale_id = $1`,
      [returnSaleId]
    );

    res.status(201).json({
      ...detail.rows[0],
      return_id: returnId || returnSaleId,
      refund_type: refundType,
      refund_cash_amount: refundType === 'cash' ? grandTotal : 0,
      original_invoice: original.invoice_number,
      return_reason: returnReason,
      message: 'Sales return recorded',
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be rolled back */
    }
    console.error('Error creating return:', error);
    const msg = String(error.message || '');
    const friendly =
      error.code === '25P02' || msg.includes('transaction is aborted')
        ? 'Return failed (database schema). Run migration 009_sales_returns_daily_closing.sql in Supabase, then try again.'
        : msg || 'Failed to process return';
    res.status(400).json({ error: friendly });
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

    await auditFromReq(req, {
      action: 'finalize',
      tableName: 'sales',
      recordId: parseInt(id, 10),
      notes: 'Finalized invoice',
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

