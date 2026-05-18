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
export const sendPaymentRequestSchema = z.object({
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
