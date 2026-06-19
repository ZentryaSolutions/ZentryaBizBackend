-- Enforce profiles.shop_limit on new shops (even direct Supabase client inserts).
-- Run after 007_profiles_shop_limit.sql.

CREATE OR REPLACE FUNCTION public.enforce_owner_shop_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lim integer;
  used integer;
  owner_plan text;
BEGIN
  SELECT p.shop_limit, lower(coalesce(p.plan::text, 'trial'))
  INTO lim, owner_plan
  FROM public.profiles p
  WHERE p.id = NEW.owner_id;

  IF lim IS NULL THEN
    IF owner_plan = 'premium' THEN
      lim := 99999;
    ELSIF owner_plan = 'expired' THEN
      lim := 0;
    ELSE
      lim := 1;
    END IF;
  END IF;

  IF lim <= 0 THEN
    RAISE EXCEPTION 'subscription_expired'
      USING ERRCODE = 'P0001',
            MESSAGE = 'Subscription expired. Renew your plan to create shops.';
  END IF;

  IF lim >= 99999 THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::int INTO used FROM public.shops WHERE owner_id = NEW.owner_id;
  IF used >= lim THEN
    RAISE EXCEPTION 'shop_limit_reached'
      USING ERRCODE = 'P0001',
            MESSAGE = format('Shop limit reached (%s). Upgrade your plan to add more shops.', lim);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shops_enforce_plan_limit ON public.shops;
CREATE TRIGGER trg_shops_enforce_plan_limit
  BEFORE INSERT ON public.shops
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_owner_shop_limit();
