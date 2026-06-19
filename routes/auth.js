/**
 * Authentication Routes
 * Handles login, logout, password recovery, and user management
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const { shopLimitForPlan } = require('../lib/planShopLimits');
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
  destroyAllUserSessions,
  requireAuth, 
  requireRole 
} = require('../middleware/authMiddleware');
const { logLogin, logLogout, logAuditEvent } = require('../utils/auditLogger');
const deviceFingerprint = require('../utils/deviceFingerprint');
const { validateEmailOtpMatch, markEmailOtpConsumed, normalizeEmail } = require('../utils/emailOtpVerify');
const notificationsModule = require('./notifications');
const createNotification = notificationsModule.createNotification || (async () => {});
const { issueEmailOtp } = require('../utils/emailOtpIssue');
const { isDeviceTrusted, addTrustedDevice } = require('../utils/trustedDevices');
const { consumeLogoutAllToken } = require('../utils/emailSecurityTokens');
const { sendLoginAlertEmail, getFrontendBaseUrl } = require('../utils/loginAlertEmail');
const { verifyGoogleIdToken, getGoogleClientId } = require('../utils/googleIdToken');
const { applySignupAccountProfile, normalizeSignupAccountType } = require('../lib/accountRoles');
const {
  refreshPlanLifecycleForProfile,
  maybeSendPlanRenewalReminder,
} = require('../utils/planLifecycle');
const crypto = require('crypto');

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

  const shopLimit = shopLimitForPlan(planStr);
  try {
    await client.query(
      `UPDATE public.profiles
          SET shop_limit = $2,
              trial_started_at = CASE
                WHEN $3::text = 'trial' THEN COALESCE(trial_started_at, now())
                ELSE trial_started_at
              END,
              trial_ends_at = CASE
                WHEN $3::text = 'trial' THEN COALESCE(trial_ends_at, now() + interval '14 days')
                ELSE trial_ends_at
              END
        WHERE id = $1::uuid`,
      [zbId, shopLimit, planStr]
    );
  } catch (e) {
    if (/trial_started_at|trial_ends_at/i.test(String(e.message || ''))) {
      await client.query(`UPDATE public.profiles SET shop_limit = $2 WHERE id = $1::uuid`, [zbId, shopLimit]);
    } else if (!/shop_limit/i.test(String(e.message || ''))) {
      throw e;
    }
  }
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

function maskEmailHint(emailRaw) {
  const e = normalizeEmail(emailRaw);
  const [u, d] = e.split('@');
  if (!u || !d) return '';
  const vis = u.length <= 2 ? `${u.slice(0, 1)}••` : `${u.slice(0, 2)}•••`;
  return `${vis}@${d}`;
}

/** After password (+ optional OTP), create session, trust device, audit log, login alert email. */
async function finalizeZbSimpleAuthSession(req, { user, zb, deviceId, ipAddress, userAgent }) {
  const sessionId = await createSession(user.user_id, deviceId, ipAddress, userAgent);
  await Promise.all([
    addTrustedDevice(user.user_id, deviceId),
    logLogin(user.user_id, ipAddress, userAgent, true, {
      shopId: user.shop_id || null,
      userName: user.name || user.username,
      method: 'email',
    }),
  ]);
  const em =
    normalizeEmail(zb.email) ||
    String(zb.username || '')
      .trim()
      .toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    sendLoginAlertEmail(req, {
      to: em,
      displayName: user.name,
      userId: user.user_id,
    }).catch((e) => {
      console.warn('[Auth Route] login alert email:', e.message);
    });
  }
  return sessionId;
}

function buildZbAuthPayload(zb, planStatus = null) {
  const email =
    normalizeEmail(zb.email) ||
    String(zb.username || '')
      .trim()
      .toLowerCase();
  return {
    user_id: zb.id,
    username: zb.username,
    full_name: zb.full_name,
    email,
    plan: planStatus?.plan || null,
    trial_ends_at: planStatus?.trial_ends_at || null,
    stripe_current_period_end: planStatus?.stripe_current_period_end || null,
  };
}

/**
 * Verifies zb_simple_users password and returns linked `users` row (creating it if absent).
 */
