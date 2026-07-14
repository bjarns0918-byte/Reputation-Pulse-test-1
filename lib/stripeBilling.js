// Handles Stripe Checkout (the $35/month payment page) and the webhook that
// tells us when a payment succeeds or a subscription is canceled.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

export async function createCheckoutSession(business) {
  const priceId =
    business.billingPlan === "annual"
      ? process.env.STRIPE_PRICE_ID_ANNUAL
      : process.env.STRIPE_PRICE_ID_MONTHLY;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 7
    },
    customer_email: business.email,
    client_reference_id: business.id,
    success_url: `${process.env.BASE_URL}/?checkout=success`,
    cancel_url: `${process.env.BASE_URL}/signup.html?checkout=cancelled`
  });
  return session.url;
}

export function verifyWebhookSignature(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// Lets a customer manage or cancel their own subscription through Stripe's
// hosted portal - no custom cancellation UI needed. Requires the "Customer
// portal" to be turned on once in the Stripe dashboard (Settings -> Billing
// -> Customer portal - just a toggle, no code needed).
export async function createPortalSession(business) {
  if (!business.stripeCustomerId) {
    throw new Error("No billing account found yet - complete checkout first.");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: business.stripeCustomerId,
    return_url: `${process.env.BASE_URL}/`
  });
  return session.url;
}

// Cancels at the end of the current billing period rather than instantly -
// the customer keeps access through what they already paid for, and it
// simply won't renew. The existing webhook handler flips their local
// subscriptionStatus to "canceled" automatically once Stripe actually ends it.
export async function cancelSubscriptionAtPeriodEnd(business) {
  if (!business.stripeSubscriptionId) {
    throw new Error("No active subscription found to cancel.");
  }
  const subscription = await stripe.subscriptions.update(business.stripeSubscriptionId, {
    cancel_at_period_end: true
  });
  return subscription;
}

// Used when someone deletes their whole account - cancels right away rather
// than waiting for period end, since there's no account left to keep access to.
export async function cancelSubscriptionImmediately(business) {
  if (!business.stripeSubscriptionId) return;
  try {
    await stripe.subscriptions.cancel(business.stripeSubscriptionId);
  } catch (err) {
    console.error(`[stripe] Failed to immediately cancel subscription for ${business.email}:`, err.message);
  }
}

export { stripe };
