// Talks to the Google Business Profile APIs to find the connected business's
// account/location, then pull its reviews.
//
// Docs: https://developers.google.com/my-business/content/review-data
// Note: Google occasionally reshuffles these endpoints between their various
// "Business Profile" sub-APIs. If a call here starts failing, check
// https://developers.google.com/my-business for the current endpoint shape.

async function googleRequest(url, accessToken, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    throw new Error(`Google API request failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Finds the first account + location tied to the signed-in Google user.
// If a business manages multiple locations, this grabs the first one -
// good enough for a single-location salon/shop MVP.
export async function findFirstAccountAndLocation(accessToken) {
  const accounts = await googleRequest(
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    accessToken
  );
  const account = accounts.accounts && accounts.accounts[0];
  if (!account) throw new Error("No Google Business account found for this login.");
  const accountId = account.name.split("/")[1];

  const locations = await googleRequest(
    `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations?readMask=name,title`,
    accessToken
  );
  const location = locations.locations && locations.locations[0];
  if (!location) throw new Error("No locations found for this Google Business account.");
  const locationId = location.name.split("/")[1];

  return { accountId, locationId, businessTitle: location.title };
}

// Posts (or updates) a reply on a specific review.
// Docs: https://developers.google.com/my-business/content/review-data
export async function postReplyToReview(accessToken, accountId, locationId, reviewId, comment) {
  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;
  return googleRequest(url, accessToken, {
    method: "PUT",
    body: JSON.stringify({ comment })
  });
}
export async function fetchAllReviews(accessToken, accountId, locationId) {
  let reviews = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?${params}`;
    const data = await googleRequest(url, accessToken);
    reviews = reviews.concat(data.reviews || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  // Normalize into a simpler shape the rest of the app uses.
  return reviews.map((r) => ({
    reviewId: r.reviewId,
    reviewer: r.reviewer && r.reviewer.displayName ? r.reviewer.displayName : "A customer",
    starRating: r.starRating, // e.g. "FIVE", "TWO"
    comment: r.comment || "(no written comment, star rating only)",
    createTime: r.createTime,
    updateTime: r.updateTime
  }));
}
