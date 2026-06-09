import { z } from "zod";

export const flagOrderSchema = z.object({
  flagged: z.boolean(),
  note: z
    .string()
    .trim()
    .max(2000, "Note must be 2,000 characters or fewer")
    .optional(),
});

export type FlagOrderInput = z.infer<typeof flagOrderSchema>;
