-- Resolve duplicate invoice numbers within a shop (keep earliest sale_id, suffix others).
WITH ranked AS (
  SELECT
    sale_id,
    invoice_number,
    ROW_NUMBER() OVER (
      PARTITION BY shop_id, lower(trim(invoice_number))
      ORDER BY sale_id
    ) AS rn
  FROM public.sales
  WHERE invoice_number IS NOT NULL AND trim(invoice_number) <> ''
)
UPDATE public.sales s
SET invoice_number = r.invoice_number || '-DUP-' || s.sale_id::text
FROM ranked r
WHERE s.sale_id = r.sale_id
  AND r.rn > 1;

-- One invoice / credit-note number per shop (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS sales_shop_invoice_number_uidx
  ON public.sales (shop_id, lower(trim(invoice_number)))
  WHERE invoice_number IS NOT NULL AND trim(invoice_number) <> '';
