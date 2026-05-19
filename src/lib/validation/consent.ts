import { z } from "zod";

import { CONSENT_METHODS } from "@/lib/constants/enums";

/**
 * Body for POST /api/consent/[token] — the public confirmation endpoint
 * the hosted page hits. The `acknowledgement` field is echoed back so
 * we can detect a tampered DOM before persisting.
 *
 * `signedName` is left optional at the validation layer so an idempotent
 * replay (refresh after a record was already confirmed) doesn't trip
 * 422. The service requires it on the first REQUESTED → VERIFIED
 * transition.
 */
export const recordConsentSchema = z.object({
  acknowledgement: z.string().trim().min(10).max(1000),
  signedName: z
    .string()
    .trim()
    .max(120)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  method: z.enum(CONSENT_METHODS).optional(),
});
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;
