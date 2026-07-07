# Reputation Pulse — Setup Guide

This is now a real multi-business SaaS: anyone can sign up, pay $35/month via
Stripe, and get their own dashboard. You (the owner) also get a free admin
account that bypasses payment entirely, so you can keep testing.

## What's new in this version

- **Public signup page** (`/signup.html`): email, password, optional phone
  number, and business name. Creates an account, then sends the person to
  Stripe Checkout to pay.
- **Login page** (`/login.html`): existing accounts log in here.
- **Your admin account**: set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`
  in your environment variables. The server automatically creates this
  account on startup, marked as free/unlimited forever - no Stripe payment
  ever required for this one login.
- **Per-business data**: every signed-up business gets their own reviews,
  Google connection, and reply tone - fully separated from every other
  business using the app.

## Environment variables

See `.env.example` for the full list with comments. New ones beyond what
existed before:

- `SESSION_SECRET` - any long random string, keeps login sessions secure
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` - see below
- `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` - your free admin login (use an
  email-shaped value for the username, e.g. `you@example.com`, since it's
  used the same way as any other account's email)

No more `BUSINESS_NAME`, `REPLY_TONE`, or `OWNER_EMAIL` as environment
variables - those are now per-business, collected at signup and stored in
the database instead.

## Setting up Stripe billing

1. Go to https://dashboard.stripe.com and sign up
2. Go to **Product catalog** → **Add product**
   - Name: anything (e.g. "Reputation Pulse Subscription")
   - Pricing: **Recurring**, **$35.00**, **Monthly**
   - Save, then copy the **Price ID** shown (starts with `price_`) into
     `STRIPE_PRICE_ID`
3. Go to **Developers** → **API keys** → copy your **Secret key** into
   `STRIPE_SECRET_KEY` (starts with `sk_`)
4. Go to **Developers** → **Webhooks** → **Add endpoint**
   - Endpoint URL: `https://your-real-url.onrender.com/webhook/stripe`
   - Select events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - After creating it, click into the endpoint and copy the **Signing secret**
     (starts with `whsec_`) into `STRIPE_WEBHOOK_SECRET`

Stripe also has **test mode** (a toggle in the dashboard) - use test mode
and Stripe's test card numbers (like `4242 4242 4242 4242`) while you're
still building, so you don't process real charges. Switch to live mode
(and a live secret key + live webhook) only once you're ready for real
customers to pay.

## How the free admin account works

The first time the server starts with `DASHBOARD_USERNAME` and
`DASHBOARD_PASSWORD` set, it automatically creates an account using those
as the login email/password, marked as an admin - permanently active,
never needs to pay. Just go to `/login.html` and log in with those same
values to get in.

## Everything else

The rest of the setup (Node.js install, Google Cloud OAuth credentials,
Anthropic key, Resend key, deploying to Render, the daily sync and monthly
digest schedule) works the same as before - see `.env.example` for exactly
which values go where.

## A note on the database

Everything (accounts, reviews, billing status) is stored in a single
`data/db.json` file on disk. This is fine for getting started, but on most
hosting platforms (including Render's free/starter tiers) this file can be
wiped out when the server redeploys or restarts. Once you have real,
paying customers, add a small persistent disk (Render calls this a "Disk"
in your service settings) so account data survives redeploys - losing
customer accounts is a much bigger problem than losing test data.
