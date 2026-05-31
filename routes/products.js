const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const {
  auditFromReq,
  normalizeProductAudit,
  buildProductChangeNotes,
  buildProductCreateNotes,
  buildProductDeleteNotes,
} = require('../lib/auditTrail');

// All product routes require authentication (both admins and cashiers can view products)
router.use(requireAuth);
router.use(requireShopContext);

// Get all products with supplier name (for electric shop)
router.get('/', async (req, res) => {
  try {
    const { category_id, sub_category_id, frequently_sold } = req.query;
    const shopId = req.shopId;

    let whereClause = ' WHERE p.shop_id = $1';
    const params = [shopId];
    let paramIndex = 2;

    if (category_id) {
      whereClause += ` AND p.category_id = $${paramIndex}`;
      params.push(category_id);
      paramIndex++;
    }

    if (sub_category_id) {
      whereClause += ` AND p.sub_category_id = $${paramIndex}`;
      params.push(sub_category_id);
      paramIndex++;
    }

    if (frequently_sold === 'true') {
      whereClause += ` AND p.is_frequently_sold = true`;
    }

    // Order by: frequently_sold first, then display_order, then name
    const result = await db.query(`
      SELECT 
        p.product_id,
        p.name,
        p.item_name_english,
        p.item_name_urdu,
        p.sku,
        p.category,
        p.category_id,
        p.sub_category_id,
        p.purchase_price,
        p.selling_price,
        p.retail_price,
        p.wholesale_price,
        p.special_price,
        p.unit_type,
        p.is_frequently_sold,
        p.display_order,
        p.quantity_in_stock,
        p.supplier_id,
        s.name as supplier_name,
        c.category_name,
        sc.sub_category_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = $1
      LEFT JOIN categories c ON p.category_id = c.category_id AND c.shop_id = $1
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.sub_category_id
      ${whereClause}
      ORDER BY 
        p.is_frequently_sold DESC,
        p.display_order ASC,
        COALESCE(p.item_name_english, p.name) ASC
    `, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to fetch products', 
      message: error.message,
      code: error.code,
      detail: error.detail
    });
  }
});

/** Return lines for a product — dedicated tables + CN sale_items (same as Returns detail). */
async function fetchProductReturnLines(productId, shopId) {
  let dedicated = [];
  let hasReturnTables = true;

  try {
    const result = await db.query(
      `SELECT
        COALESCE(sr.return_id, sr.sale_id) AS return_id,
        sr.sale_id,
        sr.return_number,
        sr.return_date AS date,
        sr.return_reason,
        sr.refund_type,
        sr.original_sale_id,
        orig.invoice_number AS original_invoice_number,
        sri.return_item_id,
        sri.quantity,
        sri.selling_price,
        sri.line_total,
        COALESCE(c.name, sr.customer_name) AS customer_name
      FROM sales_return_items sri
      JOIN sales_returns sr ON sr.return_id = sri.return_id AND sr.shop_id = $2
      LEFT JOIN customers c ON c.customer_id = sr.customer_id AND c.shop_id = sr.shop_id
      LEFT JOIN sales orig
        ON orig.sale_id = sr.original_sale_id AND orig.shop_id = sr.shop_id
      WHERE sri.product_id = $1 AND sr.shop_id = $2
      ORDER BY sr.return_date DESC NULLS LAST, sr.return_id DESC, sri.return_item_id DESC`,
      [productId, shopId]
    );
    dedicated = result.rows;
  } catch (error) {
    if (error.code !== '42P01') throw error;
    hasReturnTables = false;
  }

  const coveredSaleIds = new Set(
    dedicated.map((r) => String(r.sale_id)).filter((id) => id && id !== 'undefined')
  );

  let legacyExclude = '';
  if (hasReturnTables && coveredSaleIds.size > 0) {
    legacyExclude = ` AND NOT EXISTS (
      SELECT 1
      FROM sales_return_items sri2
      JOIN sales_returns sr2 ON sr2.return_id = sri2.return_id AND sr2.shop_id = $2
      WHERE sr2.sale_id = s.sale_id AND sri2.product_id = si.product_id
    )`;
  }

  const legacy = await db.query(
    `SELECT
      s.sale_id AS return_id,
      s.sale_id,
      s.invoice_number AS return_number,
      s.date,
      s.notes,
      s.original_sale_id,
      orig.invoice_number AS original_invoice_number,
      si.sale_item_id AS return_item_id,
      si.quantity,
      si.selling_price,
      (COALESCE(si.quantity, 0) * COALESCE(si.selling_price, 0)) AS line_total,
      COALESCE(c.name, s.customer_name) AS customer_name,
      CASE
        WHEN lower(COALESCE(s.payment_type, 'cash')) = 'credit' THEN 'credit'
        ELSE 'cash'
      END AS refund_type
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.sale_id AND s.shop_id = $2
    LEFT JOIN customers c ON c.customer_id = s.customer_id AND c.shop_id = s.shop_id
    LEFT JOIN sales orig
      ON orig.sale_id = s.original_sale_id AND orig.shop_id = s.shop_id
    WHERE si.product_id = $1
      AND s.shop_id = $2
      AND (
        lower(COALESCE(s.sale_kind, '')) = 'return'
        OR s.invoice_number ILIKE 'CN-%'
      )
      ${legacyExclude}
    ORDER BY s.date DESC NULLS LAST, s.sale_id DESC, si.sale_item_id DESC`,
    [productId, shopId]
  );

  const legacyRows = legacy.rows.map((row) => {
    const notes = String(row.notes || '');
    const reasonMatch = notes.match(/REASON:([^|]*)/i);
    return {
      ...row,
      return_reason: reasonMatch ? String(reasonMatch[1]).trim() : notes.trim(),
    };
  });

  const merged = [...dedicated, ...legacyRows];
  merged.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });
  return merged;
}

