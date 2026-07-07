import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { getDb, saveGoogleTokens, saveLocation, getAllReviews, upsertReview, clearDemoReviews } from "./lib/store.js";
import { getGoogleAuthUrl, exchangeCodeForTokens } from "./lib/googleAuth.js";
import { findFirstAccountAndLocation } from "./lib/googleReviews.js";
import { syncReviewsAndDraftReplies, runMonthlyDigest, postApprovedReply, startScheduler } from "./lib/scheduler.js";
import { getValidAccessToken } from "./lib/googleAuth.js";
import { draftReply, draftAutoPostReply, buildDigest, generateSampleReviews } from "./lib/claude.js";

const AUTO_POST_STARS = ["FOUR", "FIVE"];
const STAR_MAP = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- Simple password lock. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD in your ---
// --- environment variables to require a login before anyone can use this site. ---
// --- If those aren't set, the site stays open (useful only for local testing). ---
function requireAuth(req, res, next) {
  const user = process.env.DASHBOARD_USERNAME;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) return next();

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const separatorIndex = decoded.indexOf(":");
    const suppliedUser = decoded.slice(0, separatorIndex);
    const suppliedPass = decoded.slice(separatorIndex + 1);
    if (suppliedUser === user && suppliedPass === pass) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Reputation Pulse"');
  res.status(401).send("Password required.");
}
app.use(requireAuth);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Step 1: owner clicks this once to connect their Google Business Profile ---
app.get("/auth/google", (req, res) => {
  res.redirect(getGoogleAuthUrl());
});

// --- Step 2: Google sends the owner back here after they approve access ---
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing authorization code.");

    const tokens = await exchangeCodeForTokens(code);
    saveGoogleTokens(tokens);

    const { accountId, locationId, businessTitle } = await findFirstAccountAndLocation(
      tokens.access_token
    );
    saveLocation(accountId, locationId);

    console.log(`Connected Google Business Profile for: ${businessTitle}`);
    res.redirect("/?connected=1");
  } catch (err) {
    console.error("Google auth callback failed:", err.message);
    res.status(500).send(`Something went wrong connecting Google: ${err.message}`);
  }
});

// --- Dashboard data: all reviews + their drafted replies ---
app.get("/api/reviews", (req, res) => {
  res.json(getAllReviews());
});

app.get("/api/status", (req, res) => {
  const db = getDb();
  res.json({
    googleConnected: !!db.googleTokens,
    locationId: db.locationId || null
  });
});

