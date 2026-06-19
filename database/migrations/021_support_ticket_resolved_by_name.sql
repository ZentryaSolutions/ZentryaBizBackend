-- Who marked a support ticket resolved (name + role at time of action)

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS resolved_by_name text;

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS resolved_by_role text;
