-- Allow shop_limit = 0 for expired subscriptions (trial expiry sets plan=expired, shop_limit=0).
-- Without this, profiles_shop_limit_check (shop_limit >= 1) blocks expireTrialIfNeeded.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_shop_limit_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_shop_limit_check CHECK (shop_limit >= 0);
