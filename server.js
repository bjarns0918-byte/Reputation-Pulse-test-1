import "dotenv/config";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

import { hashPassword, verifyPassword, generateResetToken, hashResetToken, generateConfirmationCode, hashConfirmationCode } from "./lib/auth.js";
import {
  createBusiness,
  getBusinessByEmail,
  getBusinessById,
  getBusinessByStripeCustomerId,
  getBusinessByResetTokenHash,
  updateBusiness,
  ensureAdminAccount,
  getAllReviews,
  upsertReview,
  clearDemoReviews,
  appendRatingSnapshot,
  clearRatingHistory,
  appendThemeSnapshot,
  clearThemeHistory,
  setResetToken,
  clearResetToken,
  setCancelCode,
  clearCancelCode
} from "./lib/store.js";
import { createCheckoutSession, verifyWebhookSignature, createPortalSession, cancelSubscriptionAtPeriodEnd } from "./lib/stripeBilling.js";
import { sendEmail } from "./lib/emailer.js";
import { getGoogleAuthUrl, exchangeCodeForTokens, getValidAccessToken } from "./lib/googleAuth.js";
import { findFirstAccountAndLocation } from "./lib/googleReviews.js";
import { syncOneBusiness, runDigestForBusiness, postApprovedReply, startScheduler } from "./lib/scheduler.js";
import { draftReply, draftAutoPostReply, buildDigest, generateSampleReviews, extractThemes } from "./lib/claude.js";

