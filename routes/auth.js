/**
 * Authentication Routes
 * Handles login, logout, password recovery, and user management
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { 
  hashPassword, 
  verifyPassword, 
  hashPIN, 
  verifyPIN,
  generateResetToken,
  hashSecurityAnswer,
  verifySecurityAnswer,
  validatePassword,
  validateUsername,
  generateDeviceBoundRecoveryKey
} = require('../utils/authUtils');
const { 
  createSession, 
  destroySession, 
  requireAuth, 
  requireRole 
} = require('../middleware/authMiddleware');
const { logLogin, logLogout, logAuditEvent } = require('../utils/auditLogger');
const deviceFingerprint = require('../utils/deviceFingerprint');
const { validateEmailOtpMatch, markEmailOtpConsumed, normalizeEmail } = require('../utils/emailOtpVerify');
const notificationsModule = require('./notifications');
const createNotification = notificationsModule.createNotification || (async () => {});

function coercePlanForInsert(plan) {
  const s = plan == null || plan === '' ? 'trial' : String(plan).trim().toLowerCase();
  const allowed = new Set(['trial', 'starter', 'pro', 'premium', 'expired']);
  return allowed.has(s) ? s : 'trial';
}

async function insertProfileWithFallbacks(client, { zbId, displayName, userRole, planRaw }) {
  const planStr = coercePlanForInsert(planRaw);
  const roleCandidates =
    userRole === 'administrator'
      ? ['admin', 'owner', 'administrator']
      : ['salesman', 'cashier', 'user', 'staff'];

  await client.query('SAVEPOINT sp_profiles');
  let lastErr = null;
  let inserted = false;
  for (const pr of roleCandidates) {
    for (const withPlan of [true, false]) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT sp_profiles');
      } catch (_) {
        /* ignore */
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
  if (!inserted) throw lastErr || new Error('Could not insert profiles row');
  await client.query('RELEASE SAVEPOINT sp_profiles');
}

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

async function getInviteByToken(token) {
  await ensureStaffInvitationsTable();
  const r = await db.query(
    `SELECT si.*, s.name AS store_name
     FROM staff_invitations si
     LEFT JOIN public.shops s ON s.id = si.shop_id
     WHERE si.token = $1
     LIMIT 1`,
    [token]
  );
  return r.rows[0] || null;
}

async function attachExistingUserToInvitedShop(invite) {
  const email = normalizeEmail(invite.email);
  const zb = await db.query(
    `SELECT id, username, full_name FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
    [email]
  );
  if (!zb.rows.length) {
    return { ok: false, error: 'No existing account found for this email. Choose "No" and set a password.' };
  }

  const zbProfileId = zb.rows[0].id;
  const userRole = invite.role === 'administrator' ? 'administrator' : 'cashier';
  const shopRoleCandidates =
    userRole === 'administrator'
      ? ['admin', 'owner', 'administrator']
      : ['salesman', 'cashier', 'user', 'staff'];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    let inserted = false;
    let lastErr = null;
    for (const roleTry of shopRoleCandidates) {
      try {
        await client.query(
          `INSERT INTO public.shop_users (shop_id, user_id, role)
           VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
          [invite.shop_id, zbProfileId, roleTry]
        );
        inserted = true;
        break;
      } catch (e) {
        lastErr = e;
        if (e.code === '23505') {
          inserted = true; // already linked to this shop
          break;
        }
      }
    }
    if (!inserted && lastErr) throw lastErr;

    await client.query(
      `UPDATE users
       SET is_active = true, role = $1, zb_profile_id = COALESCE(zb_profile_id, $2::uuid), updated_at = NOW()
       WHERE lower(trim(username)) = $3`,
      [userRole, zbProfileId, email]
    );

    await client.query(
      `UPDATE staff_invitations
       SET status = 'accepted', responded_at = NOW(), response_note = 'accepted by existing registered user'
       WHERE invitation_id = $1`,
      [invite.invitation_id]
    );
    await client.query('COMMIT');
    return { ok: true, email };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

router.get('/staff-invite/:token', async (req, res) => {
  try {
    const invite = await getInviteByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });
    const expired = new Date(invite.expires_at).getTime() < Date.now();
    const status = expired && invite.status === 'pending' ? 'expired' : invite.status;
    return res.json({
      success: true,
      invitation: {
        email: invite.email,
        name: invite.name,
        role: invite.role,
        storeName: invite.store_name || 'Store',
        status,
        expiresAt: invite.expires_at,
      },
    });
  } catch (error) {
    console.error('[Auth Route] staff invite fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch invitation' });
  }
});

