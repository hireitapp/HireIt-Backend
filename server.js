if (process.env.NODE_ENV !== 'production') require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { Resend } = require('resend')

const getStripe = () => require('stripe')(process.env.HIREIT_STRIPE_KEY || process.env.STRIPE_SECRET_KEY)
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

app.get('/health', (req, res) => {
  const key = process.env.HIREIT_STRIPE_KEY || process.env.STRIPE_SECRET_KEY
  res.json({ status: 'ok', stripeKeyPrefix: key?.slice(0,15), stripekeySuffix: key?.slice(-4) })
})

app.post('/notify-booking', async (req, res) => {
  try {
    const { ownerEmail, ownerName, hirerName, itemTitle, startDate, hours, total } = req.body
    console.log('Sending booking notification to:', ownerEmail)
    await resend.emails.send({
      from: 'HireIt <hello@hireitnow.au>',
      to: ownerEmail,
      subject: `New booking request for ${itemTitle}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #3B6D11; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">HireIt</h1>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #3B6D11;">New booking request!</h2>
            <p>Hi ${ownerName},</p>
            <p><strong>${hirerName}</strong> wants to hire your <strong>${itemTitle}</strong>.</p>
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="margin: 8px 0;"><strong>Start date:</strong> ${startDate}</p>
              <p style="margin: 8px 0;"><strong>Duration:</strong> ${hours} hours</p>
              <p style="margin: 8px 0;"><strong>Total:</strong> $${total}</p>
            </div>
            <p>Log in to HireIt to accept or decline this booking.</p>
            <a href="https://hireitnow.au/my-bookings" style="background:#3B6D11;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:16px;font-weight:bold;">View booking</a>
          </div>
          <div style="padding: 20px; text-align: center; color: #888; font-size: 13px;">
            <p>HireIt — Hire anything, from anyone near you</p>
            <p><a href="https://hireitnow.au" style="color: #3B6D11;">hireitnow.au</a></p>
          </div>
        </div>
      `
    })
    console.log('Email sent successfully to:', ownerEmail)
    res.json({ success: true })
  } catch (err) {
    console.error('Email error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/confirm-booking', async (req, res) => {
  try {
    const { hirerEmail, hirerName, itemTitle, ownerName, startDate, hours, total } = req.body
    await resend.emails.send({
      from: 'HireIt <hello@hireitnow.au>',
      to: hirerEmail,
      subject: `Booking confirmed — ${itemTitle}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #3B6D11; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">HireIt</h1>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #3B6D11;">Booking confirmed! 🎉</h2>
            <p>Hi ${hirerName},</p>
            <p>Your booking for <strong>${itemTitle}</strong> has been confirmed by ${ownerName}.</p>
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="margin: 8px 0;"><strong>Item:</strong> ${itemTitle}</p>
              <p style="margin: 8px 0;"><strong>Owner:</strong> ${ownerName}</p>
              <p style="margin: 8px 0;"><strong>Start date:</strong> ${startDate}</p>
              <p style="margin: 8px 0;"><strong>Duration:</strong> ${hours} hours</p>
              <p style="margin: 8px 0;"><strong>Total paid:</strong> $${total}</p>
            </div>
            <div style="background: #FAEEDA; border-radius: 8px; padding: 16px; margin: 20px 0;">
              <p style="margin: 0; color: #BA7517;"><strong>⚠️ Insurance reminder</strong></p>
              <p style="margin: 8px 0 0; color: #BA7517; font-size: 14px;">Remember to arrange your own insurance for the hired item before collection. HireIt accepts no liability for any loss or damage.</p>
            </div>
            <a href="https://hireitnow.au/my-bookings" style="background:#3B6D11;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:16px;font-weight:bold;">View my bookings</a>
          </div>
          <div style="padding: 20px; text-align: center; color: #888; font-size: 13px;">
            <p>HireIt — Hire anything, from anyone near you</p>
            <p><a href="https://hireitnow.au" style="color: #3B6D11;">hireitnow.au</a></p>
          </div>
        </div>
      `
    })
    res.json({ success: true })
  } catch (err) {
    console.error('Email error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/stripe/connect/onboard', async (req, res) => {
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

app.post('/stripe/payment-intent', async (req, res) => {
  try {
    const stripe = getStripe()
    const { amountAUD, depositAUD, ownerStripeId, bookingId, listingTitle } = req.body
    const totalCents = Math.round(amountAUD * 100)
    const depositCents = Math.round(depositAUD * 100)
    const hireCents = totalCents - depositCents
    const platformFeeCents = Math.round(hireCents * PLATFORM_FEE_PERCENT)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'aud',
      payment_method_types: ['card'],
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: ownerStripeId },
      metadata: { bookingId, listingTitle, depositCents },
      description: `HireIt booking: ${listingTitle}`,
    })
    res.json({ clientSecret: paymentIntent.client_secret })
  } catch (err) {
    console.error('Payment intent error:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/webhook', async (req, res) => {
  const stripe = getStripe()
  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object
      console.log(`✅ Payment succeeded: $${pi.amount / 100}`)
      break
    }
    case 'payment_intent.payment_failed': {
      console.log(`❌ Payment failed`)
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
  res.json({ received: true })
})

app.post('/stripe/connect/dashboard', async (req, res) => {
  try {
    const stripe = getStripe()
    const { accountId } = req.body
    const loginLink = await stripe.accounts.createLoginLink(accountId)
    res.json({ url: loginLink.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
app.post('/notify-review', async (req, res) => {
  try {
    const { recipientEmail, recipientName, reviewerName, rating, comment, itemTitle } = req.body
    await resend.emails.send({
      from: 'HireIt <hello@hireitnow.au>',
      to: recipientEmail,
      subject: `You received a ${rating}⭐ review on HireIt!`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #3B6D11; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">HireIt</h1>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #3B6D11;">You got a new review! ⭐</h2>
            <p>Hi ${recipientName},</p>
            <p><strong>${reviewerName}</strong> left you a ${rating}-star review for <strong>${itemTitle}</strong>.</p>
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <div style="font-size: 24px; margin-bottom: 8px;">${'⭐'.repeat(rating)}</div>
              <p style="margin: 0; font-style: italic;">"${comment}"</p>
            </div>
            <a href="https://hireitnow.au/profile" style="background:#3B6D11;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:16px;font-weight:bold;">View your profile</a>
          </div>
          <div style="padding: 20px; text-align: center; color: #888; font-size: 13px;">
            <p>HireIt — Hire anything, from anyone near you</p>
            <p><a href="https://hireitnow.au" style="color: #3B6D11;">hireitnow.au</a></p>
          </div>
        </div>
      `
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
    await resend.emails.send({
      from: 'HireIt <hello@hireitnow.au>',
      to: 'ky@kcroofplumbing.com.au',
      subject: `⚠️ Dispute filed — ${itemTitle}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #A32D2D; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">HireIt — Dispute Alert</h1>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <h2 style="color: #A32D2D;">⚠️ A problem has been reported</h2>
            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="margin: 8px 0;"><strong>Item:</strong> ${itemTitle}</p>
              <p style="margin: 8px 0;"><strong>Hirer:</strong> ${hirerName} (${hirerEmail})</p>
              <p style="margin: 8px 0;"><strong>Owner email:</strong> ${ownerEmail}</p>
              <p style="margin: 8px 0;"><strong>Total paid:</strong> $${total}</p>
              <p style="margin: 8px 0;"><strong>Booking ID:</strong> ${bookingId}</p>
              <p style="margin: 8px 0;"><strong>Problem:</strong> ${reason}</p>
            </div>
            <p>Log in to Supabase or Stripe to review this dispute and process a refund if applicable.</p>
            <a href="https://hireitnow.au/admin" style="background:#A32D2D;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;display:inline-block;margin-top:16px;font-weight:bold;">View admin dashboard</a>
          </div>
        </div>
      `
    })
    res.json({ success: true })
  } catch (err) {
    console.error('Dispute email error:', err)
    res.status(500).json({ error: err.message })
  }
})
const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`HireIt backend running on port ${PORT}`))
