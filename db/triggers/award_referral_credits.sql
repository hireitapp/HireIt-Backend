-- Awards referral credits when a booking transitions to 'completed'.
-- Lives in Supabase (applied via SQL editor), saved here for version tracking.
-- When a booking's status becomes 'completed', checks if the hirer or owner is a
-- referred user with a still-'pending' referral; if so, marks it 'qualified' and
-- adds 3 to the referrer's referral_fee_credits. Idempotent (status guard prevents
-- double-award). SECURITY DEFINER so it can write regardless of who triggered the update.

CREATE OR REPLACE FUNCTION award_referral_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  party uuid;
  ref_row referrals%ROWTYPE;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    FOREACH party IN ARRAY ARRAY[NEW.hirer_id, NEW.owner_id]
    LOOP
      UPDATE referrals
        SET status = 'qualified', qualified_at = now()
        WHERE referred_id = party AND status = 'pending'
        RETURNING * INTO ref_row;
      IF FOUND THEN
        UPDATE profiles
          SET referral_fee_credits = COALESCE(referral_fee_credits, 0) + 3
          WHERE id = ref_row.referrer_id;
        RAISE NOTICE 'Referral qualified: +3 credits to %, referred % via booking %', ref_row.referrer_id, party, NEW.id;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_award_referral_credits ON bookings;

CREATE TRIGGER trg_award_referral_credits
AFTER UPDATE OF status ON bookings
FOR EACH ROW
EXECUTE FUNCTION award_referral_credits();
