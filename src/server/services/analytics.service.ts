import "server-only";

import {
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import { ItemType, Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter } from "@/server/db/org/org-context";
import { Types } from "mongoose";

export interface AnalyticsRange {
  from?: Date;
  to?: Date;
}

export interface AnalyticsTotals {
  ordersCreated: number;
  ordersPaid: number;
  ordersPending: number;
  ordersFailed: number;
  ordersExpired: number;
  revenue: number;
  averageOrderValue: number;
  currency: string;
  conversionRate: number;
}

export interface DailyPoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface ItemTypeBreakdown {
  /** Stable internal identifier, kept for analytics joins / future
   *  drill-downs. NEVER render this directly in the UI. */
  itemTypeKey: string;
  /** Operator-facing label resolved by joining each aggregation
   *  bucket against the tenant's per-org ItemType catalog. Falls
   *  back to "Unknown item type" when an order references a key no
   *  longer defined (e.g. ItemType deleted after order creation). */
  displayName: string;
  count: number;
  revenue: number;
}

export interface StaffBreakdown {
  userId: string;
  name: string;
  orders: number;
  revenue: number;
}

export interface AnalyticsSummary {
  range: { from: string; to: string };
  totals: AnalyticsTotals;
  daily: DailyPoint[];
  itemTypes: ItemTypeBreakdown[];
  topStaff: StaffBreakdown[];
}

function resolveRange(range: AnalyticsRange): { from: Date; to: Date } {
  const to = range.to ?? new Date();
  const from = range.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export async function getAnalyticsSummary(
  range: AnalyticsRange = {},
  ctx: { orgId?: string | null } = {},
): Promise<AnalyticsSummary> {
  await connectMongo();
  const { from, to } = resolveRange(range);
  // Tenant scope: when an orgId is supplied, every aggregation is
  // pinned to that org. Legacy callers (no orgId) keep the old
  // cross-tenant behavior, phased out as callers migrate.
  const baseMatch: Record<string, unknown> = {
    state: RecordState.ACTIVE,
    createdAt: { $gte: from, $lte: to },
  };
  if (ctx.orgId && Types.ObjectId.isValid(ctx.orgId)) {
    baseMatch.orgId = new Types.ObjectId(ctx.orgId);
  }

  const [statusAgg, dailyAgg, bookingAgg, staffAgg] = await Promise.all([
    Order.aggregate<{
      _id: OrderStatus;
      count: number;
      revenue: number;
    }>([
      { $match: baseMatch },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$status", OrderStatus.PAID] },
                { $ifNull: ["$payment.amountReceived", "$pricing.amount"] },
                0,
              ],
            },
          },
        },
      },
    ]),
    Order.aggregate<{
      _id: string;
      revenue: number;
      orders: number;
    }>([
      { $match: { ...baseMatch, status: OrderStatus.PAID } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$payment.paidAt" },
          },
          revenue: {
            $sum: {
              $ifNull: ["$payment.amountReceived", "$pricing.amount"],
            },
          },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate<{
      _id: string;
      count: number;
      revenue: number;
    }>([
      { $match: baseMatch },
      { $unwind: { path: "$lineItems", preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: "$lineItems.itemTypeKey",
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$status", OrderStatus.PAID] },
                { $ifNull: ["$lineItems.total", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
    Order.aggregate<{
      _id: { userId: string; name: string };
      orders: number;
      revenue: number;
    }>([
      { $match: baseMatch },
      {
        $group: {
          _id: {
            userId: "$createdBy.userId",
            name: "$createdBy.name",
          },
          orders: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$status", OrderStatus.PAID] },
                { $ifNull: ["$payment.amountReceived", "$pricing.amount"] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
  ]);

  let totalOrders = 0;
  let totalPaid = 0;
  let totalPending = 0;
  let totalFailed = 0;
  let totalExpired = 0;
  let totalRevenue = 0;
  for (const row of statusAgg) {
    totalOrders += row.count;
    if (row._id === OrderStatus.PAID) {
      totalPaid = row.count;
      totalRevenue = row.revenue;
    } else if (row._id === OrderStatus.PAYMENT_PENDING) {
      totalPending = row.count;
    } else if (row._id === OrderStatus.FAILED) {
      totalFailed = row.count;
    } else if (row._id === OrderStatus.EXPIRED) {
      totalExpired = row.count;
    }
  }

  // Common currency assumption: most-frequent currency in the range.
  const currencyAgg = await Order.aggregate<{
    _id: string;
    count: number;
  }>([
    { $match: { ...baseMatch, status: OrderStatus.PAID } },
    { $group: { _id: "$pricing.currency", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 },
  ]);
  const currency = currencyAgg[0]?._id ?? "USD";

  const totals: AnalyticsTotals = {
    ordersCreated: totalOrders,
    ordersPaid: totalPaid,
    ordersPending: totalPending,
    ordersFailed: totalFailed,
    ordersExpired: totalExpired,
    revenue: round2(totalRevenue),
    averageOrderValue: totalPaid > 0 ? round2(totalRevenue / totalPaid) : 0,
    currency,
    conversionRate:
      totalOrders > 0 ? round2((totalPaid / totalOrders) * 100) : 0,
  };

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totals,
    daily: dailyAgg.map((d) => ({
      date: d._id,
      revenue: round2(d.revenue),
      orders: d.orders,
    })),
    itemTypes: await resolveItemTypeDisplayNames(
      bookingAgg.map((b) => ({
        itemTypeKey: b._id,
        count: b.count,
        revenue: round2(b.revenue),
      })),
      ctx.orgId ?? null,
    ),
    topStaff: staffAgg.map((s) => ({
      userId: String(s._id.userId),
      name: s._id.name,
      orders: s.orders,
      revenue: round2(s.revenue),
    })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Join analytics buckets against the tenant's ItemType catalog to
 * populate `displayName`. Single round-trip lookup keyed by the
 * distinct itemTypeKeys seen in the aggregation.
 *
 * Why this lives at the service layer (not the UI): the UI must
 * NEVER render `itemTypeKey` directly, that's how the internal
 * "engagement" key leaked into customer screens. By resolving here,
 * the DTO carries a stable, operator-facing `displayName` and the
 * UI is free of any fallback logic.
 *
 * Missing-name handling: if an Order references an itemTypeKey that
 * no longer exists in the catalog (deleted ItemType, cross-tenant
 * legacy data), we surface "Unknown item type", never the raw key.
 */
async function resolveItemTypeDisplayNames(
  buckets: Array<Omit<ItemTypeBreakdown, "displayName">>,
  orgId: string | null,
): Promise<ItemTypeBreakdown[]> {
  if (buckets.length === 0) return [];
  const keys = Array.from(new Set(buckets.map((b) => b.itemTypeKey)));
  const filter: Record<string, unknown> = { key: { $in: keys } };
  if (orgId) filter.orgId = orgIdFilter(orgId);
  const docs = await ItemType.find(filter)
    .select({ key: 1, name: 1 })
    .lean<{ key: string; name: string }[]>();
  const byKey = new Map<string, string>();
  for (const d of docs) {
    if (d?.name?.trim()) byKey.set(d.key, d.name.trim());
  }
  return buckets.map((b) => ({
    ...b,
    displayName: byKey.get(b.itemTypeKey) ?? "Unknown item type",
  }));
}
