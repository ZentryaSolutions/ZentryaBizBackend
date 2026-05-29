-- Trial expiry + paid-plan renewal reminders.
-- Trial users get 14 days; paid plan reminders are sent once per billing period near renewal.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_reminder_last_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS plan_reminder_period_end timestamptz;

DO $$
DECLARE
  has_created_at boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'created_at'
  )
  INTO has_created_at;

  IF has_created_at THEN
    EXECUTE $sql$
      UPDATE public.profiles
      SET trial_started_at = COALESCE(trial_started_at, created_at, now()),
          trial_ends_at = COALESCE(trial_ends_at, COALESCE(created_at, now()) + interval '14 days')
      WHERE lower(coalesce(plan::text, 'trial')) = 'trial'
    $sql$;
  ELSE
    UPDATE public.profiles
    SET trial_started_at = COALESCE(trial_started_at, now()),
        trial_ends_at = COALESCE(trial_ends_at, now() + interval '14 days')
    WHERE lower(coalesce(plan::text, 'trial')) = 'trial';
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.trial_started_at IS 'When the 14-day trial began.';
COMMENT ON COLUMN public.profiles.trial_ends_at IS 'When trial access expires and plan should become expired.';
COMMENT ON COLUMN public.profiles.plan_reminder_last_sent_at IS 'Last time renewal reminder email was sent.';
COMMENT ON COLUMN public.profiles.plan_reminder_period_end IS 'Stripe period end covered by the last renewal reminder.';
