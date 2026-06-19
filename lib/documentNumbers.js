const db = require('../db');

async function readMaxSeq(q, sql, params) {
  const result = await q.query(sql, params);
  return parseInt(result.rows[0]?.max_seq, 10) || 0;
}

function formatNumber(prefix, seq, padWidth) {
  return `${prefix}${String(seq).padStart(padWidth, '0')}`;
}

/** Serialize per-shop document numbering for the duration of the current transaction. */
async function lockShopDocumentNumbers(client, shopId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [String(shopId)]);
}

/** Next sale invoice in INV-YYYY-NNNN (continues legacy Bill-NNNN when no INV rows exist). */
async function generateInvoiceNumber(shopId, client) {
  const q = client || db;
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;

  try {
    const invMax = await readMaxSeq(
      q,
      `SELECT COALESCE(MAX(
         (regexp_match(invoice_number, 'INV-' || $2::text || '-(\\d+)', 'i'))[1]::int
       ), 0) AS max_seq
       FROM sales
       WHERE shop_id = $1
         AND invoice_number ~* ('^INV-' || $2::text || '-\\d+$')
         AND lower(COALESCE(sale_kind, '')) <> 'return'
         AND invoice_number NOT ILIKE 'CN-%'`,
      [shopId, year]
    );
    let nextSeq = invMax + 1;

    if (nextSeq <= 1) {
      const billMax = await readMaxSeq(
        q,
        `SELECT COALESCE(MAX(
           (regexp_match(invoice_number, 'Bill-(\\d+)', 'i'))[1]::int
         ), 0) AS max_seq
         FROM sales
         WHERE shop_id = $1
           AND invoice_number ~* '^Bill-\\d+$'
           AND lower(COALESCE(sale_kind, '')) <> 'return'`,
        [shopId]
      );
      if (billMax > 0) nextSeq = billMax + 1;
    }

    return formatNumber(prefix, nextSeq, 4);
  } catch (error) {
    console.error('[documentNumbers] invoice:', error);
    return `${prefix}0001`;
  }
}

/** Next credit note CN-NNNNN — checks sales + sales_returns so sequences never reset. */
async function generateCreditNoteNumber(shopId, client) {
  const q = client || db;

  try {
    const salesMax = await readMaxSeq(
      q,
      `SELECT COALESCE(MAX(
         (regexp_match(invoice_number, 'CN-(\\d+)', 'i'))[1]::int
       ), 0) AS max_seq
       FROM sales
       WHERE shop_id = $1 AND invoice_number ~* '^CN-\\d+$'`,
      [shopId]
    );

    let returnsMax = 0;
    try {
      returnsMax = await readMaxSeq(
        q,
        `SELECT COALESCE(MAX(
           (regexp_match(return_number, 'CN-(\\d+)', 'i'))[1]::int
         ), 0) AS max_seq
         FROM sales_returns
         WHERE shop_id = $1 AND return_number ~* '^CN-\\d+$'`,
        [shopId]
      );
    } catch (error) {
      if (error.code !== '42P01') throw error;
    }

    return formatNumber('CN-', Math.max(salesMax, returnsMax) + 1, 5);
  } catch (error) {
    console.error('[documentNumbers] credit note:', error);
    return 'CN-00001';
  }
}

/** Next support ticket ST-NNNNN from max existing ticket_number in the shop. */
async function generateSupportTicketNumber(shopId, client) {
  const q = client || db;
  const max = await readMaxSeq(
    q,
    `SELECT COALESCE(MAX(
       (regexp_match(ticket_number, 'ST-(\\d+)', 'i'))[1]::int
     ), 0) AS max_seq
     FROM support_tickets
     WHERE shop_id = $1 AND ticket_number ~ '^ST-[0-9]+$'`,
    [shopId]
  );
  return formatNumber('ST-', max + 1, 5);
}

module.exports = {
  lockShopDocumentNumbers,
  generateInvoiceNumber,
  generateCreditNoteNumber,
  generateSupportTicketNumber,
};
