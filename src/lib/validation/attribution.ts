import { z } from "zod";

import { ATTRIBUTION_FIELD_MAX } from "@/lib/analytics/attribution";

/**
 * Server-side validation for lead attribution.
 *
 * This is the boundary, not a formality. The values arrive from
 * `sessionStorage` in the visitor's browser, so anyone can POST whatever they
 * like here: a megabyte campaign name, a nested object, `null` in place of a
 * string. The route's `bodyLimitBytes` caps the request as a whole; this caps
 * each field so no single one can dominate a stored document.
 *
 * Every field is optional and nullable — a direct visit legitimately has no
 * attribution at all, and a lead must never be rejected for it. Unknown keys
 * are stripped by zod's default object behaviour, so a client that invents
 * `isAdmin: true` cannot smuggle it into the document.
 *
 * NOTHING HERE IS A SECURITY INPUT. Attribution is reporting data. It never
 * decides ownership, admin status, moderation, or publication.
 */

/** One attribution field: trimmed, capped, empty collapsed to null. */
const field = z
  .string()
  .trim()
  .max(ATTRIBUTION_FIELD_MAX)
  .nullish()
  .transform((v) => v?.trim() || null);

export const attributionSchema = z.object({
  utmSource: field,
  utmMedium: field,
  utmCampaign: field,
  utmTerm: field,
  utmContent: field,
  referrer: field,
  landingPage: field,
});

export type AttributionInput = z.infer<typeof attributionSchema>;

/**
 * Normalise a parsed attribution object for storage, or null when it carries
 * nothing. Storing a row of seven nulls would make "no attribution" and
 * "attribution captured but empty" indistinguishable in the admin view.
 */
export function attributionForStorage(
  input: AttributionInput | null | undefined,
): AttributionInput | null {
  if (!input) return null;
  const hasValue = Object.values(input).some((v) => v !== null);
  return hasValue ? input : null;
}
