/**
 * Structured audit logging for admin review (shop-scoped).
 */

const { logAuditEvent } = require('../utils/auditLogger');

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'pin',
  'pin_hash',
  'token',
  'refresh_token',
  'secret',
]);

const PRODUCT_FIELD_LABELS = {
  item_name_english: 'Product name',
  sku: 'SKU',
  purchase_price: 'Purchase price',
  retail_price: 'Retail price',
  wholesale_price: 'Wholesale price',
  special_price: 'Special price',
  quantity_in_stock: 'Stock quantity',
};

function sanitizeForAudit(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeForAudit(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(String(k).toLowerCase())) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitizeForAudit(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) {
    return `${value.slice(0, 500)}…`;
  }
  return value;
}

function pickFields(obj, keys) {
  if (!obj || !keys?.length) return null;
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return Object.keys(out).length ? out : null;
}

function fmtAuditMoney(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return v == null || v === '' ? '—' : String(v);
  return `PKR ${n.toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 0.0001;
  return String(a ?? '') === String(b ?? '');
}

/** Normalize product row for before/after audit snapshots. */
function normalizeProductAudit(row) {
  if (!row) return {};
  const retail = row.retail_price ?? row.selling_price ?? null;
  return {
    product_id: row.product_id,
    item_name_english: row.item_name_english || row.name || null,
    sku: row.sku || null,
    purchase_price: row.purchase_price,
    retail_price: retail,
    wholesale_price: row.wholesale_price ?? null,
    special_price: row.special_price ?? null,
    quantity_in_stock: row.quantity_in_stock,
  };
}

/** Human-readable one-line summary of product field changes. */
function buildProductChangeNotes(oldV, newV) {
  const name = newV?.item_name_english || oldV?.item_name_english || 'Product';
  const pid = newV?.product_id || oldV?.product_id;
  const head = pid ? `${name} (#${pid})` : name;
  const changes = [];

  for (const [key, label] of Object.entries(PRODUCT_FIELD_LABELS)) {
    const o = oldV?.[key];
    const n = newV?.[key];
    if (valuesEqual(o, n)) continue;
    if (key.includes('price')) {
      changes.push(`${label}: ${fmtAuditMoney(o)} → ${fmtAuditMoney(n)}`);
    } else {
      changes.push(`${label}: ${o ?? '—'} → ${n ?? '—'}`);
    }
  }

  if (!changes.length) return `Updated ${head} (no tracked field changes)`;
  return `${head}: ${changes.join('; ')}`;
}

function buildProductCreateNotes(row) {
  const snap = normalizeProductAudit(row);
  const name = snap.item_name_english || 'Product';
  return `Added product "${name}" — purchase ${fmtAuditMoney(snap.purchase_price)}, retail ${fmtAuditMoney(snap.retail_price)}, stock ${snap.quantity_in_stock ?? 0}`;
}

function buildProductDeleteNotes(row) {
  const snap = normalizeProductAudit(row);
  const name = snap.item_name_english || 'Product';
  const sku = snap.sku ? `, SKU ${snap.sku}` : '';
  return `Deleted product "${name}"${sku} — last purchase ${fmtAuditMoney(snap.purchase_price)}, retail ${fmtAuditMoney(snap.retail_price)}, stock ${snap.quantity_in_stock ?? 0}`;
}

/**
 * Log from an authenticated shop request.
 */
async function auditFromReq(req, {
  action,
  tableName = null,
  recordId = null,
  oldValues = null,
  newValues = null,
  notes = null,
}) {
  if (!action) return;
  await logAuditEvent({
    userId: req.user?.user_id ?? null,
    shopId: req.shopId ?? null,
    action,
    tableName,
    recordId: recordId != null ? Number(recordId) || recordId : null,
    oldValues: oldValues ? sanitizeForAudit(oldValues) : null,
    newValues: newValues ? sanitizeForAudit(newValues) : null,
    ipAddress: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get?.('user-agent') || null,
    notes,
  });
}

module.exports = {
  auditFromReq,
  sanitizeForAudit,
  pickFields,
  normalizeProductAudit,
  buildProductChangeNotes,
  buildProductCreateNotes,
  buildProductDeleteNotes,
  PRODUCT_FIELD_LABELS,
  fmtAuditMoney,
};
