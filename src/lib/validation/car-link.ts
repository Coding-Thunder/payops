import { z } from "zod";

const trimmedName = z
  .string()
  .trim()
  .min(2, "At least 2 characters")
  .max(80);

const imageUrl = z
  .string()
  .trim()
  .min(1, "Public link is required")
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), {
    message: "Enter a valid http(s) URL",
  });

const notesField = z
  .string()
  .trim()
  .max(500)
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

export const createCarLinkSchema = z.object({
  carMake: trimmedName,
  carType: trimmedName,
  imageUrl,
  notes: notesField,
});
export type CreateCarLinkInput = z.infer<typeof createCarLinkSchema>;

export const updateCarLinkSchema = z.object({
  carMake: trimmedName.optional(),
  carType: trimmedName.optional(),
  imageUrl: imageUrl.optional(),
  notes: notesField,
});
export type UpdateCarLinkInput = z.infer<typeof updateCarLinkSchema>;

export const listCarLinksQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  /** When true, include `active=false` rows. Admins-only on the API side. */
  includeArchived: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListCarLinksQuery = z.infer<typeof listCarLinksQuerySchema>;
