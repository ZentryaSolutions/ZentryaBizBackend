-- Remove erroneous shop_users rows where a shop OWNER was linked to another shop's team.
-- (Caused by legacy repairOwnerShopLinks cross-linking profile ids.)
-- Keeps invited staff (admin/cashier roles) on shops they do not own.

DELETE FROM public.shop_users su
WHERE EXISTS (
  SELECT 1
  FROM public.shops owned
  WHERE owned.owner_id = su.user_id
    AND owned.id IS DISTINCT FROM su.shop_id
)
AND lower(su.role::text) IN ('owner', 'administrator');
