import { z } from "zod";

/**
 * Self-serve account edits. Intentionally minimal: the caller may change
 * ONLY their own display name. Email is the login identity (owned by the
 * sign-in provider) and role/status are never self-editable — those are
 * deliberately absent so a self-serve PATCH can't escalate.
 */
export const updateAccountSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
});

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
