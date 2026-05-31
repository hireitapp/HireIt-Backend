if (process.env.NODE_ENV !== 'production') require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Resend } = require('resend')

// Stripe mode selector. Strict equality with 'test' — anything else (unset, empty, garbage, mixed-case)
// resolves to 'live'. The default is live by construction; you have to type STRIPE_MODE=test exactly.
const STRIPE_MODE = process.env.STRIPE_MODE === 'test' ? 'test' : 'live'

// Resolve the Stripe secret key for the current mode. Live mode preserves the legacy fallback chain
// for backwards-compatibility with today's deployed STRIPE_KEY env var. Test mode requires
// STRIPE_KEY_TEST explicitly and refuses to fall back to live keys (lazy throw on first use).
const getStripeSecretKey = () => {
  if (STRIPE_MODE === 'test') {
    const k = process.env.STRIPE_KEY_TEST
    if (!k) throw new Error('STRIPE_MODE=test but STRIPE_KEY_TEST is not set — refusing to fall back to live keys.')
    return k
  }
  return process.env.STRIPE_KEY_LIVE
    || process.env.STRIPE_KEY
    || process.env.HIREIT_STRIPE_KEY
    || process.env.STRIPE_SECRET_KEY
}

// Resolve the Stripe webhook signing secret for the current mode. Same shape as the key resolver.
const getStripeWebhookSecret = () => {
  if (STRIPE_MODE === 'test') {
    const s = process.env.STRIPE_WEBHOOK_SECRET_TEST
    if (!s) throw new Error('STRIPE_MODE=test but STRIPE_WEBHOOK_SECRET_TEST is not set.')
    return s
  }
  return process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET
}

const getStripe = () => require('stripe')(getStripeSecretKey())

const { createClient } = require('@supabase/supabase-js')

// Service-role client — bypasses RLS so the webhook can write to bookings
// regardless of which user (or no user) is logged in. Service-role key is
// for backend use only and must NEVER ship to the frontend.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

// ── Auth middleware ────────────────────────────────────────
// Verify the Supabase JWT in the Authorization header. Sets req.userId on
// success. Returns 401 if the token is missing or invalid.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing bearer token' })
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' })
  req.userId = data.user.id
  next()
}

// Look up the booking by Stripe PI id and assert the authenticated user is
// either the hirer or the owner. Sends the response itself on failure and
// returns null; on success returns the booking row.
async function assertBookingParty(req, res, paymentIntentId) {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, owner_id, hirer_id, listings(country)')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle()
  if (error) {
    res.status(500).json({ error: 'Booking lookup failed' })
    return null
  }
  if (!booking) {
    res.status(404).json({ error: 'Booking not found' })
    return null
  }
  if (req.userId !== booking.owner_id && req.userId !== booking.hirer_id) {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  return booking
}

const resend = new Resend(process.env.RESEND_API_KEY)
const app = express()

app.use(cors({
origin: ['https://hire-it-one.vercel.app', 'https://hireitnow.au', 'https://www.hireitnow.au', 'http://localhost:3000'],
methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
allowedHeaders: ['Content-Type', 'Authorization']
}))

app.options('*', cors())
app.use('/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

const PLATFORM_FEE_PERCENT = 0.15

// Country → Stripe currency-code map (lowercase). Kept in sync with
// frontend lib/constants.js COUNTRY_CURRENCIES; update both if currencies change.
const COUNTRY_CURRENCY_CODES = {
  'Australia': 'aud',
  'United States': 'usd',
  'United Kingdom': 'gbp',
  'Canada': 'cad',
  'New Zealand': 'nzd',
  'Europe': 'eur',
  'Germany': 'eur',
  'France': 'eur',
  'Italy': 'eur',
  'Spain': 'eur',
  'Netherlands': 'eur',
  'Japan': 'jpy',
  'China': 'cny',
  'India': 'inr',
  'Singapore': 'sgd',
  'Hong Kong': 'hkd',
  'South Africa': 'zar',
  'Brazil': 'brl',
  'Mexico': 'mxn',
  'UAE': 'aed',
}

const getCurrencyCode = (country) => COUNTRY_CURRENCY_CODES[country] || 'aud'

// Stripe expects amounts in the smallest currency unit. Two-decimal currencies use × 100 (cents).
// Zero-decimal currencies (JPY, KRW, etc.) use whole units — multiplying by 100 would charge 100×
// the intended amount. Three-decimal currencies (BHD, KWD, OMR, TND, JOD) aren't in our currency
// map; if added, extend this helper.
// Source: https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])

const toSmallestUnit = (amount, currencyCode) => {
  return ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())
    ? Math.round(amount)
    : Math.round(amount * 100)
}

const fromSmallestUnit = (amount, currencyCode) => {
  return ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())
    ? amount
    : amount / 100
}