// Purchase + sale line history for product detail screen (must be before GET /:id if ever ambiguous)
router.get('/:id/activity', async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shopId;
    const pid = parseInt(id, 10);
    if (Number.isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const verify = await db.query(
      'SELECT product_id FROM products WHERE product_id = $1 AND shop_id = $2',
      [pid, shopId]
    );
    if (verify.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [purchasesResult, salesResult, returnsRows] = await Promise.all([
      db.query(
        `SELECT 
          p.purchase_id,
          p.date,
          p.payment_type,
          s.name AS supplier_name,
          pi.quantity,
          pi.cost_price,
          pi.purchase_item_id
        FROM purchase_items pi
        JOIN purchases p ON pi.purchase_id = p.purchase_id AND p.shop_id = $2
        LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = $2
        WHERE pi.item_id = $1 AND p.shop_id = $2
        ORDER BY p.date DESC NULLS LAST, p.purchase_id DESC`,
        [pid, shopId]
      ),
      db.query(
        `SELECT 
          s.sale_id,
          s.date,
          s.invoice_number,
          si.quantity,
          si.selling_price,
          COALESCE(c.name, s.customer_name) AS customer_name
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.sale_id AND s.shop_id = $2
        LEFT JOIN customers c ON s.customer_id = c.customer_id AND c.shop_id = s.shop_id
        WHERE si.product_id = $1 AND s.shop_id = $2
        ORDER BY s.date DESC NULLS LAST, s.sale_id DESC`,
        [pid, shopId]
      ),
      fetchProductReturnLines(pid, shopId),
    ]);

    const purchases = purchasesResult.rows.map((row) => ({
      ...row,
      invoice_ref: `PUR-${String(row.purchase_id).padStart(6, '0')}`,
    }));

    const returns = (returnsRows || []).map((row) => ({
      ...row,
      invoice_ref: row.return_number || `CN-${String(row.return_id).padStart(6, '0')}`,
    }));

    res.json({ purchases, sales: salesResult.rows, returns });
  } catch (error) {
    console.error('Error fetching product activity:', error);
    res.status(500).json({ error: 'Failed to fetch product activity', message: error.message });
  }
});

// Get single product by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shopId;
    const result = await db.query(
      `SELECT 
        p.product_id,
        p.name,
        p.item_name_english,
        p.item_name_urdu,
        p.sku,
        p.category,
        p.category_id,
        p.sub_category_id,
        p.purchase_price,
        p.selling_price,
        p.retail_price,
        p.wholesale_price,
        p.special_price,
        p.unit_type,
        p.is_frequently_sold,
        p.display_order,
        p.quantity_in_stock,
        p.supplier_id,
        s.name as supplier_name,
        c.category_name,
        sc.sub_category_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = $2
      LEFT JOIN categories c ON p.category_id = c.category_id AND c.shop_id = $2
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.sub_category_id
      WHERE p.product_id = $1 AND p.shop_id = $2`,
      [id, shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: 'Failed to fetch product', message: error.message });
  }
});

