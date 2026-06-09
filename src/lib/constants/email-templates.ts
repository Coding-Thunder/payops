/**
 * System (platform-defined) email template keys. These map 1:1 to React
 * Email components in `server/email/templates/` and are referenced by
 * name from the order lifecycle service. Tenants cannot rename or
 * delete these — they can only edit the copy through the admin template
 * editor.
 *
 * Tenant-defined keys (kind === "custom") are free-form slugs and live
 * alongside these in the EmailTemplate collection, distinguished by the
 * doc's `kind` field. Server code that wants to dispatch a system
 * template MUST narrow against this constant; lookup-by-string is fine
 * for custom kinds.
 */
export const SYSTEM_EMAIL_TEMPLATE_KEYS = [
  "payment-confirmation",
  "payment-request",
] as const;
export type SystemEmailTemplateKey = (typeof SYSTEM_EMAIL_TEMPLATE_KEYS)[number];

/** @deprecated use SYSTEM_EMAIL_TEMPLATE_KEYS — kept as an alias so
 *  existing imports compile during the rename window. */
export const EMAIL_TEMPLATE_KEYS = SYSTEM_EMAIL_TEMPLATE_KEYS;
/** @deprecated use SystemEmailTemplateKey. */
export type EmailTemplateKey = SystemEmailTemplateKey;

/** Kind discriminator on the EmailTemplate doc. */
export type EmailTemplateKind = "system" | "custom";

/**
 * Slug validator for tenant-defined template keys. Lower-case kebab,
 * 2-48 chars, must start with a letter. Same shape as the system keys
 * so the routing code never has to special-case.
 */
export const CUSTOM_TEMPLATE_KEY_REGEX = /^[a-z][a-z0-9-]{1,47}$/;

/**
 * Operator-facing labels for the system templates. Used when surfacing
 * the system kinds alongside custom kinds in admin lists / send pickers.
 */
export const SYSTEM_TEMPLATE_LABELS: Record<SystemEmailTemplateKey, string> = {
  "payment-request": "Payment Request",
  "payment-confirmation": "Payment Confirmation",
};

export const SYSTEM_TEMPLATE_DESCRIPTIONS: Record<SystemEmailTemplateKey, string> = {
  "payment-request":
    "Sent when an operator dispatches the payment link to a customer.",
  "payment-confirmation":
    "Sent automatically once a payment settles successfully.",
};

export function isSystemTemplateKey(
  key: string,
): key is SystemEmailTemplateKey {
  return (SYSTEM_EMAIL_TEMPLATE_KEYS as readonly string[]).includes(key);
}
