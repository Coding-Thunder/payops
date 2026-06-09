import { z } from "zod";

/**
 * Workflow builder request schemas.
 *
 * Status keys are UPPER_SNAKE_CASE so they stay grep-able + obviously
 * distinct from labels (which are free-form display copy). Labels can
 * use any printable text; the schema just caps length.
 *
 * Colors are 6-digit hex, same constraint as Branding.primaryColor -
 * because the status badge renderer doesn't have a `bg-…` lookup for
 * arbitrary OKLCH / named colors, only inline CSS.
 */

const statusKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[A-Z][A-Z0-9_]{0,47}$/, "Use UPPER_SNAKE_CASE (e.g. SHIPPED, REFUND_PENDING)");

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex like #16A34A");

const labelSchema = z.string().trim().min(1).max(80);

export const addStatusSchema = z.object({
  key: statusKeySchema,
  label: labelSchema,
  color: hexColorSchema.optional(),
  isTerminal: z.boolean().optional(),
  isPaid: z.boolean().optional(),
});
export type AddStatusInput = z.infer<typeof addStatusSchema>;

export const editStatusSchema = z.object({
  label: labelSchema.optional(),
  color: hexColorSchema.optional(),
  isTerminal: z.boolean().optional(),
  isPaid: z.boolean().optional(),
});
export type EditStatusInput = z.infer<typeof editStatusSchema>;

export const addTransitionSchema = z.object({
  fromKey: statusKeySchema,
  toKey: statusKeySchema,
  label: labelSchema,
  // Free string, the platform doesn't enforce that this matches a
  // real Permission key, because tenants can layer custom roles later.
  // Empty string normalised to null.
  requiredPermission: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  automationTriggerKey: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});
export type AddTransitionInput = z.infer<typeof addTransitionSchema>;

export const setPaymentMappingSchema = z.object({
  paymentSuccessStatusKey: statusKeySchema,
  paymentFailureStatusKey: statusKeySchema,
});
export type SetPaymentMappingInput = z.infer<typeof setPaymentMappingSchema>;
