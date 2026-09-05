// Shared by the CDK stack (seeding, Cognito group) and the library Lambda.
// Keep this file free of CDK imports: it is bundled into the Lambda.
export const ADMIN_GROUP = "admins";

export const SEED_CATEGORIES = [
  "Tech & Programming", "Security & Hacking", "Fiction", "Comics", "TTRPG", "Certification", "Other/Lifestyle",
] as const;

// Fixed so the seed custom resources' parameters never change between deploys.
export const SEED_AT = "2026-09-04T00:00:00.000Z";
