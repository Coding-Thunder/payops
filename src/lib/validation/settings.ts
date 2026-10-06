import { z } from "zod";

import {
  BOOKING_TYPES,
  CONSENT_MODES,
  CURRENCIES,
  ServiceType,
} from "@/lib/constants/enums";

// Support email/phone live on the Branding doc now (see /admin/branding).
// Redirect URLs are computed from APP_URL — accepted but ignored by the
// service mapper so the form's read-only display stays in sync.
export const updateSettingsSchema = z.object({
  paymentExpiryHours: z.number().int().min(1).max(24 * 30),
  orderPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,6}$/, "Use 2-6 uppercase letters"),
  allowedBookingTypes: z
    .array(z.enum(BOOKING_TYPES))
    .min(1, "At least one booking type must be enabled"),
  defaultCurrency: z.enum(CURRENCIES),
  successRedirectUrl: z.string().url(),
  cancelRedirectUrl: z.string().url(),
  cancellationPolicy: z
    .string()
    .trim()
    .min(20, "Policy must be at least 20 characters")
    .max(4000, "Policy must be 4000 characters or fewer"),
  consentMode: z.enum(CONSENT_MODES).optional(),
  consentMessage: z
    .string()
    .trim()
    .min(20, "Acknowledgement must be at least 20 characters")
    .max(1000, "Acknowledgement must be 1000 characters or fewer")
    .optional(),
  termsAndConditions: z
    .string()
    .trim()
    .min(20, "Terms must be at least 20 characters")
    .max(8000, "Terms must be 8000 characters or fewer")
    .optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// One organization's own legal text for one service type — FLIGHT only for
// now. There is deliberately no organization field: the route writes the
// selected organization and nothing else. Same limits and messages as the
// deployment-wide text above.
export const updateServiceLegalSchema = z.object({
  serviceType: z.literal(ServiceType.FLIGHT),
  termsAndConditions: z
    .string()
    .trim()
    .min(20, "Terms must be at least 20 characters")
    .max(8000, "Terms must be 8000 characters or fewer"),
  cancellationPolicy: z
    .string()
    .trim()
    .min(20, "Policy must be at least 20 characters")
    .max(4000, "Policy must be 4000 characters or fewer"),
  /**
   * What the editor was showing when Save was pressed. The organization is
   * still taken ONLY from the selected-organization scope — these never
   * choose anything; they refuse a save from a stale tab (another brand
   * selected since, or someone else's newer edit) instead of overwriting.
   */
  expectedOrganizationId: z.string().trim().max(64).optional(),
  expectedTermsVersion: z.string().trim().max(16).optional(),
  expectedCancellationPolicyVersion: z.string().trim().max(16).optional(),
});

export type UpdateServiceLegalInput = z.infer<typeof updateServiceLegalSchema>;
