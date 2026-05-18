import { z } from "zod";

import { EMAIL_TEMPLATE_KEYS } from "@/lib/constants/email-templates";

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

export const templateKeyParam = z.enum(EMAIL_TEMPLATE_KEYS);

/** Body for POST /api/admin/email-templates/[key] (create new version). */
export const createEmailTemplateVersionSchema = z.object({
  subject: optionalLine,
  greeting: optionalLine,
  intro: optionalParagraph,
  note: optionalParagraph,
  supportHeadline: optionalLine,
  supportDescription: optionalParagraph,
  footerNote: optionalShortLine,
});
export type CreateEmailTemplateVersionInput = z.infer<
  typeof createEmailTemplateVersionSchema
>;
