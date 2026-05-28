-- Issue #23: optional supplier email (run in Supabase SQL editor)
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS email VARCHAR(320);

COMMENT ON COLUMN public.suppliers.email IS 'Optional supplier contact email';
