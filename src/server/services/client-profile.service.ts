import "server-only";

import { Types } from "mongoose";

import { AuditAction, AuditEntity, RecordState } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { RequestContext } from "@/server/api/request-context";
import {
  Customer,
  Dispute,
  Document as DocumentModel,
  Order,
  PaymentConsent,
  type CustomerDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";

import { recordAudit } from "./audit.service";

/**
 * Client Profile — the read/aggregation surface over the Customer spine.
 *
 * The `customer.service` primitives own linking (email → phone → create) and
 * the cheap denormalised counters. THIS service computes the authoritative,
 * on-read lifetime view from the client's orders and assembles the
 * cross-entity timeline. Every query is tenant-scoped by `orgId`; financials
 * are grouped BY currency (never summed across currencies).
 */

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

function escapeRegex(s: string): string {
  return s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ─── Profile ──────────────────────────────────────────────────────────── */

export interface ClientOrderRowDTO {
  id: string;
  orderNumber: string;
  status: string;
  amount: number;
  currency: string;
  paid: boolean;
  createdAt: string;
}

export interface ClientTotalsDTO {
  totalOrders: number;
  paidOrders: number;
  /** Revenue in the PRIMARY currency only (see `currency`/`multiCurrency`). */
  revenue: number;
  refunded: number;
  /** Sum of unpaid orders still awaiting payment (link generated / pending). */
  outstanding: number;
  averageOrderValue: number;
  currency: string | null;
  multiCurrency: boolean;
}

export interface ClientProfileDTO {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  notes: string | null;
  tags: string[];
  customerSince: string | null;
  firstTransaction: string | null;
  lastActivity: string | null;
  totals: ClientTotalsDTO;
  orders: ClientOrderRowDTO[];
}

interface CurrencyGroup {
  _id: string | null;
  orders: number;
  paidOrders: number;
  revenue: number;
  refunded: number;
  outstanding: number;
}

/** Orders belonging to a client: the stable FK, plus an email fallback for
 *  rows the backfill hasn't linked — BOTH pinned to the tenant. Archived
 *  rows are excluded (matches the rest of the customer surface). */
function orderMatch(
  orgFilter: unknown,
  customerId: Types.ObjectId,
  email: string,
): Record<string, unknown> {
  const branches: Record<string, unknown>[] = [{ customerId }];
  if (email) branches.push({ "customer.email": email });
  return {
    orgId: orgFilter,
    state: { $ne: RecordState.ARCHIVED },
    $or: branches,
  };
}

export async function getClientProfile(
  orgId: string | null | undefined,
  customerId: string,
): Promise<ClientProfileDTO> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Client not found");
  }
  const orgFilter = orgIdFilter(scopedOrgId);
  const oid = new Types.ObjectId(customerId);
  const customer = await Customer.findOne({
    _id: oid,
    orgId: orgFilter,
  }).lean<CustomerDoc & { _id: Types.ObjectId }>();
  if (!customer) throw new NotFoundError("Client not found");

  const email = (customer.email ?? "").toLowerCase();
  const match = orderMatch(orgFilter, oid, email);

  const [groups, orderDocs] = await Promise.all([
    Order.aggregate<CurrencyGroup>([
      { $match: match },
      {
        $group: {
          _id: "$pricing.currency",
          orders: { $sum: 1 },
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
          outstanding: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$payment.paidAt", null] },
                    { $in: ["$status", ["LINK_GENERATED", "PAYMENT_PENDING"]] },
                  ],
                },
                { $ifNull: ["$pricing.amount", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
    Order.find(match)
      .sort({ createdAt: -1 })
      .limit(50)
      .select({
        orderNumber: 1,
        status: 1,
        pricing: 1,
        "payment.paidAt": 1,
        createdAt: 1,
      })
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
  ]);

  const totalOrders = groups.reduce((s, g) => s + g.orders, 0);
  const paidOrders = groups.reduce((s, g) => s + g.paidOrders, 0);
  const currencies = groups.filter((g) => g._id);
  // Primary = the currency the client has the most revenue in (orders break
  // ties). Money fields reflect ONLY this currency.
  const primary = [...groups].sort(
    (a, b) => b.revenue - a.revenue || b.orders - a.orders,
  )[0];

  const totals: ClientTotalsDTO = {
    totalOrders,
    paidOrders,
    revenue: primary?.revenue ?? 0,
    refunded: primary?.refunded ?? 0,
    outstanding: primary?.outstanding ?? 0,
    averageOrderValue:
      primary && primary.paidOrders > 0
        ? primary.revenue / primary.paidOrders
        : 0,
    currency: primary?._id ?? orderDocs[0]?.pricing?.currency ?? null,
    multiCurrency: currencies.length > 1,
  };

  return {
    id: String(customer._id),
    name: customer.name,
    email: customer.email,
    phone: customer.phone ?? "",
    company: customer.company ?? null,
    notes: customer.notes ?? null,
    tags: Array.isArray(customer.tags) ? customer.tags : [],
    customerSince: iso(customer.createdAt),
    firstTransaction: iso(customer.firstOrderAt),
    lastActivity: iso(customer.lastOrderAt),
    totals,
    orders: orderDocs.map((o) => ({
      id: String(o._id),
      orderNumber: o.orderNumber ?? "—",
      status: o.status ?? "—",
      amount: typeof o.pricing?.amount === "number" ? o.pricing.amount : 0,
      currency: o.pricing?.currency ?? "USD",
      paid: o.payment?.paidAt != null,
      createdAt: iso(o.createdAt) ?? new Date(0).toISOString(),
    })),
  };
}

/* ─── List ─────────────────────────────────────────────────────────────── */

export const CLIENT_SORTS = {
  activity: { lastOrderAt: -1 as const },
  orders: { ordersCount: -1 as const },
  created: { createdAt: -1 as const },
  name: { name: 1 as const },
};
export type ClientSort = keyof typeof CLIENT_SORTS;

export interface ClientListRowDTO {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  tags: string[];
  ordersCount: number;
  lastOrderAt: string | null;
  createdAt: string | null;
}

export interface ListClientsResult {
  items: ClientListRowDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ListClientsQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listClients(
  orgId: string | null | undefined,
  query: ListClientsQuery = {},
): Promise<ListClientsResult> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const sort =
    (query.sort && CLIENT_SORTS[query.sort as ClientSort]) ||
    CLIENT_SORTS.activity;

  const filter: Record<string, unknown> = { orgId: orgIdFilter(scopedOrgId) };
  if (query.search && query.search.trim()) {
    const rx = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [
      { name: rx },
      { email: rx },
      { phone: rx },
      { company: rx },
    ];
  }

  const [docs, total] = await Promise.all([
    Customer.find(filter)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<Array<CustomerDoc & { _id: Types.ObjectId }>>(),
    Customer.countDocuments(filter),
  ]);

  return {
    items: docs.map((d) => ({
      id: String(d._id),
      name: d.name,
      email: d.email,
      phone: d.phone ?? "",
      company: d.company ?? null,
      tags: Array.isArray(d.tags) ? d.tags : [],
      ordersCount: d.ordersCount ?? 0,
      lastOrderAt: iso(d.lastOrderAt),
      createdAt: iso(d.createdAt),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/* ─── Update ───────────────────────────────────────────────────────────── */

export interface UpdateClientInput {
  name?: string;
  phone?: string;
  company?: string | null;
  notes?: string | null;
  tags?: string[];
}

export interface UpdateClientContext {
  actor: { id: string; name: string; role: string };
  request?: RequestContext | null;
}

/**
 * Edit a Client Profile's identity fields (company / notes / tags / name /
 * phone). Tenant-pinned; validates + audits. Does NOT touch email (the
 * unique key) or the computed financials.
 */
export async function updateClient(
  orgId: string | null | undefined,
  customerId: string,
  input: UpdateClientInput,
  ctx: UpdateClientContext,
): Promise<ClientProfileDTO> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Client not found");
  }
  const orgFilter = orgIdFilter(scopedOrgId);
  const doc = await Customer.findOne({
    _id: new Types.ObjectId(customerId),
    orgId: orgFilter,
  });
  if (!doc) throw new NotFoundError("Client not found");

  const changed: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const v = input.name.trim();
    if (!v) throw new ValidationError("Name cannot be empty");
    if (v.length > 120) throw new ValidationError("Name is too long");
    if (v !== doc.name) changed.name = doc.name = v;
  }
  if (input.phone !== undefined) {
    const v = input.phone.trim();
    if (v.length > 32) throw new ValidationError("Phone is too long");
    if (v !== doc.phone) changed.phone = doc.phone = v;
  }
  if (input.company !== undefined) {
    const v = input.company?.trim() || null;
    if (v && v.length > 160) throw new ValidationError("Company is too long");
    if (v !== doc.company) changed.company = doc.company = v;
  }
  if (input.notes !== undefined) {
    const v = input.notes?.trim() || null;
    if (v && v.length > 4000) throw new ValidationError("Notes are too long");
    if (v !== doc.notes) changed.notes = doc.notes = v;
  }
  if (input.tags !== undefined) {
    const tags = Array.from(
      new Set(input.tags.map((t) => t.trim()).filter((t) => t.length > 0)),
    ).slice(0, 50);
    doc.tags = tags;
    changed.tags = tags;
  }

  if (Object.keys(changed).length > 0) {
    await doc.save();
    await recordAudit({
      action: AuditAction.CUSTOMER_UPDATED,
      entityType: AuditEntity.CUSTOMER,
      entityId: String(doc._id),
      orgId: scopedOrgId,
      actor: {
        userId: ctx.actor.id,
        name: ctx.actor.name,
        role: ctx.actor.role as never,
      },
      request: ctx.request ?? null,
      metadata: { changed: Object.keys(changed) },
    });
  }

  return getClientProfile(orgId, customerId);
}

/* ─── Timeline ─────────────────────────────────────────────────────────── */

export interface TimelineEventDTO {
  id: string;
  kind: string;
  category:
    | "client"
    | "order"
    | "payment"
    | "refund"
    | "consent"
    | "document"
    | "dispute";
  title: string;
  detail: string | null;
  at: string;
  orderId: string | null;
  orderNumber: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
}

/**
 * Assemble the client's chronological cross-entity timeline: the profile
 * creation, every order (created / paid / refunded), consent lifecycle,
 * issued documents, and disputes — all tenant-scoped, newest first.
 */
export async function getClientTimeline(
  orgId: string | null | undefined,
  customerId: string,
): Promise<TimelineEventDTO[]> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Client not found");
  }
  const orgFilter = orgIdFilter(scopedOrgId);
  const oid = new Types.ObjectId(customerId);
  const customer = await Customer.findOne({
    _id: oid,
    orgId: orgFilter,
  }).lean<CustomerDoc & { _id: Types.ObjectId }>();
  if (!customer) throw new NotFoundError("Client not found");

  const email = (customer.email ?? "").toLowerCase();
  const match = orderMatch(orgFilter, oid, email);

  const orders = await Order.find(match)
    .sort({ createdAt: -1 })
    .limit(200)
    .select({
      orderNumber: 1,
      status: 1,
      pricing: 1,
      "payment.paidAt": 1,
      refundedAmount: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .lean<
      Array<{
        _id: Types.ObjectId;
        orderNumber?: string;
        status?: string;
        pricing?: { amount?: number; currency?: string } | null;
        payment?: { paidAt?: Date | null } | null;
        refundedAmount?: number;
        createdAt?: Date | null;
        updatedAt?: Date | null;
      }>
    >();

  const orderIds = orders.map((o) => o._id);
  const orderNumberById = new Map(
    orders.map((o) => [String(o._id), o.orderNumber ?? "—"]),
  );

  const [consents, documents, disputes] = await Promise.all([
    email
      ? PaymentConsent.find({ orgId: orgFilter, customerEmail: email })
          .lean<
            Array<{
              _id: Types.ObjectId;
              orderId?: Types.ObjectId | null;
              orderNumber?: string;
              status?: string;
              requestedAt?: Date | null;
              receivedAt?: Date | null;
              verifiedAt?: Date | null;
            }>
          >()
      : Promise.resolve([]),
    orderIds.length
      ? DocumentModel.find({ orgId: orgFilter, orderId: { $in: orderIds } })
          .lean<
            Array<{
              _id: Types.ObjectId;
              orderId?: Types.ObjectId | null;
              kind?: string;
              number?: string;
              issuedAt?: Date | null;
            }>
          >()
      : Promise.resolve([]),
    orderIds.length
      ? Dispute.find({ orderId: { $in: orderIds } })
          .lean<
            Array<{
              _id: Types.ObjectId;
              orderId?: Types.ObjectId | null;
              status?: string;
              reason?: string | null;
              amount?: number;
              currency?: string;
              openedAt?: Date | null;
              closedAt?: Date | null;
            }>
          >()
      : Promise.resolve([]),
  ]);

  const events: TimelineEventDTO[] = [];

  // Client created
  if (customer.createdAt) {
    events.push({
      id: `client:${customer._id}`,
      kind: "client.created",
      category: "client",
      title: "Client created",
      detail: null,
      at: iso(customer.createdAt)!,
      orderId: null,
      orderNumber: null,
      amount: null,
      currency: null,
      status: null,
    });
  }

  // Orders: created / paid / refunded
  for (const o of orders) {
    const orderId = String(o._id);
    const orderNumber = o.orderNumber ?? "—";
    const currency = o.pricing?.currency ?? null;
    const amount =
      typeof o.pricing?.amount === "number" ? o.pricing.amount : null;
    if (o.createdAt) {
      events.push({
        id: `order:${orderId}:created`,
        kind: "order.created",
        category: "order",
        title: `Order ${orderNumber} created`,
        detail: null,
        at: iso(o.createdAt)!,
        orderId,
        orderNumber,
        amount,
        currency,
        status: o.status ?? null,
      });
    }
    if (o.payment?.paidAt) {
      events.push({
        id: `order:${orderId}:paid`,
        kind: "order.paid",
        category: "payment",
        title: `Payment received`,
        detail: `Order ${orderNumber}`,
        at: iso(o.payment.paidAt)!,
        orderId,
        orderNumber,
        amount,
        currency,
        status: "PAID",
      });
    }
    if ((o.refundedAmount ?? 0) > 0 && o.updatedAt) {
      events.push({
        id: `order:${orderId}:refunded`,
        kind: "order.refunded",
        category: "refund",
        title: `Refund issued`,
        detail: `Order ${orderNumber}`,
        at: iso(o.updatedAt)!,
        orderId,
        orderNumber,
        amount: o.refundedAmount ?? null,
        currency,
        status: "REFUNDED",
      });
    }
  }

  // Consent lifecycle
  for (const c of consents) {
    const orderId = c.orderId ? String(c.orderId) : null;
    const orderNumber = c.orderNumber ?? null;
    const base = { orderId, orderNumber, amount: null, currency: null };
    if (c.requestedAt) {
      events.push({
        id: `consent:${c._id}:requested`,
        kind: "consent.requested",
        category: "consent",
        title: "Consent requested",
        detail: orderNumber ? `Order ${orderNumber}` : null,
        at: iso(c.requestedAt)!,
        status: "REQUESTED",
        ...base,
      });
    }
    if (c.receivedAt) {
      events.push({
        id: `consent:${c._id}:received`,
        kind: "consent.received",
        category: "consent",
        title: "Consent accepted",
        detail: orderNumber ? `Order ${orderNumber}` : null,
        at: iso(c.receivedAt)!,
        status: "RECEIVED",
        ...base,
      });
    }
    if (c.verifiedAt) {
      events.push({
        id: `consent:${c._id}:verified`,
        kind: "consent.verified",
        category: "consent",
        title: "Consent verified",
        detail: orderNumber ? `Order ${orderNumber}` : null,
        at: iso(c.verifiedAt)!,
        status: "VERIFIED",
        ...base,
      });
    }
  }

  // Documents issued
  for (const d of documents) {
    if (!d.issuedAt) continue;
    const orderId = d.orderId ? String(d.orderId) : null;
    const orderNumber = orderId ? (orderNumberById.get(orderId) ?? null) : null;
    events.push({
      id: `document:${d._id}`,
      kind: "document.issued",
      category: "document",
      title: `${d.kind === "RECEIPT" ? "Receipt" : "Invoice"} ${d.number ?? ""} issued`.trim(),
      detail: orderNumber ? `Order ${orderNumber}` : null,
      at: iso(d.issuedAt)!,
      orderId,
      orderNumber,
      amount: null,
      currency: null,
      status: d.kind ?? null,
    });
  }

  // Disputes
  for (const dp of disputes) {
    const orderId = dp.orderId ? String(dp.orderId) : null;
    const orderNumber = orderId ? (orderNumberById.get(orderId) ?? null) : null;
    if (dp.openedAt) {
      events.push({
        id: `dispute:${dp._id}:opened`,
        kind: "dispute.opened",
        category: "dispute",
        title: "Dispute opened",
        detail: dp.reason ?? (orderNumber ? `Order ${orderNumber}` : null),
        at: iso(dp.openedAt)!,
        orderId,
        orderNumber,
        amount: typeof dp.amount === "number" ? dp.amount : null,
        currency: dp.currency ?? null,
        status: dp.status ?? null,
      });
    }
    if (dp.closedAt) {
      events.push({
        id: `dispute:${dp._id}:closed`,
        kind: "dispute.closed",
        category: "dispute",
        title: "Dispute closed",
        detail: orderNumber ? `Order ${orderNumber}` : null,
        at: iso(dp.closedAt)!,
        orderId,
        orderNumber,
        amount: null,
        currency: null,
        status: dp.status ?? null,
      });
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events;
}
