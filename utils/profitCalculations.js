/**
 * Signed sales / COGS helpers — credit notes (returns) count as negative revenue & cost.
 */

/** SQL: -1 for return rows, else +1 */
function saleSignFactor(sAlias = 's') {
  return `(CASE WHEN COALESCE(${sAlias}.sale_kind, 'sale') = 'return' OR ${sAlias}.invoice_number ILIKE 'CN-%' THEN -1 ELSE 1 END)`;
}

/** SQL: line net revenue (qty × price − line_discount) */
function lineNetRevenueSql(siAlias = 'si') {
  return `(COALESCE(${siAlias}.quantity, 0) * COALESCE(${siAlias}.selling_price, 0) - COALESCE(${siAlias}.line_discount, 0))`;
}

/** SQL: line COGS */
function lineCogsSql(siAlias = 'si', pAlias = 'p') {
  return `(COALESCE(${siAlias}.purchase_price, ${pAlias}.purchase_price, 0) * COALESCE(${siAlias}.quantity, 0))`;
}

module.exports = {
  saleSignFactor,
  lineNetRevenueSql,
  lineCogsSql,
};