function emailLayout(bodyHtml) {
return `
<div style="font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
<div style="background: linear-gradient(135deg, #2D3FCC 0%, #7B3FE4 100%); padding: 28px 20px; text-align: center;">
<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">HireIt</h1>
</div>
<div style="padding: 32px 28px; background: #F7F8FB;">
${bodyHtml}
</div>
<div style="padding: 24px; text-align: center; color: #8A8FA3; font-size: 13px; background: #fff; border-top: 1px solid #EEF0F6;">
<p style="margin: 0 0 4px;">HireIt — Hire anything, from anyone near you</p>
<p style="margin: 0;"><a href="https://hireitnow.au" style="color: #2D3FCC; text-decoration: none; font-weight: 600;">hireitnow.au</a></p>
</div>
</div>
`
}

function ctaButton(url, text) {
return `<a href="${url}" style="background: linear-gradient(135deg, #2D3FCC 0%, #7B3FE4 100%); color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; display: inline-block; margin-top: 8px; font-weight: 700; box-shadow: 0 4px 14px rgba(45, 63, 204, 0.3);">${text}</a>`
}

function infoCard(rows) {
return `
<div style="background: white; border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #2D3FCC;">
${rows.map(r => `<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">${r.label}:</strong> ${r.val}</p>`).join('')}
</div>
`
}

app.get('/health', (req, res) => {
try {
const key = getStripeSecretKey()
res.json({ status: 'ok', mode: STRIPE_MODE, stripeKeyPrefix: key?.slice(0,15), stripeKeySuffix: key?.slice(-4) })
} catch (e) {
res.json({ status: 'ok', mode: STRIPE_MODE, stripeKeyError: e.message })
}
})

app.post('/notify-booking', async (req, res) => {
try {
const { ownerEmail, ownerName, hirerName, itemTitle, startDate, hours, total } = req.body
const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">New booking request!</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${ownerName},</p>
<p style="margin: 0 0 16px; color: #5A6079;"><strong>${hirerName}</strong> wants to hire your <strong>${itemTitle}</strong>.</p>
${infoCard([
{ label: 'Start date', val: startDate },
{ label: 'Duration', val: `${hours} hours` },
{ label: 'Total', val: `$${total}` },
])}
<p style="margin: 0 0 16px; color: #5A6079;">Log in to HireIt to accept or decline this booking.</p>
${ctaButton('https://hireitnow.au/my-bookings', 'View booking')}
<p style="font-size:13px;color:#8A8FA3;margin-top:16px;">👉 Open the <strong>HireIt app</strong> on your phone and go to <strong>My Bookings</strong> to accept or decline.</p>
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: ownerEmail,
subject: `New booking request for ${itemTitle}`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Email error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/confirm-booking', async (req, res) => {
try {
const { hirerEmail, hirerName, itemTitle, ownerName, startDate, hours, total } = req.body
const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">Booking confirmed! 🎉</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${hirerName},</p>
<p style="margin: 0 0 16px; color: #5A6079;">Your booking for <strong>${itemTitle}</strong> has been confirmed by ${ownerName}.</p>
${infoCard([
{ label: 'Item', val: itemTitle },
{ label: 'Owner', val: ownerName },
{ label: 'Start date', val: startDate },
{ label: 'Duration', val: `${hours} hours` },
{ label: 'Total', val: `$${total}` },
])}
<div style="background: #E8EBFB; border-left: 4px solid #2D3FCC; border-radius: 8px; padding: 14px 16px; margin: 16px 0;">
<p style="margin: 0; color: #2D3FCC; font-weight: 700;">💳 Next step: Authorise your payment</p>
<p style="margin: 6px 0 0; color: #5A6079; font-size: 14px;">Your card will be authorised (not charged) until the hire is complete. Go to Messages to authorise and arrange pickup.</p>
</div>
<div style="background: #FAEEDA; border-left: 4px solid #BA7517; border-radius: 8px; padding: 14px 16px; margin: 16px 0;">
<p style="margin: 0; color: #BA7517; font-weight: 700;">⚠️ Insurance reminder</p>
<p style="margin: 6px 0 0; color: #BA7517; font-size: 14px;">Arrange your own insurance for the hired item before collection. HireIt accepts no liability for any loss or damage.</p>
</div>
${ctaButton('https://hireitnow.au/my-bookings', 'View my bookings')}
<p style="font-size:13px;color:#8A8FA3;margin-top:16px;">👉 Open the <strong>HireIt app</strong> and go to <strong>Messages</strong> to authorise payment.</p>
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: hirerEmail,
subject: `Booking confirmed — ${itemTitle}`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Email error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/notify-payment', async (req, res) => {
try {
const { ownerEmail, ownerName, hirerName, itemTitle, total } = req.body
const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">💳 Payment authorised!</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${ownerName},</p>
<p style="margin: 0 0 16px; color: #5A6079;"><strong>${hirerName}</strong> has authorised payment of <strong>$${total}</strong> for <strong>${itemTitle}</strong>. Funds are held securely until the return is confirmed.</p>
<p style="margin: 0 0 16px; color: #5A6079;">Please arrange pickup details with them via the HireIt app.</p>
${ctaButton('https://hireitnow.au/messages', 'View messages')}
<p style="font-size:13px;color:#8A8FA3;margin-top:16px;">👉 Open the <strong>HireIt app</strong> on your phone and go to <strong>Messages</strong> to arrange pickup.</p>
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: ownerEmail,
subject: `💳 Payment authorised for ${itemTitle}`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Payment notification error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/notify-pickup', async (req, res) => {
try {
const { ownerEmail, ownerName, hirerName, itemTitle } = req.body
const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">📦 Item collected!</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${ownerName},</p>
<p style="margin: 0 0 16px; color: #5A6079;"><strong>${hirerName}</strong> has confirmed they have collected <strong>${itemTitle}</strong>.</p>
<p style="margin: 0 0 16px; color: #5A6079;">When the item is returned, mark the booking as complete in the HireIt app to release the deposit back to the hirer.</p>
${ctaButton('https://hireitnow.au/my-bookings', 'View my bookings')}
<p style="font-size:13px;color:#8A8FA3;margin-top:16px;">👉 Open the <strong>HireIt app</strong> on your phone and go to <strong>My Bookings</strong>.</p>
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: ownerEmail,
subject: `📦 ${itemTitle} has been collected`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Pickup notification error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/notify-message', async (req, res) => {
try {
const { recipientEmail, recipientName, senderName, itemTitle, messagePreview, bookingId } = req.body
if (!recipientEmail) return res.status(400).json({ error: 'recipientEmail required' })

const preview = (messagePreview || '').slice(0, 200) + (messagePreview && messagePreview.length > 200 ? '...' : '')

const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">💬 You have a new message</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${recipientName || 'there'},</p>
<p style="margin: 0 0 16px; color: #5A6079;"><strong>${senderName}</strong> just sent you a message about <strong>${itemTitle}</strong>:</p>
<div style="background: #F4F6FE; border-left: 4px solid #7B3FE4; padding: 14px 18px; border-radius: 8px; margin: 16px 0; color: #14172B; font-style: italic; line-height: 1.5;">
"${preview}"
</div>
<p style="margin: 0 0 16px; color: #5A6079;">Reply in the app to keep the conversation going.</p>
${ctaButton(`https://hireitnow.au/messages?booking=${bookingId}`, 'View message')}
<p style="font-size:13px;color:#8A8FA3;margin-top:16px;">👉 Open the <strong>HireIt app</strong> on your phone and go to <strong>Messages</strong>.</p>
`

await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: recipientEmail,
subject: `💬 New message from ${senderName} about ${itemTitle}`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Message notification error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/notify-review', async (req, res) => {
try {
const { recipientEmail, recipientName, reviewerName, rating, comment, itemTitle } = req.body
const stars = '⭐'.repeat(rating)
const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">You got a new review! ⭐</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${recipientName},</p>
<p style="margin: 0 0 16px; color: #5A6079;"><strong>${reviewerName}</strong> left you a ${rating}-star review for <strong>${itemTitle}</strong>.</p>
<div style="background: white; border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #7B3FE4;">
<div style="font-size: 22px; margin-bottom: 10px;">${stars}</div>
<p style="margin: 0; font-style: italic; color: #14172B; line-height: 1.6;">"${comment}"</p>
</div>
${ctaButton('https://hireitnow.au/profile', 'View your profile')}
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: recipientEmail,
subject: `You received a ${rating}⭐ review on HireIt!`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Review email error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/notify-dispute', async (req, res) => {
try {
const { hirerEmail, hirerName, ownerEmail, itemTitle, reason, bookingId, total } = req.body
const body = `
<h2 style="color: #A32D2D; margin: 0 0 12px; font-size: 22px;">⚠️ A problem has been reported</h2>
<div style="background: white; border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #A32D2D;">
<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">Item:</strong> ${itemTitle}</p>
<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">Hirer:</strong> ${hirerName} (${hirerEmail})</p>
<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">Owner email:</strong> ${ownerEmail}</p>
<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">Total paid:</strong> $${total}</p>
<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">Booking ID:</strong> ${bookingId}</p>
<p style="margin: 8px 0; color: #14172B;"><strong style="color: #0F1E4A;">Problem:</strong> ${reason}</p>
</div>
<p style="margin: 0 0 16px; color: #5A6079;">Log in to Supabase or Stripe to review this dispute and process a refund if applicable.</p>
<a href="https://hireitnow.au/admin" style="background: #A32D2D; color: white; padding: 14px 28px; text-decoration: none; border-radius: 10px; display: inline-block; margin-top: 8px; font-weight: 700;">View admin dashboard</a>
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: 'ky@kcroofplumbing.com.au',
subject: `⚠️ Dispute filed — ${itemTitle}`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Dispute email error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/notify-offer', async (req, res) => {
try {
const { ownerEmail, ownerName, hirerName, itemTitle, offeredPrice, hours, hirePeriod, startDate, listedPrice } = req.body
const body = `
<h2 style="color: #0F1E4A; margin: 0 0 12px; font-size: 22px;">💰 You received an offer!</h2>
<p style="margin: 0 0 16px; color: #14172B;">Hi ${ownerName},</p>
<p style="margin: 0 0 16px; color: #5A6079;"><strong>${hirerName}</strong> has made an offer on your <strong>${itemTitle}</strong>.</p>
${infoCard([
{ label: 'Listed price', val: `$${listedPrice}/hr` },
{ label: 'Offered price', val: `$${offeredPrice}/hr` },
{ label: 'Start date', val: startDate },
{ label: 'Duration', val: `${hours} ${hirePeriod}` },
])}
<p style="margin: 0 0 16px; color: #5A6079;">Log in to HireIt to accept or decline this offer. Offer expires in 24 hours.</p>
${ctaButton('https://hireitnow.au/my-bookings', 'View offer')}
`
await resend.emails.send({
from: 'HireIt <hello@hireitnow.au>',
to: ownerEmail,
subject: `💰 New offer on your ${itemTitle}`,
html: emailLayout(body),
})
res.json({ success: true })
} catch (err) {
console.error('Offer email error:', err)
res.status(500).json({ error: err.message })
}
})

