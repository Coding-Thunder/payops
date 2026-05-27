import { z } from "zod";

import {
  EMAIL_BLOCK_KEYS,
  ITEM_ATTRIBUTE_KEY_REGEX,
  ITEM_ATTRIBUTE_TYPES,
  ITEM_PRICING_MODELS,
  ITEM_TYPE_KEY_REGEX,
  ItemAttributeType,
} from "@/lib/constants/items";
import { BUSINESS_VERTICALS } from "@/lib/constants/business-templates";

/**
 * Pass 6b — onboarding wizard payload.
 *
 * The wizard prepopulates the form from the platform-defined template
 * (see `business-templates.ts`), lets the founder edit lightly, then
 * POSTs the resulting ItemType definition. The shape is intentionally
 * the same as what `createItemType` would accept directly — the
 * wizard is a UX wrapper around the existing service, not a parallel
 * pipeline.
 */

const wizardAttributeSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        ITEM_ATTRIBUTE_KEY_REGEX,
        "Use lowercase letters, digits, and underscores",
      ),
    label: z.string().trim().min(1).max(120),
    type: z.enum(ITEM_ATTRIBUTE_TYPES),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(80)).optional(),
    helpText: z.string().trim().max(280).optional().nullable(),
    displayOrder: z.number().int().min(0).max(999),
  })
  .superRefine((s, ctx) => {
    if (s.type === ItemAttributeType.SELECT) {
      if (!s.options || s.options.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "SELECT fields need at least one option",
        });
      }
    }
  });

export const completeBusinessSetupSchema = z.object({
  vertical: z.enum(BUSINESS_VERTICALS),
  itemType: z.object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        ITEM_TYPE_KEY_REGEX,
        "Use lowercase letters, digits, and underscores",
      ),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional().nullable(),
    pricingModel: z.enum(ITEM_PRICING_MODELS),
    requiresScheduling: z.boolean().default(false),
    inventoryTracked: z.boolean().default(false),
    attributeSchema: z.array(wizardAttributeSchema).max(40).default([]),
    confirmationEmailBlocks: z
      .array(z.enum(EMAIL_BLOCK_KEYS))
      .optional()
      .default([]),
  }),
});

export type CompleteBusinessSetupInput = z.infer<
  typeof completeBusinessSetupSchema
>;
