import { z } from "zod";

/**
 * Public signup form. Validation mirrors `createUserSchema` for the
 * user fields, adds an organization name (free-form, server slugifies
 * + de-duplicates), and reuses the Turnstile token field from login.
 */
export const signupSchema = z.object({
  // Founder user.
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  email: z.string().email("Enter a valid email").toLowerCase().trim(),
  password: z
    .string()
    .min(10, "Use at least 10 characters")
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/[0-9]/, "Include a number"),

  // Organization.
  orgName: z
    .string()
    .trim()
    .min(2, "Business name must be at least 2 characters")
    .max(120, "Business name must be 120 characters or fewer"),

  /** Bot-check token (same surface as login). Optional in schema so
   *  non-browser clients keep working, the server verifier no-ops
   *  when `TURNSTILE_SECRET_KEY` is unset. */
  cfToken: z.string().max(2048).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
