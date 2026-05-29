/**
 * Audit Logging Utility
 * Logs all sensitive operations for security and compliance
 */

const db = require('../db');

/**
 * Log an audit event
 * @param {Object} params - Audit log parameters
 * @param {number} params.userId - User ID (null if not authenticated)
 * @param {string} params.action - Action type ('create', 'update', 'delete', 'view', 'login', 'logout', etc.)
 * @param {string} params.tableName - Table name (optional)
 * @param {number} params.recordId - Record ID (optional)
 * @param {Object} params.oldValues - Old values (for updates/deletes)
 * @param {Object} params.newValues - New values (for creates/updates)
 * @param {string} params.ipAddress - IP address (optional)
 * @param {string} params.userAgent - User agent (optional)
 * @param {string} params.notes - Additional notes (optional)
 */
async function logAuditEvent({
  userId = null,
  shopId = null,
  action,
  tableName = null,
  recordId = null,
  oldValues = null,
  newValues = null,
  ipAddress = null,
  userAgent = null,
  notes = null,
}) {
  const baseParams = [
    userId,
    action,
    tableName,
    recordId,
    oldValues ? JSON.stringify(oldValues) : null,
    newValues ? JSON.stringify(newValues) : null,
    ipAddress,
    userAgent,
    notes,
  ];

  try {
    await db.query(
      `INSERT INTO audit_logs (
        user_id, action, table_name, record_id,
        old_values, new_values, ip_address, user_agent, notes, shop_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [...baseParams, shopId]
    );
  } catch (error) {
    if (error.code === '42703') {
      try {
        await db.query(
          `INSERT INTO audit_logs (
            user_id, action, table_name, record_id,
            old_values, new_values, ip_address, user_agent, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          baseParams
        );
        return;
      } catch (fallbackErr) {
        console.error('[Audit Log] Error logging audit event:', fallbackErr);
        return;
      }
    }
    console.error('[Audit Log] Error logging audit event:', error);
  }
}

/**
 * Middleware to automatically log requests
 * Should be used after authentication middleware
 */
function auditMiddleware(req, res, next) {
  // Store original res.json to intercept responses
  const originalJson = res.json.bind(res);
  
  res.json = function(data) {
    // Log the request after response is sent
    setImmediate(async () => {
      const userId = req.user?.user_id || null;
      const action = getActionFromRequest(req);
      const tableName = getTableNameFromPath(req.path);
      
      await logAuditEvent({
        userId,
        action,
        tableName,
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent'),
        notes: `API ${req.method} ${req.path}`
      });
    });
    
    return originalJson(data);
  };
  
  next();
}

/**
 * Get action type from request
 */
function getActionFromRequest(req) {
  const method = req.method.toUpperCase();
  const path = req.path.toLowerCase();
  
  if (path.includes('login')) return 'login';
  if (path.includes('logout')) return 'logout';
  if (path.includes('create') || path.includes('add')) return 'create';
  if (path.includes('update') || path.includes('edit')) return 'update';
  if (path.includes('delete') || path.includes('remove')) return 'delete';
  if (method === 'GET') return 'view';
  if (method === 'POST') return 'create';
  if (method === 'PUT' || method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';
  
  return 'unknown';
}

/**
 * Get table name from API path
 */
function getTableNameFromPath(path) {
  // Extract table name from path like /api/products -> products
  const match = path.match(/\/api\/([^\/]+)/);
  return match ? match[1] : null;
}

/**
 * Log user login / sign-in (shop-scoped when shopId provided).
 * @param {object} [options] — { shopId, userName, method, attemptedUser }
 */
async function logLogin(userId, ipAddress, userAgent, success = true, options = {}) {
  const {
    shopId = null,
    userName = null,
    method = null,
    attemptedUser = null,
  } = options;

  const methodLabel = method ? String(method) : null;
  let notes;
  if (success) {
    const who = userName || (userId ? `User #${userId}` : 'User');
    notes = methodLabel ? `${who} signed in (${methodLabel})` : `${who} signed in`;
  } else {
    const attempt = attemptedUser ? ` for "${attemptedUser}"` : '';
    notes = methodLabel
      ? `Failed sign-in (${methodLabel})${attempt}`
      : `Failed sign-in attempt${attempt}`;
  }

  await logAuditEvent({
    userId: success ? userId : null,
    shopId,
    action: success ? 'login' : 'login_failed',
    tableName: 'auth',
    notes,
    newValues: success && userName ? { user_name: userName, method: methodLabel } : null,
    ipAddress,
    userAgent,
  });
}

/**
 * Log user logout
 */
async function logLogout(userId, ipAddress, userAgent, options = {}) {
  const { shopId = null, userName = null } = options;
  const who = userName || (userId ? `User #${userId}` : 'User');
  await logAuditEvent({
    userId,
    shopId,
    action: 'logout',
    tableName: 'auth',
    notes: `${who} signed out`,
    ipAddress,
    userAgent,
  });
}

const RESOURCE_VIEW_LABELS = {
  users: 'Users & staff',
  audit: 'Audit history',
  audit_logs: 'Audit history',
  reports: 'Reports',
  profit: 'Profit report',
  dashboard: 'Dashboard',
  settings: 'Settings',
};

/**
 * Log read-only access to admin screens or reports (descriptive notes for audit UI).
 * @param {string} resource — module key (stored in table_name)
 * @param {object|string} [options] — { description, shopId, context, meta }
 */
async function logSensitiveAccess(userId, resource, ipAddress, userAgent, options = {}) {
  const opts = typeof options === 'string' ? { description: options } : options || {};
  const { description, shopId = null, context = null, meta = null } = opts;

  let notes = description;
  if (!notes) {
    const label = RESOURCE_VIEW_LABELS[resource] || String(resource || 'page').replace(/_/g, ' ');
    notes =
      context === 'audit_filter'
        ? `Loaded ${label} for audit filters`
        : `Opened ${label}`;
    if (meta?.user_count != null) notes += ` (${meta.user_count} users)`;
    else if (meta?.count != null) notes += ` (${meta.count} records)`;
    else if (meta?.period) notes += ` — ${meta.period}`;
  }

  await logAuditEvent({
    userId,
    shopId,
    action: 'view',
    tableName: resource,
    newValues: meta && typeof meta === 'object' ? meta : null,
    notes,
    ipAddress,
    userAgent,
  });
}

module.exports = {
  logAuditEvent,
  auditMiddleware,
  logLogin,
  logLogout,
  logSensitiveAccess,
};


