-- Zentrya / HisaabKitab: allow duplicate full names; only email must be unique for signup.
-- Run in Supabase SQL Editor (or psql) on the same database as zb_simple_users.
--
-- IMPORTANT
-- - Do NOT drop the `username` column on `zb_simple_users` or `users` without updating
--   all RPCs (zb_login), API routes, and triggers. The app stores the user's **email**
--   in `username` so login stays a single stable key; `full_name` is display only and
--   may repeat (e.g. two users named "Ali").
--
-- 1) Remove UNIQUE constraint on full_name (if your schema had one — common cause of
--    "duplicate name" errors). Constraint names differ per project; this loop drops any
--    unique constraint on zb_simple_users that mentions full_name.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.zb_simple_users'::regclass
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) ILIKE '%full_name%'
  LOOP
    EXECUTE format('ALTER TABLE public.zb_simple_users DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Dropped unique constraint: %', r.conname;
  END LOOP;
END $$;

-- 2) Ensure email is unique (signup + OTP already rely on this). Skip if you already have it.
-- Uncomment if needed after checking \d zb_simple_users in psql:
-- ALTER TABLE public.zb_simple_users
--   ADD CONSTRAINT zb_simple_users_email_unique UNIQUE (email);

-- 3) If your `public.zb_signup_email` function still inserts `username` from the old
--    second argument, update the app/backend to pass **email** as that argument (done in
--    Node route zb-signup-with-otp). Optionally replace the function body so the second
--    parameter is ignored and login id is always lower(trim(p_email)), for example:
--
-- CREATE OR REPLACE FUNCTION public.zb_signup_email(
--   p_full_name text,
--   p_username text,  -- legacy; should equal email; safe to ignore in body
--   p_password text,
--   p_email text
-- )
-- RETURNS jsonb
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public
-- AS $fn$
-- DECLARE
--   v_email text := lower(trim(p_email));
--   v_name  text := trim(coalesce(p_full_name, ''));
--   v_login text := v_email;
--   new_id uuid;
-- BEGIN
--   IF v_email IS NULL OR v_email = '' OR position('@' IN v_email) < 2 THEN
--     RETURN jsonb_build_object('ok', false, 'error', 'Invalid email');
--   END IF;
--   IF length(v_name) < 2 THEN
--     RETURN jsonb_build_object('ok', false, 'error', 'Enter your full name');
--   END IF;
--   IF length(trim(coalesce(p_password, ''))) < 4 THEN
--     RETURN jsonb_build_object('ok', false, 'error', 'Password too short');
--   END IF;
--   IF EXISTS (
--     SELECT 1 FROM public.zb_simple_users z
--     WHERE lower(trim(coalesce(z.email, ''))) = v_email
--   ) THEN
--     RETURN jsonb_build_object('ok', false, 'error', 'Email already registered');
--   END IF;
--
--   INSERT INTO public.zb_simple_users (username, full_name, email, password_hash)
--   VALUES (v_login, v_name, v_email, crypt(p_password, gen_salt('bf')))
--   RETURNING id INTO new_id;
--
--   -- If you use public.profiles without a trigger, INSERT here to match your columns.
--
--   RETURN jsonb_build_object(
--     'ok', true,
--     'user_id', new_id,
--     'username', v_login,
--     'full_name', v_name
--   );
-- EXCEPTION
--   WHEN unique_violation THEN
--     RETURN jsonb_build_object('ok', false, 'error', 'Email already registered');
-- END;
-- $fn$;
