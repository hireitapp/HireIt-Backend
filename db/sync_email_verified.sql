-- ============================================================================
-- sync_email_verified.sql
--
-- PURPOSE
-- Bridge Supabase's built-in email confirmation (auth.users.email_confirmed_at)
-- to HireIt's custom profiles.email_verified flag, and activate any listings
-- that were waiting on verification.
--
-- BACKGROUND
-- The app has two disconnected email-confirmation systems:
--   1. Supabase built-in — auto-fires on signup; sets auth.users.email_confirmed_at
--      when the user clicks Supabase's confirmation link.
--   2. HireIt custom — POST /send-verification sends a HireIt-branded email that
--      hits GET /verify-email, which sets profiles.email_verified = true and
--      activates listings that were 'pending_verification'.
-- The app only reads profiles.email_verified. Users who confirmed via Supabase's
-- link stay flagged as unverified in the app, and their pending listings never
-- go live. This script closes that gap.
--
-- HOW TO RUN
-- Paste this whole file into the Supabase SQL Editor (Dashboard → SQL → New
-- query) and run. Safe to re-run: the function uses CREATE OR REPLACE, the
-- trigger uses DROP IF EXISTS + CREATE, and the UPDATE statements are
-- idempotent (only touch rows still in the wrong state).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- Block 1 · Function: sync_email_verified()
--
-- Runs whenever auth.users.email_confirmed_at is UPDATEd. Flips the linked
-- profile's email_verified to true and activates any of that user's listings
-- still sitting in 'pending_verification'.
--
-- SECURITY DEFINER is required because the trigger fires on auth.users (owned
-- by supabase_auth_admin) but writes to public.profiles / public.listings.
-- SET search_path pins the schema so SECURITY DEFINER can't be tricked into
-- resolving unqualified names against an attacker-controlled schema.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sync_email_verified()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL
     AND NEW.email_confirmed_at IS DISTINCT FROM OLD.email_confirmed_at
  THEN
    UPDATE public.profiles
       SET email_verified = true
     WHERE id = NEW.id
       AND email_verified IS DISTINCT FROM true;

    UPDATE public.listings
       SET status = 'active'
     WHERE owner_id = NEW.id
       AND status = 'pending_verification';
  END IF;
  RETURN NEW;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Block 2 · Trigger: on_auth_user_email_confirmed
--
-- Attaches sync_email_verified() to fire AFTER an UPDATE of email_confirmed_at
-- on auth.users. We use DROP IF EXISTS + CREATE (Postgres has no
-- CREATE OR REPLACE TRIGGER) so this block is safely re-runnable.
-- ────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;

CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_email_verified();


-- ────────────────────────────────────────────────────────────────────────────
-- Block 3 · Retroactive backfill: profiles.email_verified
--
-- For every user who already confirmed via Supabase's link before this trigger
-- existed, flip their profile flag. Idempotent — only touches rows currently
-- false or null. This is what fixes Sandra Tay and anyone in the same state.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE public.profiles
   SET email_verified = true
 WHERE id IN (
   SELECT id FROM auth.users WHERE email_confirmed_at IS NOT NULL
 )
   AND email_verified IS DISTINCT FROM true;


-- ────────────────────────────────────────────────────────────────────────────
-- Block 4 · Retroactive backfill: listings.status
--
-- Activate any listing sitting in 'pending_verification' whose owner has now
-- confirmed their email (per Block 3). This is what should have happened when
-- they originally clicked the Supabase confirmation link.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE public.listings
   SET status = 'active'
 WHERE status = 'pending_verification'
   AND owner_id IN (
     SELECT id FROM auth.users WHERE email_confirmed_at IS NOT NULL
   );


-- ────────────────────────────────────────────────────────────────────────────
-- Block 5 · Post-run verification queries (OPTIONAL, run separately)
--
-- After running Blocks 1–4, these two SELECTs should each return zero rows.
-- If they do, the fix landed cleanly. If they return anything, investigate.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Profiles marked verified in auth but still unverified in profiles:
-- SELECT p.id, u.email, u.email_confirmed_at, p.email_verified
--   FROM auth.users u
--   JOIN public.profiles p ON p.id = u.id
--  WHERE u.email_confirmed_at IS NOT NULL
--    AND p.email_verified IS DISTINCT FROM true;

-- 2. Listings still stuck in pending_verification with a verified owner:
-- SELECT l.id, l.title, l.status, u.email_confirmed_at
--   FROM public.listings l
--   JOIN auth.users u ON u.id = l.owner_id
--  WHERE l.status = 'pending_verification'
--    AND u.email_confirmed_at IS NOT NULL;
