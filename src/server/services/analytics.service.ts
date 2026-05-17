import "server-only";

import {
  BookingType,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

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

export interface BookingTypeBreakdown {
  bookingType: BookingType;
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
  bookingTypes: BookingTypeBreakdown[];
  topStaff: StaffBreakdown[];
}

function resolveRange(range: AnalyticsRange): { from: Date; to: Date } {
  const to = range.to ?? new Date();
  const from = range.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export async function getAnalyticsSummary(
  range: AnalyticsRange = {},
): Promise<AnalyticsSummary> {
  await connectMongo();
  const { from, to } = resolveRange(range);
  const baseMatch = {
    state: RecordState.ACTIVE,
    createdAt: { $gte: from, $lte: to },
  };

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
      _id: BookingType;
      count: number;
      revenue: number;
    }>([
      { $match: baseMatch },
      {
        $group: {
          _id: "$bookingType",
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
    bookingTypes: bookingAgg.map((b) => ({
      bookingType: b._id,
      count: b.count,
      revenue: round2(b.revenue),
    })),
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
