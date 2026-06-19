-- Per-ticket chat (shop admin + cashier; platform admin replies later)

CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  message_id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES public.support_tickets (ticket_id) ON DELETE CASCADE,
  shop_id uuid NOT NULL,
  sender_user_id integer NOT NULL,
  sender_name text NOT NULL DEFAULT '',
  sender_role text NOT NULL DEFAULT '',
  sender_kind text NOT NULL DEFAULT 'shop_staff',
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_ticket_messages_body_check CHECK (
    char_length(trim(body)) >= 1 AND char_length(body) <= 4000
  ),
  CONSTRAINT support_ticket_messages_sender_kind_check CHECK (
    sender_kind IN ('shop_staff', 'platform_admin')
  )
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_created
  ON public.support_ticket_messages (ticket_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_shop_ticket
  ON public.support_ticket_messages (shop_id, ticket_id);

COMMENT ON TABLE public.support_ticket_messages IS 'Chat thread per support ticket; scoped by shop_id + ticket_id';