router.post('/staff-invite/:token/reject', async (req, res) => {
  try {
    const invite = await getInviteByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'Invitation is no longer pending' });
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Invitation expired' });
    }

    await db.query(
      `UPDATE staff_invitations
       SET status = 'rejected', responded_at = NOW(), response_note = 'rejected by recipient'
       WHERE invitation_id = $1`,
      [invite.invitation_id]
    );

    await createNotification({
      userId: invite.invited_by_user_id,
      title: 'Invitation rejected',
      message: `${invite.email} rejected the cashier invitation for ${invite.store_name || 'your store'}.`,
      type: 'warning',
      metadata: { shopId: invite.shop_id, inviteEmail: invite.email, action: 'reject' },
      shopId: invite.shop_id,
    });

    return res.json({ success: true, message: 'Invitation rejected' });
  } catch (error) {
    console.error('[Auth Route] staff invite reject error:', error);
    return res.status(500).json({ error: 'Failed to reject invitation' });
  }
});

router.post('/staff-invite/:token/accept', async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message || 'Invalid password' });
    }

    const invite = await getInviteByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'Invitation is no longer pending' });
    if (new Date(invite.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Invitation expired' });

    const email = normalizeEmail(invite.email);
    const userRole = invite.role === 'administrator' ? 'administrator' : 'cashier';
    const displayName = String(invite.name || email.split('@')[0]).trim();

    const dupZb = await db.query(
      `SELECT 1 FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
      [email]
    );
    if (dupZb.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    const planRow = await db.query(
      `SELECT p.plan FROM users u JOIN public.profiles p ON p.id = u.zb_profile_id WHERE u.user_id = $1 LIMIT 1`,
      [invite.invited_by_user_id]
    );
    const planValue = coercePlanForInsert(planRow.rows[0]?.plan);
    const passwordHash = await hashPassword(password);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const zbIns = await client.query(
        `INSERT INTO public.zb_simple_users (username, full_name, email, password_hash)
         VALUES ($1, $2, $3, crypt($4::text, gen_salt('bf'::text)))
         RETURNING id`,
        [email, displayName, email, password]
      );
      const zbId = zbIns.rows[0].id;
      await insertProfileWithFallbacks(client, { zbId, displayName, userRole, planRaw: planValue });

      const shopRoleCandidates =
        userRole === 'administrator'
          ? ['admin', 'owner', 'administrator']
          : ['salesman', 'cashier', 'user', 'staff'];
      await client.query('SAVEPOINT sp_shop_users');
      let insertedShopUser = false;
      for (let i = 0; i < shopRoleCandidates.length; i++) {
        if (i > 0) await client.query('ROLLBACK TO SAVEPOINT sp_shop_users');
        try {
          await client.query(
            `INSERT INTO public.shop_users (shop_id, user_id, role)
             VALUES ($1::uuid, $2::uuid, $3::public.zb_user_role)`,
            [invite.shop_id, zbId, shopRoleCandidates[i]]
          );
          insertedShopUser = true;
          break;
        } catch (_) {
          /* try next role */
        }
      }
      if (!insertedShopUser) throw new Error('Failed to link invited user to shop');
      await client.query('RELEASE SAVEPOINT sp_shop_users');

      try {
        await client.query(
          `INSERT INTO users (username, password_hash, name, role, shop_id, zb_profile_id, is_active)
           VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, true)`,
          [email, passwordHash, displayName, userRole, invite.shop_id, zbId]
        );
      } catch (ie) {
        if (ie.code === '42703' && String(ie.message || '').includes('shop_id')) {
          await client.query(
            `INSERT INTO users (username, password_hash, name, role, zb_profile_id, is_active)
             VALUES ($1, $2, $3, $4, $5::uuid, true)`,
            [email, passwordHash, displayName, userRole, zbId]
          );
        } else {
          throw ie;
        }
      }

      await client.query(
        `UPDATE staff_invitations
         SET status = 'accepted', responded_at = NOW(), response_note = 'accepted and registered'
         WHERE invitation_id = $1`,
        [invite.invitation_id]
      );

      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }

    await createNotification({
      userId: invite.invited_by_user_id,
      title: 'Invitation accepted',
      message: `${email} accepted the invitation and completed registration for ${invite.store_name || 'your store'}.`,
      type: 'success',
      metadata: { shopId: invite.shop_id, inviteEmail: email, action: 'accept' },
      shopId: invite.shop_id,
    });

    return res.json({ success: true, message: 'Registration completed successfully' });
  } catch (error) {
    console.error('[Auth Route] staff invite accept error:', error);
    return res.status(500).json({ error: 'Failed to complete registration', message: error.message });
  }
});

router.post('/staff-invite/:token/accept-existing', async (req, res) => {
  try {
    const invite = await getInviteByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'Invitation is no longer pending' });
    if (new Date(invite.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Invitation expired' });

    const linked = await attachExistingUserToInvitedShop(invite);
    if (!linked.ok) return res.status(400).json({ error: linked.error });

    await createNotification({
      userId: invite.invited_by_user_id,
      title: 'Invitation accepted',
      message: `${linked.email} accepted the invitation for ${invite.store_name || 'your store'} using existing account.`,
      type: 'success',
      metadata: { shopId: invite.shop_id, inviteEmail: linked.email, action: 'accept_existing' },
      shopId: invite.shop_id,
    });

    return res.json({ success: true, message: 'Invitation accepted. Please log in.' });
  } catch (error) {
    console.error('[Auth Route] staff invite accept-existing error:', error);
    return res.status(500).json({ error: 'Failed to accept invitation', message: error.message });
  }
});

/**
 * POST /api/auth/zb-signup-with-otp
 * Email-verified signup (Microsoft Graph or SMTP sends OTP). Calls public.zb_signup_email (not exposed to anon).
 */
router.post('/zb-signup-with-otp', async (req, res) => {
  try {
    const { fullName, email, password, otp } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    const fn = String(fullName || '').trim();
    const pw = String(password || '');
    const otpCode = String(otp || '').trim();
    /** Login key in zb_simple_users.username — same as email (no separate username). */
    const loginKey = em;

    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        message: 'Set DATABASE_URL in backend/.env',
      });
    }

    if (!em || !em.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!fn || fn.length < 2 || pw.length < 4) {
      return res.status(400).json({ error: 'Full name (2+ characters) and password (4+) required' });
    }
    if (!/^\d{6}$/.test(otpCode)) {
      return res.status(400).json({ error: 'Enter the 6-digit code from your email' });
    }

    const otpCheck = await validateEmailOtpMatch(em, otpCode, 'signup');
    if (!otpCheck.ok) {
      return res.status(400).json({ error: otpCheck.error || 'Invalid code' });
    }

    let data;
    try {
      const q = await db.query(`SELECT public.zb_signup_email($1::text, $2::text, $3::text, $4::text) AS r`, [
        fn,
        loginKey,
        pw,
        em,
      ]);
      const raw = q.rows[0]?.r;
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      if (e.code === '42883' || (e.message && e.message.includes('zb_signup_email'))) {
        return res.status(503).json({
          error: 'Signup function missing',
          message: 'Run database/zentrya_biz_zb_simple_users_email.sql in Supabase',
        });
      }
      throw e;
    }

    if (!data?.ok) {
      return res.status(400).json({ error: data?.error || 'Signup failed' });
    }

    await markEmailOtpConsumed(otpCheck.rowId);

    return res.json({
      ok: true,
      user_id: data.user_id,
      username: data.username,
      full_name: data.full_name,
    });
  } catch (error) {
    console.error('[Auth Route] zb-signup-with-otp error:', error);
    res.status(500).json({
      error: 'Signup failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/auth/zb-reset-password-after-otp
 * Forgot password: verify reset OTP, update zb_simple_users + linked users row.
 */
router.post('/zb-reset-password-after-otp', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    const em = normalizeEmail(email);
    const otpCode = String(otp || '').trim();
    const pw = String(newPassword || '');

    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        message: 'Set DATABASE_URL in backend/.env',
      });
    }
    if (!em || !em.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!/^\d{6}$/.test(otpCode)) {
      return res.status(400).json({ error: 'Enter the 6-digit code from your email' });
    }
    if (pw.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    const otpCheck = await validateEmailOtpMatch(em, otpCode, 'reset');
    if (!otpCheck.ok) {
      return res.status(400).json({ error: otpCheck.error || 'Invalid code' });
    }

    const zbRow = await db.query(
      `SELECT id, username FROM public.zb_simple_users WHERE lower(trim(coalesce(email,''))) = $1 LIMIT 1`,
      [em]
    );
    if (zbRow.rows.length === 0) {
      return res.status(400).json({ error: 'No account for this email' });
    }

    const uname = String(zbRow.rows[0].username || '').trim().toLowerCase();

    await db.query(
      `UPDATE public.zb_simple_users
       SET password_hash = crypt($1::text, gen_salt('bf'::text))
       WHERE lower(trim(coalesce(email,''))) = $2`,
      [pw, em]
    );

    const bcryptHash = await hashPassword(pw);
    await db.query(
      `UPDATE users SET password_hash = $1 WHERE lower(trim(username)) = $2 AND is_active = true`,
      [bcryptHash, uname]
    );

    await markEmailOtpConsumed(otpCheck.rowId);

    return res.json({ ok: true });
  } catch (error) {
    console.error('[Auth Route] zb-reset-password-after-otp error:', error);
    res.status(500).json({
      error: 'Password reset failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/auth/login
 * Login with username/password or PIN
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password, pin } = req.body;
    const deviceId = req.headers['x-device-id'] || deviceFingerprint.getDeviceId();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!username && !pin) {
      return res.status(400).json({
        error: 'Invalid credentials',
        message: 'Username/password or PIN is required'
      });
    }

    let user;
    
    // PIN login (for cashier)
    if (pin && !username) {
      if (!/^\d{4}$/.test(pin)) {
        await logLogin(null, ipAddress, userAgent, false);
        return res.status(400).json({
          error: 'Invalid PIN',
          message: 'PIN must be exactly 4 digits'
        });
      }

      // Find user by PIN
      const pinResult = await db.query(`
        SELECT user_id, username, name, role, pin_hash, is_active
        FROM users
        WHERE pin_hash IS NOT NULL
        AND is_active = true
      `);

      let foundUser = null;
      for (const row of pinResult.rows) {
        const isValid = await verifyPIN(pin, row.pin_hash);
        if (isValid) {
          foundUser = row;
          break;
        }
      }

      if (!foundUser) {
        await logLogin(null, ipAddress, userAgent, false);
        return res.status(401).json({
          error: 'Invalid PIN',
          message: 'The PIN you entered is incorrect'
        });
      }

      user = foundUser;
    } else {
      // Username/password login
      if (!username || !password) {
        return res.status(400).json({
          error: 'Invalid credentials',
          message: 'Username and password are required'
        });
      }

      const result = await db.query(`
        SELECT user_id, username, name, role, password_hash, is_active
        FROM users
        WHERE username = $1 AND is_active = true
      `, [username]);

      if (result.rows.length === 0) {
        await logLogin(null, ipAddress, userAgent, false);
        return res.status(401).json({
          error: 'Invalid credentials',
          message: 'Username or password is incorrect'
        });
      }

      user = result.rows[0];
      const isValidPassword = await verifyPassword(password, user.password_hash);
      
      if (!isValidPassword) {
        await logLogin(null, ipAddress, userAgent, false);
        return res.status(401).json({
          error: 'Invalid credentials',
          message: 'Username or password is incorrect'
        });
      }
    }

    // Create session
    const sessionId = await createSession(user.user_id, deviceId, ipAddress, userAgent);
    
    // Log successful login
    await logLogin(user.user_id, ipAddress, userAgent, true);

    res.json({
      success: true,
      sessionId,
      user: {
        user_id: user.user_id,
        username: user.username,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('[Auth Route] Login error:', error);
    res.status(500).json({
      error: 'Login failed',
      message: 'An error occurred during login. Please try again.'
    });
  }
});

/**
 * POST /api/auth/zb-simple-session
 * Zentrya web login uses public.zb_simple_users (pgcrypto). HisaabKitab API routes use users + user_sessions.
 * Verifies the same username/password against zb_simple_users, finds or creates a users row, returns sessionId.
 */
router.post('/zb-simple-session', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const deviceId = req.headers['x-device-id'] || deviceFingerprint.getDeviceId();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!username || !password) {
      return res.status(400).json({
        error: 'Invalid credentials',
        message: 'Username and password are required',
      });
    }

    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        message: 'Set DATABASE_URL in backend/.env',
      });
    }

    const u = String(username).trim().toLowerCase();
    if (u.length < 2) {
      return res.status(400).json({ error: 'Invalid username', message: 'Username too short' });
    }

    let zbResult;
    try {
      zbResult = await db.query(
        `SELECT id, full_name, username
         FROM zb_simple_users
         WHERE (lower(trim(username)) = $1 OR lower(trim(coalesce(email, ''))) = $1)
           AND password_hash = crypt($2::text, password_hash)`,
        [u, password]
      );
    } catch (e) {
      if (e.code === '42P01') {
        return res.status(503).json({
          error: 'zb_simple_users missing',
          message: 'Run database/zentrya_biz_simple_supabase_auth.sql in Supabase SQL',
        });
      }
      if (e.code === '42703') {
        return res.status(503).json({
          error: 'Email column missing',
          message: 'Run database/zentrya_biz_zb_simple_users_email.sql in Supabase (or omit email in login until migrated).',
        });
      }
      if (e.message && e.message.includes('function crypt')) {
        return res.status(503).json({
          error: 'pgcrypto required',
          message: 'Enable extension pgcrypto in Postgres (Supabase: Database → Extensions)',
        });
      }
      throw e;
    }

    if (zbResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Zentrya username/password not found or incorrect',
      });
    }

    const zb = zbResult.rows[0];
    const lookupUserKey = String(zb.username).trim().toLowerCase();
    let userResult = await db.query(
      `SELECT user_id, username, name, role FROM users WHERE lower(trim(username)) = $1 AND is_active = true`,
      [lookupUserKey]
    );

    let user;
    if (userResult.rows.length > 0) {
      user = userResult.rows[0];
      await db.query(`UPDATE users SET zb_profile_id = COALESCE(zb_profile_id, $1::uuid) WHERE user_id = $2`, [
        zb.id,
        user.user_id,
      ]);
    } else {
      const displayName = (zb.full_name && String(zb.full_name).trim()) || zb.username || lookupUserKey;
      const passwordHash = await hashPassword(password);
      try {
        const ins = await db.query(
          `INSERT INTO users (name, username, password_hash, role, is_active, zb_profile_id)
           VALUES ($1, $2, $3, 'administrator', true, $4::uuid)
           RETURNING user_id, username, name, role`,
          [displayName, lookupUserKey, passwordHash, zb.id]
        );
        user = ins.rows[0];
      } catch (insErr) {
        if (insErr.code === '23505') {
          userResult = await db.query(
            `SELECT user_id, username, name, role FROM users WHERE lower(trim(username)) = $1 AND is_active = true`,
            [lookupUserKey]
          );
          if (userResult.rows.length === 0) throw insErr;
          user = userResult.rows[0];
        } else {
          throw insErr;
        }
      }
    }

    const sessionId = await createSession(user.user_id, deviceId, ipAddress, userAgent);
    await logLogin(user.user_id, ipAddress, userAgent, true);

    res.json({
      success: true,
      sessionId,
      user: {
        user_id: user.user_id,
        username: user.username,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[Auth Route] zb-simple-session error:', error);
    const msg = String(error?.message || '');
    const causeMsg = String(error?.cause?.message || '');
    const combined = `${msg} ${causeMsg}`.toLowerCase();
    const transientDb =
      combined.includes('connection terminated') ||
      combined.includes('connection timeout') ||
      combined.includes('terminated unexpectedly') ||
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('ENETUNREACH');
    if (transientDb) {
      return res.status(503).json({
        error: 'Database unreachable',
        message:
          'PostgreSQL timed out or dropped the connection while creating your API session. Check DATABASE_URL, Supabase pooler (try port 5432 session mode if 6543 fails), VPN/firewall, or increase DB_CONNECTION_TIMEOUT_MS in backend/.env. Wait a few seconds and log in again.',
      });
    }
    res.status(500).json({
      error: 'Session failed',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Could not create API session',
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout and destroy session
 */
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const sessionId = req.sessionId;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    await destroySession(sessionId);
    await logLogout(req.user.user_id, ipAddress, userAgent);

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('[Auth Route] Logout error:', error);
    res.status(500).json({
      error: 'Logout failed',
      message: 'An error occurred during logout'
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get('/me', requireAuth, async (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

/**
 * POST /api/auth/forgot-password
 * Generate password recovery token (offline)
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { username, securityAnswer, deviceId } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!username) {
      return res.status(400).json({
        error: 'Username required',
        message: 'Please provide your username'
      });
    }

    const result = await db.query(`
      SELECT user_id, username, security_answer_hash, security_question
      FROM users
      WHERE username = $1 AND is_active = true
    `, [username]);

    if (result.rows.length === 0) {
      // Don't reveal if user exists (security best practice)
      return res.json({
        success: true,
        message: 'If the username exists, a recovery key has been generated'
      });
    }

    const user = result.rows[0];

    // If security answer provided, verify it
    if (securityAnswer && user.security_answer_hash) {
      const isValid = await verifySecurityAnswer(securityAnswer, user.security_answer_hash);
      if (!isValid) {
        await logAuditEvent({
          userId: null,
          action: 'password_recovery_failed',
          notes: `Failed password recovery attempt for user: ${username}`,
          ipAddress,
          userAgent
        });
        return res.status(401).json({
          error: 'Invalid answer',
          message: 'The security answer is incorrect'
        });
      }
    }

    // Generate device-bound recovery key
    const currentDeviceId = deviceId || deviceFingerprint.getDeviceId();
    const recoveryKey = generateDeviceBoundRecoveryKey(currentDeviceId);
    
    // Store recovery token (temporary password)
    const resetToken = generateResetToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour validity

    await db.query(`
      UPDATE users
      SET password_reset_token = $1,
          password_reset_expires = $2
      WHERE user_id = $3
    `, [resetToken, expiresAt, user.user_id]);

    await logAuditEvent({
      userId: user.user_id,
      action: 'password_recovery_requested',
      notes: 'Password recovery key generated',
      ipAddress,
      userAgent
    });

    // Return recovery key (in production, this would be shown in a secure popup)
    res.json({
      success: true,
      recoveryKey,
      message: 'Recovery key generated. Use this to reset your password.',
      resetToken // Client will use this to reset password
    });
  } catch (error) {
    console.error('[Auth Route] Forgot password error:', error);
    res.status(500).json({
      error: 'Recovery failed',
      message: 'An error occurred during password recovery'
    });
  }
});

/**
 * POST /api/auth/reset-password
 * Reset password using recovery token
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { username, recoveryKey, resetToken, newPassword } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!username || !newPassword || (!recoveryKey && !resetToken)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Username, recovery key/token, and new password are required'
      });
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: 'Invalid password',
        message: passwordValidation.message
      });
    }

    const result = await db.query(`
      SELECT user_id, username, password_reset_token, password_reset_expires
      FROM users
      WHERE username = $1 AND is_active = true
    `, [username]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found'
      });
    }

    const user = result.rows[0];

    // Verify reset token
    if (resetToken && user.password_reset_token !== resetToken) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Invalid or expired recovery token'
      });
    }

    if (user.password_reset_expires && new Date() > new Date(user.password_reset_expires)) {
      return res.status(401).json({
        error: 'Token expired',
        message: 'Recovery token has expired. Please request a new one.'
      });
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update password and clear reset token
    await db.query(`
      UPDATE users
      SET password_hash = $1,
          password_reset_token = NULL,
          password_reset_expires = NULL,
          updated_at = NOW()
      WHERE user_id = $2
    `, [passwordHash, user.user_id]);

    await logAuditEvent({
      userId: user.user_id,
      action: 'password_reset',
      notes: 'Password reset successfully',
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Password reset successfully. Please log in with your new password.'
    });
  } catch (error) {
    console.error('[Auth Route] Reset password error:', error);
    res.status(500).json({
      error: 'Reset failed',
      message: 'An error occurred during password reset'
    });
  }
});

/**
 * POST /api/auth/change-password
 * Change password (requires authentication)
 */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.user_id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Current password and new password are required'
      });
    }

    // Get current password hash
    const result = await db.query(`
      SELECT password_hash FROM users WHERE user_id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'User not found'
      });
    }

    // Verify current password
    const isValid = await verifyPassword(currentPassword, result.rows[0].password_hash);
    if (!isValid) {
      return res.status(401).json({
        error: 'Invalid password',
        message: 'Current password is incorrect'
      });
    }

    // Validate new password
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        error: 'Invalid password',
        message: passwordValidation.message
      });
    }

    // Hash and update password
    const passwordHash = await hashPassword(newPassword);
    await db.query(`
      UPDATE users
      SET password_hash = $1, updated_at = NOW()
      WHERE user_id = $2
    `, [passwordHash, userId]);

    await logAuditEvent({
      userId,
      action: 'password_changed',
      notes: 'User changed their password',
      ipAddress,
      userAgent
    });

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('[Auth Route] Change password error:', error);
    res.status(500).json({
      error: 'Change failed',
      message: 'An error occurred while changing password'
    });
  }
});

module.exports = router;


