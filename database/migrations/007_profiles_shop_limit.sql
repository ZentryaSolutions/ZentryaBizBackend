-- Subscription shop limits on public.profiles (Growth = 1, Business = unlimited).
-- Run in Supabase SQL editor if not already applied.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS shop_limit integer;

UPDATE public.profiles
SET shop_limit = CASE
  WHEN lower(coalesce(plan::text, '')) = 'premium' THEN 99999
  WHEN lower(coalesce(plan::text, '')) = 'expired' THEN 0
  ELSE 1
END
WHERE shop_limit IS NULL;

ALTER TABLE public.profiles
  ALTER COLUMN shop_limit SET DEFAULT 1;

COMMENT ON COLUMN public.profiles.shop_limit IS 'Max shops owner may create; 99999 = unlimited (Business/premium).';