app.post('/stripe/connect/onboard', requireAuth, async (req, res) => {
try {
const stripe = getStripe()
const { userId, email } = req.body
const account = await stripe.accounts.create({
type: 'express',
country: 'AU',
email,
capabilities: {
card_payments: { requested: true },
transfers: { requested: true },
},
business_type: 'individual',
metadata: { supabase_user_id: userId },
})
const accountLink = await stripe.accountLinks.create({
account: account.id,
refresh_url: `${process.env.FRONTEND_URL}/profile?stripe=refresh`,
return_url: `${process.env.FRONTEND_URL}/profile?stripe=success`,
type: 'account_onboarding',
})
res.json({ url: accountLink.url, accountId: account.id })
} catch (err) {
console.error('Stripe Connect error:', err)
res.status(500).json({ error: err.message })
}
})

app.get('/stripe/connect/status/:accountId', async (req, res) => {
try {
const stripe = getStripe()
const account = await stripe.accounts.retrieve(req.params.accountId)
res.json({
onboarded: account.details_submitted && account.charges_enabled,
chargesEnabled: account.charges_enabled,
payoutsEnabled: account.payouts_enabled,
})
} catch (err) {
res.status(500).json({ error: err.message })
}
})

// ── Create Payment Intent (MANUAL CAPTURE - escrow) ──────
// Card is AUTHORISED but NOT CHARGED until return is confirmed
app.post('/stripe/payment-intent', requireAuth, async (req, res) => {
try {
const { bookingId, listingTitle } = req.body
if (!bookingId) return res.status(400).json({ error: 'bookingId required' })

// Server-side source of truth for amounts and owner — never trust the client for money values.
const { data: booking, error: bookingError } = await supabase
.from('bookings')
.select('id, hirer_id, owner_id, total_amount, deposit_amount, stripe_payment_intent_id, referral_credit_applied_at, listings(country)')
.eq('id', bookingId)
.maybeSingle()
if (bookingError) {
console.error('Booking lookup failed:', bookingError)
return res.status(500).json({ error: 'Booking lookup failed' })
}
if (!booking) return res.status(404).json({ error: 'Booking not found' })

// Only the hirer may create a payment intent for this booking
if (req.userId !== booking.hirer_id) return res.status(403).json({ error: 'Forbidden' })

const stripe = getStripe()

// Idempotency: if a PI is already bound, branch on its current Stripe status.
//   reusable status  → return the existing client_secret (retries land on the same PI)
//   'succeeded'      → 409, this booking is already paid
//   anything else (e.g. 'canceled') → fall through and create a fresh PI; the bind below
//     will overwrite the stale id since the immutable-columns trigger does not lock it.
//   retrieve throws  → fall through similarly.
if (booking.stripe_payment_intent_id) {
try {
const existing = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id)
const reusable = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture']
if (reusable.includes(existing.status)) {
return res.json({ clientSecret: existing.client_secret, paymentIntentId: existing.id })
}
if (existing.status === 'succeeded') {
return res.status(409).json({ error: 'This booking has already been paid' })
}
console.log('Existing PI in non-reusable status, creating new:', existing.status)
} catch (e) {
console.error('Existing PI retrieve failed, creating new one:', e.message)
}
}

// Look up the owner's Stripe Connect account server-side — never trust client-supplied ownerStripeId
const { data: ownerProfile, error: ownerError } = await supabase
.from('profiles')
.select('stripe_account_id, referral_fee_credits')
.eq('id', booking.owner_id)
.maybeSingle()
if (ownerError) {
console.error('Owner lookup failed:', ownerError)
return res.status(500).json({ error: 'Owner lookup failed' })
}
if (!ownerProfile?.stripe_account_id) {
return res.status(400).json({ error: 'Owner has not connected their payout account' })
}

// Derive amounts and currency from the booking row, not from req.body
const currencyCode = getCurrencyCode(booking.listings?.country)
const totalUnits = toSmallestUnit(booking.total_amount || 0, currencyCode)
const depositUnits = toSmallestUnit(booking.deposit_amount || 0, currencyCode)
const hireUnits = totalUnits - depositUnits

// Referral fee discount: if the owner has unused referral credits, charge 10% instead of 15%
// and consume one credit. Idempotent per booking: if a credit was already applied to this booking
// (referral_credit_applied_at is set), apply the same 10% rate without decrementing again — so a
// cancel-and-retry on the same booking re-creates the PI with the same discount.
let feeRate = PLATFORM_FEE_PERCENT
let consumeCredit = false
if (booking.referral_credit_applied_at) {
  feeRate = 0.10
} else if ((ownerProfile.referral_fee_credits || 0) > 0) {
  feeRate = 0.10
  consumeCredit = true
}
const platformFeeUnits = Math.round(hireUnits * feeRate)

const paymentIntent = await stripe.paymentIntents.create({
amount: totalUnits,
currency: currencyCode,
payment_method_types: ['card'],
capture_method: 'manual',
application_fee_amount: platformFeeUnits,
transfer_data: { destination: ownerProfile.stripe_account_id },
metadata: { bookingId, listingTitle, depositCents: depositUnits.toString() },
description: `HireIt booking: ${listingTitle}`,
})

// Bind the PI to the booking server-side (consolidates the previously inconsistent frontend writes).
// Failure here logs but does not fail the response: the PI is already created in Stripe.
const { error: bindError } = await supabase
.from('bookings')
.update({ stripe_payment_intent_id: paymentIntent.id })
.eq('id', bookingId)
if (bindError) {
console.error('Failed to bind PI to booking:', bindError)
}

console.log(`💸 Fee rate ${feeRate} for booking ${bookingId} (${consumeCredit ? 'consuming credit' : booking.referral_credit_applied_at ? 'credit already applied on prior attempt' : 'no credit'})`)

if (consumeCredit) {
  try {
    // Stamp the booking so a future retry (cancel-and-retry path) re-applies the same 10% rate
    // without decrementing the owner's credit again.
    await supabase
      .from('bookings')
      .update({ referral_credit_applied_at: new Date().toISOString() })
      .eq('id', bookingId)
    // Decrement the owner's credit atomically via Postgres function — the function decrements
    // only if credits > 0, race-free without the read-modify-write + .eq guard pattern we'd
    // otherwise need. Concurrent decrements on the same owner can't underflow or double-debit.
    await supabase.rpc('consume_referral_credit', { owner: booking.owner_id })
  } catch (e) {
    console.error('Referral credit consume error (PI already created, payment proceeds):', e)
  }
}

res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id })
} catch (err) {
console.error('Payment intent error:', err)
res.status(500).json({ error: err.message })
}
})

