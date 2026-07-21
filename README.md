# RepAnchor — Setup Guide

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
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_MONTHLY`, `STRIPE_PRICE_ID_ANNUAL`, `STRIPE_WEBHOOK_SECRET` - see below
- `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` - your free admin login (use an
  email-shaped value for the username, e.g. `you@example.com`, since it's
  used the same way as any other account's email)

No more `BUSINESS_NAME`, `REPLY_TONE`, or `OWNER_EMAIL` as environment
variables - those are now per-business, collected at signup and stored in
the database instead.

## Setting up Stripe billing

1. Go to https://dashboard.stripe.com and sign up
2. Go to **Product catalog** → **Add product**
   - Name: anything (e.g. "RepAnchor Subscription")
   - Add a **Recurring** price: **$35.00**, **Monthly** - save, then copy that
     **Price ID** (starts with `price_`) into `STRIPE_PRICE_ID_MONTHLY`
   - On the same product, click **"Add another price"** and add a second
     **Recurring** price: **$395.00**, **Yearly** - copy that Price ID into
     `STRIPE_PRICE_ID_ANNUAL`
3. Go to **Developers** → **API keys** → copy your **Secret key** into
   `STRIPE_SECRET_KEY` (starts with `sk_`)
4. Go to **Developers** → **Webhooks** → **Add endpoint**
   - Endpoint URL: `https://your-real-url.onrender.com/webhook/stripe`
   - Select events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - After creating it, click into the endpoint and copy the **Signing secret**
     (starts with `whsec_`) into `STRIPE_WEBHOOK_SECRET`
5. Turn on the **Customer portal**: Settings → Billing → Customer portal -
   just a toggle, needed for the "Update payment method" button to work.

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

## New: CAPTCHA on signup (optional)

Signup can require a quick "prove you're human" check (Cloudflare Turnstile)
to stop bots and card-testing fraud attempts. It's off by default - leave
`TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` blank and signup works exactly
as before.

To turn it on:
1. Go to https://dash.cloudflare.com, sign up free
2. Go to **Turnstile** in the sidebar → **Add a site**
3. Choose the **Managed** widget type, add your real domain
4. Copy the **Site Key** into `TURNSTILE_SITE_KEY` and the **Secret Key** into
   `TURNSTILE_SECRET_KEY`

Most real visitors won't see any puzzle at all - Turnstile usually verifies
silently in the background.

## New: self-serve cancellation, password reset, and settings

- **Cancellation**: customers can now manage or cancel their subscription
  themselves from `/settings.html`, which sends them to Stripe's own hosted
  billing portal. **One-time setup required**: in the Stripe dashboard, go
  to Settings -> Billing -> Customer portal, and turn it on. No code needed,
  just that one toggle - it won't work until you do this.
- **Forgot password**: `/forgot-password.html` emails a one-time reset link
  (valid 1 hour) via Resend. `/reset-password.html` is where that link lands.
- **Settings page**: business name, reply tone, and phone number can now be
  edited after signup at `/settings.html`, instead of being locked in forever.

## New: Terms of Service and Privacy Policy

`/terms.html` and `/privacy.html` are included as a starting template -
**this is not legal advice**. Before relying on these for real customers:
1. Search each page for `[fill in date]`, `[your business/legal name]`, and
   `[your contact email]` and replace them with your real information.
2. Have an actual lawyer review both pages, especially since you're
   processing real payments and collecting phone numbers.
