import { z } from "zod";

import {
  CUSTOM_TEMPLATE_KEY_REGEX,
  SYSTEM_EMAIL_TEMPLATE_KEYS,
} from "@/lib/constants/email-templates";

const optionalLine = z
  .string()
  .trim()
  .max(200)
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

const optionalParagraph = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

const optionalShortLine = z
  .string()
  .trim()
  .max(500)
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

/** Free-form template key validator. Accepts a system key OR any
 *  CUSTOM_TEMPLATE_KEY_REGEX-shaped slug. URL-safe slug form is
 *  enforced so the routing layer never has to encode special chars. */
export const templateKeyParam = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .refine(
    (k) =>
      (SYSTEM_EMAIL_TEMPLATE_KEYS as readonly string[]).includes(k) ||
      CUSTOM_TEMPLATE_KEY_REGEX.test(k),
    "Template key must be lower-case kebab, 2 to 48 chars",
  );

const contentFieldsSchema = z.object({
  subject: optionalLine,
  greeting: optionalLine,
  intro: optionalParagraph,
  note: optionalParagraph,
  supportHeadline: optionalLine,
  supportDescription: optionalParagraph,
  footerNote: optionalShortLine,
});

/** Body for POST /api/admin/email-templates/[key] (create new version). */
export const createEmailTemplateVersionSchema = contentFieldsSchema;
export type CreateEmailTemplateVersionInput = z.infer<
  typeof createEmailTemplateVersionSchema
>;

/** Body for POST /api/admin/email-templates/custom (create new tenant
 *  template). Carries the key, displayName, description + the same
 *  content payload as a version save. */
export const createCustomTemplateSchema = contentFieldsSchema.extend({
  templateKey: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      CUSTOM_TEMPLATE_KEY_REGEX,
      "Template key must be lower-case kebab (e.g. payment-reminder), 2 to 48 chars, starting with a letter",
    ),
  displayName: z
    .string()
    .trim()
    .min(2, "Pick a name your team will recognise")
    .max(120),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});
export type CreateCustomTemplateInput = z.infer<
  typeof createCustomTemplateSchema
>;

/** Body for PATCH /api/admin/email-templates/[key]/rename, custom only. */
export const renameCustomTemplateSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .optional(),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});
export type RenameCustomTemplateInput = z.infer<
  typeof renameCustomTemplateSchema
>;

/** Body for POST /api/admin/email-templates/[key]/send, manual operator
 *  dispatch from order / customer / payment surfaces. */
export const sendCustomTemplateSchema = z.object({
  to: z
    .string()
    .trim()
    .toLowerCase()
    .email("Recipient must be a valid email address")
    .max(254),
  /** Optional source context. When orderId is supplied, the send
   *  records an evidence event against the order so the dispute
   *  artifact captures the manual touchpoint. */
  source: z
    .union([
      z.object({
        kind: z.literal("order"),
        orderId: z.string().trim().min(1).max(120),
      }),
      z.object({
        kind: z.literal("customer"),
        customerId: z.string().trim().min(1).max(120),
      }),
    ])
    .optional()
    .nullable(),
  /** Per-send copy overrides without burning a new template version. */
  overrides: z
    .object({
      subject: z
        .string()
        .trim()
        .max(200)
        .optional()
        .nullable()
        .transform((v) => (v && v.length > 0 ? v : null)),
      greeting: z
        .string()
        .trim()
        .max(200)
        .optional()
        .nullable()
        .transform((v) => (v && v.length > 0 ? v : null)),
      intro: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .nullable()
        .transform((v) => (v && v.length > 0 ? v : null)),
      note: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .nullable()
        .transform((v) => (v && v.length > 0 ? v : null)),
      footerNote: z
        .string()
        .trim()
        .max(500)
        .optional()
        .nullable()
        .transform((v) => (v && v.length > 0 ? v : null)),
    })
    .optional(),
});
export type SendCustomTemplateRequest = z.infer<
  typeof sendCustomTemplateSchema
>;
