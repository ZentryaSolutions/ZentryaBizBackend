-- Google Sign-In: link GIS subject to zb_simple_users (password login unchanged)
ALTER TABLE public.zb_simple_users ADD COLUMN IF NOT EXISTS google_sub text;

CREATE UNIQUE INDEX IF NOT EXISTS zb_simple_users_google_sub_uidx
  ON public.zb_simple_users (google_sub)
  WHERE google_sub IS NOT NULL AND google_sub <> '';

COMMENT ON COLUMN public.zb_simple_users.google_sub IS 'Google account subject (sub) from Sign in with Google';
