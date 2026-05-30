import { z } from "zod";

import { CURRENCIES, RECORD_STATES } from "@/lib/constants/enums";
import {
  ITEM_ATTRIBUTE_KEY_REGEX,
  ITEM_TYPE_KEY_REGEX,
} from "@/lib/constants/items";

/**
 * Pass 6c — admin CRUD for the per-tenant Item catalog.
 *
 * Each Item references an ItemType via `itemTypeKey`. The service
 * layer validates `attributes` against that ItemType's
 * `attributeSchema` — Zod here is shape-only (it doesn't know which
 * fields the org has declared on which type).
 */

const itemPriceSchema = z.object({
  amount: z
    .number()
    .min(0, "Price can't be negative")
    .max(10_000_000, "Price looks unrealistic"),
  currency: z.enum(CURRENCIES),
});

const itemInventorySchema = z.object({
  available: z.number().int().min(0).max(1_000_000),
  reserved: z.number().int().min(0).max(1_000_000),
});

export const createItemSchema = z.object({
  itemTypeKey: z
    .string()
    .trim()
    .toLowerCase()
    .regex(ITEM_TYPE_KEY_REGEX, "Invalid item type key"),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  basePrice: itemPriceSchema.optional().nullable(),
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  imageUrl: z
    .string()
    .trim()
    .max(2048)
    .url("Enter a valid http(s) URL")
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  attributes: z
    .record(z.string().regex(ITEM_ATTRIBUTE_KEY_REGEX), z.unknown())
    .default({}),
  inventory: itemInventorySchema.optional().nullable(),
});
export type CreateItemApiInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = createItemSchema
  .partial()
  .omit({ itemTypeKey: true });
export type UpdateItemApiInput = z.infer<typeof updateItemSchema>;

export const itemStatusSchema = z.object({
  status: z.enum(RECORD_STATES),
});

export const listItemsQuerySchema = z.object({
  itemTypeKey: z
    .string()
    .trim()
    .toLowerCase()
    .regex(ITEM_TYPE_KEY_REGEX)
    .optional(),
  /** "true" includes ARCHIVED + DISABLED. Default ACTIVE-only. */
  includeAll: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
});
export type ListItemsQueryInput = z.infer<typeof listItemsQuerySchema>;
