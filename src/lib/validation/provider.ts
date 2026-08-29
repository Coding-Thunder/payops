import { z } from "zod";

import {
  RECORD_STATES,
  RecordState,
  SERVICE_TYPES,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex like #1E3A8A");

const providerKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    PROVIDER_KEY_REGEX,
    "Use 2–32 chars: uppercase letters, digits, or underscore. Must start with a letter.",
  );

// All fields required at the API boundary — callers supply their own
// defaults so the schema's Input type matches its Output (keeps the
// generic react-hook-form Resolver type happy).
export const createProviderSchema = z.object({
  key: providerKey,
  name: z.string().trim().min(2, "Name is required").max(80),
  /** Logo URL/path. Usually filled by the upload endpoint, but admins can
   *  also paste a pre-hosted absolute URL when seeding by hand. */
  logo: z.string().trim().min(1, "Upload or specify a logo").max(200),
  primaryColor: hexColor,
  onPrimaryColor: hexColor,
  tagline: z.string().trim().max(140),
  sortOrder: z.number().int().min(0).max(9_999),
  /**
   * Which services this supplier can be attached to.
   *
   * Defaults to [CAR_RENTAL], which is what every provider row that existed
   * before this field is, so an admin who omits it creates exactly the
   * car-rental supplier they have always created. Without this field being
   * WRITABLE, no airline or hotel group could ever be marked FLIGHT/HOTEL
   * and the flight/hotel order forms' required provider dropdown stayed
   * permanently empty.
   */
  serviceTypes: z
    .array(z.enum(SERVICE_TYPES))
    .min(1, "Pick at least one service type")
    // `.optional()`, NOT `.default()`. This file deliberately keeps each
    // schema's zod Input type identical to its Output type so the generic
    // react-hook-form Resolver in create-provider-dialog.tsx stays happy;
    // a `.default()` makes them diverge and breaks that component's
    // typing. The CAR_RENTAL fallback is applied in createProvider instead.
    .optional(),
  /**
   * Organizations allowed to use this supplier. EMPTY means EVERY
   * organization — which is how the whole catalog behaves today, so an
   * omitted value changes nothing for the incumbents. Set it to restrict a
   * supplier to one brand (e.g. a FlightBizz-only airline).
   */
  organizationIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i, "Invalid organization id"))
    .max(50)
    .optional(),
});

export type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const updateProviderSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  logo: z.string().trim().min(1).max(200).optional(),
  primaryColor: hexColor.optional(),
  onPrimaryColor: hexColor.optional(),
  tagline: z.string().trim().max(140).optional(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
  serviceTypes: z
    .array(z.enum(SERVICE_TYPES))
    .min(1, "Pick at least one service type")
    .optional(),
  organizationIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i, "Invalid organization id"))
    .max(50)
    .optional(),
});

export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

export const setProviderStatusSchema = z.object({
  status: z.enum(RECORD_STATES, {
    error: () => ({ message: "Pick ACTIVE, DISABLED, or ARCHIVED" }),
  }),
});

export type SetProviderStatusInput = z.infer<typeof setProviderStatusSchema>;

export const listProvidersQuerySchema = z.object({
  status: z.enum(RECORD_STATES).optional(),
  /** When true, returns every provider regardless of status. Admin use only. */
  includeAll: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  /** Narrow to suppliers serving one service type. Omitted = all. */
  serviceType: z.enum(SERVICE_TYPES).optional(),
  /** Narrow to suppliers available to one organization. Omitted = all. */
  organizationId: z.string().optional(),
});

export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;

/** Reusable order-side validator for the provider key field. */
export const orderProviderKeySchema = providerKey;

export { RecordState as ProviderStatus };
