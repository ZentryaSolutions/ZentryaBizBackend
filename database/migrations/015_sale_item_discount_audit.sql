-- Per-line sale discounts (item-wise profitability) + shop-scoped audit trail

ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS line_discount numeric(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.sale_items
  DROP CONSTRAINT IF EXISTS sale_items_line_discount_nonneg;

ALTER TABLE public.sale_items
  ADD CONSTRAINT sale_items_line_discount_nonneg CHECK (line_discount >= 0);

COMMENT ON COLUMN public.sale_items.line_discount IS 'PKR discount applied to this line (not per-unit); reduces revenue and profit.';

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS shop_id uuid;

COMMENT ON COLUMN public.audit_logs.shop_id IS 'Shop context for workspace-scoped audit (nullable for legacy rows).';

CREATE INDEX IF NOT EXISTS idx_audit_logs_shop_timestamp
  ON public.audit_logs (shop_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_timestamp
  ON public.audit_logs (action, timestamp DESC);
