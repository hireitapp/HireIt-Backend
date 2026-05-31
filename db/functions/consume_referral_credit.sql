-- Atomically decrements a referrer's referral_fee_credits by 1, only if > 0.
-- Lives in Supabase (applied via SQL editor); saved here for version tracking.
-- Called from /stripe/payment-intent when an owner with credits creates a payment intent.
CREATE OR REPLACE FUNCTION consume_referral_credit(owner uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE profiles
  SET referral_fee_credits = referral_fee_credits - 1
  WHERE id = owner AND referral_fee_credits > 0
  RETURNING referral_fee_credits;
$$;
