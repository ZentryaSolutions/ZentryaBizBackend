-- Dedicated sales returns tables (credit notes remain in sales for billing/reports)

CREATE TABLE IF NOT EXISTS public.sales_returns (
  return_id serial PRIMARY KEY,
  shop_id uuid NOT NULL,
  sale_id integer NOT NULL,
  original_sale_id integer,
  return_number text NOT NULL,
  return_reason text NOT NULL DEFAULT '',
  refund_type text NOT NULL DEFAULT 'cash',
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  tax numeric(14,2) NOT NULL DEFAULT 0,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  payment_type text,
  customer_id integer,
  customer_name text,
  created_by integer,
  return_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_returns_shop_sale_unique UNIQUE (shop_id, sale_id),
  CONSTRAINT sales_returns_shop_number_unique UNIQUE (shop_id, return_number),
  CONSTRAINT sales_returns_refund_type_check CHECK (refund_type IN ('cash', 'credit'))
);

CREATE INDEX IF NOT EXISTS idx_sales_returns_shop_created
  ON public.sales_returns (shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_returns_shop_original
  ON public.sales_returns (shop_id, original_sale_id);

CREATE TABLE IF NOT EXISTS public.sales_return_items (
  return_item_id serial PRIMARY KEY,
  return_id integer NOT NULL REFERENCES public.sales_returns (return_id) ON DELETE CASCADE,
  product_id integer NOT NULL,
  quantity numeric(14,3) NOT NULL,
  selling_price numeric(14,2) NOT NULL DEFAULT 0,
  purchase_price numeric(14,2) NOT NULL DEFAULT 0,
  line_discount numeric(14,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sales_return_items_return
  ON public.sales_return_items (return_id);

COMMENT ON TABLE public.sales_returns IS 'Return / credit-note header linked to sales row (CN-*)';
COMMENT ON TABLE public.sales_return_items IS 'Line items for each sales return';

-- Backfill from existing credit notes in sales
INSERT INTO public.sales_returns (
  shop_id,
  sale_id,
  original_sale_id,
  return_number,
  return_reason,
  refund_type,
  subtotal,
  discount,
  tax,
  total_amount,
  paid_amount,
  payment_type,
  customer_id,
  customer_name,
  created_by,
  return_date
)
SELECT
  s.shop_id,
  s.sale_id,
  s.original_sale_id,
  s.invoice_number,
  COALESCE(
    NULLIF(trim(substring(s.notes from 'REASON:(.*)')), ''),
    NULLIF(trim(s.notes), ''),
    'Historical return'
  ),
  CASE
    WHEN lower(COALESCE(s.payment_type, 'cash')) = 'credit' THEN 'credit'
    ELSE 'cash'
  END,
  COALESCE(s.subtotal, 0),
  COALESCE(s.discount, 0),
  COALESCE(s.tax, 0),
  COALESCE(s.total_amount, 0),
  COALESCE(s.paid_amount, 0),
  s.payment_type,
  s.customer_id,
  s.customer_name,
  s.created_by,
  COALESCE(s.date::date, CURRENT_DATE)
FROM public.sales s
WHERE s.shop_id IS NOT NULL
  AND (
    lower(COALESCE(s.sale_kind, '')) = 'return'
    OR s.invoice_number ILIKE 'CN-%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.sales_returns sr
    WHERE sr.shop_id = s.shop_id AND sr.sale_id = s.sale_id
  );

INSERT INTO public.sales_return_items (
  return_id,
  product_id,
  quantity,
  selling_price,
  purchase_price,
  line_discount,
  line_total
)
SELECT
  sr.return_id,
  si.product_id,
  si.quantity,
  COALESCE(si.selling_price, 0),
  COALESCE(si.purchase_price, 0),
  COALESCE(si.line_discount, 0),
  GREATEST(
    0,
    COALESCE(si.selling_price, 0) * si.quantity - COALESCE(si.line_discount, 0)
  )
FROM public.sale_items si
JOIN public.sales_returns sr ON sr.sale_id = si.sale_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.sales_return_items sri
  WHERE sri.return_id = sr.return_id AND sri.product_id = si.product_id
);
