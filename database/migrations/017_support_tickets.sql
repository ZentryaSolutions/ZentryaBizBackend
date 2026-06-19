-- Shop support tickets (report issues with optional screenshots)

CREATE TABLE IF NOT EXISTS public.support_tickets (
  ticket_id serial PRIMARY KEY,
  shop_id uuid NOT NULL,
  ticket_number text NOT NULL,
  created_by_user_id integer NOT NULL,
  created_by_name text NOT NULL DEFAULT '',
  created_by_role text NOT NULL DEFAULT '',
  heading text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  resolved_by_user_id integer,
  platform_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_shop_number_unique UNIQUE (shop_id, ticket_number),
  CONSTRAINT support_tickets_status_check CHECK (status IN ('open', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_shop_created
  ON public.support_tickets (shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_shop_status
  ON public.support_tickets (shop_id, status);

CREATE TABLE IF NOT EXISTS public.support_ticket_images (
  image_id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES public.support_tickets (ticket_id) ON DELETE CASCADE,
  file_name text,
  mime_type text NOT NULL DEFAULT 'image/jpeg',
  image_data text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_images_ticket
  ON public.support_ticket_images (ticket_id, sort_order);

COMMENT ON TABLE public.support_tickets IS 'In-app support requests from shop staff (cashier/admin)';
COMMENT ON TABLE public.support_ticket_images IS 'Up to 3 screenshots per support ticket (base64)';
