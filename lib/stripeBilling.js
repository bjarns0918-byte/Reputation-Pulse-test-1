// Handles Stripe Checkout (the $35/month payment page) and the webhook that
// tells us when a payment succeeds or a subscription is canceled.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

export async function createCheckoutSession(business) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
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

export { stripe };
