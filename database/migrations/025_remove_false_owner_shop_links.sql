-- Remove shop_users rows where user_id has role owner but is not shops.owner_id.

DELETE FROM public.shop_users su
USING public.shops s
WHERE su.shop_id = s.id
  AND su.user_id IS DISTINCT FROM s.owner_id
  AND lower(su.role::text) = 'owner';
