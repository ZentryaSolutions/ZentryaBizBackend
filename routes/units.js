const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');

router.use(requireAuth);
router.use(requireShopContext);

async function ensureDefaultUnits(shopId) {
  try {
    const exists = await db.query('SELECT unit_id FROM units_of_measure WHERE shop_id = $1 LIMIT 1', [String(shopId)]);
    if ((exists.rows || []).length) return;
    const defaults = [
      { code: 'pcs', name: 'Pieces' },
      { code: 'm', name: 'Meter' },
      { code: 'kg', name: 'Kilogram' },
      { code: 'L', name: 'Litre' },
      { code: 'box', name: 'Box' },
      { code: 'dozen', name: 'Dozen' },
    ];
    await Promise.all(
      defaults.map((u) =>
        db.query(
          `INSERT INTO units_of_measure (shop_id, unit_code, unit_name, status)
           VALUES ($1, $2, $3, 'active')
           ON CONFLICT (shop_id, (lower(unit_code))) DO NOTHING`,
          [String(shopId), u.code.trim(), u.name.trim()]
        )
      )
    );
  } catch (e) {
    console.warn('[units] default seed failed:', e.message);
  }
}

// Read (cashiers/admins)
router.get('/', async (req, res) => {
  try {
    await ensureDefaultUnits(req.shopId);
    const r = await db.query(
      `SELECT unit_id, unit_code, unit_name, status, created_at
       FROM units_of_measure
       WHERE shop_id = $1
       ORDER BY LOWER(unit_name) ASC`,
      [String(req.shopId)]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch units', message: e.message });
  }
});

// Create (admin only)
router.post('/', requireRole('administrator'), async (req, res) => {
  try {
    const { unit_code, unit_name, status } = req.body || {};
    const code = String(unit_code || '').trim();
    const name = String(unit_name || '').trim();
    if (!code || !name) return res.status(400).json({ error: 'Unit code and name are required' });

    const r = await db.query(
      `INSERT INTO units_of_measure (shop_id, unit_code, unit_name, status)
       VALUES ($1, $2, $3, $4)
       RETURNING unit_id, unit_code, unit_name, status, created_at`,
      [String(req.shopId), code, name, status || 'active']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Unit already exists' });
    res.status(500).json({ error: 'Failed to create unit', message: e.message });
  }
});

// Update (admin only)
router.put('/:id', requireRole('administrator'), async (req, res) => {
  try {
    const { id } = req.params;
    const { unit_code, unit_name, status } = req.body || {};
    const code = String(unit_code || '').trim();
    const name = String(unit_name || '').trim();
    if (!code || !name) return res.status(400).json({ error: 'Unit code and name are required' });

    const r = await db.query(
      `UPDATE units_of_measure
       SET unit_code = $1, unit_name = $2, status = $3
       WHERE unit_id = $4 AND shop_id = $5
       RETURNING unit_id, unit_code, unit_name, status, created_at`,
      [code, name, status || 'active', id, String(req.shopId)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unit not found' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Unit already exists' });
    res.status(500).json({ error: 'Failed to update unit', message: e.message });
  }
});

// Delete (admin only)
router.delete('/:id', requireRole('administrator'), async (req, res) => {
  try {
    const { id } = req.params;
    const r = await db.query('DELETE FROM units_of_measure WHERE unit_id = $1 AND shop_id = $2 RETURNING unit_id', [
      id,
      String(req.shopId),
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Unit not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete unit', message: e.message });
  }
});

module.exports = router;

