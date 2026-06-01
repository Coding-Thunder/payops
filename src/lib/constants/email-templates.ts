/**
 * Client-safe enum of email template keys. Mirrors the array on the
 * server-side EmailTemplate model, kept here so validation schemas
 * (loaded into client bundles via `lib/validation`) don't drag in
 * Mongoose.
 */
export const EMAIL_TEMPLATE_KEYS = [
  "payment-confirmation",
  "payment-request",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];
