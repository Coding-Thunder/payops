import { z } from "zod";

/**
 * Hotel catalog validation. Mirrors `car-link.ts` field for field where the
 * two overlap, so the two catalogs stay recognisably the same thing.
 */

const hotelName = z
  .string()
  .trim()
  .min(2, "At least 2 characters")
  .max(160);

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

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null));

/** One catalog image. `sortOrder` defaults to array position at the service
 *  layer when the caller omits it. */
export const hotelImageSchema = z.object({
  url: imageUrl,
  caption: optionalText(200),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});
export type HotelImageInput = z.infer<typeof hotelImageSchema>;

export const hotelLocationSchema = z.object({
  city: z.string().trim().min(2, "City is required").max(120),
  country: z.string().trim().min(2, "Country is required").max(80),
  address: optionalText(300),
});

export const createHotelSchema = z.object({
  name: hotelName,
  description: optionalText(4000),
  location: hotelLocationSchema,
  amenities: z
    .array(z.string().trim().min(1).max(60))
    .max(40, "Too many amenities")
    .optional(),
  /**
   * Multiple images per hotel — the requirement that distinguishes this
   * catalog from `car_links`, which carries a single `imageUrl`. Capped so
   * one document cannot grow unbounded.
   */
  images: z
    .array(hotelImageSchema)
    .max(20, "At most 20 images per hotel")
    .optional(),
  starRating: z.coerce.number().int().min(1).max(5).optional().nullable(),
  notes: notesField,
});
export type CreateHotelInput = z.infer<typeof createHotelSchema>;

export const updateHotelSchema = z.object({
  name: hotelName.optional(),
  description: optionalText(4000),
  location: hotelLocationSchema.optional(),
  amenities: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  images: z.array(hotelImageSchema).max(20).optional(),
  starRating: z.coerce.number().int().min(1).max(5).optional().nullable(),
  notes: notesField,
});
export type UpdateHotelInput = z.infer<typeof updateHotelSchema>;

export const listHotelsQuerySchema = z.object({
  /** Free-text search over name + city. */
  q: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  /** When true, include `active=false` rows. Admins-only on the API side. */
  includeArchived: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListHotelsQuery = z.infer<typeof listHotelsQuerySchema>;