// ── CANCEL payment authorisation (no charge) ─────────────
app.post('/stripe/cancel-payment', requireAuth, async (req, res) => {
try {
const stripe = getStripe()
const { paymentIntentId } = req.body
if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' })
const booking = await assertBookingParty(req, res, paymentIntentId)
if (!booking) return
const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId)
console.log(`🚫 Cancelled payment authorisation ${paymentIntentId}`)
res.json({ success: true, status: paymentIntent.status })
} catch (err) {
console.error('Cancel payment error:', err)
res.status(500).json({ error: err.message, code: err.code, paymentIntentStatus: err.payment_intent?.status })
}
})

// ── PARTIAL CAPTURE (cancellation with fee) ──────────────
app.post('/stripe/partial-capture', requireAuth, async (req, res) => {
try {
const stripe = getStripe()
const { paymentIntentId, amountToCaptureAUD } = req.body
if (!paymentIntentId || amountToCaptureAUD === undefined) {
return res.status(400).json({ error: 'paymentIntentId and amountToCaptureAUD required' })
}
const booking = await assertBookingParty(req, res, paymentIntentId)
if (!booking) return
// Currency derived from booking.listings.country (which is what we used to set the PI's currency at
// creation). Defensive alternative: stripe.paymentIntents.retrieve(piId).currency — tighter consistency
// if listings.country were ever mutated after PI creation, but adds a round-trip to every cancel-with-fee.
const currencyCode = getCurrencyCode(booking.listings?.country)
const amountToCaptureUnits = toSmallestUnit(amountToCaptureAUD, currencyCode)
const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId, {
amount_to_capture: amountToCaptureUnits,
})
console.log(`💰 Partial captured ${paymentIntentId}: ${amountToCaptureAUD} ${currencyCode.toUpperCase()}`)
res.json({ success: true, status: paymentIntent.status, capturedAmount: amountToCaptureAUD })
} catch (err) {
console.error('Partial capture error:', err)
res.status(500).json({ error: err.message, code: err.code, paymentIntentStatus: err.payment_intent?.status })
}
})