async function resolveZbSimpleLogin(username, password) {
  if (!username || !password) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid credentials', message: 'Username and password are required' },
    };
  }

  if (!db.isDatabaseConfigured()) {
    return {
      ok: false,
      status: 503,
      body: { error: 'Database not configured', message: 'Set DATABASE_URL in backend/.env' },
    };
  }

  const u = String(username).trim().toLowerCase();
  if (u.length < 2) {
    return { ok: false, status: 400, body: { error: 'Invalid username', message: 'Username too short' } };
  }

  let zbResult;
  try {
    zbResult = await db.query(
      `SELECT id, full_name, username, email, COALESCE(mfa_email_enabled, false) AS mfa_email_enabled
       FROM zb_simple_users
       WHERE (lower(trim(username)) = $1 OR lower(trim(coalesce(email, ''))) = $1)
         AND password_hash = crypt($2::text, password_hash)`,
      [u, password]
    );
  } catch (e) {
    if (e.code === '42P01') {
      return {
        ok: false,
        status: 503,
        body: {
          error: 'zb_simple_users missing',
          message: 'Run database/zentrya_biz_simple_supabase_auth.sql in Supabase SQL',
        },
      };
    }
    if (e.code === '42703') {
      return {
        ok: false,
        status: 503,
        body: {
          error: 'Email or MFA column missing',
          message: 'Run database migrations (zb_simple_users email + mfa_email_enabled).',
        },
      };
    }
    if (e.message && e.message.includes('function crypt')) {
      return {
        ok: false,
        status: 503,
        body: {
          error: 'pgcrypto required',
          message: 'Enable extension pgcrypto in Postgres (Supabase: Database → Extensions)',
        },
      };
    }
    throw e;
  }

  if (zbResult.rows.length === 0) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Invalid credentials',
        message: 'Email or Password incorrect',
      },
    };
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

  return { ok: true, zb, user };
}

/** Lookup zb_simple_users by email (no password) — for Google sign-in + OTP completion. */
async function resolveZbByEmail(email) {
  const em = normalizeEmail(email);
  if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    return { ok: false, status: 400, body: { error: 'Valid email required' } };
  }
  if (!db.isDatabaseConfigured()) {
    return {
      ok: false,
      status: 503,
      body: { error: 'Database not configured', message: 'Set DATABASE_URL in backend/.env' },
    };
  }

  let zbResult;
  try {
    zbResult = await db.query(
      `SELECT id, full_name, username, email, COALESCE(mfa_email_enabled, false) AS mfa_email_enabled
       FROM zb_simple_users
       WHERE lower(trim(coalesce(email, ''))) = $1 OR lower(trim(username)) = $1
       LIMIT 1`,
      [em]
    );
  } catch (e) {
    if (e.code === '42P01') {
      return {
        ok: false,
        status: 503,
        body: { error: 'zb_simple_users missing', message: 'Run database migrations in Supabase' },
      };
    }
    throw e;
  }

  if (!zbResult.rows.length) {
    return { ok: false, status: 404, body: { error: 'Account not found', message: 'No account for this email' } };
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
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
    const ins = await db.query(
      `INSERT INTO users (name, username, password_hash, role, is_active, zb_profile_id)
       VALUES ($1, $2, $3, 'administrator', true, $4::uuid)
       RETURNING user_id, username, name, role`,
      [displayName, lookupUserKey, passwordHash, zb.id]
    );
    user = ins.rows[0];
  }

  return { ok: true, zb, user };
}

/**
 * Find or create zb_simple_users + users for Google Sign-In.
 */
