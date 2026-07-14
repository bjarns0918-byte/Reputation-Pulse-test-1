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

export function createBusiness({ email, passwordHash, businessName, phone, billingPlan }) {
  const db = readDb();
  const existing = Object.values(db.businesses).find(
    (b) => b.email.toLowerCase() === email.toLowerCase()
  );
  if (existing) throw new Error("An account with this email already exists.");
  if (isEmailTakenByTeamMember(db, email)) {
    throw new Error("An account with this email already exists.");
  }

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
    billingPlan: billingPlan === "annual" ? "annual" : "monthly",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    googleTokens: null,
    accountId: null,
    locationId: null,
    reviews: {},
    ratingHistory: [], // [{ label, avgRating, reviewCount, date }]
    themeHistory: [], // [{ label, themes: [{theme, sentiment, mentions}], date }]
    resetTokenHash: null,
    resetTokenExpiry: null,
    cancelCodeHash: null,
    cancelCodeExpiry: null,
    lastSyncedAt: null,
    teamMembers: [], // [{ id, email, passwordHash, invitedAt }]
    latestDigest: null // { strengths, improvements }
  };
  writeDb(db);
  return db.businesses[id];
}

function isEmailTakenByTeamMember(db, email) {
  return Object.values(db.businesses).some((b) =>
    (b.teamMembers || []).some((t) => t.email.toLowerCase() === email.toLowerCase())
  );
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

export function getBusinessByResetTokenHash(tokenHash) {
  const db = readDb();
  return Object.values(db.businesses).find((b) => b.resetTokenHash === tokenHash) || null;
}

export function setResetToken(businessId, tokenHash, expiryIso) {
  const db = readDb();
  if (!db.businesses[businessId]) return;
  db.businesses[businessId].resetTokenHash = tokenHash;
  db.businesses[businessId].resetTokenExpiry = expiryIso;
  writeDb(db);
}

export function clearResetToken(businessId) {
  const db = readDb();
  if (!db.businesses[businessId]) return;
  db.businesses[businessId].resetTokenHash = null;
  db.businesses[businessId].resetTokenExpiry = null;
  writeDb(db);
}

// --- Cancellation confirmation code ---

export function setCancelCode(businessId, codeHash, expiryIso) {
  const db = readDb();
  if (!db.businesses[businessId]) return;
  db.businesses[businessId].cancelCodeHash = codeHash;
  db.businesses[businessId].cancelCodeExpiry = expiryIso;
  writeDb(db);
}

export function clearCancelCode(businessId) {
  const db = readDb();
  if (!db.businesses[businessId]) return;
  db.businesses[businessId].cancelCodeHash = null;
  db.businesses[businessId].cancelCodeExpiry = null;
  writeDb(db);
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

// --- Team members: shared logins with limited (non-billing) access ---

export function addTeamMember(businessId, { email, passwordHash }) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) throw new Error("Business not found.");

  const emailTaken =
    Object.values(db.businesses).some((b) => b.email.toLowerCase() === email.toLowerCase()) ||
    Object.values(db.businesses).some((b) => (b.teamMembers || []).some((t) => t.email.toLowerCase() === email.toLowerCase()));
  if (emailTaken) throw new Error("An account with this email already exists.");

  if (!Array.isArray(biz.teamMembers)) biz.teamMembers = [];
  const member = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    invitedAt: new Date().toISOString()
  };
  biz.teamMembers.push(member);
  writeDb(db);
  return member;
}

export function removeTeamMember(businessId, teamMemberId) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  biz.teamMembers = (biz.teamMembers || []).filter((t) => t.id !== teamMemberId);
  writeDb(db);
}

export function getTeamMembers(businessId) {
  const db = readDb();
  const biz = db.businesses[businessId];
  return biz ? (biz.teamMembers || []) : [];
}

// Used at login: finds which business a team member's email belongs to.
export function findTeamMemberByEmail(email) {
  const db = readDb();
  for (const business of Object.values(db.businesses)) {
    const member = (business.teamMembers || []).find((t) => t.email.toLowerCase() === email.toLowerCase());
    if (member) return { business, member };
  }
  return null;
}

export function updateTeamMemberPassword(businessId, teamMemberId, passwordHash) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  const member = (biz.teamMembers || []).find((t) => t.id === teamMemberId);
  if (member) {
    member.passwordHash = passwordHash;
    writeDb(db);
  }
}

export function deleteBusiness(businessId) {
  const db = readDb();
  if (!db.businesses[businessId]) return false;
  delete db.businesses[businessId];
  writeDb(db);
  return true;
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
    reviews: {},
    ratingHistory: [],
    themeHistory: [],
    resetTokenHash: null,
    resetTokenExpiry: null,
    cancelCodeHash: null,
    cancelCodeExpiry: null,
    lastSyncedAt: null,
    teamMembers: [],
    latestDigest: null
  };
  writeDb(db);
  return db.businesses[id];
}

// --- Rating history, for the trend chart ---

export function appendRatingSnapshot(businessId, entry) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  if (!Array.isArray(biz.ratingHistory)) biz.ratingHistory = [];
  const existingIndex = biz.ratingHistory.findIndex((h) => h.label === entry.label);
  if (existingIndex >= 0) {
    biz.ratingHistory[existingIndex] = entry;
  } else {
    biz.ratingHistory.push(entry);
  }
  writeDb(db);
}

export function clearRatingHistory(businessId) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  biz.ratingHistory = [];
  writeDb(db);
}

// --- Theme/sentiment history, for the sentiment trend panel ---

export function appendThemeSnapshot(businessId, entry) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  if (!Array.isArray(biz.themeHistory)) biz.themeHistory = [];
  const existingIndex = biz.themeHistory.findIndex((h) => h.label === entry.label);
  if (existingIndex >= 0) {
    biz.themeHistory[existingIndex] = entry;
  } else {
    biz.themeHistory.push(entry);
  }
  writeDb(db);
}

export function clearThemeHistory(businessId) {
  const db = readDb();
  const biz = db.businesses[businessId];
  if (!biz) return;
  biz.themeHistory = [];
  writeDb(db);
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