// ── Webhook helper ─────────────────────────────────────────
// Find the booking by Stripe PI id and apply `updates`. Returns one of:
//   { result: 'updated', rows }  — at least one row mutated
//   { result: 'noop' }            — no matching/eligible rows (idempotent re-fire or unknown PI)
//   { result: 'error', error }    — Supabase error, caller should 500 so Stripe retries
//
// `extraFilters` is a function that can add filters like `.is('paid_at', null)`
// to enforce first-write-only semantics. This avoids hitting the
// `bookings_lock_immutable_columns` trigger when frontend has already
// populated a write-once column.
async function updateBookingByPI(piId, updates, extraFilters = (q) => q) {
  if (!piId) return { result: 'noop' }
  const query = extraFilters(
    supabase.from('bookings').update(updates).eq('stripe_payment_intent_id', piId)
  )
  const { data, error } = await query.select()
  if (error) return { result: 'error', error }
  if (!data || data.length === 0) return { result: 'noop' }
  return { result: 'updated', rows: data }
}

app.post('/webhook', async (req, res) => {
const stripe = getStripe()
const sig = req.headers['stripe-signature']
let event
try {
event = stripe.webhooks.constructEvent(req.body, sig, getStripeWebhookSecret())
} catch (err) {
return res.status(400).send(`Webhook Error: ${err.message}`)
}
// Deterministic timestamp from Stripe — re-firing the same event yields
// the same value, so duplicate updates are no-ops against the immutable
// -column trigger (IS DISTINCT FROM returns false for equal values).
const eventTime = new Date(event.created * 1000).toISOString()
let dbResult = null

switch (event.type) {
case 'payment_intent.amount_capturable_updated': {
const pi = event.data.object
console.log(`💳 Payment authorised (held in escrow): ${fromSmallestUnit(pi.amount, pi.currency)} ${pi.currency.toUpperCase()}`)
// First-write only via `.is('paid_at', null)`: if the frontend (Payment.js)
// already populated paid_at, the immutable-column trigger would otherwise
// reject this update. Filtering pre-empts that with a clean no-op.
dbResult = await updateBookingByPI(pi.id, {
payment_status: 'authorised',
paid_at: eventTime,
}, (q) => q.is('paid_at', null))
break
}
case 'payment_intent.succeeded': {
const pi = event.data.object
console.log(`✅ Payment captured: ${fromSmallestUnit(pi.amount, pi.currency)} ${pi.currency.toUpperCase()}`)
// First-write only on payment_captured_at — Messages.js:588 may already
// have populated it when the owner agreed on return.
dbResult = await updateBookingByPI(pi.id, {
payment_status: 'captured',
payment_captured_at: eventTime,
}, (q) => q.is('payment_captured_at', null))
break
}
case 'payment_intent.canceled': {
const pi = event.data.object
console.log(`🚫 Payment authorisation cancelled`)
// Don't regress a captured payment back to "cancelled" — a separate
// refund event handles post-capture reversal.
dbResult = await updateBookingByPI(pi.id, {
payment_status: 'cancelled',
}, (q) => q.not('payment_status', 'in', '("captured","refunded")'))
break
}
case 'payment_intent.payment_failed': {
console.log(`❌ Payment failed`)
// No DB write — payment_failed currently has no dedicated status.
// Hirer is still on Payment.js and will see the Stripe error inline.
break
}
case 'charge.refunded': {
const charge = event.data.object
console.log(`💸 Refund: ${fromSmallestUnit(charge.amount_refunded, charge.currency)} ${charge.currency.toUpperCase()}`)
// PI id lives on the charge object, not on the event metadata.
dbResult = await updateBookingByPI(charge.payment_intent, {
payment_status: 'refunded',
})
break
}
case 'account.updated': {
const account = event.data.object
console.log(`✅ Stripe Connect updated: ${account.id}`)
break
}
default:
console.log(`Unhandled event: ${event.type}`)
}

// Inspect the DB result. Errors → 500 so Stripe retries (exponential backoff,
// up to 3 days). Noop → success (idempotent re-fires shouldn't loop).
if (dbResult?.result === 'error') {
console.error('  ✗ Supabase update failed:', dbResult.error)
return res.status(500).json({ error: 'DB update failed' })
}
if (dbResult?.result === 'noop') {
console.log('  → noop: no eligible rows (already in target state or unknown PI)')
} else if (dbResult?.result === 'updated') {
console.log(`  → updated booking ${dbResult.rows[0].id} (${dbResult.rows.length} row${dbResult.rows.length === 1 ? '' : 's'})`)
}

res.json({ received: true })
})

app.post('/stripe/connect/dashboard', requireAuth, async (req, res) => {
try {
const stripe = getStripe()
const { accountId } = req.body
const loginLink = await stripe.accounts.createLoginLink(accountId)
res.json({ url: loginLink.url })
} catch (err) {
res.status(500).json({ error: err.message })
}
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`HireIt backend running on port ${PORT}`))