async function resolveOrCreateZbGoogleUser({ email, googleSub, fullName, accountType }) {
  const em = normalizeEmail(email);
  const sub = String(googleSub || '').trim();
  const name = String(fullName || '').trim() || em.split('@')[0];

  if (!db.isDatabaseConfigured()) {
    return {
      ok: false,
      status: 503,
      body: { error: 'Database not configured', message: 'Set DATABASE_URL in backend/.env' },
    };
  }

  let bySub;
  try {
    bySub = await db.query(
      `SELECT id, full_name, username, email, COALESCE(mfa_email_enabled, false) AS mfa_email_enabled
       FROM zb_simple_users WHERE google_sub = $1 LIMIT 1`,
      [sub]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
    bySub = { rows: [] };
  }

  if (bySub.rows.length) {
    const zb = bySub.rows[0];
    const lookupUserKey = String(zb.username).trim().toLowerCase();
    let userResult = await db.query(
      `SELECT user_id, username, name, role FROM users WHERE lower(trim(username)) = $1 AND is_active = true`,
      [lookupUserKey]
    );
    if (userResult.rows.length) {
      const user = userResult.rows[0];
      await db.query(`UPDATE users SET zb_profile_id = COALESCE(zb_profile_id, $1::uuid) WHERE user_id = $2`, [
        zb.id,
        user.user_id,
      ]);
      return { ok: true, zb, user, isNew: false };
    }
    const displayName = (zb.full_name && String(zb.full_name).trim()) || name;
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
    const ins = await db.query(
      `INSERT INTO users (name, username, password_hash, role, is_active, zb_profile_id)
       VALUES ($1, $2, $3, 'administrator', true, $4::uuid)
       RETURNING user_id, username, name, role`,
      [displayName, lookupUserKey, passwordHash, zb.id]
    );
    return { ok: true, zb, user: ins.rows[0], isNew: false };
  }

  const existingEmail = await db.query(
    `SELECT id, full_name, username, email, COALESCE(mfa_email_enabled, false) AS mfa_email_enabled
     FROM zb_simple_users
     WHERE lower(trim(coalesce(email, ''))) = $1 OR lower(trim(username)) = $1
     LIMIT 1`,
    [em]
  );

  if (existingEmail.rows.length) {
    const zb = existingEmail.rows[0];
    try {
      await db.query(`UPDATE zb_simple_users SET google_sub = $1 WHERE id = $2::uuid AND (google_sub IS NULL OR google_sub = '')`, [
        sub,
        zb.id,
      ]);
    } catch (e) {
      if (e.code !== '42703') throw e;
    }
    const lookupUserKey = String(zb.username).trim().toLowerCase();
    let userResult = await db.query(
      `SELECT user_id, username, name, role FROM users WHERE lower(trim(username)) = $1 AND is_active = true`,
      [lookupUserKey]
    );
    let user;
    if (userResult.rows.length) {
      user = userResult.rows[0];
      await db.query(`UPDATE users SET zb_profile_id = COALESCE(zb_profile_id, $1::uuid) WHERE user_id = $2`, [
        zb.id,
        user.user_id,
      ]);
    } else {
      const displayName = (zb.full_name && String(zb.full_name).trim()) || name;
      const passwordHash = await hashPassword(crypto.randomBytes(24).toString('hex'));
      const ins = await db.query(
        `INSERT INTO users (name, username, password_hash, role, is_active, zb_profile_id)
         VALUES ($1, $2, $3, 'administrator', true, $4::uuid)
         RETURNING user_id, username, name, role`,
        [displayName, lookupUserKey, passwordHash, zb.id]
      );
      user = ins.rows[0];
    }
    return { ok: true, zb, user, isNew: false };
  }

  const client = await db.getClient();
  const randomSecret = crypto.randomBytes(32).toString('hex');
  try {
    await client.query('BEGIN');
    let zbRow;
    await client.query('SAVEPOINT sp_google_zb');
    try {
      const ins = await client.query(
        `INSERT INTO zb_simple_users (username, full_name, email, password_hash, google_sub)
         VALUES ($1, $2, $3, crypt($4::text, gen_salt('bf'::text)), $5)
         RETURNING id, username, full_name, email, COALESCE(mfa_email_enabled, false) AS mfa_email_enabled`,
        [em, name, em, randomSecret, sub]
      );
      zbRow = ins.rows[0];
      await client.query('RELEASE SAVEPOINT sp_google_zb');
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_google_zb');
      if (e.code !== '42703') throw e;
      const ins = await client.query(
        `INSERT INTO zb_simple_users (username, full_name, email, password_hash)
         VALUES ($1, $2, $3, crypt($4::text, gen_salt('bf'::text)))
         RETURNING id, username, full_name, email, COALESCE(mfa_email_enabled, false) AS mfa_email_enabled`,
        [em, name, em, randomSecret]
      );
      zbRow = ins.rows[0];
    }

    const signupKind = normalizeSignupAccountType(accountType);
    await insertProfileWithFallbacks(client, {
      zbId: zbRow.id,
      displayName: name,
      userRole: signupKind === 'cashier' ? 'cashier' : 'administrator',
      planRaw: signupKind === 'cashier' ? 'starter' : 'trial',
    });
    await applySignupAccountProfile(client, zbRow.id, signupKind, { updateUsersRow: false });

    const passwordHash = await hashPassword(randomSecret);
    const userIns = await client.query(
      `INSERT INTO users (name, username, password_hash, role, is_active, zb_profile_id)
       VALUES ($1, $2, $3, $4, true, $5::uuid)
       RETURNING user_id, username, name, role`,
      [name, em, passwordHash, signupKind === 'cashier' ? 'cashier' : 'administrator', zbRow.id]
    );

    await client.query('COMMIT');
    return { ok: true, zb: zbRow, user: userIns.rows[0], isNew: true };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    if (e.code === '23505') {
      return {
        ok: false,
        status: 409,
        body: { error: 'Account already exists', message: 'Use email/password sign-in or try again.' },
      };
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * MFA / new-device checks → session or OTP challenge (shared by password + Google login).
 */
async function beginZbApiSession(req, { zb, user }) {
  const deviceId = req.headers['x-device-id'] || deviceFingerprint.getDeviceId();
  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('user-agent');
  let planStatus = null;
  try {
    planStatus = await refreshPlanLifecycleForProfile(zb.id);
    if (planStatus && String(planStatus.plan || '').toLowerCase() !== 'trial') {
      maybeSendPlanRenewalReminder(zb.id).catch((e) => {
        console.warn('[Auth Route] plan renewal reminder:', e.message);
      });
    }
  } catch (e) {
    console.warn('[Auth Route] plan lifecycle:', e.message);
  }

  if (zb.mfa_email_enabled) {
    const em =
      normalizeEmail(zb.email) ||
      String(zb.username || '')
        .trim()
        .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'Two-factor is enabled but this account has no valid email on file.',
        },
      };
    }
    try {
      await issueEmailOtp(req, em, 'login');
    } catch (e) {
      if (e.code === 'OTP_RATE_LIMIT') {
        return { ok: false, status: 429, body: { error: 'Too many requests. Try again later.' } };
      }
      throw e;
    }
    return {
      ok: true,
      requiresOtp: true,
      otpKind: 'mfa',
      emailHint: maskEmailHint(em),
      zb,
      user,
      planStatus,
    };
  }

  const zbEmail =
    normalizeEmail(zb.email) ||
    String(zb.username || '')
      .trim()
      .toLowerCase();
  const trusted = await isDeviceTrusted(user.user_id, deviceId);
  if (!trusted) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(zbEmail)) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'Security check requires a valid email on your account.',
        },
      };
    }
    try {
      await issueEmailOtp(req, zbEmail, 'new_device');
    } catch (e) {
      if (e.code === 'OTP_RATE_LIMIT') {
        return { ok: false, status: 429, body: { error: 'Too many requests. Try again later.' } };
      }
      throw e;
    }
    return {
      ok: true,
      requiresOtp: true,
      otpKind: 'new_device',
      emailHint: maskEmailHint(zbEmail),
      zb,
      user,
      planStatus,
    };
  }

  const sessionId = await finalizeZbSimpleAuthSession(req, {
    user,
    zb,
    deviceId,
    ipAddress,
    userAgent,
  });

  return {
    ok: true,
    sessionId,
    user: {
      user_id: user.user_id,
      username: user.username,
      name: user.name,
      role: user.role,
    },
    zb,
    planStatus,
  };
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
    const { fullName, email, password, otp, accountType } = req.body || {};
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

    try {
      await applySignupAccountProfile(db, data.user_id, accountType);
    } catch (profileErr) {
      console.warn('[Auth] zb-signup account profile:', profileErr.message);
    }

    return res.json({
      ok: true,
      user_id: data.user_id,
      username: data.username,
      full_name: data.full_name,
      account_type: normalizeSignupAccountType(accountType),
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
 * POST /api/auth/zb-change-password
 * Zentrya browser login: verify current password on zb_simple_users (pgcrypto), update crypt hash + linked users row (bcrypt).
 */
router.post('/zb-change-password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body || {};
    const em = normalizeEmail(email);
    const cur = String(currentPassword ?? '');
    const nw = String(newPassword ?? '');

    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        message:
          'The server is not connected to your database. Use “Forgot password” on sign-in or try again later.',
      });
    }
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!cur) {
      return res.status(400).json({ error: 'Enter your current password' });
    }
    const pwdVal = validatePassword(nw);
    if (!pwdVal.valid) {
      return res.status(400).json({ error: pwdVal.message || 'Invalid new password' });
    }

    let zbVerify;
    try {
      zbVerify = await db.query(
        `SELECT id, username FROM public.zb_simple_users
         WHERE lower(trim(coalesce(email,''))) = $1
           AND password_hash = crypt($2::text, password_hash)`,
        [em, cur]
      );
    } catch (e) {
      if (e.code === '42P01') {
        return res.status(503).json({ error: 'Account store not ready', message: 'zb_simple_users table missing.' });
      }
      throw e;
    }

    if (zbVerify.rows.length === 0) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const zbId = zbVerify.rows[0].id;
    const uname = String(zbVerify.rows[0].username || '').trim().toLowerCase();

    await db.query(
      `UPDATE public.zb_simple_users SET password_hash = crypt($1::text, gen_salt('bf'::text)) WHERE id = $2::uuid`,
      [nw, zbId]
    );

    const bcryptHash = await hashPassword(nw);
    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE is_active = true AND (zb_profile_id = $2::uuid OR lower(trim(username)) = $3)`,
      [bcryptHash, zbId, uname]
    );

    return res.json({ ok: true, message: 'Password updated' });
  } catch (error) {
    console.error('[Auth Route] zb-change-password error:', error);
    res.status(500).json({
      error: 'Password change failed',
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
        await logLogin(null, ipAddress, userAgent, false, { method: 'PIN', attemptedUser: 'invalid PIN format' });
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
 * POST /api/auth/google
 * Sign in with Google (GIS id_token). Does not change email/password login.
 */
router.post('/google', async (req, res) => {
  try {
    if (!getGoogleClientId()) {
      return res.status(503).json({
        error: 'Google sign-in not configured',
        message: 'Set GOOGLE_OAUTH_CLIENT_ID on the backend (same Web client ID as frontend).',
      });
    }

    const credential = req.body?.credential || req.body?.id_token;
    const accountType = req.body?.accountType;
    const googleUser = await verifyGoogleIdToken(credential);
    const resolved = await resolveOrCreateZbGoogleUser({
      email: googleUser.email,
      googleSub: googleUser.sub,
      fullName: googleUser.name,
      accountType,
    });
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body);
    }

    const { zb, user, isNew } = resolved;
    const flow = await beginZbApiSession(req, { zb, user });
    if (!flow.ok) {
      return res.status(flow.status).json(flow.body);
    }

    if (flow.requiresOtp) {
      return res.json({
        success: true,
        requiresOtp: true,
        otpKind: flow.otpKind,
        emailHint: flow.emailHint,
        authMethod: 'google',
        isNewAccount: Boolean(isNew),
        ...buildZbAuthPayload(zb, flow.planStatus),
      });
    }

    return res.json({
      success: true,
      sessionId: flow.sessionId,
      user: flow.user,
      authMethod: 'google',
      isNewAccount: Boolean(isNew),
      ...buildZbAuthPayload(zb, flow.planStatus),
    });
  } catch (error) {
    console.error('[Auth Route] google sign-in error:', error);
    const code = error.code;
    if (code === 'GOOGLE_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message });
    }
    if (code === 'INVALID_TOKEN' || code === 'NO_EMAIL' || code === 'EMAIL_NOT_VERIFIED') {
      return res.status(401).json({ error: error.message });
    }
    res.status(500).json({
      error: 'Google sign-in failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/auth/google/verify-otp
 * Complete Google sign-in after MFA or new-device email code (no password).
 */
router.post('/google/verify-otp', async (req, res) => {
  try {
    const { email, otp, otpKind } = req.body || {};
    const deviceId = req.headers['x-device-id'] || deviceFingerprint.getDeviceId();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    const resolved = await resolveZbByEmail(email);
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body);
    }
    const { zb, user } = resolved;

    const em =
      normalizeEmail(zb.email) ||
      String(zb.username || '')
        .trim()
        .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return res.status(400).json({ error: 'Invalid account email for OTP verification' });
    }

    const otpKindNorm = String(otpKind || '')
      .trim()
      .toLowerCase();
    let purpose;
    if (zb.mfa_email_enabled) {
      purpose = 'login';
    } else if (otpKindNorm === 'new_device') {
      purpose = 'new_device';
    } else {
      return res.status(400).json({
        error: 'Invalid verification request',
        message: 'Use the security code sent to your email.',
      });
    }

    const otpCode = String(otp || '').trim();
    const otpCheck = await validateEmailOtpMatch(em, otpCode, purpose);
    if (!otpCheck.ok) {
      return res.status(400).json({ error: otpCheck.error || 'Invalid code' });
    }
    await markEmailOtpConsumed(otpCheck.rowId);

    const sessionId = await finalizeZbSimpleAuthSession(req, {
      user,
      zb,
      deviceId,
      ipAddress,
      userAgent,
    });

    res.json({
      success: true,
      sessionId,
      user: {
        user_id: user.user_id,
        username: user.username,
        name: user.name,
        role: user.role,
      },
      user_id: zb.id,
      username: zb.username,
      full_name: zb.full_name,
      email: em,
    });
  } catch (error) {
    console.error('[Auth Route] google/verify-otp error:', error);
    res.status(500).json({
      error: 'Session failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * POST /api/auth/google/resend-otp
 * Resend MFA or new-device code during Google sign-in (no password).
 */
router.post('/google/resend-otp', async (req, res) => {
  try {
    const em = normalizeEmail(req.body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const resolved = await resolveZbByEmail(em);
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body);
    }
    const { zb } = resolved;
    const purpose = zb.mfa_email_enabled ? 'login' : 'new_device';
    await issueEmailOtp(req, em, purpose);
    return res.json({
      success: true,
      otpKind: zb.mfa_email_enabled ? 'mfa' : 'new_device',
      emailHint: maskEmailHint(em),
    });
  } catch (e) {
    if (e.code === 'OTP_RATE_LIMIT') {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    console.error('[Auth Route] google/resend-otp:', e);
    return res.status(500).json({ error: 'Could not resend code' });
  }
});

/**
 * POST /api/auth/zb-simple-session
 * Zentrya web login uses public.zb_simple_users (pgcrypto). Legacy LAN API routes use users + user_sessions.
 * Verifies the same username/password against zb_simple_users, finds or creates a users row, returns sessionId.
 */
router.post('/zb-simple-session', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    const resolved = await resolveZbSimpleLogin(username, password);
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body);
    }
    const { zb, user } = resolved;

    const flow = await beginZbApiSession(req, { zb, user });
    if (!flow.ok) {
      return res.status(flow.status).json(flow.body);
    }
    if (flow.requiresOtp) {
      return res.json({
        success: true,
        requiresOtp: true,
        otpKind: flow.otpKind,
        emailHint: flow.emailHint,
        ...buildZbAuthPayload(zb, flow.planStatus),
      });
    }

    res.json({
      success: true,
      sessionId: flow.sessionId,
      user: flow.user,
      ...buildZbAuthPayload(zb, flow.planStatus),
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
    const debugEnabled = String(process.env.API_DEBUG_ERRORS || '').trim().toLowerCase() === 'true';
    const debugMsg = debugEnabled ? (error?.message || String(error)) : null;
    res.status(500).json({
      error: 'Session failed',
      message: process.env.NODE_ENV === 'development' ? error.message : debugMsg || 'Could not create API session',
      ...(debugEnabled ? { detail: { code: error?.code, hint: error?.hint } } : {}),
    });
  }
});

/**
 * POST /api/auth/zb-simple-session/verify-otp
 * Completes zb-simple-session after password + login OTP when mfa_email_enabled is true.
 */
router.post('/zb-simple-session/verify-otp', async (req, res) => {
  try {
    const { username, password, otp, otpKind } = req.body || {};
    const deviceId = req.headers['x-device-id'] || deviceFingerprint.getDeviceId();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    if (!password) {
      return res.status(400).json({
        error: 'password required',
        message: 'Password is required to verify the login code.',
      });
    }
    const resolved = await resolveZbSimpleLogin(username, password);
    if (!resolved.ok) {
      return res.status(resolved.status).json(resolved.body);
    }

    const { zb, user } = resolved;

    const em =
      normalizeEmail(zb.email) ||
      String(zb.username || '')
        .trim()
        .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return res.status(400).json({ error: 'Invalid account email for OTP verification' });
    }

    const otpKindNorm = String(otpKind || '')
      .trim()
      .toLowerCase();
    let purpose;
    if (zb.mfa_email_enabled) {
      purpose = 'login';
    } else if (otpKindNorm === 'new_device') {
      purpose = 'new_device';
    } else {
      return res.status(400).json({
        error: 'Invalid verification request',
        message:
          'Use the security code sent when signing in from a new browser, or sign in without a code from a trusted device.',
      });
    }

    const otpCode = String(otp || '').trim();
    const otpCheck = await validateEmailOtpMatch(em, otpCode, purpose);
    if (!otpCheck.ok) {
      return res.status(400).json({ error: otpCheck.error || 'Invalid code' });
    }
    await markEmailOtpConsumed(otpCheck.rowId);

    const sessionId = await finalizeZbSimpleAuthSession(req, {
      user,
      zb,
      deviceId,
      ipAddress,
      userAgent,
    });

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
    console.error('[Auth Route] zb-simple-session/verify-otp error:', error);
    res.status(500).json({
      error: 'Session failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * GET /api/auth/email-revoke-sessions?token=...
 * One-time link from login alert email — invalidates all API sessions for the account.
 */
router.get('/email-revoke-sessions', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const r = await consumeLogoutAllToken(token);
    if (!r.ok) {
      return res.status(400).send(String(r.error || 'Invalid or expired link'));
    }
    await destroyAllUserSessions(r.userId);
    const fe = getFrontendBaseUrl();
    if (fe) {
      return res.redirect(302, `${fe}/login?revoked=1`);
    }
    return res.type('html').send(
      '<!doctype html><html><head><meta charset="utf-8"><title>Signed out</title></head><body style="font-family:system-ui;padding:24px">' +
        '<p>All sessions for this account have been signed out. You can close this window.</p></body></html>'
    );
  } catch (error) {
    console.error('[Auth Route] email-revoke-sessions:', error);
    res.status(500).send('Could not complete request');
  }
});

/**
 * GET /api/auth/zb-email-mfa — current user's email OTP MFA toggle (zb_simple_users).
 */
router.get('/zb-email-mfa', requireAuth, async (req, res) => {
  try {
    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const uidResult = await db.query(`SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`, [
      req.user.user_id,
    ]);
    const profileId = uidResult.rows[0]?.zb_profile_id;
    if (!profileId) {
      return res.status(404).json({ error: 'Profile not linked', message: 'zb_profile_id missing on users row.' });
    }

    const zb = await db.query(
      `SELECT mfa_email_enabled::boolean AS mfa_email_enabled, email FROM zb_simple_users WHERE id = $1::uuid LIMIT 1`,
      [profileId]
    );
    if (!zb.rows.length) {
      return res.status(404).json({ error: 'Zentrya profile not found' });
    }
    const row = zb.rows[0];
    res.json({
      success: true,
      enabled: Boolean(row.mfa_email_enabled),
      emailHint: row.email ? maskEmailHint(row.email) : '',
    });
  } catch (error) {
    console.error('[Auth Route] zb-email-mfa GET:', error);
    res.status(500).json({ error: 'Failed to load MFA setting' });
  }
});

/**
 * PUT /api/auth/zb-email-mfa — body: { enabled: boolean }
 */
router.put('/zb-email-mfa', requireAuth, async (req, res) => {
  try {
    if (!db.isDatabaseConfigured()) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const enabled = Boolean(req.body?.enabled);

    const uidResult = await db.query(`SELECT zb_profile_id FROM users WHERE user_id = $1 AND is_active = true`, [
      req.user.user_id,
    ]);
    const profileId = uidResult.rows[0]?.zb_profile_id;
    if (!profileId) {
      return res.status(404).json({ error: 'Profile not linked', message: 'zb_profile_id missing on users row.' });
    }

    await db.query(`UPDATE zb_simple_users SET mfa_email_enabled = $1 WHERE id = $2::uuid`, [
      enabled,
      profileId,
    ]);

    res.json({ success: true, enabled });
  } catch (error) {
    console.error('[Auth Route] zb-email-mfa PUT:', error);
    res.status(500).json({ error: 'Failed to update MFA setting' });
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
    await logLogout(req.user.user_id, ipAddress, userAgent, {
      shopId: req.shopId || req.user?.shop_id || null,
      userName: req.user?.name || req.user?.username,
    });

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


