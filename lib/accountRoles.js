const STAFF_PROFILE_ROLES = new Set(['cashier', 'salesman', 'staff', 'user']);
const OWNER_PROFILE_ROLES = new Set(['owner', 'admin', 'administrator']);

function isStaffProfileRole(role) {
  return STAFF_PROFILE_ROLES.has(String(role || '').trim().toLowerCase());
}

function isShopOwnerProfileRole(role) {
  return OWNER_PROFILE_ROLES.has(String(role || '').trim().toLowerCase());
}

function normalizeSignupAccountType(raw) {
  const v = String(raw || 'shop_owner')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (v === 'cashier' || v === 'staff') return 'cashier';
  return 'shop_owner';
}

async function applySignupAccountProfile(client, profileId, accountType, { updateUsersRow = true } = {}) {
  const kind = normalizeSignupAccountType(accountType);
  const q = client;

  if (kind === 'cashier') {
    try {
      await q.query(
        `UPDATE public.profiles
            SET role = 'cashier'::public.zb_user_role,
                plan = 'starter'::public.zb_plan,
                shop_limit = 0,
                trial_started_at = NULL,
                trial_ends_at = NULL,
                signup_kind = 'cashier'
          WHERE id = $1::uuid`,
        [profileId]
      );
    } catch (e) {
      if (e.code !== '42703') throw e;
      await q.query(
        `UPDATE public.profiles
            SET role = 'cashier'::public.zb_user_role,
                plan = 'starter'::public.zb_plan,
                shop_limit = 0,
                trial_started_at = NULL,
                trial_ends_at = NULL
          WHERE id = $1::uuid`,
        [profileId]
      );
    }
    if (updateUsersRow) {
      await q.query(
        `UPDATE public.users
            SET role = 'cashier'
          WHERE zb_profile_id = $1::uuid`,
        [profileId]
      );
    }
    return 'cashier';
  }

  try {
    await q.query(
      `UPDATE public.profiles
          SET role = COALESCE(NULLIF(role::text, ''), 'administrator')::public.zb_user_role,
              plan = COALESCE(plan, 'trial'::public.zb_plan),
              shop_limit = GREATEST(COALESCE(shop_limit, 1), 1),
              signup_kind = 'shop_owner'
        WHERE id = $1::uuid`,
      [profileId]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
    await q.query(
      `UPDATE public.profiles
          SET role = COALESCE(NULLIF(role::text, ''), 'administrator')::public.zb_user_role,
              plan = COALESCE(plan, 'trial'::public.zb_plan),
              shop_limit = GREATEST(COALESCE(shop_limit, 1), 1)
        WHERE id = $1::uuid`,
      [profileId]
    );
  }
  return 'shop_owner';
}

async function getSignupKindState(client, profileId) {
  const q = client;
  if (!profileId) {
    return { needsSignupRole: false, signup_kind: null, profile_role: null };
  }
  try {
    const res = await q.query(
      `SELECT signup_kind, role::text AS profile_role
         FROM public.profiles
        WHERE id = $1::uuid
        LIMIT 1`,
      [profileId]
    );
    const row = res.rows[0];
    const kind = row?.signup_kind;
    const needsSignupRole = kind == null || String(kind).trim() === '';
    return {
      needsSignupRole,
      signup_kind: kind || null,
      profile_role: row?.profile_role || null,
    };
  } catch (e) {
    if (e.code === '42703') {
      return { needsSignupRole: false, signup_kind: null, profile_role: null };
    }
    throw e;
  }
}

module.exports = {
  STAFF_PROFILE_ROLES,
  OWNER_PROFILE_ROLES,
  isStaffProfileRole,
  isShopOwnerProfileRole,
  normalizeSignupAccountType,
  applySignupAccountProfile,
  getSignupKindState,
};
