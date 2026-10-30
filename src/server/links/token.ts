import { createHash, randomBytes } from "node:crypto";

/**
 * Customer link tokens (PRD v0.2 §6.4): 32 random bytes (256 bits, above the 128-bit minimum), URL-safe base64
 * without padding. Only the SHA-256 of the token is stored; the token itself exists in the URL the customer holds.
 */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newLinkToken(): { token: string; hash: Buffer } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashLinkToken(token)! };
}

/** The stored hash of a token, or null when the text cannot be a token at all (it is then simply invalid). */
export function hashLinkToken(token: string): Buffer | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest();
}

/** Where the customer opens the link, in their preferred language (the page offers the other one). */
export function linkPath(locale: "ar" | "en", token: string): string {
  return `/${locale}/c/${token}`;
}
