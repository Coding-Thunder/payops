import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { Order, PendingEmail, AuditLog, Types } from "@/console/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/console/server/pagination";

/**
 * Orders / Payments — cross-tenant transaction visibility for the Founder
 * Console. Read-only: the console inspects orders across every tenant (no
 * org scoping), surfaces payment + refund state, and links each order to
 * its emails and audit events. Issuing refunds/mutations is deliberately
 * out of scope here (that's a gateway operation for a later, guarded step).
 */

// Canonical, not re-declared. The console used to keep its own copies of both
// lists; they matched by luck, and the failure mode when they stopped matching
// would have been a filter dropdown that silently returns zero rows with no
// error anywhere.
import {
  ORDER_STATUSES,
  PAYMENT_GATEWAY_KEYS,
} from "@/lib/constants/enums";

export const GATEWAYS = PAYMENT_GATEWAY_KEYS;
export { ORDER_STATUSES };

export const ORDER_SORTS = {
  created: { createdAt: -1 },
  oldest: { createdAt: 1 },
  paid: { "payment.paidAt": -1 },
  amount: { "pricing.amount": -1 },
} as const;
export type OrderSort = keyof typeof ORDER_SORTS;

export interface OrderRow {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  amount: number | null;
  currency: string | null;
  status: string;
  paid: boolean;
  gateway: string | null;
  refundedAmount: number;
  org: string | null;
  createdAt: string | null;
  paidAt: string | null;
}

export interface OrderFilters {
  status?: string;
  gateway?: string;
  paid?: string; // "paid" | "unpaid"
  q?: string;
  org?: string;
  from?: string;
  to?: string;
  sort?: string;
}

