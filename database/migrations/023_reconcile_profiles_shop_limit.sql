-- Align profiles.shop_limit with plan (run after 024 if expired rows need shop_limit=0).
-- e.g. premium with shop_limit=4, or expired trial still at shop_limit=1.

UPDATE public.profiles
   SET shop_limit = CASE lower(coalesce(plan::text, 'trial'))
     WHEN 'expired' THEN 0
     WHEN 'premium' THEN 99999
     ELSE 1
   END
 WHERE shop_limit IS DISTINCT FROM (
   CASE lower(coalesce(plan::text, 'trial'))
     WHEN 'expired' THEN 0
     WHEN 'premium' THEN 99999
     ELSE 1
   END
 );
