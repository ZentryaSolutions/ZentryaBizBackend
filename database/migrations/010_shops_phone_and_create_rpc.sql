-- Shops: optional contact columns + RPC to create shops in the same DB as Supabase Table Editor.
-- Run in Supabase SQL Editor (HissaabKitab-DB) once.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS address text;

CREATE OR REPLACE FUNCTION public.zb_create_shop(
  p_profile_id uuid,
  p_name text,
  p_phone text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_business_type text DEFAULT 'General',
  p_city text DEFAULT NULL,
  p_currency text DEFAULT 'PKR'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_phone text := nullif(trim(coalesce(p_phone, '')), '');
  v_address text := nullif(trim(coalesce(p_address, '')), '');
  v_type text := coalesce(nullif(trim(coalesce(p_business_type, '')), ''), 'General');
  v_city text := nullif(trim(coalesce(p_city, '')), '');
  v_currency text := coalesce(nullif(trim(coalesce(p_currency, '')), ''), 'PKR');
  role_try text;
  linked boolean := false;
BEGIN
  IF v_name = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Shop name is required');
  END IF;
  IF p_profile_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Profile id is required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Profile not found');
  END IF;

  INSERT INTO public.shops (owner_id, name, phone, address, business_type, city, currency)
  VALUES (p_profile_id, v_name, v_phone, v_address, v_type, v_city, v_currency)
  RETURNING id INTO new_id;

  FOREACH role_try IN ARRAY ARRAY['owner', 'admin', 'administrator']::text[] LOOP
    BEGIN
      INSERT INTO public.shop_users (shop_id, user_id, role)
      VALUES (new_id, p_profile_id, role_try::public.zb_user_role);
      linked := true;
      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        linked := true;
        EXIT;
      WHEN OTHERS THEN
        NULL;
    END;
  END LOOP;

  IF NOT linked THEN
    DELETE FROM public.shops WHERE id = new_id;
    RETURN jsonb_build_object('ok', false, 'error', 'Could not link shop to your account');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'shopId', new_id,
    'id', new_id,
    'shop', jsonb_build_object(
      'id', new_id,
      'name', v_name,
      'phone', v_phone,
      'address', v_address,
      'business_type', v_type,
      'city', v_city,
      'currency', v_currency,
      'role', 'owner'
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.zb_create_shop(uuid, text, text, text, text, text, text) TO anon, authenticated, service_role;
