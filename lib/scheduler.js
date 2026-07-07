import cron from "node-cron";
import { getDb, saveGoogleTokens, upsertReview, getReviewsSince } from "./store.js";
import { getValidAccessToken } from "./googleAuth.js";
import { fetchAllReviews, postReplyToReview } from "./googleReviews.js";
import { draftReply, draftAutoPostReply, buildDigest } from "./claude.js";
import { sendEmail } from "./emailer.js";

const BUSINESS_NAME = process.env.BUSINESS_NAME || "our business";
const REPLY_TONE = process.env.REPLY_TONE || "warm and casual";
const AUTO_POST_STARS = ["FOUR", "FIVE"]; // 4-5 star reviews get auto-posted replies
const DRAFT_ONLY_STARS = ["ONE", "TWO", "THREE"]; // 1-3 star reviews wait for your approval

// Pulls the latest reviews from Google. 4-5 star reviews get a reply
// automatically posted. 1-3 star reviews get drafted and left on the
// dashboard for you to review and post yourself.
export async function syncReviewsAndDraftReplies() {
  const db = getDb();
  if (!db.googleTokens || !db.accountId || !db.locationId) {
    console.log("[sync] Google not connected yet - visit /auth/google first.");
    return;
  }

  const accessToken = await getValidAccessToken(db.googleTokens, saveGoogleTokens);
  const reviews = await fetchAllReviews(accessToken, db.accountId, db.locationId);

  let autoPosted = 0;
  let drafted = 0;

  for (const review of reviews) {
    const alreadyHandled = db.reviews[review.reviewId];
    if (alreadyHandled && (alreadyHandled.status === "posted" || alreadyHandled.status === "pending_approval")) {
      continue; // already handled in a previous sync
    }

    if (AUTO_POST_STARS.includes(review.starRating)) {
      const replyText = await draftAutoPostReply(review, BUSINESS_NAME, REPLY_TONE);
      await postReplyToReview(accessToken, db.accountId, db.locationId, review.reviewId, replyText);
      upsertReview({
        ...review,
        status: "posted",
        postedReply: replyText,
        postedAt: new Date().toISOString()
      });
      autoPosted++;
    } else if (DRAFT_ONLY_STARS.includes(review.starRating)) {
      const [opt1, opt2] = await draftReply(review, BUSINESS_NAME, REPLY_TONE);
      upsertReview({
        ...review,
        status: "pending_approval",
        draftReplies: [opt1, opt2],
        draftedAt: new Date().toISOString()
      });
      drafted++;
    }
  }

  console.log(
    `[sync] Checked ${reviews.length} reviews. Auto-posted ${autoPosted} (4-5 star). Drafted ${drafted} for approval (1-3 star).`
  );
}

// Posts an approved reply for a review that was left as a draft (1-3 stars).
export async function postApprovedReply(accessToken, accountId, locationId, reviewId, replyText) {
  await postReplyToReview(accessToken, accountId, locationId, reviewId, replyText);
  upsertReview({
    reviewId,
    status: "posted",
    postedReply: replyText,
    postedAt: new Date().toISOString()
  });
}

// Builds and emails the monthly digest for reviews from the last 30 days.
export async function runMonthlyDigest() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentReviews = getReviewsSince(thirtyDaysAgo);

  if (recentReviews.length === 0) {
    console.log("[digest] No reviews in the last 30 days, skipping digest.");
    return;
  }

  const digestText = await buildDigest(recentReviews, BUSINESS_NAME);
  const html = `
    <h2>${BUSINESS_NAME} — Monthly Review Digest</h2>
    <p>${digestText.replace(/\n/g, "<br>")}</p>
    <p style="color:#888;font-size:12px;">Based on ${recentReviews.length} review(s) from the last 30 days.</p>
  `;
  await sendEmail(`${BUSINESS_NAME}: Your monthly review digest`, html);
  console.log("[digest] Monthly digest emailed.");
}

export function startScheduler() {
  // Every day at 8am server time: check for new reviews and draft replies.
  cron.schedule("0 8 * * *", () => {
    syncReviewsAndDraftReplies().catch((err) => console.error("[sync] failed:", err.message));
  });

  // 1st of every month at 8am server time: send the digest.
  cron.schedule("0 8 1 * *", () => {
    runMonthlyDigest().catch((err) => console.error("[digest] failed:", err.message));
  });

  console.log("Scheduler started: daily review sync at 8am, monthly digest on the 1st at 8am.");
}
