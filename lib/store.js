// Simple file-based storage. No database to install - everything is saved
// to data/db.json on disk. This is plenty for one business tracking reviews.
// If you outgrow this later, swap this file out for a real database.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function readDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      googleTokens: null, // { access_token, refresh_token, expiry_date }
      accountId: null,
      locationId: null,
      reviews: {} // keyed by review id -> { ...review, draftReplies: [...], draftedAt }
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(data) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function getDb() {
  return readDb();
}

export function saveGoogleTokens(tokens) {
  const db = readDb();
  db.googleTokens = tokens;
  writeDb(db);
}

export function saveLocation(accountId, locationId) {
  const db = readDb();
  db.accountId = accountId;
  db.locationId = locationId;
  writeDb(db);
}

export function upsertReview(review) {
  const db = readDb();
  const existing = db.reviews[review.reviewId] || {};
  db.reviews[review.reviewId] = { ...existing, ...review };
  writeDb(db);
  return db.reviews[review.reviewId];
}

export function getAllReviews() {
  const db = readDb();
  return Object.values(db.reviews).sort(
    (a, b) => new Date(b.createTime) - new Date(a.createTime)
  );
}

export function getReviewsSince(dateObj) {
  return getAllReviews().filter((r) => new Date(r.createTime) >= dateObj);
}

export function clearDemoReviews() {
  const db = readDb();
  for (const id of Object.keys(db.reviews)) {
    if (db.reviews[id].isDemo) delete db.reviews[id];
  }
  writeDb(db);
}
