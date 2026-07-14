// Simple password hashing using Node's built-in crypto module.
// No extra npm packages needed, no native compilation to worry about.

import crypto from "crypto";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(":");
  const hashToCompare = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hashToCompare, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Generates a one-time password reset token. The raw token goes in the
// emailed link; only its hash is stored, so a leaked database can't be
// used to reset anyone's password.
export function generateResetToken() {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

export function hashResetToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Generates a 6-digit code for confirming sensitive actions (like
// cancellation) by email. Only the hash is stored, same as the reset token.
export function generateConfirmationCode() {
  const rawCode = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const codeHash = crypto.createHash("sha256").update(rawCode).digest("hex");
  return { rawCode, codeHash };
}

export function hashConfirmationCode(rawCode) {
  return crypto.createHash("sha256").update(rawCode).digest("hex");
}

// A short numeric code for confirming sensitive actions (like cancellation)
// over email - easier to type than a long token, still single-use and short-lived.
export function generateSixDigitCode() {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  return { code, codeHash };
}

export function hashSixDigitCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}
