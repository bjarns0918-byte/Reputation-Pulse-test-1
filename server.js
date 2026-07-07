import "dotenv/config";
import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";

import { hashPassword, verifyPassword } from "./lib/auth.js";
import {
  createBusiness,
  getBusinessByEmail,
  getBusinessById,
  getBusinessByStripeCustomerId,
  updateBusiness,
  ensureAdminAccount,
  getAllReviews,
  upsertReview,
  clearDemoReviews
} from "./lib/store.js";
import { createCheckoutSession, verifyWebhookSignature } from "./lib/stripeBilling.js";
import { getGoogleAuthUrl, exchangeCodeForTokens, getValidAccessToken } from "./lib/googleAuth.js";
import { findFirstAccountAndLocation } from "./lib/googleReviews.js";
import { syncOneBusiness, runDigestForBusiness, postApprovedReply, startScheduler } from "./lib/scheduler.js";
import { draftReply, draftAutoPostReply, buildDigest, generateSampleReviews } from "./lib/claude.js";

const AUTO_POST_STARS = ["FOUR", "FIVE"];
const STAR_MAP = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- Stripe webhook needs the RAW request body to verify its signature, so ---
// --- this route must be registered before express.json() below. ---
app.post("/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhookSignature(req.body, req.headers["stripe-signature"]);
  } catch (err) {
    console.error("Stripe webhook signature check failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const businessId = session.client_reference_id;
    if (businessId) {
      updateBusiness(businessId, {
        subscriptionStatus: "active",
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription
      });
      console.log(`[stripe] Subscription activated for business ${businessId}`);
    }
  } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const business = getBusinessByStripeCustomerId(subscription.customer);
    if (business) {
      const status = subscription.status === "active" ? "active" : "canceled";
      updateBusiness(business.id, { subscriptionStatus: status });
      console.log(`[stripe] ${business.businessName} subscription status -> ${status}`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
  })
);

// --- Auth middleware ---
function requireLogin(req, res, next) {
  if (!req.session.businessId) {
    return res.status(401).json({ ok: false, error: "Please log in first." });
  }
  const business = getBusinessById(req.session.businessId);
  if (!business) {
    req.session.destroy(() => {});
    return res.status(401).json({ ok: false, error: "Account not found. Please log in again." });
  }
  req.business = business;
  next();
}

function requireActive(req, res, next) {
  if (req.business.isAdmin || req.business.subscriptionStatus === "active") return next();
  return res.status(402).json({
    ok: false,
    error: "Your subscription isn't active yet.",
    subscriptionStatus: req.business.subscriptionStatus
  });
}

