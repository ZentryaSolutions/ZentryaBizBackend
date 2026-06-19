-- How money was received (cash | card | transfer) — separate from payment_type (cash | credit | split).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'cash';

UPDATE sales
SET payment_mode = 'cash'
WHERE payment_mode IS NULL OR trim(payment_mode) = '';
