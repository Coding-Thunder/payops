import { z } from "zod";

import {
  BOOKING_TYPES,
  CURRENCIES,
  ORDER_STATUSES,
  RECORD_STATES,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

const isoDateString = z
  .string()
  .min(1, "Date is required")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date");

const phoneRegex = /^[+0-9()\-\s]{7,32}$/;

export const createOrderSchema = z
  .object({
    bookingType: z.enum(BOOKING_TYPES),
    provider: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PROVIDER_KEY_REGEX, "Select a rental provider"),
    customer: z.object({
      name: z.string().trim().min(2, "Customer name is required").max(120),
      email: z.string().email("Enter a valid email").toLowerCase(),
      phone: z
        .string()
        .trim()
        .regex(phoneRegex, "Enter a valid phone number")
        .max(32),
    }),
    vehicle: z.object({
      company: z
        .string()
        .trim()
        .min(2, "Car company is required")
        .max(80),
      type: z.string().trim().min(2, "Car type is required").max(80),
    }),
    trip: z
      .object({
        pickupDate: isoDateString,
        dropoffDate: isoDateString,
      })
      .refine(
        (t) => new Date(t.pickupDate) < new Date(t.dropoffDate),
        {
          path: ["dropoffDate"],
          message: "Drop-off must be after pick-up",
        },
      ),
    pricing: z.object({
      amount: z
        .number({ error: "Enter a valid amount" })
        .positive("Amount must be greater than zero")
        .max(1_000_000, "Amount looks unrealistic"),
      currency: z.enum(CURRENCIES),
    }),
    notes: z.string().trim().max(2000).optional(),
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const listOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  bookingType: z.enum(BOOKING_TYPES).optional(),
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

export const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
