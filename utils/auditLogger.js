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
  action,
  tableName = null,
  recordId = null,
  oldValues = null,
  newValues = null,
  ipAddress = null,
  userAgent = null,
  notes = null
}) {
  try {
    await db.query(`
      INSERT INTO audit_logs (
        user_id, action, table_name, record_id, 
        old_values, new_values, ip_address, user_agent, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      userId,
      action,
      tableName,
      recordId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress,
      userAgent,
      notes
    ]);
  } catch (error) {
    // Don't throw - audit logging should never break the application
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
 * Log user login
 */
async function logLogin(userId, ipAddress, userAgent, success = true) {
  await logAuditEvent({
    userId: success ? userId : null,
    action: success ? 'login' : 'login_failed',
    notes: success ? 'User logged in successfully' : 'Failed login attempt',
    ipAddress,
    userAgent
  });
}

/**
 * Log user logout
 */
async function logLogout(userId, ipAddress, userAgent) {
  await logAuditEvent({
    userId,
    action: 'logout',
    notes: 'User logged out',
    ipAddress,
    userAgent
  });
}

/**
 * Log sensitive data access (profit, reports, etc.)
 */
async function logSensitiveAccess(userId, resource, ipAddress, userAgent) {
  await logAuditEvent({
    userId,
    action: 'view_sensitive',
    tableName: resource,
    notes: `Accessed sensitive resource: ${resource}`,
    ipAddress,
    userAgent
  });
}

module.exports = {
  logAuditEvent,
  auditMiddleware,
  logLogin,
  logLogout,
  logSensitiveAccess,
};


