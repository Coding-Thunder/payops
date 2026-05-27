import { z } from "zod";

import {
  CURRENCIES,
  ORDER_STATUSES,
  RECORD_STATES,
} from "@/lib/constants/enums";
import {
  ITEM_ATTRIBUTE_KEY_REGEX,
  ITEM_TYPE_KEY_REGEX,
  SCHEDULING_TYPES,
} from "@/lib/constants/items";

const isoDateString = z
  .string()
  .min(1, "Date is required")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date");

const phoneRegex = /^[+0-9()\-\s]{7,32}$/;

/* ─────────────────────── Universal commerce input ────────────────────── */

/**
 * Universal commerce input.
 *
 * Validation here is structural only: itemTypeKey + attributes shape +
 * scheduling envelope. Per-attribute type/required checks happen in
 * `attribute-validator.service.ts` once the ItemType is resolved
 * (those rules are per-tenant per-vertical, not platform-fixed).
 */
export const orderLineItemInputSchema = z.object({
  itemTypeKey: z
    .string()
    .trim()
    .toLowerCase()
    .regex(ITEM_TYPE_KEY_REGEX, "Invalid item type key"),
  /** Optional pointer back into the catalog. When omitted the line is
   *  ad-hoc (e.g. one-off service charge with no Item row). */
  itemId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, "Invalid item id")
    .optional()
    .nullable(),
  name: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).optional().nullable(),
  quantity: z.number().positive().max(10_000),
  unitPrice: z.number().min(0).max(1_000_000),
  /** Server recomputes total = quantity × unitPrice to defend against
   *  client tampering — but the client may pre-compute for the preview.
   *  When supplied it must match within rounding tolerance. */
  total: z.number().min(0).max(10_000_000).optional(),
  attributes: z
    .record(z.string().regex(ITEM_ATTRIBUTE_KEY_REGEX), z.unknown())
    .default({}),
  /** Optional per-line scheduling — overrides the order-level
   *  `scheduling` for THIS line only. */
  scheduling: z
    .object({
      type: z.enum(SCHEDULING_TYPES),
      startsAt: isoDateString,
      endsAt: isoDateString.optional().nullable(),
    })
    .optional()
    .nullable(),
});

export const orderSchedulingInputSchema = z
  .object({
    type: z.enum(SCHEDULING_TYPES),
    startsAt: isoDateString,
    endsAt: isoDateString.optional().nullable(),
  })
  .refine(
    (s) =>
      !s.endsAt ||
      new Date(s.startsAt).getTime() < new Date(s.endsAt).getTime(),
    {
      path: ["endsAt"],
      message: "Scheduling end must be after start",
    },
  );

export const createOrderUniversalSchema = z.object({
  customer: z.object({
    name: z.string().trim().min(2, "Customer name is required").max(120),
    email: z.string().email("Enter a valid email").toLowerCase(),
    phone: z
      .string()
      .trim()
      .regex(phoneRegex, "Enter a valid phone number")
      .max(32),
  }),
  lineItems: z
    .array(orderLineItemInputSchema)
    .min(1, "Order needs at least one line item")
    .max(50, "Too many line items"),
  pricing: z.object({
    /** Grand total (sum of line totals + any taxes/fees). Server
     *  recomputes from lineItems and refuses if mismatched. */
    amount: z
      .number({ error: "Enter a valid amount" })
      .positive("Amount must be greater than zero")
      .max(10_000_000, "Amount looks unrealistic"),
    currency: z.enum(CURRENCIES),
  }),
  scheduling: orderSchedulingInputSchema.optional().nullable(),
  notes: z.string().trim().max(2000).optional(),
});

export type CreateOrderUniversalInput = z.infer<
  typeof createOrderUniversalSchema
>;

export const listOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  state: z.enum(RECORD_STATES).optional().default("ACTIVE"),
  mine: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const archiveOrderSchema = z.object({
  reason: z.string().trim().min(2).max(500).optional(),
});

export type ArchiveOrderInput = z.infer<typeof archiveOrderSchema>;

const objectIdRegex = /^[a-f0-9]{24}$/i;

export const deleteByIdsSchema = z.object({
  ids: z
    .array(z.string().regex(objectIdRegex, "Invalid id"))
    .min(1, "Select at least one record")
    .max(100, "Too many records selected"),
});

export type DeleteByIdsInput = z.infer<typeof deleteByIdsSchema>;

export const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
