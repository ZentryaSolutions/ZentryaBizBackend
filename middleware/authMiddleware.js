/**
 * Authentication Middleware
 * Handles user authentication and session management
 */

const db = require('../db');
const mockSessions = require('../utils/mockSessions');
const { verifyPassword, verifyPIN } = require('../utils/authUtils');
const deviceFingerprint = require('../utils/deviceFingerprint');

/**
 * Middleware to check if user is authenticated
 * Attaches user info to req.user if authenticated
 */
async function requireAuth(req, res, next) {
  try {
    // Get session ID from header or cookie
    const sessionId = req.headers['x-session-id'] || req.cookies?.sessionId;
    
    if (!sessionId) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please log in to access this resource'
      });
    }

    // Verify session
    const session = await verifySession(sessionId);
    
    if (!session || !session.isValid) {
      return res.status(401).json({
        error: 'Invalid session',
        message: 'Your session has expired. Please log in again.'
      });
    }

    // Attach user info to request
    req.user = session.user;
    req.sessionId = sessionId;
    
    // Note: User ID is available in req.user.user_id for audit logging
    next();
  } catch (error) {
    console.error('[Auth Middleware] Error checking authentication:', error);
    return res.status(500).json({
      error: 'Authentication error',
      message: 'An error occurred while checking authentication'
    });
  }
}

/**
 * Roles that count as shop owner / full admin in API checks.
 * zb-simple-session used `admin`; legacy uses `administrator`; profiles may use `owner`.
 * Compare case-insensitively — Postgres / clients sometimes vary casing or add spaces.
 */
const ELEVATED_ROLE_KEYS = new Set(['administrator', 'admin', 'owner', 'superadmin']);

function normalizeRoleKey(role) {
  if (role == null || role === undefined) return '';
  return String(role).trim().toLowerCase();
}

/**
 * Middleware to check if user has required role
 * Must be used after requireAuth
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please log in to access this resource'
      });
    }

    const r = normalizeRoleKey(req.user.role);
    const needsAdministrator = allowedRoles.some((a) => normalizeRoleKey(a) === 'administrator');
    const userIsElevated = ELEVATED_ROLE_KEYS.has(r);

    if (needsAdministrator && userIsElevated) {
      return next();
    }

    const allowedKeys = new Set(allowedRoles.map((a) => normalizeRoleKey(a)));
    if (allowedKeys.has(r)) {
      return next();
    }

    return res.status(403).json({
      error: 'Access denied',
      message: 'You do not have permission to access this resource',
      detail: process.env.NODE_ENV === 'development' ? `Your API role is "${req.user.role}" (expected admin).` : undefined,
    });
  };
}

/** Supabase profile roles that may manage staff / settings when users.role is out of sync (e.g. salesman row + owner profile). */
const PROFILE_OWNER_ADMIN_KEYS = new Set(['owner', 'admin']);

/**
 * Same as requireRole('administrator') for elevated API users, but also allows access when
 * users.zb_profile_id → public.profiles.role is owner or admin (matches frontend isAdmin()).
 * Use on routes that must align with Zentrya profile role, not only legacy users.role.
 */
async function requireAdministratorOrProfileOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
    });
  }

  const r = normalizeRoleKey(req.user.role);
  if (ELEVATED_ROLE_KEYS.has(r)) {
    return next();
  }

  if (!db.isDatabaseConfigured()) {
    return res.status(403).json({
      error: 'Access denied',
      message: 'You do not have permission to access this resource',
      detail: process.env.NODE_ENV === 'development' ? `Your API role is "${req.user.role}" (expected admin).` : undefined,
    });
  }

  try {
    const result = await db.query(
      `SELECT lower(trim(p.role::text)) AS pr
       FROM users u
       JOIN public.profiles p ON p.id = u.zb_profile_id
       WHERE u.user_id = $1 AND u.is_active = true`,
      [req.user.user_id]
    );
    const pr = result.rows[0]?.pr || '';
    if (PROFILE_OWNER_ADMIN_KEYS.has(pr)) {
      return next();
    }
  } catch (e) {
    console.error('[requireAdministratorOrProfileOwner]', e);
    return res.status(500).json({
      error: 'Authorization error',
      message: 'Could not verify account role.',
    });
  }

  return res.status(403).json({
    error: 'Access denied',
    message: 'You do not have permission to access this resource',
    detail: process.env.NODE_ENV === 'development' ? `Your API role is "${req.user.role}" (expected admin).` : undefined,
  });
}

/**
 * Verify a session and return user info
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object|null>} - Session info with user data or null
 */
