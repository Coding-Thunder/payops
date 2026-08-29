/**
 * Client-safe enum of email template keys. Mirrors the array on the
 * server-side EmailTemplate model — kept here so validation schemas
 * (loaded into client bundles via `lib/validation`) don't drag in
 * Mongoose.
 */
export const EMAIL_TEMPLATE_KEYS = [
  "payment-confirmation",
  "payment-request",
  /**
   * Manual-capture only: the card was AUTHORIZED, not charged. Additive —
   * no organization has a stored row for this key, so every lookup falls
   * back to the template's hardcoded copy exactly as the other two keys
   * did before an admin first edited them.
   */
  "payment-authorized",
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];