// Create new product
router.post('/', async (req, res) => {
  try {
    const shopId = req.shopId;
    const { 
      name, item_name_english, item_name_urdu, sku, category, category_id, sub_category_id,
      purchase_price, selling_price, retail_price, wholesale_price, special_price,
      unit_type, is_frequently_sold, display_order, quantity_in_stock, supplier_id 
    } = req.body;

    // Use item_name_english or name (backward compatibility)
    const englishName = item_name_english || name;
    if (!englishName || !englishName.trim()) {
      return res.status(400).json({ error: 'Product name (English) is required' });
    }
    
    if (purchase_price === undefined || purchase_price === null || purchase_price <= 0) {
      return res.status(400).json({ error: 'Purchase price must be greater than 0' });
    }
    
    // Set retail_price and wholesale_price (default to selling_price if not provided)
    const finalRetailPrice = retail_price || selling_price || 0;
    const finalWholesalePrice = wholesale_price || selling_price || retail_price || 0;
    
    if (finalRetailPrice <= 0) {
      return res.status(400).json({ error: 'Retail price must be greater than 0' });
    }
    
    if (quantity_in_stock === undefined || quantity_in_stock === null || quantity_in_stock < 0) {
      return res.status(400).json({ error: 'Quantity must be 0 or greater' });
    }

    // Auto-assign to General category if category_id is not provided (per shop)
    let finalCategoryId = category_id || null;
    if (!finalCategoryId) {
      const generalResult = await db.query(
        `SELECT category_id FROM categories 
         WHERE shop_id = $1 AND LOWER(TRIM(category_name)) = 'general' LIMIT 1`,
        [shopId]
      );
      
      if (generalResult.rows.length > 0) {
        finalCategoryId = generalResult.rows[0].category_id;
      } else {
        const createGeneral = await db.query(
          `INSERT INTO categories (category_name, status, shop_id) 
           VALUES ('General', 'active', $1) 
           RETURNING category_id`,
          [shopId]
        );
        finalCategoryId = createGeneral.rows[0].category_id;
      }
    }

    const result = await db.query(
      `INSERT INTO products (
        name, item_name_english, item_name_urdu, sku, category, category_id, sub_category_id,
        purchase_price, selling_price, retail_price, wholesale_price, special_price,
        unit_type, is_frequently_sold, display_order, quantity_in_stock, supplier_id, shop_id
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        englishName.trim(), englishName.trim(), item_name_urdu || null, sku || null, 
        category || null, finalCategoryId, sub_category_id || null,
        purchase_price, finalRetailPrice, finalRetailPrice, finalWholesalePrice, special_price || null,
        unit_type || 'piece', is_frequently_sold || false, display_order || 0, 
        quantity_in_stock || 0, supplier_id || null, shopId
      ]
    );

    // Fetch product with all fields
    const productResult = await db.query(
      `SELECT 
        p.product_id,
        p.name,
        p.item_name_english,
        p.item_name_urdu,
        p.sku,
        p.category,
        p.category_id,
        p.sub_category_id,
        p.purchase_price,
        p.selling_price,
        p.retail_price,
        p.wholesale_price,
        p.special_price,
        p.unit_type,
        p.is_frequently_sold,
        p.display_order,
        p.quantity_in_stock,
        p.supplier_id,
        s.name as supplier_name,
        c.category_name,
        sc.sub_category_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.supplier_id AND s.shop_id = $2
      LEFT JOIN categories c ON p.category_id = c.category_id AND c.shop_id = $2
      LEFT JOIN sub_categories sc ON p.sub_category_id = sc.sub_category_id
      WHERE p.product_id = $1 AND p.shop_id = $2`,
      [result.rows[0].product_id, shopId]
    );

    const created = productResult.rows[0];
    const createdSnap = normalizeProductAudit(created);
    await auditFromReq(req, {
      action: 'create',
      tableName: 'products',
      recordId: created.product_id,
      newValues: createdSnap,
      notes: buildProductCreateNotes(created),
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating product:', error);
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({ error: 'SKU already exists' });
    }
    res.status(500).json({ error: 'Failed to create product', message: error.message });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const shopId = req.shopId;
    const { id } = req.params;
    const { 
      name, item_name_english, item_name_urdu, sku, category, category_id, sub_category_id,
      purchase_price, selling_price, retail_price, wholesale_price, special_price,
      unit_type, is_frequently_sold, display_order, quantity_in_stock, supplier_id 
    } = req.body;

    // Use item_name_english or name (backward compatibility)
    const englishName = item_name_english || name;
    if (!englishName || !englishName.trim()) {
      return res.status(400).json({ error: 'Product name (English) is required' });
    }
    
    if (purchase_price === undefined || purchase_price === null || purchase_price <= 0) {
      return res.status(400).json({ error: 'Purchase price must be greater than 0' });
    }
    
    // Get existing product to preserve values if not provided
    const existingResult = await db.query(
      'SELECT * FROM products WHERE product_id = $1 AND shop_id = $2',
      [id, shopId]
    );
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const existing = existingResult.rows[0];
    
    const finalRetailPrice = retail_price || selling_price || existing.retail_price || 0;
    const finalWholesalePrice = wholesale_price || existing.wholesale_price || finalRetailPrice;
    
    if (finalRetailPrice <= 0) {
      return res.status(400).json({ error: 'Retail price must be greater than 0' });
    }
    
    if (quantity_in_stock === undefined || quantity_in_stock === null || quantity_in_stock < 0) {
      return res.status(400).json({ error: 'Quantity must be 0 or greater' });
    }

    // Auto-assign to General category if category_id is not provided or null
    let finalCategoryId = category_id || existing.category_id || null;
    if (!finalCategoryId) {
      const generalResult = await db.query(
        `SELECT category_id FROM categories 
         WHERE shop_id = $1 AND LOWER(TRIM(category_name)) = 'general' LIMIT 1`,
        [shopId]
      );
      
      if (generalResult.rows.length > 0) {
        finalCategoryId = generalResult.rows[0].category_id;
      } else {
        const createGeneral = await db.query(
          `INSERT INTO categories (category_name, status, shop_id) 
           VALUES ('General', 'active', $1) 
           RETURNING category_id`,
          [shopId]
        );
        finalCategoryId = createGeneral.rows[0].category_id;
      }
    }

    const result = await db.query(
      `UPDATE products 
       SET name = $1, item_name_english = $2, item_name_urdu = $3, sku = $4, category = $5,
           category_id = $6, sub_category_id = $7, purchase_price = $8, 
           selling_price = $9, retail_price = $10, wholesale_price = $11, special_price = $12,
           unit_type = $13, is_frequently_sold = $14, display_order = $15,
           quantity_in_stock = $16, supplier_id = $17
       WHERE product_id = $18 AND shop_id = $19
       RETURNING *`,
      [
        englishName.trim(), englishName.trim(), item_name_urdu || null, sku || null,
        category || null, finalCategoryId, sub_category_id || null,
        purchase_price, finalRetailPrice, finalRetailPrice, finalWholesalePrice, special_price || null,
        unit_type || existing.unit_type || 'piece', 
        is_frequently_sold !== undefined ? is_frequently_sold : existing.is_frequently_sold,
        display_order !== undefined ? display_order : existing.display_order,
        quantity_in_stock || 0, supplier_id || null, id, shopId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const updatedRow = result.rows[0];
    const oldSnap = normalizeProductAudit(existing);
    const newSnap = normalizeProductAudit(updatedRow);
    await auditFromReq(req, {
      action: 'update',
      tableName: 'products',
      recordId: parseInt(id, 10),
      oldValues: oldSnap,
      newValues: newSnap,
      notes: buildProductChangeNotes(oldSnap, newSnap),
    });

    res.json(updatedRow);
  } catch (error) {
    console.error('Error updating product:', error);
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({ error: 'SKU already exists' });
    }
    res.status(500).json({ error: 'Failed to update product', message: error.message });
  }
});

// Delete product
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const shopId = req.shopId;
    
    const existingResult = await db.query(
      `SELECT product_id, item_name_english, name, sku, purchase_price, retail_price,
              selling_price, wholesale_price, special_price, quantity_in_stock
       FROM products WHERE product_id = $1 AND shop_id = $2`,
      [id, shopId]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const existingProduct = existingResult.rows[0];
    const oldSnap = normalizeProductAudit(existingProduct);

    const result = await db.query(
      'DELETE FROM products WHERE product_id = $1 AND shop_id = $2 RETURNING product_id',
      [id, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await auditFromReq(req, {
      action: 'delete',
      tableName: 'products',
      recordId: parseInt(id, 10),
      oldValues: oldSnap,
      notes: buildProductDeleteNotes(existingProduct),
    });

    res.json({ message: 'Product deleted successfully', product_id: id });
  } catch (error) {
    console.error('Error deleting product:', error);
    if (error.code === '23503') { // Foreign key constraint violation
      return res.status(400).json({ error: 'Cannot delete product: it is referenced in sales or purchases' });
    }
    res.status(500).json({ error: 'Failed to delete product', message: error.message });
  }
});

/** Bulk import products from parsed CSV rows (frontend sends JSON). */
router.post('/import-bulk', async (req, res) => {
  const shopId = req.shopId;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) {
    return res.status(400).json({ error: 'No rows to import' });
  }
  if (rows.length > 2000) {
    return res.status(400).json({ error: 'Maximum 2000 products per import' });
  }

  const preview = [];
  const toInsert = [];
  const client = await db.getClient();

  try {
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i] || {};
      const name = String(r.name || r.Name || '').trim();
      const sku = r.sku != null ? String(r.sku).trim() : '';
      const category = String(r.category || r.Category || 'General').trim() || 'General';
      const unit = String(r.unit || r.Unit || 'piece').trim() || 'piece';
      const selling = parseFloat(r.selling_price ?? r['Selling Price'] ?? r.selling);
      const wholesale = parseFloat(r.wholesale_price ?? r['Wholesale Price'] ?? selling);
      const stock = parseFloat(r.opening_stock ?? r['Opening Stock'] ?? 0);

      const errors = [];
      if (!name) errors.push('Name is required');
      if (!Number.isFinite(selling) || selling < 0) errors.push('Invalid selling price');
      if (!Number.isFinite(wholesale) || wholesale < 0) errors.push('Invalid wholesale price');
      if (!Number.isFinite(stock) || stock < 0) errors.push('Invalid opening stock');

      preview.push({ row: i + 1, name, sku, category, unit, selling_price: selling, wholesale_price: wholesale, opening_stock: stock, errors });
      if (!errors.length) {
        toInsert.push({ name, sku, category, unit, selling, wholesale, stock });
      }
    }

    if (req.body?.previewOnly) {
      return res.json({ preview, validCount: toInsert.length, errorCount: preview.length - toInsert.length });
    }

    if (!toInsert.length) {
      return res.status(400).json({ error: 'No valid rows', preview });
    }

    await client.query('BEGIN');
    let created = 0;
    for (const row of toInsert) {
      let finalCategoryId = null;
      const catRes = await client.query(
        `SELECT category_id FROM categories WHERE shop_id = $1 AND LOWER(TRIM(category_name)) = LOWER($2) LIMIT 1`,
        [shopId, row.category]
      );
      if (catRes.rows.length) {
        finalCategoryId = catRes.rows[0].category_id;
      } else {
        const ins = await client.query(
          `INSERT INTO categories (category_name, status, shop_id) VALUES ($1,'active',$2) RETURNING category_id`,
          [row.category, shopId]
        );
        finalCategoryId = ins.rows[0].category_id;
      }

      await client.query(
        `INSERT INTO products (
          name, item_name_english, sku, category, category_id,
          purchase_price, selling_price, retail_price, wholesale_price,
          unit_type, quantity_in_stock, shop_id
        ) VALUES ($1,$1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)`,
        [
          row.name,
          row.sku || null,
          row.category,
          finalCategoryId,
          row.wholesale,
          row.selling,
          row.wholesale,
          row.unit,
          row.stock,
          shopId,
        ]
      );
      created += 1;
    }
    await client.query('COMMIT');
    if (created > 0) {
      await auditFromReq(req, {
        action: 'create',
        tableName: 'products',
        newValues: { import_count: created },
        notes: `Imported ${created} product(s) from spreadsheet`,
      });
    }
    res.status(201).json({ ok: true, created, preview });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[products] import-bulk:', e);
    res.status(500).json({ error: e.message || 'Import failed', preview });
  } finally {
    client.release();
  }
});

module.exports = router;

