import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { Customer, Order, PendingEmail, Types } from "@/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/server/pagination";

/**
 * Customers (Client Profiles) — cross-tenant client visibility. The list
 * uses the denormalised counters on the customer row (cheap); the detail
 * computes authoritative lifetime financials on-read by aggregating the
 * client's orders (matched by the stable customerId FK, with an email
 * fallback for orders the backfill hasn't linked yet).
 */

export const CUSTOMER_SORTS = {
  activity: { lastOrderAt: -1 },
  orders: { ordersCount: -1 },
  created: { createdAt: -1 },
  name: { name: 1 },
} as const;
export type CustomerSort = keyof typeof CUSTOMER_SORTS;

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  tags: string[];
  ordersCount: number;
  org: string | null;
  lastOrderAt: string | null;
  createdAt: string | null;
}

export interface CustomerFilters {
  q?: string;
  org?: string;
  hasOrders?: string; // "yes"
  tag?: string;
  sort?: string;
}

interface LeanCustomer {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  name?: string;
  email?: string;
  phone?: string;
  company?: string | null;
  notes?: string | null;
  tags?: string[];
  ordersCount?: number;
  firstOrderAt?: Date | null;
  lastOrderAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

function rx(s: string): RegExp {
  return new RegExp(s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function buildFilter(f: CustomerFilters): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (f.q && f.q.trim()) {
    const r = rx(f.q);
    q.$or = [{ name: r }, { email: r }, { phone: r }, { company: r }];
  }
  if (f.org && Types.ObjectId.isValid(f.org)) {
    q.orgId = new Types.ObjectId(f.org);
  }
  if (f.hasOrders === "yes") q.ordersCount = { $gt: 0 };
  if (f.tag && f.tag.trim()) q.tags = f.tag.trim();
  return q;
}

function toRow(d: LeanCustomer): CustomerRow {
  return {
    id: String(d._id),
    name: d.name ?? "—",
    email: d.email ?? "—",
    phone: d.phone ?? "",
    company: d.company ?? null,
    tags: Array.isArray(d.tags) ? d.tags : [],
    ordersCount: d.ordersCount ?? 0,
    org: d.orgId ? String(d.orgId) : null,
    lastOrderAt: iso(d.lastOrderAt),
    createdAt: iso(d.createdAt),
  };
}

export async function listCustomers(
  p: Pagination,
  f: CustomerFilters = {},
): Promise<PageResult<CustomerRow>> {
  await connectMongo();
  const filter = buildFilter(f);
  const sort =
    (f.sort && CUSTOMER_SORTS[f.sort as CustomerSort]) ||
    CUSTOMER_SORTS.activity;
  const [docs, total] = await Promise.all([
    Customer.find(filter)
      .sort(sort)
      .skip(p.skip)
      .limit(p.limit)
      .lean<LeanCustomer[]>(),
    Customer.countDocuments(filter),
  ]);
  return buildPageResult(docs.map(toRow), total, p);
}

export interface CustomerStats {
  total: number;
  withOrders: number;
  repeat: number;
}

export async function getCustomerStats(
  f: CustomerFilters = {},
): Promise<CustomerStats> {
  await connectMongo();
  const base = buildFilter(f);
  const [total, withOrders, repeat] = await Promise.all([
    Customer.countDocuments(base),
    Customer.countDocuments({ ...base, ordersCount: { $gt: 0 } }),
    Customer.countDocuments({ ...base, ordersCount: { $gt: 1 } }),
  ]);
  return { total, withOrders, repeat };
}

export interface CustomerOrderRow {
  id: string;
  orderNumber: string;
  amount: number | null;
  currency: string | null;
  status: string;
  paid: boolean;
  createdAt: string | null;
}

export interface CustomerEmailRow {
  id: string;
  kind: string;
  status: string;
  createdAt: string | null;
}

export interface CustomerProfile extends CustomerRow {
  notes: string | null;
  firstOrderAt: string | null;
  updatedAt: string | null;
  // Computed lifetime aggregates
  totalOrders: number;
  paidOrders: number;
  revenue: number;
  refunded: number;
  aov: number;
  currency: string | null;
  orders: CustomerOrderRow[];
  emails: CustomerEmailRow[];
}

export async function getCustomerById(
  id: string,
): Promise<CustomerProfile | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectMongo();
  const oid = new Types.ObjectId(id);
  const c = await Customer.findById(oid).lean<LeanCustomer | null>();
  if (!c) return null;

  const email = (c.email ?? "").toLowerCase();
  const orderMatch: Record<string, unknown> = {
    $or: [{ customerId: oid }, ...(email ? [{ "customer.email": email }] : [])],
  };

  const [aggrRows, orderDocs, emailDocs] = await Promise.all([
    Order.aggregate<{
      totalOrders: number;
      paidOrders: number;
      revenue: number;
      refunded: number;
    }>([
      { $match: orderMatch },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          paidOrders: {
            $sum: { $cond: [{ $ne: ["$payment.paidAt", null] }, 1, 0] },
          },
          revenue: {
            $sum: {
              $cond: [
                { $ne: ["$payment.paidAt", null] },
                { $ifNull: ["$pricing.amount", 0] },
                0,
              ],
            },
          },
          refunded: { $sum: { $ifNull: ["$refundedAmount", 0] } },
        },
      },
    ]),
    Order.find(orderMatch)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<
        Array<{
          _id: Types.ObjectId;
          orderNumber?: string;
          status?: string;
          pricing?: { amount?: number; currency?: string } | null;
          payment?: { paidAt?: Date | null } | null;
          createdAt?: Date | null;
        }>
      >(),
    email
      ? PendingEmail.find({ recipient: email })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean<
            Array<{
              _id: Types.ObjectId;
              kind?: string;
              status?: string;
              createdAt?: Date | null;
            }>
          >()
      : Promise.resolve([]),
  ]);

  const aggr = aggrRows[0] ?? {
    totalOrders: 0,
    paidOrders: 0,
    revenue: 0,
    refunded: 0,
  };
  const currency = orderDocs[0]?.pricing?.currency ?? null;

  return {
    ...toRow(c),
    notes: c.notes ?? null,
    firstOrderAt: iso(c.firstOrderAt),
    updatedAt: iso(c.updatedAt),
    totalOrders: aggr.totalOrders,
    paidOrders: aggr.paidOrders,
    revenue: aggr.revenue,
    refunded: aggr.refunded,
    aov: aggr.paidOrders > 0 ? aggr.revenue / aggr.paidOrders : 0,
    currency,
    orders: orderDocs.map((o) => ({
      id: String(o._id),
      orderNumber: o.orderNumber ?? "—",
      amount: typeof o.pricing?.amount === "number" ? o.pricing.amount : null,
      currency: o.pricing?.currency ?? null,
      status: o.status ?? "—",
      paid: o.payment?.paidAt != null,
      createdAt: iso(o.createdAt),
    })),
    emails: emailDocs.map((e) => ({
      id: String(e._id),
      kind: e.kind ?? "—",
      status: e.status ?? "—",
      createdAt: iso(e.createdAt),
    })),
  };
}

export async function listCustomersForExport(
  f: CustomerFilters = {},
  cap = 5000,
): Promise<CustomerRow[]> {
  await connectMongo();
  const filter = buildFilter(f);
  const sort =
    (f.sort && CUSTOMER_SORTS[f.sort as CustomerSort]) ||
    CUSTOMER_SORTS.activity;
  const docs = await Customer.find(filter)
    .sort(sort)
    .limit(cap)
    .lean<LeanCustomer[]>();
  return docs.map(toRow);
}
