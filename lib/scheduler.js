import cron from "node-cron";
import { getAllBusinesses, updateBusiness, upsertReview, getReviewsSince, appendRatingSnapshot } from "./store.js";
import { getValidAccessToken } from "./googleAuth.js";
import { fetchAllReviews, postReplyToReview } from "./googleReviews.js";
import { draftReply, draftAutoPostReply, buildDigest } from "./claude.js";
import { sendEmail, sendUrgentReviewAlert } from "./emailer.js";

const AUTO_POST_STARS = ["FOUR", "FIVE"]; // 4-5 star reviews get auto-posted replies
const DRAFT_ONLY_STARS = ["ONE", "TWO", "THREE"]; // 1-3 star reviews wait for approval
const URGENT_ALERT_STARS = ["ONE", "TWO"]; // these get an instant email, not just the monthly digest

// Runs the daily review check for one business.
export async function syncOneBusiness(business) {
  if (!business.googleTokens || !business.accountId || !business.locationId) {
    return; // this business hasn't connected Google yet
  }

  const accessToken = await getValidAccessToken(business.googleTokens, (tokens) =>
    updateBusiness(business.id, { googleTokens: tokens })
  );
  const reviews = await fetchAllReviews(accessToken, business.accountId, business.locationId);

  let autoPosted = 0;
  let drafted = 0;

  for (const review of reviews) {
    const alreadyHandled = business.reviews[review.reviewId];
    if (alreadyHandled && (alreadyHandled.status === "posted" || alreadyHandled.status === "pending_approval")) {
      continue;
    }

    if (AUTO_POST_STARS.includes(review.starRating)) {
      const replyText = await draftAutoPostReply(review, business.businessName, business.replyTone);
      await postReplyToReview(accessToken, business.accountId, business.locationId, review.reviewId, replyText);
      upsertReview(business.id, {
        ...review,
        status: "posted",
        postedReply: replyText,
        postedAt: new Date().toISOString()
      });
      autoPosted++;
    } else if (DRAFT_ONLY_STARS.includes(review.starRating)) {
      const [opt1, opt2] = await draftReply(review, business.businessName, business.replyTone);
      upsertReview(business.id, {
        ...review,
        status: "pending_approval",
        draftReplies: [opt1, opt2],
        draftedAt: new Date().toISOString()
      });
      drafted++;
      if (URGENT_ALERT_STARS.includes(review.starRating)) {
        await sendUrgentReviewAlert(business, review);
      }
    }
  }

  updateBusiness(business.id, { lastSyncedAt: new Date().toISOString() });

  console.log(
    `[sync] ${business.businessName}: checked ${reviews.length} reviews, auto-posted ${autoPosted}, drafted ${drafted}.`
  );
}

export async function syncAllBusinesses() {
  const businesses = getAllBusinesses();
  for (const business of businesses) {
    try {
      await syncOneBusiness(business);
    } catch (err) {
      console.error(`[sync] failed for ${business.businessName}:`, err.message);
    }
  }
}

// Posts an approved reply for a review that was left as a draft (1-3 stars).
export async function postApprovedReply(accessToken, accountId, locationId, businessId, reviewId, replyText) {
  await postReplyToReview(accessToken, accountId, locationId, reviewId, replyText);
  upsertReview(businessId, {
    reviewId,
    status: "posted",
    postedReply: replyText,
    postedAt: new Date().toISOString()
  });
}

// Builds and emails the monthly digest for one business.
export async function runDigestForBusiness(business) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentReviews = getReviewsSince(business.id, thirtyDaysAgo);

  if (recentReviews.length === 0) return;

  const digest = await buildDigest(recentReviews, business.businessName);

  const starValue = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const avgRating =
    Math.round(
      (recentReviews.reduce((sum, r) => sum + (starValue[r.starRating] || 0), 0) / recentReviews.length) * 10
    ) / 10;
  const monthLabel = new Date().toLocaleString("en-US", { month: "short", year: "numeric" });
  appendRatingSnapshot(business.id, {
    label: monthLabel,
    avgRating,
    reviewCount: recentReviews.length,
    date: new Date().toISOString()
  });
  updateBusiness(business.id, { latestDigest: digest });

  const html = `
    <h2>${business.businessName} — Monthly Review Digest</h2>
    <p><strong>What's working:</strong> ${digest.strengths}</p>
    <p><strong>Needs improvement:</strong> ${digest.improvements}</p>
    <p style="color:#888;font-size:12px;">Based on ${recentReviews.length} review(s) from the last 30 days. Average rating: ${avgRating} / 5.</p>
  `;
  await sendEmail(business.email, `${business.businessName}: Your monthly review digest`, html);
  console.log(`[digest] Sent monthly digest to ${business.email}.`);
}

export async function runMonthlyDigestAllBusinesses() {
  const businesses = getAllBusinesses().filter((b) => b.subscriptionStatus === "active");
  for (const business of businesses) {
    try {
      await runDigestForBusiness(business);
    } catch (err) {
      console.error(`[digest] failed for ${business.businessName}:`, err.message);
    }
  }
}

export function startScheduler() {
  // Every day at 8am server time: check every connected business for new reviews.
  cron.schedule("0 8 * * *", () => {
    syncAllBusinesses().catch((err) => console.error("[sync] failed:", err.message));
  });

  // 1st of every month at 8am server time: send every active business its digest.
  cron.schedule("0 8 1 * *", () => {
    runMonthlyDigestAllBusinesses().catch((err) => console.error("[digest] failed:", err.message));
  });

  console.log("Scheduler started: daily review sync at 8am, monthly digest on the 1st at 8am, for all businesses.");
}
