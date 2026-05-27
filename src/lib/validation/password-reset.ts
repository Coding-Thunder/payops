import { z } from "zod";

/**
 * Forgot-password initiate. Accepts only an email — the route always
 * returns 200 regardless of whether the address exists, so the schema
 * stays minimal (no user-enumeration via validation errors).
 */
export const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email").toLowerCase().trim(),
  /** Cloudflare Turnstile token. Same surface as login/signup. */
  cfToken: z.string().max(2048).optional(),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/**
 * Reset-password completion. The token comes from the link in the
 * reset email; new password matches signup's strength rules.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(2048),
  newPassword: z
    .string()
    .min(10, "Use at least 10 characters")
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/[0-9]/, "Include a number"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
