/**
 * User Management Routes (Admin Only)
 * Handles user CRUD operations
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth, requireAdministratorOrProfileOwner } = require('../middleware/authMiddleware');
const { requireShopContext } = require('../middleware/shopContextMiddleware');
const { requirePremiumPlan } = require('../middleware/planMiddleware');
const { 
  hashPassword, 
  hashPIN,
  validatePassword, 
} = require('../utils/authUtils');
const { normalizeEmail } = require('../utils/emailOtpVerify');
const { sendTransactionalEmail } = require('../utils/transactionalMail');
const { buildStaffAddedEmail } = require('../utils/staffInviteEmailContent');
const { logAuditEvent, logSensitiveAccess } = require('../utils/auditLogger');
const notificationsModule = require('./notifications');
const createNotification = notificationsModule.createNotification || (async () => {});

async function ensureStaffInvitationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS staff_invitations (
      invitation_id BIGSERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'cashier',
      shop_id UUID NOT NULL,
      invited_by_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      responded_at TIMESTAMPTZ,
      response_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function isValidStaffEmail(s) {
  const e = normalizeEmail(s);
  if (!e || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Keep zb_simple_users password (crypt) in sync with users (bcrypt) when staff logs in via email + Supabase zb_login. */
async function syncZbSimplePasswordByUserId(userId, plainPassword) {
  const r = await db.query('SELECT zb_profile_id FROM users WHERE user_id = $1', [userId]);
  const pid = r.rows[0]?.zb_profile_id;
  if (!pid) return;
  await db.query(
    `UPDATE public.zb_simple_users SET password_hash = crypt($1::text, gen_salt('bf'::text)) WHERE id = $2::uuid`,
    [plainPassword, pid]
  );
}

/** Match public.zb_plan enum values from planMiddleware. */
function coercePlanForInsert(plan) {
  const s = plan == null || plan === '' ? 'trial' : String(plan).trim().toLowerCase();
  const allowed = new Set(['trial', 'starter', 'pro', 'premium', 'expired']);
  return allowed.has(s) ? s : 'trial';
}

/**
 * Insert public.profiles — enums differ per DB; try role × (with plan / without plan).
 */
async function insertProfileWithFallbacks(client, { zbId, displayName, userRole, planRaw }) {
  const planStr = coercePlanForInsert(planRaw);
  const roleCandidates =
    userRole === 'administrator'
      ? ['admin', 'owner', 'administrator']
      : ['salesman', 'cashier', 'user', 'staff'];

  await client.query('SAVEPOINT sp_profiles');
  let attempt = 0;
  let lastErr = null;
  let inserted = false;

  for (const pr of roleCandidates) {
    for (const withPlan of [true, false]) {
      if (attempt++ > 0) {
        await client.query('ROLLBACK TO SAVEPOINT sp_profiles');
      }
      try {
        if (withPlan) {
          await client.query(
            `INSERT INTO public.profiles (id, full_name, role, plan)
             VALUES ($1::uuid, $2::text, $3::public.zb_user_role, $4)`,
            [zbId, displayName, pr, planStr]
          );
        } else {
          await client.query(
            `INSERT INTO public.profiles (id, full_name, role)
             VALUES ($1::uuid, $2::text, $3::public.zb_user_role)`,
            [zbId, displayName, pr]
          );
        }
        inserted = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (inserted) break;
  }

  if (!inserted) {
    throw lastErr || new Error('Could not insert profiles row');
  }
  await client.query('RELEASE SAVEPOINT sp_profiles');
}

// All routes require authentication; admin via API role OR Supabase profile (owner/admin)
router.use(requireAuth);
router.use(requireAdministratorOrProfileOwner);
router.use(requireShopContext);

/** Users visible in this shop: Zentrya shop_users link OR users.shop_id (local cashier rows). */
function usersInShopWhereClause(shopParam = '$1') {
  return `(
    EXISTS (
      SELECT 1 FROM shop_users su
      WHERE su.shop_id = ${shopParam}::uuid
        AND su.user_id = u.zb_profile_id
    )
    OR u.shop_id = ${shopParam}::uuid
  )`;
}

async function userBelongsToShop(userId, shopId) {
  try {
    const r = await db.query(
      `SELECT 1 FROM users u
       WHERE u.user_id = $1
         AND (
           EXISTS (
             SELECT 1 FROM shop_users su
             WHERE su.shop_id = $2::uuid AND su.user_id = u.zb_profile_id
           )
           OR u.shop_id = $2::uuid
         )`,
      [userId, shopId]
    );
    return r.rows.length > 0;
  } catch (e) {
    if (e.code === '42703' && String(e.message || '').includes('shop_id')) {
      const r = await db.query(
        `SELECT 1 FROM users u
         WHERE u.user_id = $1
           AND EXISTS (
             SELECT 1 FROM shop_users su
             WHERE su.shop_id = $2::uuid AND su.user_id = u.zb_profile_id
           )`,
        [userId, shopId]
      );
      return r.rows.length > 0;
    }
    throw e;
  }
}

async function countActiveAdminsExceptInShop(excludeUserId, shopId) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS c FROM users u
       WHERE u.role = 'administrator' AND u.is_active = true AND u.user_id != $1
         AND (
           EXISTS (
             SELECT 1 FROM shop_users su
             WHERE su.shop_id = $2::uuid AND su.user_id = u.zb_profile_id
           )
           OR u.shop_id = $2::uuid
         )`,
      [excludeUserId, shopId]
    );
    return parseInt(r.rows[0].c, 10);
  } catch (e) {
    if (e.code === '42703' && String(e.message || '').includes('shop_id')) {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM users u
         WHERE u.role = 'administrator' AND u.is_active = true AND u.user_id != $1
           AND EXISTS (
             SELECT 1 FROM shop_users su
             WHERE su.shop_id = $2::uuid AND su.user_id = u.zb_profile_id
           )`,
        [excludeUserId, shopId]
      );
      return parseInt(r.rows[0].c, 10);
    }
    throw e;
  }
}

