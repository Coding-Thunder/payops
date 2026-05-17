import { z } from "zod";

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex like #0B1220");

const phoneRegex = /^[+0-9()\-\s]{5,32}$/;

export const updateBrandingSchema = z.object({
  brandName: z.string().trim().min(2, "Brand name is required").max(80).optional(),
  supportEmail: z.string().email("Enter a valid email").toLowerCase().optional(),
  supportPhone: z
    .string()
    .trim()
    .regex(phoneRegex, "Enter a valid phone number")
    .max(32)
    .optional(),
  primaryColor: hexColor.optional(),
  footerTagline: z.string().trim().max(200).optional(),
  /** Allows resetting the logo back to "no image" by sending an empty string. */
  logo: z.string().trim().max(200).optional(),
});

export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;
