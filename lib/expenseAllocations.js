/**
 * Expense ↔ product allocation helpers (daily_expenses + expense_product_allocations).
 */

async function tableExists(client, tableName) {
  const q = client || require('../db');
  const r = await q.query(`SELECT to_regclass($1) AS reg`, [`public.${tableName}`]);
  return Boolean(r.rows[0]?.reg);
}

function parseAllocationsInput(body, totalAmount) {
  const amt = parseFloat(totalAmount);
  if (!amt || amt <= 0) return { error: 'Amount must be greater than 0' };

  const lines = [];
  if (Array.isArray(body?.product_allocations) && body.product_allocations.length) {
    for (const row of body.product_allocations) {
      const pid = parseInt(row.product_id, 10);
      const lineAmt = parseFloat(row.amount);
      if (!pid || !lineAmt || lineAmt <= 0) continue;
      lines.push({ product_id: pid, amount: lineAmt });
    }
  } else if (body?.product_id != null && String(body.product_id).trim() !== '') {
    const pid = parseInt(body.product_id, 10);
    if (pid) lines.push({ product_id: pid, amount: amt });
  }

  if (!lines.length) {
    return { lines: [], scope: 'shop' };
  }

  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (Math.abs(sum - amt) > 0.02) {
    return { error: `Product allocation total (${sum.toFixed(2)}) must equal expense amount (${amt.toFixed(2)})` };
  }

  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.product_id)) return { error: 'Duplicate product in allocation' };
    seen.add(l.product_id);
  }

  return { lines, scope: 'product' };
}

async function assertProductsInShop(client, shopId, productIds) {
  if (!productIds.length) return;
  const r = await client.query(
    `SELECT product_id FROM products WHERE shop_id = $1 AND product_id = ANY($2::int[])`,
    [shopId, productIds]
  );
  if (r.rows.length !== productIds.length) {
    throw new Error('One or more products were not found in this shop');
  }
}

async function replaceAllocations(client, expenseId, shopId, lines) {
  const hasTable = await tableExists(client, 'expense_product_allocations');
  if (!hasTable) {
    if (lines.length) {
      throw new Error('Run database/migrations/014_expense_product_allocations.sql in Supabase first');
    }
    return;
  }

  await client.query(`DELETE FROM expense_product_allocations WHERE expense_id = $1`, [expenseId]);
  for (const line of lines) {
    await client.query(
      `INSERT INTO expense_product_allocations (expense_id, product_id, amount, shop_id)
       VALUES ($1, $2, $3, $4)`,
      [expenseId, line.product_id, line.amount, shopId]
    );
  }
}

async function loadAllocationsForExpenses(client, expenseIds) {
  if (!expenseIds.length) return new Map();
  const hasTable = await tableExists(client, 'expense_product_allocations');
  if (!hasTable) return new Map();

  const r = await client.query(
    `SELECT a.expense_id, a.product_id, a.amount::float AS amount,
            COALESCE(p.item_name_english, p.name) AS product_name
     FROM expense_product_allocations a
     JOIN products p ON p.product_id = a.product_id AND p.shop_id = a.shop_id
     WHERE a.expense_id = ANY($1::int[])
     ORDER BY a.product_id`,
    [expenseIds]
  );
  const map = new Map();
  for (const row of r.rows) {
    const id = row.expense_id;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({
      product_id: row.product_id,
      amount: parseFloat(row.amount) || 0,
      product_name: row.product_name,
    });
  }
  return map;
}

const EXPENSE_LIST_SQL = `
  SELECT e.*
  FROM daily_expenses e
  WHERE e.shop_id = $1
`;

async function attachAllocationsToRows(client, rows) {
  const ids = rows.map((r) => r.expense_id);
  const map = await loadAllocationsForExpenses(client, ids);
  return rows.map((row) => ({
    ...row,
    product_allocations: map.get(row.expense_id) || [],
  }));
}

module.exports = {
  parseAllocationsInput,
  assertProductsInShop,
  replaceAllocations,
  loadAllocationsForExpenses,
  attachAllocationsToRows,
  tableExists,
  EXPENSE_LIST_SQL,
};