async function usernameTakenInShop(username, shopId) {
  try {
    const r = await db.query(
      `SELECT u.user_id FROM users u
       WHERE lower(trim(u.username)) = lower(trim($1))
         AND (
           EXISTS (
             SELECT 1 FROM shop_users su
             WHERE su.shop_id = $2::uuid AND su.user_id = u.zb_profile_id
           )
           OR u.shop_id = $2::uuid
         )`,
      [username, shopId]
    );
    return r.rows.length > 0;
  } catch (e) {
    if (e.code === '42703' && String(e.message || '').includes('shop_id')) {
      const r = await db.query(
        `SELECT u.user_id FROM users u
         WHERE lower(trim(u.username)) = lower(trim($1))
           AND EXISTS (
             SELECT 1 FROM shop_users su
             WHERE su.shop_id = $2::uuid AND su.user_id = u.zb_profile_id
           )`,
        [username, shopId]
      );
      return r.rows.length > 0;
    }
    throw e;
  }
}

/**
 * GET /api/users
 * Get users for the active shop only (admin only; requires x-shop-id)
 */
router.get('/', async (req, res) => {
  try {
    await logSensitiveAccess(
      req.user.user_id,
      'users',
      req.ip || req.connection.remoteAddress,
      req.get('user-agent')
    );

    const shopId = req.shopId;
    let result;
    try {
      result = await db.query(
        `
      SELECT 
        u.user_id,
        u.username,
        u.name,
        u.role,
        u.is_active,
        u.created_at,
        u.updated_at,
        u.last_login
      FROM users u
      WHERE ${usersInShopWhereClause('$1')}
      ORDER BY u.created_at DESC
    `,
        [shopId]
      );
    } catch (e) {
      if (e.code === '42703' && e.message && e.message.includes('shop_id')) {
        result = await db.query(
          `
      SELECT 
        u.user_id,
        u.username,
        u.name,
        u.role,
        u.is_active,
        u.created_at,
        u.updated_at,
        u.last_login
      FROM users u
      WHERE EXISTS (
        SELECT 1 FROM shop_users su
        WHERE su.shop_id = $1::uuid
          AND su.user_id = u.zb_profile_id
      )
      ORDER BY u.created_at DESC
    `,
          [shopId]
        );
      } else {
        throw e;
      }
    }

    res.json({
      success: true,
      users: result.rows
    });
  } catch (error) {
    console.error('[Users Route] Get users error:', error);
    res.status(500).json({
      error: 'Failed to fetch users',
      message: 'An error occurred while fetching users'
    });
  }
});

/**
 * POST /api/users
 * Create staff: email + password + role (PIN optional). Creates zb_simple_users + profiles + shop_users + users so login works with email (zb_login).
 */
