// Multi-tenant file-based storage. Each business (restaurant) that signs up
// gets its own record: login info, billing status, Google connection, and reviews.
// Still no database to install - everything saves to data/db.json on disk.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function readDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = { businesses: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDb(data) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export function createBusiness({ email, passwordHash, businessName, phone }) {
  const db = readDb();
  const existing = Object.values(db.businesses).find(
    (b) => b.email.toLowerCase() === email.toLowerCase()
  );
  if (existing) throw new Error("An account with this email already exists.");

  const id = crypto.randomUUID();
  db.businesses[id] = {
    id,
    email,
    passwordHash,
    businessName,
    phone: phone || null,
    replyTone: "warm and casual",
    createdAt: new Date().toISOString(),
    isAdmin: false,
    subscriptionStatus: "pending", // pending -> active -> canceled
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    googleTokens: null,
    accountId: null,
    locationId: null,
    reviews: {}
  };
  writeDb(db);
  return db.businesses[id];
}

export function getBusinessByEmail(email) {
  const db = readDb();
  return Object.values(db.businesses).find(
    (b) => b.email.toLowerCase() === email.toLowerCase()
  ) || null;
}

export function getBusinessById(id) {
  const db = readDb();
  return db.businesses[id] || null;
}

export function getBusinessByStripeCustomerId(stripeCustomerId) {
  const db = readDb();
  return Object.values(db.businesses).find((b) => b.stripeCustomerId === stripeCustomerId) || null;
}

export function updateBusiness(id, patch) {
  const db = readDb();
  if (!db.businesses[id]) return null;
  db.businesses[id] = { ...db.businesses[id], ...patch };
  writeDb(db);
  return db.businesses[id];
}

export function getAllBusinesses() {
  const db = readDb();
  return Object.values(db.businesses);
}

export function ensureAdminAccount(email, passwordHash) {
  if (!email || !passwordHash) return;
  const db = readDb();
  const existing = Object.values(db.businesses).find((b) => b.isAdmin);
  if (existing) {
    existing.email = email;
    existing.passwordHash = passwordHash;
    existing.subscriptionStatus = "active";
    writeDb(db);
    return existing;
  }
  const id = crypto.randomUUID();
  db.businesses[id] = {
    id,
    email,
    passwordHash,
    businessName: "Admin Test Account",
    phone: null,
    replyTone: "warm and casual",
    createdAt: new Date().toISOString(),
    isAdmin: true,
    subscriptionStatus: "active",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    googleTokens: null,
    accountId: null,
    locationId: null,
    reviews: {}
  };
  writeDb(db);
  return db.businesses[id];
}

// --- Review helpers, all scoped to a specific business ---

export function upsertReview(businessId, review) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return null;
  const existing = biz.reviews[review.reviewId] || {};
  biz.reviews[review.reviewId] = { ...existing, ...review };
  writeDb(db);
  return biz.reviews[review.reviewId];
}

export function getAllReviews(businessId) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return [];
  return Object.values(biz.reviews).sort(
    (a, b) => new Date(b.createTime) - new Date(a.createTime)
  );
}

export function getReviewsSince(businessId, dateObj) {
  return getAllReviews(businessId).filter((r) => new Date(r.createTime) >= dateObj);
}

export function clearDemoReviews(businessId) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  for (const id of Object.keys(biz.reviews)) {
    if (biz.reviews[id].isDemo) delete biz.reviews[id];
  }
  writeDb(db);
}
