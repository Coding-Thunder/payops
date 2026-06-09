import { z } from "zod";

import { RECORD_STATES } from "@/lib/constants/enums";
import {
  EMAIL_BLOCK_KEYS,
  ITEM_ATTRIBUTE_KEY_REGEX,
  ITEM_ATTRIBUTE_TYPES,
  ITEM_PRICING_MODELS,
  ITEM_TYPE_KEY_REGEX,
  ItemAttributeType,
} from "@/lib/constants/items";

/**
 * Pass 5e, Admin CRUD for the per-tenant ItemType catalog.
 *
 * The schemas mirror the model layer except they accept what the form
 * actually sends (string-typed enums vs the model's literal unions, plus
 * optional fields that default at the service layer).
 */

const attributeSpecSchema = z
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
          message: "SELECT attributes need at least one option",
        });
      }
    }
  });

const itemTypeCoreSchema = z.object({
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
  attributeSchema: z.array(attributeSpecSchema).max(40).default([]),
  confirmationEmailBlocks: z
    .array(z.enum(EMAIL_BLOCK_KEYS))
    .optional()
    .default([]),
});

function refineUniqueAttributeKeys(
  value: { attributeSchema?: { key: string }[] },
  ctx: z.RefinementCtx,
): void {
  if (!value.attributeSchema) return;
  const seen = new Set<string>();
  value.attributeSchema.forEach((spec, idx) => {
    if (seen.has(spec.key)) {
      ctx.addIssue({
        code: "custom",
        path: ["attributeSchema", idx, "key"],
        message: `Duplicate attribute key "${spec.key}"`,
      });
    }
    seen.add(spec.key);
  });
}

export const createItemTypeSchema = itemTypeCoreSchema.superRefine(
  refineUniqueAttributeKeys,
);

export type CreateItemTypeApiInput = z.infer<typeof createItemTypeSchema>;

export const updateItemTypeSchema = itemTypeCoreSchema
  .partial()
  .omit({ key: true })
  .superRefine(refineUniqueAttributeKeys);

export type UpdateItemTypeApiInput = z.infer<typeof updateItemTypeSchema>;

export const itemTypeStatusSchema = z.object({
  status: z.enum(RECORD_STATES),
});
