import { z } from "zod";

/**
 * Quotation form payload. Required fields mirror what sales actually
 * needs to triage a lead: who they are, where, scale, and what they
 * want. The free-text fields are loose-typed — sales will read them
 * — but bounded so a 100KB paste can't blow up the server.
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
    .max(254),
  // Landing-page form no longer collects a phone number — but the
  // field stays optional so older payloads / API callers don't break
  // and server-side rendering of stored quotations (which may
  // include legacy phone values) keeps working.
  phone: z.string().trim().max(32).optional().default(""),
  country: z.string().trim().min(2).max(80),
  expectedVolume: z
    .string()
    .trim()
    .min(1, "Share an approximate order or payment volume")
    .max(64),
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
  source: z
    .enum([
      "landing",
      "contact_sales",
      "email_requirements",
      "waitlist",
    ])
    .default("landing"),
  /** Cloudflare Turnstile token from the marketing page widget.
   *  Optional so non-browser callers (and dev without keys) still work;
   *  the server-side verifier no-ops when TURNSTILE_SECRET_KEY is unset. */
  cfToken: z.string().max(2048).optional(),
});

/** Input shape (what the form submits) — optional fields stay optional
 *  pre-default; the parsed/output type fills them with empty strings. */
export type QuotationInput = z.input<typeof quotationSchema>;
export type ParsedQuotationInput = z.output<typeof quotationSchema>;