// --- Page routes: only show the dashboard to someone who's logged in ---
app.get("/", (req, res) => {
  if (!req.session.businessId) return res.redirect("/login.html");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// --- Account routes ---
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password, phone, businessName } = req.body;
    if (!email || !password || !businessName) {
      return res.status(400).json({ ok: false, error: "Email, password, and business name are all required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
    }
    const passwordHash = hashPassword(password);
    const business = createBusiness({ email, passwordHash, businessName, phone });
    req.session.businessId = business.id;
    const checkoutUrl = await createCheckoutSession(business);
    res.json({ ok: true, checkoutUrl });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const business = getBusinessByEmail(email || "");
  if (!business || !verifyPassword(password || "", business.passwordHash)) {
    return res.status(401).json({ ok: false, error: "Invalid email or password." });
  }
  req.session.businessId = business.id;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({
    ok: true,
    email: req.business.email,
    businessName: req.business.businessName,
    isAdmin: req.business.isAdmin,
    subscriptionStatus: req.business.subscriptionStatus
  });
});

// In case someone abandons the Stripe checkout page, this lets them restart it.
app.post("/api/create-checkout", requireLogin, async (req, res) => {
  try {
    const checkoutUrl = await createCheckoutSession(req.business);
    res.json({ ok: true, checkoutUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Google connection, scoped to whoever is logged in ---
app.get("/auth/google", requireLogin, (req, res) => {
  res.redirect(getGoogleAuthUrl());
});

app.get("/auth/google/callback", requireLogin, async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing authorization code.");
    const tokens = await exchangeCodeForTokens(code);
    const { accountId, locationId, businessTitle } = await findFirstAccountAndLocation(tokens.access_token);
    updateBusiness(req.business.id, { googleTokens: tokens, accountId, locationId });
    console.log(`Connected Google Business Profile for: ${businessTitle}`);
    res.redirect("/?connected=1");
  } catch (err) {
    console.error("Google auth callback failed:", err.message);
    res.status(500).send(`Something went wrong connecting Google: ${err.message}`);
  }
});

// --- Dashboard data ---
app.get("/api/reviews", requireLogin, (req, res) => {
  res.json(getAllReviews(req.business.id));
});

app.get("/api/status", requireLogin, (req, res) => {
  res.json({
    googleConnected: !!req.business.googleTokens,
    locationId: req.business.locationId || null,
    subscriptionStatus: req.business.subscriptionStatus,
    isAdmin: req.business.isAdmin,
    businessName: req.business.businessName
  });
});

app.post("/api/sync-now", requireLogin, requireActive, async (req, res) => {
  try {
    await syncOneBusiness(req.business);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/digest-now", requireLogin, requireActive, async (req, res) => {
  try {
    await runDigestForBusiness(req.business);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/post-reply", requireLogin, requireActive, async (req, res) => {
  try {
    const { reviewId, replyText } = req.body;
    if (!reviewId || !replyText) {
      return res.status(400).json({ ok: false, error: "Missing reviewId or replyText." });
    }
    const business = req.business;
    if (!business.googleTokens || !business.accountId || !business.locationId) {
      return res.status(400).json({ ok: false, error: "Google not connected." });
    }
    const accessToken = await getValidAccessToken(business.googleTokens, (tokens) =>
      updateBusiness(business.id, { googleTokens: tokens })
    );
    await postApprovedReply(accessToken, business.accountId, business.locationId, business.id, reviewId, replyText);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Preview / simulation: generates a realistic month of reviews for your ---
// --- own business name and runs them through the real reply/digest logic. ---
app.post("/api/run-simulation", requireLogin, requireActive, async (req, res) => {
  try {
    const business = req.business;
    const bizName = business.businessName;
    const tone = business.replyTone;

    clearDemoReviews(business.id);
    const sampleReviews = await generateSampleReviews(bizName);

    let autoPosted = 0;
    let drafted = 0;
    let starSum = 0;

    for (let i = 0; i < sampleReviews.length; i++) {
      const sample = sampleReviews[i];
      const starRating = STAR_MAP[sample.stars];
      starSum += sample.stars;
      const reviewId = `demo-${Date.now()}-${i}`;
      const fakeReview = { comment: sample.comment, starRating };

      if (AUTO_POST_STARS.includes(starRating)) {
        const reply = await draftAutoPostReply(fakeReview, bizName, tone);
        upsertReview(business.id, {
          reviewId,
          reviewer: sample.reviewer,
          comment: sample.comment,
          starRating,
          createTime: new Date().toISOString(),
          status: "posted",
          postedReply: reply,
          postedAt: new Date().toISOString(),
          isDemo: true
        });
        autoPosted++;
      } else {
        const [opt1, opt2] = await draftReply(fakeReview, bizName, tone);
        upsertReview(business.id, {
          reviewId,
          reviewer: sample.reviewer,
          comment: sample.comment,
          starRating,
          createTime: new Date().toISOString(),
          status: "pending_approval",
          draftReplies: [opt1, opt2],
          draftedAt: new Date().toISOString(),
          isDemo: true
        });
        drafted++;
      }
    }

    const avgRating = Math.round((starSum / sampleReviews.length) * 10) / 10;
    const shapedForDigest = sampleReviews.map((s) => ({ comment: s.comment, starRating: STAR_MAP[s.stars] }));
    const digest = await buildDigest(shapedForDigest, bizName);

    res.json({
      ok: true,
      businessName: bizName,
      avgRating,
      reviewCount: sampleReviews.length,
      digest,
      autoPosted,
      drafted
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/demo-post-reply", requireLogin, requireActive, (req, res) => {
  try {
    const { reviewId, replyText } = req.body;
    if (!reviewId || !replyText) {
      return res.status(400).json({ ok: false, error: "Missing reviewId or replyText." });
    }
    upsertReview(req.business.id, {
      reviewId,
      status: "posted",
      postedReply: replyText,
      postedAt: new Date().toISOString(),
      isDemo: true
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/demo-clear", requireLogin, requireActive, (req, res) => {
  try {
    clearDemoReviews(req.business.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

if (process.env.DASHBOARD_USERNAME && process.env.DASHBOARD_PASSWORD) {
  ensureAdminAccount(process.env.DASHBOARD_USERNAME, hashPassword(process.env.DASHBOARD_PASSWORD));
  console.log(`Admin account ready. Log in at /login.html using your DASHBOARD_USERNAME/DASHBOARD_PASSWORD for free access.`);
} else {
  console.log("No DASHBOARD_USERNAME/DASHBOARD_PASSWORD set - you won't have a free admin account.");
}

app.listen(PORT, () => {
  console.log(`Reputation Pulse server running at http://localhost:${PORT}`);
  startScheduler();
});
