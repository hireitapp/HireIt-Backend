-- ============================================================================
-- welcome_email_trigger.sql
--
-- PURPOSE
-- Fire a welcome email whenever a new row is inserted into public.profiles.
-- Uses pg_net to make an async HTTP POST to the Railway backend's
-- /welcome-email endpoint, which looks up the user's email + suburb from
-- auth.users and sends the email via Resend.
--
-- WHY pg_net INSTEAD OF SUPABASE DATABASE WEBHOOKS
-- The "Database Webhooks" UI was removed from the Supabase dashboard.
-- pg_net (Supabase's first-party async HTTP extension) achieves the same
-- thing directly in SQL: the trigger queues the HTTP call, pg_net's
-- background worker fires it, and the INSERT is never blocked.
--
-- SECRET STORAGE NOTE
-- The webhook secret is hardcoded in the function body rather than stored
-- via ALTER DATABASE (which requires superuser — not available in the SQL
-- Editor). The function source in pg_proc is readable only by the postgres
-- role, not by authenticated/anon, so this is acceptable for an outbound
-- webhook secret. If you rotate the secret, re-run Block 2 with the new
-- value and update WELCOME_WEBHOOK_SECRET in Railway at the same time.
--
-- HOW TO RUN
-- 1. Set WELCOME_WEBHOOK_SECRET in Railway → HireIt-backend env vars.
-- 2. Replace 'YOUR_SECRET_HERE' in Block 2 with that same value.
-- 3. Paste this whole file into Supabase → SQL Editor and click Run.
--    Safe to re-run: all statements are idempotent.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- Block 1 · Extension: pg_net
--
-- pg_net ships with every Supabase project and is usually already installed.
-- CREATE EXTENSION IF NOT EXISTS is a no-op when it is.
-- ────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_net;


-- ────────────────────────────────────────────────────────────────────────────
-- Block 2 · Function: notify_welcome_email()
--
-- Queues an async HTTP POST to the Railway /welcome-email endpoint.
-- net.http_post() is non-blocking — pg_net's background worker fires the
-- request after the INSERT commits, so a network hiccup never breaks signup.
--
-- *** Replace 'YOUR_SECRET_HERE' before running. ***
--
-- SECURITY DEFINER is needed because Supabase runs profile inserts as the
-- 'authenticated' role, which may not have EXECUTE on net.http_post.
-- Running as the function owner (postgres) guarantees access.
-- SET search_path prevents search-path injection attacks that SECURITY
-- DEFINER functions are otherwise vulnerable to.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_welcome_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
BEGIN
  PERFORM net.http_post(
    url     := 'https://hireit-production-ac0f.up.railway.app/welcome-email',
    body    := jsonb_build_object(
                 'type',       'INSERT',
                 'table',      'profiles',
                 'schema',     'public',
                 'record',     to_jsonb(NEW),
                 'old_record', NULL::jsonb
               ),
    headers := jsonb_build_object(
                 'Content-Type',     'application/json',
                 'x-webhook-secret', 'YOUR_SECRET_HERE'
               ),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a failed HTTP call break a signup
  RAISE WARNING 'notify_welcome_email: net.http_post failed: %', SQLERRM;
  RETURN NEW;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Block 3 · Trigger: on_profile_created_welcome_email
--
-- AFTER INSERT so the row is committed before the HTTP call is queued.
-- FOR EACH ROW fires once per signup, not once per statement.
-- DROP IF EXISTS + CREATE because Postgres has no CREATE OR REPLACE TRIGGER.
-- ────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS on_profile_created_welcome_email ON public.profiles;

CREATE TRIGGER on_profile_created_welcome_email
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_welcome_email();


-- ────────────────────────────────────────────────────────────────────────────
-- Block 4 · Smoke-test queries (run separately after setup)
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Confirm the trigger is attached:
-- SELECT trigger_name, event_manipulation, action_timing
--   FROM information_schema.triggers
--  WHERE event_object_table = 'profiles'
--    AND trigger_name = 'on_profile_created_welcome_email';

-- 2. After a test signup, inspect pg_net's request log:
-- SELECT id, status_code, url, timed_out, created
--   FROM net._http_response
--  ORDER BY created DESC
--  LIMIT 5;
-- You want status_code = 200 against the /welcome-email URL.
