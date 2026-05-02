const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

// Purchases management is admin-only (cashiers cannot manage purchases)
router.use(requireAuth);
router.use(requireShopContext);
router.use(requireRole('administrator'));

// Get all purchases with supplier and item details
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        p.purchase_id,
        p.supplier_id,
        s.name as supplier_name,
        p.date,
        p.total_amount,
        p.payment_type,
        p.created_at,
        COUNT(pi.purchase_item_id) as item_count
      FROM purchases p
      LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = p.shop_id
      LEFT JOIN purchase_items pi ON p.purchase_id = pi.purchase_id
      WHERE p.shop_id = $1
      GROUP BY p.purchase_id, p.supplier_id, s.name, p.date, p.total_amount, p.payment_type, p.created_at
      ORDER BY p.date DESC, p.purchase_id DESC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: 'Failed to fetch purchases', message: error.message });
  }
});

// Get single purchase with items
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [purchaseResult, itemsResult] = await Promise.all([
      db.query(
        `SELECT 
          p.*,
          s.name as supplier_name,
          s.contact_number as supplier_phone
        FROM purchases p
        LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = p.shop_id
        WHERE p.purchase_id = $1 AND p.shop_id = $2`,
        [id, req.shopId]
      ),
      db.query(
        `SELECT 
          pi.*,
          COALESCE(pr.item_name_english, pr.name) as item_name,
          pr.sku as item_sku
        FROM purchase_items pi
        JOIN products pr ON pi.item_id = pr.product_id AND pr.shop_id = $2
        WHERE pi.purchase_id = $1`,
        [id, req.shopId]
      )
    ]);
    
    if (purchaseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }
    
    res.json({
      ...purchaseResult.rows[0],
      items: itemsResult.rows
    });
  } catch (error) {
    console.error('Error fetching purchase:', error);
    res.status(500).json({ error: 'Failed to fetch purchase', message: error.message });
  }
});

