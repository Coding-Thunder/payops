import { z } from "zod";

import { disposableEmailRefinement } from "./disposable-email";

/** The one source value the public general-enquiry form may produce. */
export const GENERAL_ENQUIRY_SOURCE = "contact_sales" as const;

/**
 * Quotation payload. One schema, two shapes, keyed on `source`.
 *
 *  - `contact_sales` — the public general-enquiry form on /contact. Name,
 *    business email, company, message. A visitor asking "does this fit how
 *    I work?" has no payment volume to declare and no reason to pick a
 *    country from a list, so neither is required.
 *  - every other source — the gateway-era flows, which DO need country and
 *    expected volume to be triaged. Those requirements are unchanged; the
 *    `superRefine` below re-imposes them so relaxing the field definitions
 *    cannot quietly weaken them.
 *
 * Free-text fields are loose-typed (sales reads them) but bounded, so a
 * 100KB paste can't blow up the server.
 */
export const quotationSchema = z.object({
  fullName: z.string().trim().min(2, "Please share your full name").max(120),
  companyName: z
    .string()
    .trim()
    .min(2, "Company name is required")
    .max(160),
  workEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Use your work email address")
    .max(254)
    // Server-side, so a client that skips the form cannot bypass it. Same
    // guard `/api/beta/apply` applies; leads from throwaway domains are
    // noise at best.
    .refine(...disposableEmailRefinement),
  // Landing-page form no longer collects a phone number, but the
  // field stays optional so older payloads / API callers don't break
  // and server-side rendering of stored quotations (which may
  // include legacy phone values) keeps working.
  phone: z.string().trim().max(32).optional().default(""),
  // Required for the gateway-era sources, not for a general enquiry — see
  // the `superRefine` below. Defaulted so stored documents keep a string.
  country: z.string().trim().max(80).default(""),
  expectedVolume: z.string().trim().max(64).default(""),
  preferredGateway: z.string().trim().max(120).default(""),
  currentStack: z.string().trim().max(400).default(""),
  useCase: z
    .string()
    .trim()
    .min(10, "Tell us a bit more about your use case")
    .max(2000),
  timeline: z.string().trim().max(80).default(""),
  customRequirements: z.string().trim().max(4000).default(""),
  notes: z.string().trim().max(4000).default(""),
  /**
   * Accepted on PUBLIC input. "waitlist" is deliberately NOT here.
   *
   * `/api/quotations` is unauthenticated and passes `source` straight to the
   * insert, while `console/services/provision.ts` grants an Org + owner User
   * from a `source: "waitlist"` quotation. Accepting that value from the
   * open internet would let anyone inject a row into the admin waitlist that
   * a Grant click then turns into a real tenant. Nothing posts it any more —
   * the public waitlist form was removed — so the enum simply refuses it.
   *
   * Existing stored records keep their value; this bounds input, not
   * storage, and the admin waitlist list and provisioning read exactly what
   * they always did.
   */
  source: z
    .enum(["landing", "contact_sales", "email_requirements"])
    .default("landing"),
  /** Cloudflare Turnstile token from the marketing page widget.
   *  Optional so non-browser callers (and dev without keys) still work;
   *  the server-side verifier no-ops when TURNSTILE_SECRET_KEY is unset. */
  cfToken: z.string().max(2048).optional(),
})
  // `country` and `expectedVolume` are optional fields above so the general
  // enquiry can omit them, and mandatory again here for every source that
  // always had them. Adding a source without thinking about this lands it in
  // the strict branch by default, which is the safe direction.
  .superRefine((val, ctx) => {
    if (val.source === GENERAL_ENQUIRY_SOURCE) return;
    if (!val.country || val.country.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["country"],
        message: "Country is required",
      });
    }
    if (!val.expectedVolume) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedVolume"],
        message: "Share an approximate order or payment volume",
      });
    }
  });

/**
 * Payload the public /contact enquiry form sends. A strict subset of
 * `quotationSchema`: it cannot set `source`, `status`, or any gateway-era
 * field, so a crafted body cannot smuggle itself into the waitlist or the
 * legacy lead flows. The route fixes `source` server-side.
 */
export const contactEnquirySchema = z.object({
  fullName: z.string().trim().min(2, "Please share your full name").max(120),
  companyName: z
    .string()
    .trim()
    .min(2, "Company name is required")
    .max(160),
  workEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Use your business email address")
    .max(254)
    .refine(...disposableEmailRefinement),
  message: z
    .string()
    .trim()
    .min(10, "Tell us a bit more about what you need")
    .max(2000),
  cfToken: z.string().max(2048).optional(),
});

export type ContactEnquiryInput = z.infer<typeof contactEnquirySchema>;

/** Input shape (what the form submits), optional fields stay optional
 *  pre-default; the parsed/output type fills them with empty strings. */
export type QuotationInput = z.input<typeof quotationSchema>;
export type ParsedQuotationInput = z.output<typeof quotationSchema>;