interface LeanOrder {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  orderNumber?: string;
  status?: string;
  state?: string;
  customerId?: Types.ObjectId | null;
  customer?: { name?: string; email?: string; phone?: string } | null;
  pricing?: { amount?: number; currency?: string } | null;
  payment?: Record<string, unknown> | null;
  createdBy?: { name?: string; email?: string } | null;
  lineItems?: Array<Record<string, unknown>>;
  consent?: { status?: string } | null;
  dispute?: { status?: string | null } | null;
  refundedAmount?: number;
  notes?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

const asDate = (v: unknown): Date | null =>
  v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;

function rx(s: string): RegExp {
  return new RegExp(s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function buildFilter(f: OrderFilters): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (f.status && (ORDER_STATUSES as readonly string[]).includes(f.status)) {
    q.status = f.status;
  }
  if (f.gateway && (GATEWAYS as readonly string[]).includes(f.gateway)) {
    q["payment.gateway"] = f.gateway;
  }
  if (f.paid === "paid") q["payment.paidAt"] = { $ne: null };
  if (f.paid === "unpaid") q["payment.paidAt"] = null;
  if (f.org && Types.ObjectId.isValid(f.org)) {
    q.orgId = new Types.ObjectId(f.org);
  }
  if (f.q && f.q.trim()) {
    const r = rx(f.q);
    q.$or = [
      { orderNumber: r },
      { "customer.name": r },
      { "customer.email": r },
    ];
  }
  // `new Date("YYYY-MM-DD")` parses as UTC midnight; keep the inclusive `to`
  // boundary in UTC too so the window frame doesn't shift with process TZ.
  const range: Record<string, Date> = {};
  if (f.from) {
    const d = new Date(f.from);
    if (!Number.isNaN(d.getTime())) range.$gte = d;
  }
  if (f.to) {
    const d = new Date(f.to);
    if (!Number.isNaN(d.getTime())) {
      d.setUTCHours(23, 59, 59, 999);
      range.$lte = d;
    }
  }
  if (Object.keys(range).length) q.createdAt = range;
  return q;
}

function paymentField<T = unknown>(
  p: Record<string, unknown> | null | undefined,
  key: string,
): T | null {
  if (!p) return null;
  return (p[key] as T) ?? null;
}

function toRow(d: LeanOrder): OrderRow {
  const pay = d.payment as Record<string, unknown> | null | undefined;
  const paidAt = asDate(paymentField(pay, "paidAt"));
  return {
    id: String(d._id),
    orderNumber: d.orderNumber ?? "—",
    customerName: d.customer?.name ?? "—",
    customerEmail: d.customer?.email ?? "—",
    amount: typeof d.pricing?.amount === "number" ? d.pricing.amount : null,
    currency: d.pricing?.currency ?? null,
    status: d.status ?? "—",
    paid: paidAt != null,
    gateway: paymentField<string>(pay, "gateway"),
    refundedAmount: d.refundedAmount ?? 0,
    org: d.orgId ? String(d.orgId) : null,
    createdAt: iso(d.createdAt),
    paidAt: iso(paidAt),
  };
}

export async function listOrders(
  p: Pagination,
  f: OrderFilters = {},
): Promise<PageResult<OrderRow>> {
  await connectMongo();
  const filter = buildFilter(f);
  const sort =
    (f.sort && ORDER_SORTS[f.sort as OrderSort]) || ORDER_SORTS.created;
  // On the unfiltered default view, an exact count is a full scan — use the
  // O(1) metadata estimate instead. Filtered views get an exact count.
  const emptyFilter = Object.keys(filter).length === 0;
  const [docs, total] = await Promise.all([
    Order.find(filter)
      .sort(sort)
      .skip(p.skip)
      .limit(p.limit)
      .lean<LeanOrder[]>(),
    emptyFilter
      ? Order.estimatedDocumentCount()
      : Order.countDocuments(filter),
  ]);
  return buildPageResult(docs.map(toRow), total, p);
}

export interface OrderStats {
  total: number;
  paid: number;
  pending: number;
  failed: number;
  refunded: number;
}

export async function getOrderStats(f: OrderFilters = {}): Promise<OrderStats> {
  await connectMongo();
  const base = buildFilter(f);
  // One $facet pass instead of five separate countDocuments — the console
  // reads the same production cluster as the webhook path, so we keep the
  // number of full passes to a minimum.
  const [res] = await Order.aggregate<{
    total: [{ n: number }?];
    paid: [{ n: number }?];
    pending: [{ n: number }?];
    failed: [{ n: number }?];
    refunded: [{ n: number }?];
  }>([
    { $match: base },
    {
      $facet: {
        total: [{ $count: "n" }],
        paid: [{ $match: { "payment.paidAt": { $ne: null } } }, { $count: "n" }],
        pending: [
          { $match: { status: { $in: ["LINK_GENERATED", "PAYMENT_PENDING"] } } },
          { $count: "n" },
        ],
        failed: [
          { $match: { status: { $in: ["FAILED", "EXPIRED"] } } },
          { $count: "n" },
        ],
        refunded: [{ $match: { refundedAmount: { $gt: 0 } } }, { $count: "n" }],
      },
    },
  ]);
  const n = (a?: [{ n: number }?]) => a?.[0]?.n ?? 0;
  return {
    total: n(res?.total),
    paid: n(res?.paid),
    pending: n(res?.pending),
    failed: n(res?.failed),
    refunded: n(res?.refunded),
  };
}

export interface OrderLine {
  name: string;
  quantity: number;
  unitPrice: number | null;
  total: number | null;
}

export interface RelatedEmail {
  id: string;
  kind: string;
  status: string;
  createdAt: string | null;
}

export interface RelatedAudit {
  id: string;
  action: string;
  actor: string;
  createdAt: string | null;
}

export interface OrderDetail extends OrderRow {
  state: string | null;
  customerId: string | null;
  customerPhone: string | null;
  createdByEmail: string | null;
  updatedAt: string | null;
  notes: string | null;
  consentStatus: string | null;
  disputeStatus: string | null;
  payment: {
    gateway: string | null;
    status: string | null;
    sessionId: string | null;
    intentId: string | null;
    checkoutUrl: string | null;
    receiptUrl: string | null;
    amountReceived: number | null;
    failureReason: string | null;
    initiatedAt: string | null;
    expiresAt: string | null;
  };
  lineItems: OrderLine[];
  emails: RelatedEmail[];
  audit: RelatedAudit[];
}

export async function getOrderById(id: string): Promise<OrderDetail | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectMongo();
  const oid = new Types.ObjectId(id);
  const d = await Order.findById(oid).lean<LeanOrder | null>();
  if (!d) return null;

  const pay = (d.payment as Record<string, unknown> | null) ?? null;
  const lineItems: OrderLine[] = Array.isArray(d.lineItems)
    ? d.lineItems.map((li) => ({
        name: String(li.name ?? "—"),
        quantity: typeof li.quantity === "number" ? li.quantity : 1,
        unitPrice: typeof li.unitPrice === "number" ? li.unitPrice : null,
        total: typeof li.total === "number" ? li.total : null,
      }))
    : [];

  const [emails, audit] = await Promise.all([
    PendingEmail.find({ orderId: oid })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<
        Array<{
          _id: Types.ObjectId;
          kind?: string;
          status?: string;
          createdAt?: Date | null;
        }>
      >(),
    AuditLog.find({ entityId: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<
        Array<{
          _id: Types.ObjectId;
          action?: string;
          actor?: { email?: string | null; name?: string | null } | null;
          createdAt?: Date | null;
        }>
      >(),
  ]);

  return {
    ...toRow(d),
    state: d.state ?? null,
    customerId: d.customerId ? String(d.customerId) : null,
    customerPhone: d.customer?.phone ?? null,
    createdByEmail: d.createdBy?.email ?? null,
    updatedAt: iso(d.updatedAt),
    notes: d.notes ?? null,
    consentStatus: d.consent?.status ?? null,
    disputeStatus: d.dispute?.status ?? null,
    payment: {
      gateway: paymentField<string>(pay, "gateway"),
      status: paymentField<string>(pay, "status"),
      sessionId: paymentField<string>(pay, "stripeSessionId"),
      intentId: paymentField<string>(pay, "paymentIntentId"),
      checkoutUrl: paymentField<string>(pay, "checkoutUrl"),
      receiptUrl: paymentField<string>(pay, "receiptUrl"),
      amountReceived: paymentField<number>(pay, "amountReceived"),
      failureReason: paymentField<string>(pay, "failureReason"),
      initiatedAt: iso(asDate(paymentField(pay, "initiatedAt"))),
      expiresAt: iso(asDate(paymentField(pay, "expiresAt"))),
    },
    lineItems,
    emails: emails.map((e) => ({
      id: String(e._id),
      kind: e.kind ?? "—",
      status: e.status ?? "—",
      createdAt: iso(e.createdAt),
    })),
    audit: audit.map((a) => ({
      id: String(a._id),
      action: a.action ?? "—",
      actor: a.actor?.email ?? a.actor?.name ?? "system",
      createdAt: iso(a.createdAt),
    })),
  };
}

export async function listOrdersForExport(
  f: OrderFilters = {},
  cap = 5000,
): Promise<OrderRow[]> {
  await connectMongo();
  const filter = buildFilter(f);
  const sort =
    (f.sort && ORDER_SORTS[f.sort as OrderSort]) || ORDER_SORTS.created;
  const docs = await Order.find(filter)
    .sort(sort)
    .limit(cap)
    .lean<LeanOrder[]>();
  return docs.map(toRow);
}
