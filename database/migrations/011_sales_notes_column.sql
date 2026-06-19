-- Optional: sales.notes for invoice memos and return REF: links (if missing on older DBs)
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.sales.notes IS 'Invoice notes; credit notes use REF:Bill-xxxxx when original_sale_id unavailable';