router.post('/', async (req, res) => {
  try {
    const rawEmail = req.body?.email != null ? req.body.email : req.body?.username;
    const email = normalizeEmail(rawEmail);
    const nameRaw = req.body?.name;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    const { password, role, pin } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!email || !password) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'Email and password are required',
      });
    }
    if (!isValidStaffEmail(email)) {
      return res.status(400).json({
        error: 'Invalid email',
        message: 'Enter a valid email address',
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: 'Invalid password',
        message: passwordValidation.message,
      });
    }

    const userRole = role === 'administrator' ? 'administrator' : 'cashier';
    const displayName = name || email.split('@')[0];

    const dupZb = await db.query(
      `SELECT 1 FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
      [email]
    );
    if (dupZb.rows.length > 0) {
      return res.status(400).json({
        error: 'Email exists',
        message: 'An account with this email already exists',
      });
    }

    const taken = await usernameTakenInShop(email, req.shopId);
    if (taken) {
      return res.status(400).json({
        error: 'Email exists',
        message: 'This email is already used for a user in this shop',
      });
    }

    const passwordHash = await hashPassword(password);
    let pinHash = null;
    if (pin) {
      if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({
          error: 'Invalid PIN',
          message: 'PIN must be exactly 4 digits',
        });
      }
      pinHash = await hashPIN(pin);
    }

    const planRow = await db.query(
      `SELECT p.plan FROM users u JOIN public.profiles p ON p.id = u.zb_profile_id WHERE u.user_id = $1 LIMIT 1`,
      [req.user.user_id]
    );
    const planValue = coercePlanForInsert(planRow.rows[0]?.plan);

    const client = await db.getClient();
    let newUser;
    try {
      await client.query('BEGIN');

      let zbIns;
      try {
        zbIns = await client.query(
          `INSERT INTO public.zb_simple_users (username, full_name, email, password_hash)
           VALUES ($1, $2, $3, crypt($4::text, gen_salt('bf'::text)))
           RETURNING id`,
          [email, displayName, email, password]
        );
      } catch (zbErr) {
        const hint =
          zbErr?.code === '42883' || String(zbErr?.message || '').includes('gen_salt')
            ? ' Enable pgcrypto: run SQL "CREATE EXTENSION IF NOT EXISTS pgcrypto;" on this database.'
            : '';
        const e = new Error((zbErr?.message || 'zb_simple_users insert failed') + hint);
        e.code = zbErr?.code;
        e.detail = zbErr?.detail;
        throw e;
      }
      const zbId = zbIns.rows[0].id;

      await insertProfileWithFallbacks(client, {
        zbId,
        displayName,
        userRole,
        planRaw: planValue,
      });

      const shopRoleCandidates =
        userRole === 'administrator'
          ? ['admin', 'owner', 'administrator']
          : ['salesman', 'cashier', 'user', 'staff'];
      await client.query('SAVEPOINT sp_shop_users');
      let lastShopErr = null;
      for (let i = 0; i < shopRoleCandidates.length; i++) {
        if (i > 0) {
          await client.query('ROLLBACK TO SAVEPOINT sp_shop_users');
        }
        try {
          await client.query(
            `INSERT INTO public.shop_users (shop_id, user_id, role)
             VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
            [req.shopId, zbId, shopRoleCandidates[i]]
          );
          lastShopErr = null;
          break;
        } catch (suErr) {
          lastShopErr = suErr;
          console.warn(
            `[Users POST] shop_users role "${shopRoleCandidates[i]}" failed:`,
            suErr.message
          );
        }
      }
      if (lastShopErr) {
        throw lastShopErr;
      }
      await client.query('RELEASE SAVEPOINT sp_shop_users');

      let insUser;
      try {
        insUser = await client.query(
          `INSERT INTO users (
            username, password_hash, name, role, pin_hash, shop_id, zb_profile_id, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, true)
          RETURNING user_id, username, name, role, is_active, created_at`,
          [email, passwordHash, displayName, userRole, pinHash, req.shopId, zbId]
        );
      } catch (ie) {
        if (ie.code === '42703' && String(ie.message || '').includes('shop_id')) {
          insUser = await client.query(
            `INSERT INTO users (
              username, password_hash, name, role, pin_hash, zb_profile_id, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6::uuid, true)
            RETURNING user_id, username, name, role, is_active, created_at`,
            [email, passwordHash, displayName, userRole, pinHash, zbId]
          );
        } else {
          throw ie;
        }
      }

      await client.query('COMMIT');
      newUser = insUser.rows[0];
    } catch (txErr) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
      throw txErr;
    } finally {
      client.release();
    }

    let storeName = 'your store';
    try {
      const sr = await db.query(`SELECT name FROM public.shops WHERE id = $1::uuid`, [req.shopId]);
      if (sr.rows[0]?.name) storeName = String(sr.rows[0].name).trim() || storeName;
    } catch (_) {
      /* optional */
    }

    const roleLabel = userRole === 'administrator' ? 'Administrator' : 'Cashier';
    const { subject, text, html } = buildStaffAddedEmail({ storeName, roleLabel });
    try {
      await sendTransactionalEmail({ to: email, subject, text, html });
    } catch (mailErr) {
      console.warn('[Users] Staff invite email failed:', mailErr.message);
    }

    try {
      await logAuditEvent({
        userId: req.user.user_id,
        action: 'create',
        tableName: 'users',
        recordId: newUser.user_id,
        newValues: { email, name: displayName, role: userRole },
        notes: `Admin ${req.user.username} created staff: ${email}`,
        ipAddress,
        userAgent,
      });
    } catch (auditErr) {
      console.warn('[Users POST] audit log failed (user was created):', auditErr.message);
    }

    res.json({
      success: true,
      message: 'User created successfully',
      user: newUser,
    });
  } catch (error) {
    console.error('[Users Route] Create user error:', error?.code, error?.message, error?.detail);
    const devMsg = [error?.message, error?.detail].filter(Boolean).join(' — ');
    res.status(500).json({
      error: 'Failed to create user',
      message: devMsg || 'An error occurred while creating user',
      detail: error?.detail || undefined,
      code: error?.code || undefined,
    });
  }
});

