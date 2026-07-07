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
