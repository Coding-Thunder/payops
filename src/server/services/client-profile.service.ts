import "server-only";

import { Types } from "mongoose";

import { AuditAction, AuditEntity, RecordState } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { RequestContext } from "@/server/api/request-context";
import {
  ClientFile,
  ClientLink,
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
  /** Paid orders across ALL currencies (for the total-orders breakdown). */
  paidOrders: number;
  /** Paid orders in the PRIMARY currency only — the denominator behind
   *  `revenue`/`averageOrderValue`, so any caption pairing the money
   *  figures with a count must use THIS, never the cross-currency total. */
  primaryPaidOrders: number;
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
  country: string | null;
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
  // Email fallback catches orders the backfill hasn't linked yet — but ONLY
  // orders not linked to ANY client (customerId null/missing, which Mongo's
  // `null` match covers). Never orders already linked to a DIFFERENT client,
  // so one client's history can't bleed into another's via a shared email
  // snapshot (two same-name clients, a reused/edited email, etc.).
  if (email) branches.push({ customerId: null, "customer.email": email });
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
  // Primary = the currency this client transacts in MOST. Ranked by paid
  // order count, then total orders, then revenue — deliberately NOT by raw
  // revenue amount, because comparing money across currencies without an FX
  // rate is meaningless (¥500k would outrank $10k). All money fields below
  // then reflect ONLY this one currency, and `primaryPaidOrders` is the
  // matching denominator so revenue / AOV / any caption stay self-consistent.
  const primary = [...groups].sort(
    (a, b) =>
      b.paidOrders - a.paidOrders ||
      b.orders - a.orders ||
      b.revenue - a.revenue,
  )[0];

  const totals: ClientTotalsDTO = {
    totalOrders,
    paidOrders,
    primaryPaidOrders: primary?.paidOrders ?? 0,
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
    country: customer.country ?? null,
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
  country?: string | null;
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
  if (input.country !== undefined) {
    const v = input.country?.trim() || null;
    if (v && v.length > 80) throw new ValidationError("Country is too long");
    if (v !== doc.country) changed.country = doc.country = v;
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
    // Only a genuine change should save + audit — an idempotent re-submit
    // of the same tags must not forge a CUSTOMER_UPDATED row in the ledger.
    const current = Array.isArray(doc.tags) ? doc.tags : [];
    const same =
      tags.length === current.length &&
      tags.every((t, i) => t === current[i]);
    if (!same) {
      doc.tags = tags;
      changed.tags = tags;
    }
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

/* ─── Create ───────────────────────────────────────────────────────────── */

export interface CreateClientInput {
  name: string;
  email?: string;
  phone?: string;
  company?: string | null;
  country?: string | null;
  notes?: string | null;
}

export interface CreateClientResult {
  id: string;
  /** True when an existing client with this email was returned instead of
   *  creating a duplicate. */
  existed: boolean;
}

/**
 * Create a new Client Profile from the "New Client Record" flow. Tenant-
 * pinned + audited. Dedupes by (orgId, email): if a client with the same
 * email already exists, returns that one (`existed: true`) rather than
 * colliding on the unique index — the caller can just open it.
 */
export async function createClient(
  orgId: string | null | undefined,
  input: CreateClientInput,
  ctx: UpdateClientContext,
): Promise<CreateClientResult> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();

  const name = input.name.trim();
  if (!name) throw new ValidationError("Client name is required");
  if (name.length > 120) throw new ValidationError("Name is too long");
  const email = (input.email ?? "").toLowerCase().trim();
  const phone = (input.phone ?? "").trim();
  const company = input.company?.trim() || null;
  const country = input.country?.trim() || null;
  const notes = input.notes?.trim() || null;
  const orgFilter = orgIdFilter(scopedOrgId);

  if (email) {
    const existing = await Customer.findOne({ orgId: orgFilter, email })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId } | null>();
    if (existing) return { id: String(existing._id), existed: true };
  }

  try {
    const created = await Customer.create({
      orgId: orgFilter,
      name,
      email,
      phone,
      company,
      country,
      notes,
      tags: [],
    });
    await recordAudit({
      action: AuditAction.CUSTOMER_CREATED,
      entityType: AuditEntity.CUSTOMER,
      entityId: String(created._id),
      orgId: scopedOrgId,
      actor: {
        userId: ctx.actor.id,
        name: ctx.actor.name,
        role: ctx.actor.role as never,
      },
      request: ctx.request ?? null,
      metadata: { name, hasEmail: Boolean(email) },
    });
    return { id: String(created._id), existed: false };
  } catch (err) {
    // Lost a create race on the unique (orgId, email) index — re-read.
    if (
      email &&
      typeof err === "object" &&
      err !== null &&
      (err as { code?: number }).code === 11000
    ) {
      const again = await Customer.findOne({ orgId: orgFilter, email })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId } | null>();
      if (again) return { id: String(again._id), existed: true };
    }
    throw err;
  }
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
    | "dispute"
    | "file"
    | "link";
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
 * issued documents, disputes, and the Files & Links activity — all
 * tenant-scoped, newest first.
 *
 * Files and Links are DERIVED here rather than written to an event log,
 * exactly like orders and documents: the row carries `createdAt`,
 * `sharedWithClientAt` and `lastEmailedAt`, and those three timestamps
 * are the three things that happened. That keeps the Timeline (the
 * chronological history) and the Files/Links sections (the organised
 * collection) as two views of one truth instead of two records that can
 * disagree — which is precisely the duplication the brief warns against.
 *
 * Soft-deleted rows are deliberately INCLUDED: "Yogesh uploaded
 * requirements.pdf" is a historical fact, and deleting the file later
 * doesn't un-happen it.
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

  const [consents, documents, disputes, files, links] = await Promise.all([
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
    ClientFile.find({ orgId: orgFilter, customerId: oid })
      .sort({ createdAt: -1 })
      .limit(200)
      .select({
        fileName: 1,
        orderId: 1,
        orderNumber: 1,
        visibility: 1,
        addedBy: 1,
        sharedWithClientAt: 1,
        lastEmailedAt: 1,
        createdAt: 1,
      })
      .lean<
        Array<{
          _id: Types.ObjectId;
          fileName?: string;
          orderId?: Types.ObjectId | null;
          orderNumber?: string | null;
          visibility?: string;
          addedBy?: { name?: string; actorType?: string } | null;
          sharedWithClientAt?: Date | null;
          lastEmailedAt?: Date | null;
          createdAt?: Date | null;
        }>
      >(),
    ClientLink.find({ orgId: orgFilter, customerId: oid })
      .sort({ createdAt: -1 })
      .limit(200)
      .select({
        name: 1,
        source: 1,
        orderId: 1,
        orderNumber: 1,
        addedBy: 1,
        lastEmailedAt: 1,
        createdAt: 1,
      })
      .lean<
        Array<{
          _id: Types.ObjectId;
          name?: string;
          source?: string;
          orderId?: Types.ObjectId | null;
          orderNumber?: string | null;
          addedBy?: { name?: string; actorType?: string } | null;
          lastEmailedAt?: Date | null;
          createdAt?: Date | null;
        }>
      >(),
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

  // Files: added → shared → emailed. Each timestamp is emitted only when
  // it says something the previous one didn't, so a file uploaded as
  // "shared with client" produces ONE line, not two identical ones a
  // millisecond apart.
  for (const f of files) {
    if (!f.createdAt) continue;
    const orderId = f.orderId ? String(f.orderId) : null;
    const orderNumber =
      f.orderNumber ?? (orderId ? (orderNumberById.get(orderId) ?? null) : null);
    const detail = orderNumber ? `Order ${orderNumber}` : null;
    const byClient = f.addedBy?.actorType === "CLIENT";
    const who = byClient ? "Client" : (f.addedBy?.name ?? "Someone");
    const fileName = f.fileName ?? "a file";
    // Files the client provided read as theirs; the teammate who saved
    // them is still named, just not as the origin.
    const savedBy =
      byClient && f.addedBy?.name ? `saved by ${f.addedBy.name}` : null;
    events.push({
      id: `file:${f._id}:added`,
      kind: byClient ? "file.client_uploaded" : "file.added",
      category: "file",
      title: `${who} uploaded ${fileName}`,
      detail: [savedBy, detail].filter(Boolean).join(" · ") || null,
      at: iso(f.createdAt)!,
      orderId,
      orderNumber,
      amount: null,
      currency: null,
      status: f.visibility ?? null,
    });
    if (
      f.sharedWithClientAt &&
      !sameMoment(f.sharedWithClientAt, f.createdAt) &&
      !sameMoment(f.sharedWithClientAt, f.lastEmailedAt)
    ) {
      events.push({
        id: `file:${f._id}:shared`,
        kind: "file.shared",
        category: "file",
        title: `${who} shared ${fileName} with the client`,
        detail,
        at: iso(f.sharedWithClientAt)!,
        orderId,
        orderNumber,
        amount: null,
        currency: null,
        status: "SHARED",
      });
    }
    if (f.lastEmailedAt) {
      events.push({
        id: `file:${f._id}:emailed`,
        kind: "file.emailed",
        category: "file",
        title: `${fileName} sent via email`,
        detail,
        at: iso(f.lastEmailedAt)!,
        orderId,
        orderNumber,
        amount: null,
        currency: null,
        status: "SHARED",
      });
    }
  }

  // Links: added → shared via email.
  for (const l of links) {
    if (!l.createdAt) continue;
    const orderId = l.orderId ? String(l.orderId) : null;
    const orderNumber =
      l.orderNumber ?? (orderId ? (orderNumberById.get(orderId) ?? null) : null);
    const byClient = l.addedBy?.actorType === "CLIENT";
    const who = byClient ? "Client" : (l.addedBy?.name ?? "Someone");
    const name = l.name ?? "a link";
    const detail = [l.source, orderNumber ? `Order ${orderNumber}` : null]
      .filter(Boolean)
      .join(" · ") || null;
    events.push({
      id: `link:${l._id}:added`,
      kind: byClient ? "link.client_added" : "link.added",
      category: "link",
      title: `${who} added a link: ${name}`,
      detail,
      at: iso(l.createdAt)!,
      orderId,
      orderNumber,
      amount: null,
      currency: null,
      status: null,
    });
    if (l.lastEmailedAt) {
      events.push({
        id: `link:${l._id}:emailed`,
        kind: "link.emailed",
        category: "link",
        title: `${name} link shared with the client via email`,
        detail,
        at: iso(l.lastEmailedAt)!,
        orderId,
        orderNumber,
        amount: null,
        currency: null,
        status: null,
      });
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events;
}

/** Two timestamps close enough to be the same user action. Uploading a
 *  file that is already "shared with client" writes both stamps in the
 *  same request; they are one event, not two. */
function sameMoment(
  a?: Date | null,
  b?: Date | null,
  toleranceMs = 2000,
): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= toleranceMs;
}
