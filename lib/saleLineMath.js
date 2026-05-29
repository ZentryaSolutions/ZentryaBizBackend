/**
 * Sale line revenue / discount / profit helpers.
 */

function lineGross(quantity, unitPrice) {
  const q = parseFloat(quantity) || 0;
  const p = parseFloat(unitPrice) || 0;
  return q * p;
}

function parseLineDiscount(item, gross) {
  const d = Math.max(0, parseFloat(item?.line_discount) || 0);
  if (d > gross + 0.02) {
    throw new Error('Line discount cannot exceed line total');
  }
  return Math.round(d * 100) / 100;
}

function lineNetRevenue(quantity, unitPrice, lineDiscount) {
  return Math.max(0, lineGross(quantity, unitPrice) - (parseFloat(lineDiscount) || 0));
}

function lineProfit(quantity, unitPrice, purchasePrice, lineDiscount) {
  const q = parseFloat(quantity) || 0;
  const pp = parseFloat(purchasePrice) || 0;
  return lineNetRevenue(q, unitPrice, lineDiscount) - pp * q;
}

async function insertSaleItemRow(client, row) {
  const {
    saleId,
    productId,
    quantity,
    sellingPrice,
    purchasePrice,
    profit,
    lineDiscount = 0,
  } = row;
  const base = [saleId, productId, quantity, sellingPrice, purchasePrice, profit];
  await client.query('SAVEPOINT sp_sale_item_ins');
  try {
    await client.query(
      `INSERT INTO sale_items (sale_id, product_id, quantity, selling_price, purchase_price, profit, line_discount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [...base, lineDiscount]
    );
    await client.query('RELEASE SAVEPOINT sp_sale_item_ins');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_sale_item_ins');
    if (e.code !== '42703') throw e;
    await client.query(
      `INSERT INTO sale_items (sale_id, product_id, quantity, selling_price, purchase_price, profit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      base
    );
  }
}

module.exports = {
  lineGross,
  parseLineDiscount,
  lineNetRevenue,
  lineProfit,
  insertSaleItemRow,
};
