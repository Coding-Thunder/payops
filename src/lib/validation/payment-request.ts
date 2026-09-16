import { z } from "zod";

const trimmed = z
  .string()
  .trim()
  .max(500)
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

const longerTrimmed = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

const phoneRegex = /^[+0-9()\-\s]{7,32}$/;

/**
 * Body for POST /api/orders/[id]/send-payment-request.
 *
 * `customer` patches the order in place — agent can fix the recipient's
 * email/name/phone right before sending. Empty / absent = no change.
 */
/**
 * How the operator intends to collect.
 *
 * GATEWAY is the existing behaviour: a checkout link has been generated and
 * the email carries it. MANUAL means the operator will take the card on an
 * external terminal, so there IS no link — the customer is asked only to
 * review and consent, and the money is recorded afterwards.
 *
 * Request-scoped rather than persisted: the order does not become "a manual
 * order". `payment.gateway` stays a merchant-account pin that is stamped
 * MANUAL only when money has actually settled, so an operator can still
 * change their mind and generate a Stripe link afterwards.
 */
export const COLLECTION_METHODS = ["GATEWAY", "MANUAL"] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const sendPaymentRequestSchema = z.object({
  collection: z.enum(COLLECTION_METHODS).optional().default("GATEWAY"),
  subject: trimmed,
  greeting: trimmed,
  intro: longerTrimmed,
  note: longerTrimmed,
  customer: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      email: z.string().email().toLowerCase().optional(),
      phone: z
        .string()
        .trim()
        .regex(phoneRegex, "Enter a valid phone number")
        .max(32)
        .optional(),
    })
    .optional(),
});

export type SendPaymentRequestInput = z.infer<typeof sendPaymentRequestSchema>;
