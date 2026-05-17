import { z } from "zod";

import { RECORD_STATES, RecordState } from "@/lib/constants/enums";
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
});

export type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const updateProviderSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  logo: z.string().trim().min(1).max(200).optional(),
  primaryColor: hexColor.optional(),
  onPrimaryColor: hexColor.optional(),
  tagline: z.string().trim().max(140).optional(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
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
});

export type ListProvidersQuery = z.infer<typeof listProvidersQuerySchema>;

/** Reusable order-side validator for the provider key field. */
export const orderProviderKeySchema = providerKey;

export { RecordState as ProviderStatus };
