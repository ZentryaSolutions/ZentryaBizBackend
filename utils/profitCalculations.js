/**
 * Signed sales / COGS helpers — credit notes (returns) count as negative revenue & cost.
 */

function colRef(alias, column) {
  return alias ? `${alias}.${column}` : column;
}

/** SQL: -1 for return rows, else +1 (alias optional — use '' for unaliased `sales`). */
function saleSignFactor(sAlias = 's') {
  const kind = colRef(sAlias, 'sale_kind');
  const inv = colRef(sAlias, 'invoice_number');
  return `(CASE WHEN COALESCE(${kind}, 'sale') = 'return' OR ${inv} ILIKE 'CN-%' THEN -1 ELSE 1 END)`;
}

/** Same as saleSignFactor but only CN- invoices — safe when `sale_kind` column is missing. */
function saleSignFactorSafe(sAlias = 's') {
  const inv = colRef(sAlias, 'invoice_number');
  return `(CASE WHEN ${inv} ILIKE 'CN-%' THEN -1 ELSE 1 END)`;
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
  saleSignFactorSafe,
  lineNetRevenueSql,
  lineCogsSql,
};
