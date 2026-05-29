-- Returns (credit notes) + daily cash closing

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS sale_kind text DEFAULT 'sale';

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS original_sale_id integer;

COMMENT ON COLUMN public.sales.sale_kind IS 'sale | return (credit note)';
COMMENT ON COLUMN public.sales.original_sale_id IS 'Original invoice when sale_kind = return';

CREATE TABLE IF NOT EXISTS public.daily_closings (
  id serial PRIMARY KEY,
  shop_id uuid NOT NULL,
  closing_date date NOT NULL,
  opening_cash numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash numeric(14,2) NOT NULL DEFAULT 0,
  actual_cash numeric(14,2) NOT NULL DEFAULT 0,
  cash_sales numeric(14,2) NOT NULL DEFAULT 0,
  cash_refunds numeric(14,2) NOT NULL DEFAULT 0,
  credit_sales numeric(14,2) NOT NULL DEFAULT 0,
  credit_payments numeric(14,2) NOT NULL DEFAULT 0,
  expenses numeric(14,2) NOT NULL DEFAULT 0,
  invoice_count integer NOT NULL DEFAULT 0,
  difference numeric(14,2) NOT NULL DEFAULT 0,
  notes text,
  closed_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, closing_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_closings_shop_date ON public.daily_closings (shop_id, closing_date DESC);
