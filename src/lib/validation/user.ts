import { z } from "zod";

import { RECORD_STATES, USER_ROLES } from "@/lib/constants/enums";

const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .regex(/[A-Z]/, "Include an uppercase letter")
  .regex(/[a-z]/, "Include a lowercase letter")
  .regex(/[0-9]/, "Include a number");

// Team members are provisioned by INVITE — the owner never sets a password.
// The member sets their own via the emailed /join link (see
// team-invite.service). Hence no `password` here.
export const createUserSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  email: z.string().email("Enter a valid email").toLowerCase(),
  role: z.enum(USER_ROLES),
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
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "No changes provided",
  });

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetUserPasswordSchema = z.object({
  newPassword: passwordSchema,
});

export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;

/**
 * Owner-only Team & Permissions writer. `permissions` are raw strings — the
 * service re-validates them against the member-eligible allow-list (and the
 * session resolver re-filters on read), so an over-broad or bogus key can
 * never escalate. When mode is "full" the grant list is ignored/empty.
 */
export const updateMemberPermissionsSchema = z.object({
  permissionMode: z.enum(["full", "custom"]),
  permissions: z.array(z.string().max(64)).max(50).default([]),
});

export type UpdateMemberPermissionsInput = z.infer<
  typeof updateMemberPermissionsSchema
>;

export const listUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(RECORD_STATES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
