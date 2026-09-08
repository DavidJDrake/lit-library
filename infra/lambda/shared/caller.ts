/**
 * The caller's email, taken from the JWT's `email` claim and normalised.
 *
 * Every handler must go through this. Email addresses reach this system from two
 * places that disagree about case: the ID token's claim, and Cognito's user
 * directory. Several tables are keyed directly by the value a handler holds — the
 * downloads table by `email`, the library table by `USER#<email>` — so a handler
 * that keeps the raw claim while its neighbour lowercases will split one reader
 * across two partitions. That reader then sees an incomplete download log, loses
 * their "downloaded" marks, and cannot be matched against notifications fanned out
 * under the other spelling.
 *
 * Lowercasing is safe here: the local part of an address is case-sensitive in the
 * RFC but no real provider treats it so, and these addresses all originate from
 * Google sign-in against a fixed allowlist. Trimming guards against a stray space
 * surviving into a partition key, where it would be invisible and unexplainable.
 *
 * Returns an empty string when the claim is absent, so callers keep their existing
 * "no email claim" rejection rather than inventing a new failure mode here.
 */
export function callerEmail(claims: Record<string, unknown> | undefined): string {
  return String(claims?.email ?? "").trim().toLowerCase();
}