async function verifySession(sessionId) {
  try {
    if (!db.isDatabaseConfigured()) {
      return mockSessions.getMockSession(sessionId);
    }

    const result = await db.query(`
      SELECT 
        s.session_id,
        s.user_id,
        s.expires_at,
        s.last_activity,
        u.user_id,
        u.username,
        u.name,
        u.role,
        u.is_active
      FROM user_sessions s
      INNER JOIN users u ON s.user_id = u.user_id
      WHERE s.session_id = $1
      AND s.expires_at > NOW()
      AND u.is_active = true
    `, [sessionId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    
    // Update last activity
    await db.query(`
      UPDATE user_sessions 
      SET last_activity = NOW() 
      WHERE session_id = $1
    `, [sessionId]);

    return {
      isValid: true,
      user: {
        user_id: row.user_id,
        username: row.username,
        name: row.name,
        role: row.role
      }
    };
  } catch (error) {
    console.error('[Auth Middleware] Error verifying session:', error);
    return null;
  }
}

/**
 * Create a new session for a user
 * @param {number} userId - User ID
 * @param {string} deviceId - Device fingerprint
 * @param {string} ipAddress - IP address
 * @param {string} userAgent - User agent string
 * @returns {Promise<string>} - Session ID
 */
async function createSession(userId, deviceId, ipAddress, userAgent) {
  if (!db.isDatabaseConfigured()) {
    throw new Error(
      'createSession requires database — use mockSessions.createMockSession for no-DB setup'
    );
  }

  const { v4: uuidv4 } = require('uuid');
  const sessionId = uuidv4();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // 24 hour session

  await db.query(`
    INSERT INTO user_sessions (
      session_id, user_id, device_id, ip_address, user_agent, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [sessionId, userId, deviceId, ipAddress, userAgent, expiresAt]);

  // Update user's last login
  await db.query(`
    UPDATE users 
    SET last_login = NOW() 
    WHERE user_id = $1
  `, [userId]);

  return sessionId;
}

/**
 * Destroy a session
 * @param {string} sessionId - Session ID
 */
async function destroySession(sessionId) {
  try {
    if (!db.isDatabaseConfigured()) {
      mockSessions.destroyMockSession(sessionId);
      return;
    }

    await db.query(`
      DELETE FROM user_sessions 
      WHERE session_id = $1
    `, [sessionId]);
  } catch (error) {
    console.error('[Auth Middleware] Error destroying session:', error);
  }
}

/**
 * Destroy all sessions for a user
 * @param {number} userId - User ID
 */
async function destroyAllUserSessions(userId) {
  try {
    await db.query(`
      DELETE FROM user_sessions 
      WHERE user_id = $1
    `, [userId]);
  } catch (error) {
    console.error('[Auth Middleware] Error destroying user sessions:', error);
  }
}

/**
 * Clean up expired sessions (should be run periodically)
 */
async function cleanupExpiredSessions() {
  try {
    const result = await db.query(`
      DELETE FROM user_sessions 
      WHERE expires_at < NOW()
    `);
    console.log(`[Auth Middleware] Cleaned up ${result.rowCount} expired sessions`);
  } catch (error) {
    console.error('[Auth Middleware] Error cleaning up sessions:', error);
  }
}

function isElevatedRole(role) {
  return ELEVATED_ROLE_KEYS.has(normalizeRoleKey(role));
}

/**
 * PUT /settings: allow HisaabKitab-style admin roles OR Zentrya shop owner/admin from shop_users.
 * Covers users whose `users.role` is still `cashier` but they own the shop in shop_users.
 */
async function requireSettingsAdminOrShopOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
    });
  }
  if (isElevatedRole(req.user.role)) {
    return next();
  }
  if (!db.isDatabaseConfigured() || !req.shopId) {
    return res.status(403).json({
      error: 'Access denied',
      message: 'You do not have permission to change settings.',
    });
  }
  try {
    const uidResult = await db.query(
      `SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`,
      [req.user.user_id]
    );
    const profileId = uidResult.rows[0]?.zb_profile_id;
    if (!profileId) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Account not linked (zb_profile_id). Log out and log in again.',
      });
    }

    try {
      const mem = await db.query(
        `SELECT role::text AS role FROM shop_users WHERE shop_id = $1::uuid AND user_id = $2::uuid`,
        [req.shopId, profileId]
      );
      const m = normalizeRoleKey(mem.rows[0]?.role);
      if (m === 'owner' || m === 'admin') {
        return next();
      }
    } catch (e) {
      if (e.code !== '42P01') {
        console.warn('[requireSettingsAdminOrShopOwner] shop_users:', e.message);
      }
    }

    // Zentrya: shops.owner_id === profile (works even if shop_users.role is salesman or row missing)
    try {
      const shopOwner = await db.query(
        `SELECT owner_id::text AS oid FROM public.shops WHERE id = $1::uuid`,
        [req.shopId]
      );
      const oid = shopOwner.rows[0]?.oid;
      if (oid && String(oid).toLowerCase() === String(profileId).toLowerCase()) {
        return next();
      }
    } catch (e) {
      if (e.code !== '42P01') {
        console.warn('[requireSettingsAdminOrShopOwner] shops.owner_id:', e.message);
      }
    }
  } catch (e) {
    console.error('[requireSettingsAdminOrShopOwner]', e);
  }
  return res.status(403).json({
    error: 'Access denied',
    message: 'Only shop owners and administrators can change settings.',
  });
}

module.exports = {
  requireAuth,
  requireRole,
  requireAdministratorOrProfileOwner,
  isElevatedRole,
  requireSettingsAdminOrShopOwner,
  verifySession,
  createSession,
  destroySession,
  destroyAllUserSessions,
  cleanupExpiredSessions,
};

