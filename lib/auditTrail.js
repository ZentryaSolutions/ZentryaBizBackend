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
};
