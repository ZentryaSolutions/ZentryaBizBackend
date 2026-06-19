-- Link expenses to inventory products (per-product expense + profitability)

ALTER TABLE public.daily_expenses
  ADD COLUMN IF NOT EXISTS expense_scope text NOT NULL DEFAULT 'shop';

COMMENT ON COLUMN public.daily_expenses.expense_scope IS 'shop = general overhead; product = linked to product(s) via expense_product_allocations';

CREATE TABLE IF NOT EXISTS public.expense_product_allocations (
  allocation_id serial PRIMARY KEY,
  expense_id integer NOT NULL REFERENCES public.daily_expenses (expense_id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES public.products (product_id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  shop_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_product_alloc_expense
  ON public.expense_product_allocations (expense_id);

CREATE INDEX IF NOT EXISTS idx_expense_product_alloc_product_shop
  ON public.expense_product_allocations (shop_id, product_id);