/**
 * POST /api/users/invitations
 * Send staff invitation email (cashier/admin) with accept/reject links.
 */
router.post('/invitations', async (req, res) => {
  try {
    await ensureStaffInvitationsTable();
    const rawEmail = req.body?.email != null ? req.body.email : req.body?.username;
    const email = normalizeEmail(rawEmail);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const userRole = req.body?.role === 'administrator' ? 'administrator' : 'cashier';

    if (!isValidStaffEmail(email)) {
      return res.status(400).json({ error: 'Invalid email', message: 'Enter a valid email address' });
    }

    const dup = await db.query(
      `SELECT invitation_id FROM staff_invitations
       WHERE lower(trim(email)) = $1 AND shop_id = $2::uuid AND status = 'pending' AND expires_at > NOW()
       LIMIT 1`,
      [email, req.shopId]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: 'Invitation exists', message: 'A pending invitation already exists for this email' });
    }

    let storeName = 'your store';
    try {
      const sr = await db.query(`SELECT name FROM public.shops WHERE id = $1::uuid`, [req.shopId]);
      if (sr.rows[0]?.name) storeName = String(sr.rows[0].name).trim() || storeName;
    } catch (_) {
      /* optional */
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 2); // 48h
    await db.query(
      `INSERT INTO staff_invitations (token, email, name, role, shop_id, invited_by_user_id, status, expires_at)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, 'pending', $7)`,
      [token, email, name || null, userRole, req.shopId, req.user.user_id, expiresAt]
    );

    const appBase = process.env.APP_BASE_URL || 'http://localhost:3000';
    const acceptUrl = `${appBase}/staff-invite?token=${encodeURIComponent(token)}`;
    const rejectUrl = `${appBase}/staff-invite?token=${encodeURIComponent(token)}&action=reject`;
    const roleLabel = userRole === 'administrator' ? 'Administrator' : 'Cashier';
    const subject = `Invitation to join ${storeName}`;
    const text = [
      `You have been invited as ${roleLabel} for ${storeName}.`,
      '',
      `Accept invitation: ${acceptUrl}`,
      `Reject invitation: ${rejectUrl}`,
      '',
      'This invitation expires in 48 hours.',
    ].join('\n');
    const logoCid = 'zentrya-company-logo';
    let attachments = [];
    try {
      const logoPath = path.resolve(__dirname, '../../frontend/public/companylogo.jpeg');
      if (fs.existsSync(logoPath)) {
        const content = fs.readFileSync(logoPath);
        attachments = [{ filename: 'companylogo.jpeg', content, contentType: 'image/jpeg', cid: logoCid }];
      }
    } catch (_) {
      /* logo attachment optional */
    }
    const html = `
      <div style="margin:0;padding:18px;background:#eef2ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
        <div style="max-width:620px;margin:0 auto;background:linear-gradient(145deg,#ffffff,#f8faff);border:1px solid #dde5ff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(30,41,59,.12)">
          <div style="padding:16px 18px;background:linear-gradient(90deg,#4f46e5,#6366f1);color:#fff">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
              <tr>
                <td width="56" valign="middle" style="width:56px;vertical-align:middle;padding-right:10px">
                  <img src="cid:${logoCid}" alt="Zentrya Biz" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:10px;border:1px solid rgba(255,255,255,.45);background:#fff" />
                </td>
                <td valign="middle" style="vertical-align:middle">
                  <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.9;line-height:1.3">Zentrya Biz</div>
                  <div style="font-size:20px;font-weight:800;line-height:1.25;margin-top:2px">Store Team Invitation</div>
                </td>
              </tr>
            </table>
          </div>
          <div style="padding:18px">
            <p style="margin:0 0 10px;font-size:15px;color:#334155">You have been invited as <strong>${roleLabel}</strong> for <strong>${storeName}</strong>.</p>
            <p style="margin:0 0 14px;color:#475467">Join your team to start billing, inventory, and daily sales workflows.</p>
            <div style="margin:16px 0">
              <a href="${acceptUrl}" style="display:inline-block;padding:11px 16px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:10px;margin-right:8px;font-weight:700">Accept</a>
              <a href="${rejectUrl}" style="display:inline-block;padding:11px 16px;background:#fff;color:#b42318;text-decoration:none;border:1px solid #fecaca;border-radius:10px;font-weight:600">Reject</a>
            </div>
            <div style="margin:12px 0;padding:10px 12px;background:#eef4ff;border:1px solid #dbe5ff;border-radius:10px;color:#1e3a8a;font-size:13px">
              Already registered on this app? Click <strong>Accept</strong> and choose <strong>Yes</strong> on next page.
            </div>
            <p style="margin:10px 0 0;font-size:12px;color:#667085">This invitation expires in 48 hours.</p>
          </div>
        </div>
      </div>
    `;
    await sendTransactionalEmail({ to: email, subject, text, html, attachments });

    await createNotification({
      userId: req.user.user_id,
      title: 'Invitation sent',
      message: `Invitation sent to ${email} for ${storeName}.`,
      type: 'info',
      metadata: { email, role: userRole, shopId: req.shopId },
    });

    res.json({ success: true, message: 'Invitation sent successfully' });
  } catch (error) {
    console.error('[Users Route] Send invitation error:', error);
    res.status(500).json({
      error: 'Failed to send invitation',
      message: error.message || 'An error occurred while sending invitation',
    });
  }
});

