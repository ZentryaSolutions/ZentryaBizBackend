-- =============================================================================
-- Empty all listed PUBLIC tables for fresh testing (Supabase SQL Editor)
-- =============================================================================
-- • Uses TRUNCATE … CASCADE so child tables clear even if FK order varies.
-- • RESTART IDENTITY resets serial/bigserial counters (e.g. user_id) to 1.
-- • Does NOT touch auth.users or other auth.* tables.
-- • Backup / export first if you need any row.
-- • If you get "relation does not exist", remove that line from the list.
-- • schema_version: only truncate if you really want to reset version rows
--   (often kept; uncomment the second block if needed).
-- =============================================================================

BEGIN;

TRUNCATE TABLE
  public.sale_items,
  public.sales,
  public.purchase_items,
  public.purchases,
  public.customer_payments,
  public.supplier_payments,
  public.products,
  public.sub_categories,
  public.categories,
  public.customers,
  public.suppliers,
  public.daily_expenses,
  public.notifications,
  public.shop_users,
  public.user_sessions,
  public.users,
  public.profiles,
  public.zb_simple_users,
  public.email_otps,
  public.audit_logs,
  public.settings,
  public.shops
RESTART IDENTITY CASCADE;

COMMIT;

-- Optional: also clear schema_version (uncomment if you use it only as metadata)
-- BEGIN;
-- TRUNCATE TABLE public.schema_version RESTART IDENTITY CASCADE;
-- COMMIT;
