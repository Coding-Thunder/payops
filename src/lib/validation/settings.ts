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
  // Optional, like `termsAndConditions` below: the settings page sends the
  // car rental text only for a brand that sells car rental, and the service
  // leaves an absent field untouched.
  cancellationPolicy: z
    .string()
    .trim()
    .min(20, "Policy must be at least 20 characters")
    .max(4000, "Policy must be 4000 characters or fewer")
    .optional(),
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

/** The service types with a legal slot of their own on an organization.
 *  Car rental has none: its text is the organization's top-level legal,
 *  else the deployment settings above. */
export const SERVICE_LEGAL_TYPES = [ServiceType.FLIGHT, ServiceType.HOTEL] as const;
export type ServiceWithOwnLegal = (typeof SERVICE_LEGAL_TYPES)[number];

// One organization's own legal text for one service type. There is
// deliberately no organization field: the route writes the selected
// organization and nothing else, and only for a service it sells. Same
// limits and messages as the deployment-wide text above.
export const updateServiceLegalSchema = z.object({
  serviceType: z.enum(SERVICE_LEGAL_TYPES),
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
