import { z } from "zod";

import { RECORD_STATES, USER_ROLES } from "@/lib/constants/enums";

const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[0-9]/, "Include a number");

const objectIdList = z
  .array(z.string().regex(/^[a-f0-9]{24}$/i, "Invalid organization id"))
  .max(50);

export const createUserSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  email: z.string().email("Enter a valid email").toLowerCase(),
  role: z.enum(USER_ROLES),
  password: passwordSchema,
  /**
   * Organizations this user may act in.
   *
   * OPTIONAL, and ignored for ADMIN / SUPER_ADMIN — those roles resolve to
   * every ACTIVE organization at the authorization layer and need no rows
   * (see listMemberOrganizations). For a STAFF user this is the ONLY thing
   * that grants access, so the service refuses to create one with an empty
   * list rather than producing an account that can sign in and see nothing.
   */
  organizationIds: objectIdList.optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(120)
      .optional(),
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(RECORD_STATES).optional(),
    /**
     * The COMPLETE desired set, not a delta. Organizations present here but
     * not currently held are added; organizations currently held but absent
     * here are DEACTIVATED (never deleted, so the audit trail of who once
     * had access survives). Omit the key entirely to leave memberships
     * untouched.
     */
    organizationIds: objectIdList.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "No changes provided",
  });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetUserPasswordSchema = z.object({
  newPassword: passwordSchema,
});

export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;

export const listUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(RECORD_STATES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
