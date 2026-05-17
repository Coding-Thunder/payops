import { z } from "zod";

import { BOOKING_TYPES, CURRENCIES } from "@/lib/constants/enums";

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
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