// --- Manual triggers, useful for testing without waiting for the schedule ---
app.post("/api/sync-now", async (req, res) => {
  try {
    await syncReviewsAndDraftReplies();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/digest-now", async (req, res) => {
  try {
    await runMonthlyDigest();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Owner clicks "Post this reply" on the dashboard for a 1-3 star review draft.
app.post("/api/post-reply", async (req, res) => {
  try {
    const { reviewId, replyText } = req.body;
    if (!reviewId || !replyText) {
      return res.status(400).json({ ok: false, error: "Missing reviewId or replyText." });
    }
    const db = getDb();
    if (!db.googleTokens || !db.accountId || !db.locationId) {
      return res.status(400).json({ ok: false, error: "Google not connected." });
    }
    const accessToken = await getValidAccessToken(db.googleTokens, saveGoogleTokens);
    await postApprovedReply(accessToken, db.accountId, db.locationId, reviewId, replyText);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- TEST MODE: try the AI logic with hand-typed reviews, no Google needed ---

app.post("/api/test-draft", async (req, res) => {
  try {
    const { comment, stars } = req.body;
    if (!comment || !stars) {
      return res.status(400).json({ ok: false, error: "Missing comment or stars." });
    }
    const starRating = STAR_MAP[stars];
    const bizName = process.env.BUSINESS_NAME || "our business";
    const tone = process.env.REPLY_TONE || "warm and casual";
    const fakeReview = { comment, starRating };

    if (AUTO_POST_STARS.includes(starRating)) {
      const reply = await draftAutoPostReply(fakeReview, bizName, tone);
      res.json({ ok: true, mode: "auto", replies: [reply] });
    } else {
      const [opt1, opt2] = await draftReply(fakeReview, bizName, tone);
      res.json({ ok: true, mode: "draft", replies: [opt1, opt2] });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/test-digest", async (req, res) => {
  try {
    const { reviews } = req.body; // [{ comment, stars }, ...]
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return res.status(400).json({ ok: false, error: "No test reviews provided." });
    }
    const bizName = process.env.BUSINESS_NAME || "our business";
    const shaped = reviews.map((r) => ({ comment: r.comment, starRating: STAR_MAP[r.stars] }));
    const digest = await buildDigest(shaped, bizName);
    res.json({ ok: true, digest });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- DEMO MODE: simulate a real day of Google reviews coming in, so you can ---
// --- see the full automation (auto-post + approval queue) before you have a ---
// --- real connected business.

const SAMPLE_REVIEWS = [
  { stars: 5, reviewer: "Jordan M.", comment: "Best pizza in the neighborhood, the crust is always perfect and the staff remembers our order." },
  { stars: 5, reviewer: "Priya K.", comment: "Quick service and the garlic knots are incredible. Will definitely be back!" },
  { stars: 4, reviewer: "Sam T.", comment: "Really good food, just wish they had more vegetarian options on the menu." },
  { stars: 3, reviewer: "Alex R.", comment: "Food was fine but it took almost 45 minutes for a simple order on a weeknight." },
  { stars: 2, reviewer: "Morgan D.", comment: "Order was missing a topping we paid for and nobody answered when we called to ask about it." },
  { stars: 1, reviewer: "Casey L.", comment: "Waited over an hour for delivery and when I called to check, the person on the phone was rude and hung up on me." },
  { stars: 5, reviewer: "Taylor B.", comment: "Maria at the counter is always so kind, she remembered my usual order by name." },
  { stars: 4, reviewer: "Jamie F.", comment: "Solid food, good portions, just a bit pricier than similar spots nearby." }
];

app.post("/api/demo-full", async (req, res) => {
  try {
    const { businessName } = req.body;
    if (!businessName || !businessName.trim()) {
      return res.status(400).json({ ok: false, error: "Please enter a business name." });
    }
    const bizName = businessName.trim();
    const tone = process.env.REPLY_TONE || "warm and casual";
    const starMap = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE" };
    const autoPostStars = ["FOUR", "FIVE"];

    clearDemoReviews(); // start fresh each time so results reflect this business only

    const sampleReviews = await generateSampleReviews(bizName);

    let autoPosted = 0;
    let drafted = 0;
    let starSum = 0;

    for (let i = 0; i < sampleReviews.length; i++) {
      const sample = sampleReviews[i];
      const starRating = starMap[sample.stars];
      starSum += sample.stars;
      const reviewId = `demo-${Date.now()}-${i}`;
      const fakeReview = { comment: sample.comment, starRating };

      if (autoPostStars.includes(starRating)) {
        const reply = await draftAutoPostReply(fakeReview, bizName, tone);
        upsertReview({
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
        upsertReview({
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
    const shapedForDigest = sampleReviews.map((s) => ({ comment: s.comment, starRating: starMap[s.stars] }));
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

app.post("/api/demo-sync", async (req, res) => {
  try {
    const bizName = process.env.BUSINESS_NAME || "our business";
    const tone = process.env.REPLY_TONE || "warm and casual";
    const starMap = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE" };
    const autoPostStars = ["FOUR", "FIVE"];

    let autoPosted = 0;
    let drafted = 0;

    for (let i = 0; i < SAMPLE_REVIEWS.length; i++) {
      const sample = SAMPLE_REVIEWS[i];
      const starRating = starMap[sample.stars];
      const reviewId = `demo-${Date.now()}-${i}`;
      const fakeReview = { comment: sample.comment, starRating };

      if (autoPostStars.includes(starRating)) {
        const reply = await draftAutoPostReply(fakeReview, bizName, tone);
        upsertReview({
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
        upsertReview({
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

    res.json({ ok: true, autoPosted, drafted, total: SAMPLE_REVIEWS.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Approve a demo review's reply - just updates local storage, no real posting.
app.post("/api/demo-post-reply", (req, res) => {
  try {
    const { reviewId, replyText } = req.body;
    if (!reviewId || !replyText) {
      return res.status(400).json({ ok: false, error: "Missing reviewId or replyText." });
    }
    upsertReview({
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

app.post("/api/demo-clear", (req, res) => {
  try {
    clearDemoReviews();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Reputation Pulse server running at http://localhost:${PORT}`);
  console.log(`If this is your first time running it, visit http://localhost:${PORT}/auth/google to connect Google.`);
  startScheduler();
});
