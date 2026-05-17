import { z } from "zod";

import { BOOKING_TYPES, CURRENCIES } from "@/lib/constants/enums";

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
  supportEmail: z.string().email().toLowerCase(),
  supportPhone: z.string().trim().min(5).max(32),
  successRedirectUrl: z.string().url(),
  cancelRedirectUrl: z.string().url(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