// Create new purchase
router.post('/', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { supplier_id, items, payment_type, date } = req.body;

    // Validation
    if (!supplier_id) {
      throw new Error('Supplier ID is required');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new Error('At least one item is required');
    }

    // Verify supplier exists
    const supplierCheck = await client.query(
      'SELECT supplier_id FROM suppliers WHERE supplier_id = $1 AND shop_id = $2',
      [supplier_id, req.shopId]
    );

    if (supplierCheck.rows.length === 0) {
      throw new Error('Supplier not found');
    }

    // Validate items and calculate total
    let totalAmount = 0;
    const purchaseDate = date ? new Date(date) : new Date();

    for (const item of items) {
      const { item_id, quantity, cost_price } = item;

      if (!item_id || !quantity || !cost_price) {
        throw new Error('Each item must have item_id, quantity, and cost_price');
      }

      if (quantity <= 0) {
        throw new Error('Quantity must be greater than 0');
      }

      if (cost_price <= 0) {
        throw new Error('Cost price must be greater than 0');
      }

      // Verify product exists
      const productCheck = await client.query(
        'SELECT product_id FROM products WHERE product_id = $1 AND shop_id = $2',
        [item_id, req.shopId]
      );

      if (productCheck.rows.length === 0) {
        throw new Error(`Product with ID ${item_id} not found`);
      }

      const subtotal = parseFloat(cost_price) * quantity;
      totalAmount += subtotal;
    }

    const paymentType = payment_type || 'cash';

    // Create purchase record
    const purchaseResult = await client.query(
      `INSERT INTO purchases (supplier_id, date, total_amount, payment_type, shop_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [supplier_id, purchaseDate, totalAmount, paymentType, req.shopId]
    );

    const purchaseId = purchaseResult.rows[0].purchase_id;

    // Create purchase items and update stock
    for (const item of items) {
      const { item_id, quantity, cost_price } = item;
      const subtotal = parseFloat(cost_price) * quantity;

      // Insert purchase item
      await client.query(
        `INSERT INTO purchase_items (purchase_id, item_id, quantity, cost_price, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [purchaseId, item_id, quantity, cost_price, subtotal]
      );

      // Weighted average cost (WAC) on inbound stock:
      // newAvg = (oldQty * oldAvg + newQty * newUnitCost) / (oldQty + newQty)
      // If oldQty <= 0, treat average as the incoming unit cost (fresh stock layer).
      const productRow = await client.query(
        `SELECT quantity_in_stock, purchase_price
         FROM products
         WHERE product_id = $1 AND shop_id = $2
         FOR UPDATE`,
        [item_id, req.shopId]
      );

      if (productRow.rows.length === 0) {
        throw new Error(`Product with ID ${item_id} not found`);
      }

      const oldQty = Number(productRow.rows[0].quantity_in_stock || 0);
      const oldAvg = Number(productRow.rows[0].purchase_price || 0);
      const addQty = Number(quantity);
      const unitCost = Number(cost_price);

      if (!Number.isFinite(addQty) || addQty <= 0) {
        throw new Error('Quantity must be greater than 0');
      }
      if (!Number.isFinite(unitCost) || unitCost <= 0) {
        throw new Error('Cost price must be greater than 0');
      }

      const denom = oldQty + addQty;
      const newAvg =
        oldQty > 0 && Number.isFinite(oldAvg) && oldAvg > 0
          ? (oldQty * oldAvg + addQty * unitCost) / denom
          : unitCost;

      await client.query(
        `UPDATE products 
         SET quantity_in_stock = quantity_in_stock + $1,
             purchase_price = $2
         WHERE product_id = $3 AND shop_id = $4`,
        [addQty, newAvg, item_id, req.shopId]
      );
    }

    // Supplier payable is derived in queries (opening_balance + credit purchases − payments);
    // there is no suppliers.balance column in the schema.

    await client.query('COMMIT');

    // Fetch complete purchase with items
    const [purchaseFinal, itemsResult] = await Promise.all([
      db.query('SELECT * FROM purchases WHERE purchase_id = $1 AND shop_id = $2', [purchaseId, req.shopId]),
      db.query(
        `SELECT 
          pi.*,
          pr.name as item_name,
          pr.sku as item_sku
        FROM purchase_items pi
        JOIN products pr ON pi.item_id = pr.product_id AND pr.shop_id = $2
        WHERE pi.purchase_id = $1`,
        [purchaseId, req.shopId]
      )
    ]);

    res.status(201).json({
      ...purchaseFinal.rows[0],
      items: itemsResult.rows
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating purchase:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create purchase',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Delete purchase (reverse stock and supplier balance)
router.delete('/:id', async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const { id } = req.params;

    // Get purchase details
    const purchaseResult = await client.query(
      'SELECT * FROM purchases WHERE purchase_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );

    if (purchaseResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Purchase not found' });
    }

    const purchase = purchaseResult.rows[0];

    // Get purchase items
    const itemsResult = await client.query(
      'SELECT * FROM purchase_items WHERE purchase_id = $1',
      [id]
    );

    // Reverse stock updates
    for (const item of itemsResult.rows) {
      await client.query(
        `UPDATE products 
         SET quantity_in_stock = GREATEST(0, quantity_in_stock - $1)
         WHERE product_id = $2 AND shop_id = $3`,
        [item.quantity, item.item_id, req.shopId]
      );
    }

    // Delete purchase items (cascade should handle this, but explicit is safer)
    await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [id]);

    // Delete purchase
    await client.query('DELETE FROM purchases WHERE purchase_id = $1 AND shop_id = $2', [id, req.shopId]);

    await client.query('COMMIT');

    res.json({ message: 'Purchase deleted successfully', purchase_id: id });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting purchase:', error);
    res.status(500).json({ error: 'Failed to delete purchase', message: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;






