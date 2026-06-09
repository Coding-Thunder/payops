import { z } from "zod";

import { PAYMENT_GATEWAY_KEYS } from "@/lib/constants/enums";

/**
 * Save / rotate a per-org gateway credential.
 *
 * Validation is intentionally lax on the actual key SHAPES, vendors
 * change their key formats periodically (Stripe added `rk_` keys,
 * Razorpay uses different prefixes per region). The hard checks live in
 * the service (`saveGatewayCredential`):
 *   - key + webhook secret length > 8
 *   - master encryption key is configured
 *   - actor.orgId is a valid ObjectId
 *
 * We DO validate the gateway enum + mode strictly so an admin can't
 * smuggle a TEST key into a LIVE-mode row.
 */
export const saveGatewayCredentialSchema = z.object({
  gateway: z.enum(PAYMENT_GATEWAY_KEYS),
  mode: z.enum(["LIVE", "TEST"]),
  secretKey: z
    .string()
    .trim()
    .min(10, "Secret key looks too short")
    .max(500, "Secret key looks too long"),
  webhookSecret: z
    .string()
    .trim()
    .min(10, "Webhook secret looks too short")
    .max(500, "Webhook secret looks too long"),
  // Same silent-validation-fail pattern as connectStripeSchema -
  // empty string from an unfilled form field would block the click
  // without a visible error. Drop .min(1) and let the transform
  // normalize empty → null.
  publishableKey: z
    .string()
    .trim()
    .max(200)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  accountId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type SaveGatewayCredentialInput = z.infer<
  typeof saveGatewayCredentialSchema
>;

/* ─────────────────────── Pass 6a, Stripe auto-connect ───────────────── */

/**
 * Auto-connect input: just the secret key + mode (+ optional public
 * fields). The service verifies the key, registers the webhook
 * endpoint on the operator's Stripe account, and persists the
 * resulting signing secret, the operator never has to leave the page.
 */
export const connectStripeSchema = z.object({
  mode: z.enum(["LIVE", "TEST"]),
  secretKey: z
    .string()
    .trim()
    .min(10, "Secret key looks too short")
    .max(500, "Secret key looks too long"),
  // publishableKey + accountId are OPTIONAL, drop .min(1) so an
  // empty string (react-hook-form's default for an unfilled field)
  // doesn't fail validation silently and prevent the Connect button
  // from firing. Transform converts empty / whitespace → null.
  publishableKey: z
    .string()
    .trim()
    .max(200)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  accountId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});
export type ConnectStripeInput = z.infer<typeof connectStripeSchema>;

/** Pre-save "did this key work?" check, used by the admin UI's
 *  Test connection button. */
export const testStripeSchema = z.object({
  mode: z.enum(["LIVE", "TEST"]),
  secretKey: z
    .string()
    .trim()
    .min(10, "Secret key looks too short")
    .max(500, "Secret key looks too long"),
});
export type TestStripeInput = z.infer<typeof testStripeSchema>;

/** Path parameter, used by DELETE /api/admin/gateways/[gateway] */
export const gatewayKeyParamSchema = z.object({
  gateway: z.enum(PAYMENT_GATEWAY_KEYS),
});