const AUTO_POST_STARS = ["FOUR", "FIVE"];
const STAR_MAP = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Render sits behind a proxy, so this is required for rate limiting (and
// anything else relying on the real client IP) to work correctly.
app.set("trust proxy", 1);

function rateLimitHandler(req, res) {
  res.status(429).json({ ok: false, error: "Too many attempts. Please wait a bit and try again." });
}

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

const cancelCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

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
      const isActiveLike = ["active", "trialing"].includes(subscription.status);
      const status = isActiveLike ? "active" : "canceled";
      updateBusiness(business.id, { subscriptionStatus: status });
      console.log(`[stripe] ${business.businessName} subscription status -> ${status} (Stripe status: ${subscription.status})`);
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
app.post("/api/signup", signupLimiter, async (req, res) => {
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

app.post("/api/login", loginLimiter, (req, res) => {
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

// Always responds ok:true regardless of whether the email exists, so a
// stranger can't use this to check which emails are registered.
app.post("/api/forgot-password", forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const business = getBusinessByEmail(email || "");
    if (business && !business.isAdmin) {
      const { rawToken, tokenHash } = generateResetToken();
      const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      setResetToken(business.id, tokenHash, expiry);
      const resetUrl = `${process.env.BASE_URL}/reset-password.html?token=${rawToken}`;
      const html = `
        <p>Someone requested a password reset for your Reputation Pulse account.</p>
        <p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `;
      await sendEmail(business.email, "Reset your Reputation Pulse password", html).catch((err) => {
        console.error("[forgot-password] Failed to send reset email:", err.message);
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/reset-password", (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ ok: false, error: "Missing token or new password." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
    }
    const tokenHash = hashResetToken(token);
    const business = getBusinessByResetTokenHash(tokenHash);
    if (!business || !business.resetTokenExpiry || new Date(business.resetTokenExpiry) < new Date()) {
      return res.status(400).json({ ok: false, error: "This reset link is invalid or has expired. Please request a new one." });
    }
    updateBusiness(business.id, { passwordHash: hashPassword(newPassword) });
    clearResetToken(business.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

// Sends a customer to Stripe's own hosted page to update payment info or
// cancel their subscription - no custom cancellation flow needed.
app.post("/api/create-portal-session", requireLogin, async (req, res) => {
  try {
    if (req.business.isAdmin) {
      return res.status(400).json({ ok: false, error: "Admin accounts don't have a billing subscription to manage." });
    }
    const portalUrl = await createPortalSession(req.business);
    res.json({ ok: true, portalUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Cancellation, with an emailed 6-digit code required to confirm ---

app.post("/api/request-cancel", requireLogin, cancelCodeLimiter, async (req, res) => {
  try {
    const business = req.business;
    if (business.isAdmin) {
      return res.status(400).json({ ok: false, error: "Admin accounts don't have a subscription to cancel." });
    }
    if (!business.stripeSubscriptionId) {
      return res.status(400).json({ ok: false, error: "No active subscription found." });
    }
    const { rawCode, codeHash } = generateConfirmationCode();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes
    setCancelCode(business.id, codeHash, expiry);
    const html = `
      <p>You (or someone with access to your account) requested to cancel your Reputation Pulse subscription.</p>
      <p>Your confirmation code is:</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:4px;">${rawCode}</p>
      <p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email - your
      subscription will not be canceled without this code.</p>
    `;
    await sendEmail(business.email, "Confirm your Reputation Pulse cancellation", html);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/confirm-cancel", requireLogin, async (req, res) => {
  try {
    const business = req.business;
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ ok: false, error: "Please enter the code from your email." });
    }
    if (!business.cancelCodeHash || !business.cancelCodeExpiry || new Date(business.cancelCodeExpiry) < new Date()) {
      return res.status(400).json({ ok: false, error: "This code has expired. Please request a new one." });
    }
    if (hashConfirmationCode(code) !== business.cancelCodeHash) {
      return res.status(400).json({ ok: false, error: "That code doesn't match. Please check your email and try again." });
    }
    const subscription = await cancelSubscriptionAtPeriodEnd(business);
    clearCancelCode(business.id);
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : null;
    res.json({ ok: true, periodEnd });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Settings: business name, reply tone, phone number ---
app.get("/api/settings", requireLogin, (req, res) => {
  res.json({
    ok: true,
    businessName: req.business.businessName,
    replyTone: req.business.replyTone,
    phone: req.business.phone,
    email: req.business.email
  });
});

app.post("/api/settings", requireLogin, (req, res) => {
  try {
    const { businessName, replyTone, phone } = req.body;
    if (!businessName || !businessName.trim()) {
      return res.status(400).json({ ok: false, error: "Business name can't be empty." });
    }
    updateBusiness(req.business.id, {
      businessName: businessName.trim(),
      replyTone: (replyTone || "warm and casual").trim(),
      phone: phone ? phone.trim() : null
    });
    res.json({ ok: true });
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

    // Draft every review's reply concurrently instead of one at a time -
    // this is the difference between ~40 seconds and ~5 seconds, and avoids
    // the request timing out partway through.
    const replyPromises = sampleReviews.map(async (sample, i) => {
      const starRating = STAR_MAP[sample.stars];
      const reviewId = `demo-${Date.now()}-${i}`;
      const fakeReview = { comment: sample.comment, starRating };

      if (AUTO_POST_STARS.includes(starRating)) {
        const reply = await draftAutoPostReply(fakeReview, bizName, tone);
        return { kind: "posted", reviewId, sample, starRating, reply };
      } else {
        const [opt1, opt2] = await draftReply(fakeReview, bizName, tone);
        return { kind: "pending", reviewId, sample, starRating, opt1, opt2 };
      }
    });

    const shapedForDigest = sampleReviews.map((s) => ({ comment: s.comment, starRating: STAR_MAP[s.stars] }));

    // Draft all the replies concurrently first, then run the digest and
    // themes afterward - keeps peak simultaneous API calls lower, which
    // makes occasional empty/overloaded responses less likely.
    const replyResults = await Promise.all(replyPromises);
    const [digest, themes] = await Promise.all([
      buildDigest(shapedForDigest, bizName),
      extractThemes(shapedForDigest, bizName)
    ]);

    let autoPosted = 0;
    let drafted = 0;
    let starSum = 0;

    for (const result of replyResults) {
      starSum += result.sample.stars;
      if (result.kind === "posted") {
        upsertReview(business.id, {
          reviewId: result.reviewId,
          reviewer: result.sample.reviewer,
          comment: result.sample.comment,
          starRating: result.starRating,
          createTime: new Date().toISOString(),
          status: "posted",
          postedReply: result.reply,
          postedAt: new Date().toISOString(),
          isDemo: true
        });
        autoPosted++;
      } else {
        upsertReview(business.id, {
          reviewId: result.reviewId,
          reviewer: result.sample.reviewer,
          comment: result.sample.comment,
          starRating: result.starRating,
          createTime: new Date().toISOString(),
          status: "pending_approval",
          draftReplies: [result.opt1, result.opt2],
          draftedAt: new Date().toISOString(),
          isDemo: true
        });
        drafted++;
      }
    }

    const avgRating = Math.round((starSum / sampleReviews.length) * 10) / 10;

    const existingHistory = getBusinessById(business.id).ratingHistory || [];
    const nextLabel = `Month ${existingHistory.length + 1}`;
    appendRatingSnapshot(business.id, {
      label: nextLabel,
      avgRating,
      reviewCount: sampleReviews.length,
      date: new Date().toISOString()
    });
    appendThemeSnapshot(business.id, {
      label: nextLabel,
      themes,
      date: new Date().toISOString()
    });

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

app.get("/api/rating-history", requireLogin, (req, res) => {
  const fresh = getBusinessById(req.business.id);
  res.json({ ok: true, history: fresh.ratingHistory || [], themeHistory: fresh.themeHistory || [] });
});

app.post("/api/demo-clear", requireLogin, requireActive, (req, res) => {
  try {
    clearDemoReviews(req.business.id);
    clearRatingHistory(req.business.id);
    clearThemeHistory(req.business.id);
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
