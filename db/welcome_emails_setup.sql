-- ── 1. Add followup_email_sent column to profiles ────────────────────────────
-- Run this in Supabase → SQL Editor.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS followup_email_sent BOOLEAN NOT NULL DEFAULT false;


-- ── 2. Welcome email trigger (pg_net) ────────────────────────────────────────
-- The welcome email fires via a Postgres trigger + pg_net, not via the
-- Supabase Database Webhooks UI (which was removed). See:
--   db/welcome_email_trigger.sql
--
-- Run that file in Supabase → SQL Editor after setting WELCOME_WEBHOOK_SECRET
-- in Railway env vars and replacing 'REPLACE_ME' in Block 2 of that file.


-- ── 3. Required environment variables ────────────────────────────────────────
--
-- Railway (HireIt-backend):
--   WELCOME_WEBHOOK_SECRET   — shared secret validated by /welcome-email route
--                              (same value goes in welcome_email_trigger.sql Block 2)
--   CRON_SECRET              — shared secret for the Vercel → Railway cron call
--
-- Vercel (HireIt frontend):
--   CRON_SECRET              — same value as Railway CRON_SECRET
--                              (Vercel reads this to protect the cron endpoint)
--
-- REACT_APP_BACKEND_URL is already set on Vercel and points to Railway.
-- No other new env vars are needed on the Vercel side.
