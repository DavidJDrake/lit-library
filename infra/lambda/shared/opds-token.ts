import { createHash, randomBytes } from "node:crypto";

// A per-reader OPDS token is 256 bits of randomness from a CSPRNG, base64url-encoded so
// it drops cleanly into a query string with no escaping. Only its SHA-256 hash is ever
// stored — see opdsTokenPk below — so a database read alone can never hand out a working
// credential, and a leaked hash cannot be turned back into the token that produced it.
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_MAX_LENGTH = 200; // generous upper bound; a real token is ~43 chars

export function generateOpdsToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashOpdsToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Rejects anything that cannot possibly be a token we issued before it is ever hashed
// and looked up, so a malformed or oversized query parameter costs one regex test
// rather than a database round trip.
export function isPlausibleOpdsToken(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length <= TOKEN_MAX_LENGTH && TOKEN_RE.test(token);
}

// Key layout in the shared library table (see infra/lambda/library/store.ts):
//   pk = OPDSTOKEN#<sha256 of the token>, sk = TOKEN   -> { email, createdAt }
// A GetItem on this key is the only way to resolve a token to a reader, and it is the
// only OPDS-related access the download Lambda is granted (read-only).
export const OPDS_TOKEN_SK = "TOKEN";
export const opdsTokenPk = (hash: string): string => `OPDSTOKEN#${hash}`;

// Per-reader descriptor, alongside the Kindle settings row's own USER# partition:
//   pk = USER#<email lowercased>, sk = OPDS   -> { tokenHash, createdAt }
// Records only that a token exists and when it was made, so the interface can say so
// without ever being able to reveal it, and so revoking/regenerating can find (and
// delete) the previous lookup row above.
export const OPDS_READER_SK = "OPDS";
export const opdsReaderPk = (email: string): string => `USER#${email.toLowerCase()}`;