/**
 * PUT /api/users/:id
 * Update a user (admin only)
 */
router.put('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, role, is_active, pin, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    const inShop = await userBelongsToShop(userId, req.shopId);
    if (!inShop) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found in this shop',
      });
    }

    // Allow admin to update themselves (but not delete)
    if (userId === req.user.user_id) {
      // Admin can update their own name, password, PIN, but not role or is_active
      if (role !== undefined || is_active !== undefined) {
        return res.status(400).json({
          error: 'Cannot change own role or status',
          message: 'You cannot change your own role or active status. Contact another administrator.'
        });
      }
      // Allow updating name, password, PIN for self
    }

    // Get current user
    const currentUser = await db.query(
      'SELECT user_id, role FROM users WHERE user_id = $1',
      [userId]
    );

    if (currentUser.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found'
      });
    }

    // Prevent deleting last administrator (within this shop)
    if (currentUser.rows[0].role === 'administrator' && is_active === false) {
      const otherAdmins = await countActiveAdminsExceptInShop(userId, req.shopId);
      if (otherAdmins === 0) {
        return res.status(400).json({
          error: 'Cannot deactivate last admin',
          message: 'Cannot deactivate the last administrator account for this shop'
        });
      }
    }

    // Build update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (role !== undefined && (role === 'administrator' || role === 'cashier')) {
      updates.push(`role = $${paramCount++}`);
      values.push(role);
    }

    if (is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(is_active);
    }

    if (pin !== undefined) {
      if (pin === null || pin === '') {
        updates.push(`pin_hash = NULL`);
      } else {
        if (!/^\d{4}$/.test(pin)) {
          return res.status(400).json({
            error: 'Invalid PIN',
            message: 'PIN must be exactly 4 digits'
          });
        }
        const pinHash = await hashPIN(pin);
        updates.push(`pin_hash = $${paramCount++}`);
        values.push(pinHash);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No updates',
        message: 'No fields to update'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    let result;
    if (is_active === false) {
      const prof = await db.query(`SELECT zb_profile_id FROM users WHERE user_id = $1`, [userId]);
      const zbProfileId = prof.rows[0]?.zb_profile_id;

      if (zbProfileId) {
        await db.query(
          `DELETE FROM public.shop_users WHERE shop_id = $1::uuid AND user_id = $2::uuid`,
          [req.shopId, zbProfileId]
        );
        const remaining = await db.query(
          `SELECT COUNT(*)::int AS c FROM public.shop_users WHERE user_id = $1::uuid`,
          [zbProfileId]
        );
        try {
          await db.query(
            `UPDATE users
             SET shop_id = CASE WHEN shop_id = $1::uuid THEN NULL ELSE shop_id END,
                 updated_at = NOW()
             WHERE user_id = $2`,
            [req.shopId, userId]
          );
        } catch (shopColErr) {
          if (!(shopColErr.code === '42703' && String(shopColErr.message || '').includes('shop_id'))) {
            throw shopColErr;
          }
        }
        const hasOtherShops = Number(remaining.rows[0]?.c || 0) > 0;
        result = await db.query(
          `UPDATE users
           SET is_active = $1, updated_at = NOW()
           WHERE user_id = $2
           RETURNING user_id, username, name, role, is_active, updated_at`,
          [hasOtherShops ? true : false, userId]
        );
      } else {
        result = await db.query(`
          UPDATE users
          SET ${updates.join(', ')}
          WHERE user_id = $${paramCount}
          RETURNING user_id, username, name, role, is_active, updated_at
        `, values);
      }
    } else {
      result = await db.query(`
        UPDATE users
        SET ${updates.join(', ')}
        WHERE user_id = $${paramCount}
        RETURNING user_id, username, name, role, is_active, updated_at
      `, values);
    }

    await logAuditEvent({
      userId: req.user.user_id,
      action: 'update',
      tableName: 'users',
      recordId: userId,
      newValues: { name, role, is_active },
      notes: `Admin ${req.user.username} updated user: ${result.rows[0].username}`,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'User updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('[Users Route] Update user error:', error);
    res.status(500).json({
      error: 'Failed to update user',
      message: 'An error occurred while updating user'
    });
  }
});

/**
 * DELETE /api/users/:id
 * Delete a user (admin only)
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    // Prevent deleting yourself
    if (userId === req.user.user_id) {
      return res.status(400).json({
        error: 'Cannot delete self',
        message: 'You cannot delete your own account'
      });
    }

    const inShop = await userBelongsToShop(userId, req.shopId);
    if (!inShop) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found in this shop',
      });
    }

    // Get user info
    const userResult = await db.query(
      'SELECT user_id, username, role, zb_profile_id FROM users WHERE user_id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    // Prevent deleting last administrator (within this shop)
    if (user.role === 'administrator') {
      const otherAdmins = await countActiveAdminsExceptInShop(userId, req.shopId);
      if (otherAdmins === 0) {
        return res.status(400).json({
          error: 'Cannot delete last admin',
          message: 'Cannot delete the last administrator account for this shop'
        });
      }
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      if (user.zb_profile_id) {
        // Remove access only for current shop.
        await client.query(
          `DELETE FROM public.shop_users WHERE shop_id = $1::uuid AND user_id = $2::uuid`,
          [req.shopId, user.zb_profile_id]
        );
      }

      // Ensure the user no longer appears in this shop's legacy mapping.
      try {
        await client.query(
          `UPDATE users
           SET shop_id = CASE WHEN shop_id = $1::uuid THEN NULL ELSE shop_id END,
               updated_at = NOW()
           WHERE user_id = $2`,
          [req.shopId, userId]
        );
      } catch (shopColErr) {
        if (!(shopColErr.code === '42703' && String(shopColErr.message || '').includes('shop_id'))) {
          throw shopColErr;
        }
      }

      // If user has no other shops left, deactivate account globally.
      let hasOtherShops = false;
      if (user.zb_profile_id) {
        const remaining = await client.query(
          `SELECT COUNT(*)::int AS c FROM public.shop_users WHERE user_id = $1::uuid`,
          [user.zb_profile_id]
        );
        hasOtherShops = Number(remaining.rows[0]?.c || 0) > 0;
      }
      await client.query(
        `UPDATE users
         SET is_active = $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [hasOtherShops ? true : false, userId]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
      throw txErr;
    } finally {
      client.release();
    }

    await logAuditEvent({
      userId: req.user.user_id,
      action: 'delete',
      tableName: 'users',
      recordId: userId,
      oldValues: { username: user.username, role: user.role },
      notes: `Admin ${req.user.username} deleted user: ${user.username}`,
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'User removed from this shop successfully'
    });
  } catch (error) {
    console.error('[Users Route] Delete user error:', error);
    res.status(500).json({
      error: 'Failed to delete user',
      message: 'An error occurred while deleting user'
    });
  }
});

/**
 * GET /api/users/audit-logs
 * Get audit logs (admin only)
 */
router.get('/audit-logs', requirePremiumPlan, async (req, res) => {
  try {
    const { limit = 100, offset = 0, userId, action, tableName } = req.query;

    await logSensitiveAccess(
      req.user.user_id,
      'audit_logs',
      req.ip || req.connection.remoteAddress,
      req.get('user-agent')
    );

    let query = `
      SELECT 
        al.log_id,
        al.user_id,
        u.username,
        u.name as user_name,
        al.action,
        al.table_name,
        al.record_id,
        al.old_values,
        al.new_values,
        al.ip_address,
        al.user_agent,
        al.timestamp,
        al.notes
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.user_id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (userId) {
      query += ` AND al.user_id = $${paramCount++}`;
      params.push(userId);
    }

    if (action) {
      query += ` AND al.action = $${paramCount++}`;
      params.push(action);
    }

    if (tableName) {
      query += ` AND al.table_name = $${paramCount++}`;
      params.push(tableName);
    }

    query += ` ORDER BY al.timestamp DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count
      FROM audit_logs al
      WHERE 1=1
      ${userId ? `AND al.user_id = $1` : ''}
      ${action ? `AND al.action = $${userId ? '2' : '1'}` : ''}
      ${tableName ? `AND al.table_name = $${userId && action ? '3' : userId || action ? '2' : '1'}` : ''}
    `;
    const countParams = [];
    if (userId) countParams.push(userId);
    if (action) countParams.push(action);
    if (tableName) countParams.push(tableName);

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    res.json({
      success: true,
      logs: result.rows,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[Users Route] Get audit logs error:', error);
    res.status(500).json({
      error: 'Failed to fetch audit logs',
      message: 'An error occurred while fetching audit logs'
    });
  }
});

/**
 * POST /api/users/:id/generate-password
 * Generate a random password for a user (admin only)
 */
router.post('/:id/generate-password', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const inShop = await userBelongsToShop(userId, req.shopId);
    if (!inShop) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found in this shop',
      });
    }

    // Generate random password (8 characters: 4 letters + 4 numbers)
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    let password = '';
    for (let i = 0; i < 4; i++) {
      password += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    for (let i = 0; i < 4; i++) {
      password += numbers.charAt(Math.floor(Math.random() * numbers.length));
    }
    // Shuffle the password
    password = password.split('').sort(() => Math.random() - 0.5).join('');
    
    // Hash the password
    const passwordHash = await hashPassword(password);
    
    // Update user password
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2',
      [passwordHash, userId]
    );
    await syncZbSimplePasswordByUserId(userId, password);

    await logAuditEvent({
      userId: req.user.user_id,
      action: 'update',
      tableName: 'users',
      recordId: userId,
      notes: `Admin ${req.user.username} generated new password for user`,
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent')
    });
    
    res.json({
      success: true,
      password: password, // Return plain password so admin can share it
      message: 'Password generated successfully'
    });
  } catch (error) {
    console.error('[Users Route] Generate password error:', error);
    res.status(500).json({
      error: 'Failed to generate password',
      message: 'An error occurred while generating password'
    });
  }
});

module.exports = router;

