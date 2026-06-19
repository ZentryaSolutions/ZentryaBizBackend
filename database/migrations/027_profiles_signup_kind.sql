ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS signup_kind text;

COMMENT ON COLUMN public.profiles.signup_kind IS 'shop_owner or cashier — chosen at self-signup';

-- Staff accounts do not carry their own subscription; clear expired trials copied from invites.
UPDATE public.profiles
   SET plan = 'starter'::public.zb_plan,
       shop_limit = 0,
       trial_started_at = NULL,
       trial_ends_at = NULL,
       signup_kind = COALESCE(signup_kind, 'cashier')
 WHERE lower(coalesce(role::text, '')) IN ('cashier', 'salesman', 'staff', 'user')
   AND lower(coalesce(plan::text, '')) IN ('expired', 'trial');
