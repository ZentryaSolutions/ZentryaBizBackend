-- Per-product low stock alert threshold (quantity at or below triggers low-stock)

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS low_stock_threshold integer NOT NULL DEFAULT 10;

COMMENT ON COLUMN public.products.low_stock_threshold IS
  'Alert when quantity_in_stock is at or below this value; set per product in inventory.';
