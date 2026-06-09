import { z } from "zod";

/**
 * Validation for the order-draft autosave API. The body is intentionally
 * permissive, the create-order form snapshot is a partial CreateOrderInput
 * and we don't want to reject a draft just because the user hasn't typed
 * the phone number yet. We only enforce shape + size constraints to keep
 * payloads bounded.
 */
const draftDataSchema = z
  .object({
    bookingType: z.string().max(64).optional(),
    provider: z.string().max(64).optional(),
    customer: z
      .object({
        name: z.string().max(120).optional(),
        email: z.string().max(254).optional(),
        phone: z.string().max(32).optional(),
      })
      .partial()
      .optional(),
    vehicle: z
      .object({
        company: z.string().max(80).optional(),
        type: z.string().max(80).optional(),
        imageUrl: z
          .string()
          .max(2048)
          .optional()
          .nullable(),
      })
      .partial()
      .optional(),
    trip: z
      .object({
        pickupDate: z.string().max(64).optional(),
        dropoffDate: z.string().max(64).optional(),
      })
      .partial()
      .optional(),
    pricing: z
      .object({
        amount: z
          .union([z.number(), z.string()])
          .transform((v) => (typeof v === "string" && v === "" ? null : v))
          .optional()
          .nullable(),
        currency: z.string().max(8).optional(),
      })
      .partial()
      .optional(),
    notes: z.string().max(2000).optional(),
  })
  .passthrough();

export const createDraftSchema = z.object({
  data: draftDataSchema.optional().default({}),
});

export type CreateDraftInput = z.infer<typeof createDraftSchema>;

export const updateDraftSchema = z.object({
  data: draftDataSchema,
  /** Last revision observed by the client. `null` = force overwrite. */
  expectedRevision: z.number().int().nonnegative().nullable(),
});

export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
